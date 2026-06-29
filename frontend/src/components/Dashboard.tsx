import React, { useState, useEffect, useRef } from 'react';

interface DashboardProps {
  onStartJob: (jobId: string) => void;
  onViewJob: (jobId: string) => void;
  onLogout: () => void;
}

interface OllamaPullStatus {
  model: string | null;
  status: string;
  completed: number;
  total: number;
  error: string | null;
}

interface PastJob {
  id: string;
  title: string;
  status: string;
  total_resumes: number;
  created_at: string;
}

export const Dashboard: React.FC<DashboardProps> = ({ onStartJob, onViewJob, onLogout }) => {
  const [models, setModels] = useState<string[]>([]);
  const [loadingModels, setLoadingModels] = useState(false);
  const [warningMsg, setWarningMsg] = useState('');
  
  // Model assignments
  const [filterModel, setFilterModel] = useState('');
  const [scorerModel, setScorerModel] = useState('');
  const [rankerModel, setRankerModel] = useState('');
  const [embeddingModel, setEmbeddingModel] = useState('');

  // Pull model form
  const [modelToPull, setModelToPull] = useState('');
  const [pullProgress, setPullProgress] = useState<OllamaPullStatus | null>(null);
  const pullIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Job Submission form
  const [jobTitle, setJobTitle] = useState('');
  const [jdText, setJdText] = useState('');
  const [jdFile, setJdFile] = useState<File | null>(null);
  const [resumeFiles, setResumeFiles] = useState<File[]>([]);
  const [submittingJob, setSubmittingJob] = useState(false);
  const [jobError, setJobError] = useState('');

  // Past jobs
  const [pastJobs, setPastJobs] = useState<PastJob[]>([]);
  const [loadingJobs, setLoadingJobs] = useState(false);

  const baseUrl = import.meta.env.VITE_API_BASE_URL || 'http://localhost:8000';
  const token = localStorage.getItem('talentsift_token') || '';

  // Fetch Ollama models
  const fetchModels = async () => {
    setLoadingModels(true);
    setWarningMsg('');
    try {
      const response = await fetch(`${baseUrl}/api/ollama/models`);
      const data = await response.json();
      setModels(data.models || []);
      if (data.warning) {
        setWarningMsg(data.warning);
      }
      
      // Auto-assign defaults if models exist
      if (data.models && data.models.length > 0) {
        // Look for typical models or default to first
        const gemma = data.models.find((m: string) => m.includes('gemma'));
        const qwen = data.models.find((m: string) => m.includes('qwen'));
        const embed = data.models.find((m: string) => m.includes('embed'));
        
        setFilterModel(gemma || data.models[0]);
        setScorerModel(qwen || data.models[0]);
        setRankerModel(qwen || data.models[0]);
        setEmbeddingModel(embed || data.models[0]);
      }
    } catch (err) {
      setWarningMsg('Could not connect to backend server for models.');
    } finally {
      setLoadingModels(false);
    }
  };

  // Fetch past jobs list
  const fetchPastJobs = async () => {
    setLoadingJobs(true);
    try {
      const response = await fetch(`${baseUrl}/api/jobs`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      if (response.ok) {
        const data = await response.json();
        setPastJobs(data);
      }
    } catch (err) {
      console.error("Error fetching jobs: ", err);
    } finally {
      setLoadingJobs(false);
    }
  };

  // Effect on mount
  useEffect(() => {
    fetchModels();
    fetchPastJobs();
    
    // Check if there's an ongoing pull on mount
    checkPullStatus();
    
    return () => {
      if (pullIntervalRef.current) clearInterval(pullIntervalRef.current);
    };
  }, []);

  // Check Ollama pull status
  const checkPullStatus = async () => {
    try {
      const response = await fetch(`${baseUrl}/api/ollama/pull/status`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      if (response.ok) {
        const data: OllamaPullStatus = await response.json();
        if (data.status && data.status !== 'idle') {
          setPullProgress(data);
          
          if (data.status === 'success') {
            setPullProgress(null);
            fetchModels();
            if (pullIntervalRef.current) {
              clearInterval(pullIntervalRef.current);
              pullIntervalRef.current = null;
            }
          } else if (data.status === 'error') {
            if (pullIntervalRef.current) {
              clearInterval(pullIntervalRef.current);
              pullIntervalRef.current = null;
            }
          } else {
            // Start polling if not already started
            if (!pullIntervalRef.current) {
              pullIntervalRef.current = setInterval(checkPullStatus, 1500);
            }
          }
        } else {
          setPullProgress(null);
          if (pullIntervalRef.current) {
            clearInterval(pullIntervalRef.current);
            pullIntervalRef.current = null;
          }
        }
      }
    } catch (err) {
      console.error(err);
    }
  };

  // Pull model from Ollama
  const handlePullModel = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!modelToPull.trim()) return;

    try {
      const response = await fetch(`${baseUrl}/api/ollama/pull`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({ model: modelToPull.trim() })
      });
      
      const data = await response.json();
      if (!response.ok) {
        alert(data.detail || 'Failed to start pulling model.');
      } else {
        setModelToPull('');
        // Start status checker
        checkPullStatus();
      }
    } catch (err) {
      alert('Error triggering model pull.');
    }
  };

  // Handle files selection
  const handleResumeSelection = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) {
      const selectedFiles = Array.from(e.target.files);
      
      // Basic check
      const totalCount = resumeFiles.length + selectedFiles.length;
      if (totalCount > 100) {
        alert(`You can upload at most 100 resumes. Selecting these files would result in ${totalCount} resumes.`);
        return;
      }
      
      setResumeFiles(prev => [...prev, ...selectedFiles]);
    }
  };

  const removeResumeFile = (index: number) => {
    setResumeFiles(prev => prev.filter((_, i) => i !== index));
  };

  // Submit Job
  const handleSubmitJob = async (e: React.FormEvent) => {
    e.preventDefault();
    setJobError('');
    
    if (!jobTitle.trim()) {
      setJobError('Please enter a job title.');
      return;
    }
    if (!jdText.trim() && !jdFile) {
      setJobError('Please provide a Job Description (paste text or upload a PDF).');
      return;
    }
    if (resumeFiles.length === 0) {
      setJobError('Please upload at least one resume.');
      return;
    }
    if (!filterModel || !scorerModel || !rankerModel) {
      setJobError('Please ensure LLM models are selected for all 3 agents.');
      return;
    }

    setSubmittingJob(true);
    const formData = new FormData();
    formData.append('title', jobTitle);
    formData.append('filter_model', filterModel);
    formData.append('scorer_model', scorerModel);
    formData.append('ranker_model', rankerModel);
    formData.append('embedding_model', embeddingModel);

    if (jdText.trim()) {
      formData.append('jd_text', jdText);
    }
    if (jdFile) {
      formData.append('jd_file', jdFile);
    }
    
    resumeFiles.forEach(file => {
      formData.append('resumes_files', file);
    });

    try {
      const response = await fetch(`${baseUrl}/api/jobs`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`
        },
        body: formData
      });

      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.detail || 'Failed to create job');
      }

      // Transition to run page
      onStartJob(data.job_id);
    } catch (err: any) {
      setJobError(err.message || 'Error occurred while creating shortlisting job.');
      setSubmittingJob(false);
    }
  };

  // Helper: Format bytes
  const formatBytes = (bytes: number) => {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  };

  // Calculate pull progress percentage
  const getPullPercentage = () => {
    if (!pullProgress || pullProgress.total === 0) return 0;
    return Math.round((pullProgress.completed / pullProgress.total) * 100);
  };

  return (
    <div className="animate-fade-in" style={styles.dashboardContainer}>
      {/* Header bar */}
      <div className="flex-between" style={styles.header}>
        <div>
          <h2>HR Shortlisting Panel</h2>
          <p>Deploy multi-agent pipelines to shortlist, score, and rank applications.</p>
        </div>
        <button onClick={onLogout} className="btn btn-secondary">
          🚪 Logout
        </button>
      </div>

      {warningMsg && (
        <div style={styles.warningBox}>
          <span>💡</span> {warningMsg}
          <button onClick={fetchModels} style={styles.refreshBtn}>🔄 Retry</button>
        </div>
      )}

      {/* Main Grid */}
      <div style={styles.mainGrid}>
        
        {/* Left Side: Configuration & Models */}
        <div style={styles.leftCol}>
          
          {/* Models Puller */}
          <div className="card" style={styles.sectionCard}>
            <h3 style={styles.cardTitle}>Ollama LLM Puller</h3>
            <p style={styles.cardDesc}>Download additional LLM models from Ollama Library (e.g. <code>llama3.2</code>, <code>mistral</code>, <code>nomic-embed-text</code>).</p>
            
            {pullProgress ? (
              <div style={styles.progressContainer}>
                <div style={styles.progressHeader}>
                  <span style={styles.pullModelName}>⏬ Pulling: {pullProgress.model}</span>
                  <span style={styles.pullPercentage}>{getPullPercentage()}%</span>
                </div>
                <div style={styles.progressBarBg}>
                  <div style={{ ...styles.progressBarFill, width: `${getPullPercentage()}%` }}></div>
                </div>
                <div style={styles.pullStatusText}>
                  {pullProgress.status} 
                  {pullProgress.total > 0 && ` (${formatBytes(pullProgress.completed)} / ${formatBytes(pullProgress.total)})`}
                </div>
              </div>
            ) : (
              <form onSubmit={handlePullModel} style={styles.pullForm}>
                <input
                  type="text"
                  placeholder="e.g. llama3.2:1b"
                  value={modelToPull}
                  onChange={(e) => setModelToPull(e.target.value)}
                  style={{ flexGrow: 1 }}
                />
                <button type="submit" className="btn btn-secondary" style={styles.pullBtn}>
                  ⬇️ Pull
                </button>
              </form>
            )}
            
            {pullProgress?.status === 'error' && (
              <div style={styles.pullError}>
                Error: {pullProgress.error}
                <button onClick={() => setPullProgress(null)} style={styles.closePullError}>Dismiss</button>
              </div>
            )}
          </div>

          {/* Model Assignments */}
          <div className="card" style={styles.sectionCard}>
            <h3 style={styles.cardTitle}>Agent Model Mapping</h3>
            <p style={styles.cardDesc}>Assign individual Ollama models for each pipeline agent.</p>
            
            {loadingModels ? (
              <p>Loading available models...</p>
            ) : models.length === 0 ? (
              <div style={styles.noModelsWarning}>
                No local Ollama models found. Please pull a model (like <code>gemma2:2b</code>) above to continue.
              </div>
            ) : (
              <div style={styles.modelSelectors}>
                <div className="form-group">
                  <label>1. Filter Agent Model</label>
                  <select value={filterModel} onChange={(e) => setFilterModel(e.target.value)}>
                    {models.map(m => <option key={m} value={m}>{m}</option>)}
                  </select>
                </div>
                <div className="form-group">
                  <label>2. Scorer Agent Model</label>
                  <select value={scorerModel} onChange={(e) => setScorerModel(e.target.value)}>
                    {models.map(m => <option key={m} value={m}>{m}</option>)}
                  </select>
                </div>
                <div className="form-group">
                  <label>3. Ranker Agent Model</label>
                  <select value={rankerModel} onChange={(e) => setRankerModel(e.target.value)}>
                    {models.map(m => <option key={m} value={m}>{m}</option>)}
                  </select>
                </div>
                <div className="form-group">
                  <label>Embedding Model (Optional)</label>
                  <select value={embeddingModel} onChange={(e) => setEmbeddingModel(e.target.value)}>
                    <option value="">None (Standard processing)</option>
                    {models.map(m => <option key={m} value={m}>{m}</option>)}
                  </select>
                </div>
              </div>
            )}
          </div>

          {/* Past Jobs */}
          <div className="card" style={styles.sectionCard}>
            <h3 style={styles.cardTitle}>Recent Pipelines</h3>
            {loadingJobs ? (
              <p>Loading past campaigns...</p>
            ) : pastJobs.length === 0 ? (
              <p style={{ fontStyle: 'italic', fontSize: '0.9rem', color: 'var(--text-muted)' }}>No shortlisting campaigns launched yet.</p>
            ) : (
              <div style={styles.jobsList}>
                {pastJobs.map(job => (
                  <div key={job.id} style={styles.jobListItem} onClick={() => onViewJob(job.id)}>
                    <div style={styles.jobItemMeta}>
                      <span style={styles.jobItemTitle}>{job.title}</span>
                      <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                        {new Date(job.created_at).toLocaleDateString()}
                      </span>
                    </div>
                    <div style={styles.jobItemStats}>
                      <span style={styles.jobResumeCount}>📄 {job.total_resumes} Resumes</span>
                      <span className={`badge ${
                        job.status === 'completed' ? 'badge-success' :
                        job.status === 'failed' ? 'badge-danger' : 'badge-warning'
                      }`}>
                        {job.status}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

        </div>

        {/* Right Side: Create Job Campaign */}
        <div style={styles.rightCol}>
          <form onSubmit={handleSubmitJob} className="card" style={{ ...styles.sectionCard, height: '100%' }}>
            <h3 style={styles.cardTitle}>Launch Shortlisting Campaign</h3>
            <p style={styles.cardDesc}>Upload details and candidates to start processing.</p>

            {jobError && (
              <div style={styles.jobErrorBox}>
                <span>⚠️</span> {jobError}
              </div>
            )}

            <div className="form-group">
              <label>Campaign Title</label>
              <input
                type="text"
                placeholder="e.g. Senior Full-Stack Engineer"
                value={jobTitle}
                onChange={(e) => setJobTitle(e.target.value)}
                required
              />
            </div>

            <div className="form-group">
              <label>Job Description (JD)</label>
              <div style={styles.jdInputsContainer}>
                <textarea
                  placeholder="Paste the Job Description text here..."
                  rows={6}
                  value={jdText}
                  onChange={(e) => {
                    setJdText(e.target.value);
                    if (e.target.value.trim()) setJdFile(null); // Clear file if text entered
                  }}
                  disabled={!!jdFile}
                  style={styles.jdTextArea}
                />
                
                <div style={styles.divider}>
                  <span style={styles.dividerLine}></span>
                  <span style={styles.dividerText}>OR</span>
                  <span style={styles.dividerLine}></span>
                </div>

                <div style={styles.jdFileInputRow}>
                  <label htmlFor="jd-file-input" style={styles.jdFileLabel}>
                    📂 {jdFile ? `Selected: ${jdFile.name}` : 'Upload JD PDF file'}
                  </label>
                  <input
                    id="jd-file-input"
                    type="file"
                    accept=".pdf"
                    onChange={(e) => {
                      if (e.target.files && e.target.files[0]) {
                        setJdFile(e.target.files[0]);
                        setJdText(''); // Clear text if file selected
                      }
                    }}
                    style={{ display: 'none' }}
                  />
                  {jdFile && (
                    <button type="button" style={styles.clearJdBtn} onClick={() => setJdFile(null)}>
                      ❌ Clear
                    </button>
                  )}
                </div>
              </div>
            </div>

            <div className="form-group">
              <label>Candidate Resumes (Limit: 100 PDF / ZIP / Folder)</label>
              <div style={styles.uploadBox}>
                <input
                  id="resume-files-input"
                  type="file"
                  accept=".pdf,.zip"
                  multiple
                  onChange={handleResumeSelection}
                  style={{ display: 'none' }}
                />
                <label htmlFor="resume-files-input" style={styles.uploadLabel}>
                  <div style={styles.uploadIcon}>📥</div>
                  <div style={styles.uploadTextBold}>Click to select Resumes</div>
                  <div style={styles.uploadTextSub}>Supports multiple PDFs, folders, or ZIP archives containing PDFs.</div>
                </label>
              </div>

              {resumeFiles.length > 0 && (
                <div style={styles.selectedFilesContainer}>
                  <div style={styles.filesHeader}>
                    <span>Selected Candidates ({resumeFiles.length} / 100)</span>
                    <button type="button" className="btn btn-secondary" style={{ padding: '0.2rem 0.5rem', fontSize: '0.8rem' }} onClick={() => setResumeFiles([])}>
                      Clear All
                    </button>
                  </div>
                  <div style={styles.filesList}>
                    {resumeFiles.map((file, index) => (
                      <div key={index} style={styles.fileRow}>
                        <div style={styles.fileNameCol}>
                          <span>📄</span>
                          <span style={styles.fileRowName}>{file.name}</span>
                        </div>
                        <div style={styles.fileSizeCol}>
                          <span style={styles.fileRowSize}>{formatBytes(file.size)}</span>
                          <button type="button" style={styles.removeFileBtn} onClick={() => removeResumeFile(index)}>
                            ❌
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>

            <button
              type="submit"
              className="btn btn-primary"
              style={styles.submitBtn}
              disabled={submittingJob || models.length === 0}
            >
              {submittingJob ? (
                <>⚙️ Initializing Pipeline...</>
              ) : (
                <>🚀 Run Agent Pipeline</>
              )}
            </button>
          </form>
        </div>

      </div>
    </div>
  );
};

const styles: Record<string, React.CSSProperties> = {
  dashboardContainer: {
    maxWidth: '1200px',
    margin: '0 auto',
  },
  header: {
    marginBottom: '2rem',
    borderBottom: '1px solid var(--border-color)',
    paddingBottom: '1.5rem',
  },
  warningBox: {
    background: 'var(--color-warning-bg)',
    color: 'var(--color-warning)',
    border: '1px solid var(--color-warning-border)',
    borderRadius: '12px',
    padding: '0.85rem 1.25rem',
    marginBottom: '2rem',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    fontSize: '0.95rem',
  },
  refreshBtn: {
    background: 'none',
    border: 'none',
    color: 'var(--color-warning)',
    cursor: 'pointer',
    fontWeight: 'bold',
    textDecoration: 'underline',
  },
  mainGrid: {
    display: 'grid',
    gridTemplateColumns: '380px 1fr',
    gap: '2rem',
    alignItems: 'start',
  },
  leftCol: {
    display: 'flex',
    flexDirection: 'column',
    gap: '2rem',
  },
  rightCol: {
    height: '100%',
  },
  sectionCard: {
    padding: '1.5rem',
  },
  cardTitle: {
    fontSize: '1.25rem',
    marginBottom: '0.25rem',
    color: 'var(--text-primary)',
  },
  cardDesc: {
    fontSize: '0.85rem',
    color: 'var(--text-secondary)',
    marginBottom: '1.25rem',
  },
  pullForm: {
    display: 'flex',
    gap: '0.5rem',
  },
  pullBtn: {
    padding: '0.75rem 1rem',
  },
  progressContainer: {
    marginTop: '0.5rem',
    background: 'rgba(0,0,0,0.2)',
    padding: '1rem',
    borderRadius: '10px',
    border: '1px solid var(--border-color)',
  },
  progressHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    marginBottom: '0.5rem',
    fontSize: '0.9rem',
  },
  pullModelName: {
    fontWeight: 'bold',
    color: 'var(--color-primary-hover)',
  },
  pullPercentage: {
    fontWeight: 'bold',
    color: 'var(--color-secondary)',
  },
  progressBarBg: {
    height: '8px',
    background: '#1e293b',
    borderRadius: '4px',
    overflow: 'hidden',
    marginBottom: '0.5rem',
  },
  progressBarFill: {
    height: '100%',
    background: 'linear-gradient(90deg, var(--color-primary) 0%, var(--color-secondary) 100%)',
    transition: 'width 0.3s ease',
  },
  pullStatusText: {
    fontSize: '0.75rem',
    color: 'var(--text-muted)',
    textTransform: 'capitalize',
  },
  pullError: {
    background: 'var(--color-danger-bg)',
    color: 'var(--color-danger)',
    border: '1px solid var(--color-danger-border)',
    borderRadius: '8px',
    padding: '0.5rem 0.75rem',
    marginTop: '0.75rem',
    fontSize: '0.8rem',
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  closePullError: {
    background: 'none',
    border: 'none',
    color: 'var(--color-danger)',
    cursor: 'pointer',
    textDecoration: 'underline',
    fontSize: '0.75rem',
  },
  noModelsWarning: {
    background: 'rgba(244, 63, 94, 0.05)',
    border: '1px dashed var(--color-danger)',
    color: 'var(--color-danger)',
    padding: '1rem',
    borderRadius: '10px',
    fontSize: '0.9rem',
    textAlign: 'center',
  },
  modelSelectors: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.75rem',
  },
  jobsList: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.75rem',
    maxHeight: '300px',
    overflowY: 'auto',
    paddingRight: '0.25rem',
  },
  jobListItem: {
    background: 'rgba(255, 255, 255, 0.02)',
    border: '1px solid var(--border-color)',
    borderRadius: '10px',
    padding: '0.85rem 1rem',
    cursor: 'pointer',
    transition: 'var(--transition-fast)',
    display: 'flex',
    flexDirection: 'column',
    gap: '0.5rem',
  },
  jobListItemHover: {
    borderColor: 'var(--border-color-hover)',
    background: 'var(--bg-card-hover)',
  },
  jobItemMeta: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  jobItemTitle: {
    fontWeight: '700',
    fontSize: '0.95rem',
    color: 'var(--text-primary)',
  },
  jobItemStats: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  jobResumeCount: {
    fontSize: '0.85rem',
    color: 'var(--text-secondary)',
  },
  submitBtn: {
    width: '100%',
    padding: '0.9rem',
    fontSize: '1rem',
    marginTop: '1.5rem',
  },
  jobErrorBox: {
    background: 'var(--color-danger-bg)',
    color: 'var(--color-danger)',
    border: '1px solid var(--color-danger-border)',
    borderRadius: '10px',
    padding: '0.75rem 1rem',
    marginBottom: '1.25rem',
    fontSize: '0.9rem',
    display: 'flex',
    alignItems: 'center',
    gap: '0.5rem',
  },
  jdInputsContainer: {
    background: 'rgba(0,0,0,0.15)',
    border: '1px solid var(--border-color)',
    borderRadius: '10px',
    padding: '1rem',
  },
  jdTextArea: {
    width: '100%',
    resize: 'vertical',
  },
  divider: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    margin: '0.75rem 0',
  },
  dividerLine: {
    flexGrow: 1,
    height: '1px',
    background: 'var(--border-color)',
  },
  dividerText: {
    fontSize: '0.75rem',
    color: 'var(--text-muted)',
    padding: '0 0.75rem',
    fontWeight: 'bold',
  },
  jdFileInputRow: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  jdFileLabel: {
    cursor: 'pointer',
    background: 'rgba(255, 255, 255, 0.04)',
    border: '1px dashed var(--text-muted)',
    borderRadius: '8px',
    padding: '0.5rem 1rem',
    fontSize: '0.85rem',
    textTransform: 'none',
    color: 'var(--text-secondary)',
    flexGrow: 1,
    textAlign: 'center',
  },
  clearJdBtn: {
    background: 'none',
    border: 'none',
    color: 'var(--color-danger)',
    cursor: 'pointer',
    padding: '0.5rem',
    marginLeft: '0.5rem',
  },
  uploadBox: {
    border: '2px dashed var(--border-color)',
    borderRadius: '12px',
    padding: '2rem 1.5rem',
    textAlign: 'center',
    cursor: 'pointer',
    background: 'rgba(255, 255, 255, 0.01)',
    transition: 'var(--transition-fast)',
  },
  uploadLabel: {
    cursor: 'pointer',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    textTransform: 'none',
  },
  uploadIcon: {
    fontSize: '2.5rem',
    marginBottom: '0.5rem',
  },
  uploadTextBold: {
    fontWeight: 'bold',
    fontSize: '1rem',
    color: 'var(--text-primary)',
    marginBottom: '0.25rem',
  },
  uploadTextSub: {
    fontSize: '0.75rem',
    color: 'var(--text-muted)',
  },
  selectedFilesContainer: {
    marginTop: '1rem',
    background: 'rgba(0,0,0,0.1)',
    borderRadius: '10px',
    padding: '1rem',
    border: '1px solid var(--border-color)',
  },
  filesHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    fontSize: '0.85rem',
    fontWeight: 'bold',
    color: 'var(--text-secondary)',
    marginBottom: '0.75rem',
    borderBottom: '1px solid var(--border-color)',
    paddingBottom: '0.5rem',
  },
  filesList: {
    maxHeight: '180px',
    overflowY: 'auto',
    display: 'flex',
    flexDirection: 'column',
    gap: '0.5rem',
  },
  fileRow: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    background: 'rgba(255,255,255,0.02)',
    padding: '0.5rem 0.75rem',
    borderRadius: '6px',
    border: '1px solid rgba(255,255,255,0.03)',
  },
  fileNameCol: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.5rem',
    overflow: 'hidden',
    marginRight: '1rem',
  },
  fileRowName: {
    fontSize: '0.85rem',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  fileSizeCol: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.75rem',
    flexShrink: 0,
  },
  fileRowSize: {
    fontSize: '0.75rem',
    color: 'var(--text-muted)',
  },
  removeFileBtn: {
    background: 'none',
    border: 'none',
    cursor: 'pointer',
    fontSize: '0.75rem',
  },
};
