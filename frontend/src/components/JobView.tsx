import React, { useState, useEffect, useRef } from 'react';

interface JobViewProps {
  jobId: string;
  onBackToDashboard: () => void;
}

interface ResumeResult {
  id: string;
  filename: string;
  relevant: boolean | null;
  filter_analysis: string | null;
  score: number | null;
  scorer_analysis: string | null;
  rank: number | null;
  ranker_analysis: string | null;
}

interface JobDetails {
  id: string;
  title: string;
  jd_text: string;
  filter_model: string;
  scorer_model: string;
  ranker_model: string;
  embedding_model: string;
  status: string;
  created_at: string;
  resumes: ResumeResult[];
}

interface StageProgress {
  current: number;
  total: number;
  status: string; // idle, running, completed, failed
}

interface SSEEventData {
  stage: string;
  logs: string[];
  filter: StageProgress;
  scorer: StageProgress;
  ranker: StageProgress;
}

export const JobView: React.FC<JobViewProps> = ({ jobId, onBackToDashboard }) => {
  const [job, setJob] = useState<JobDetails | null>(null);
  const [loading, setLoading] = useState(true);
  
  // Real-time SSE State
  const [logs, setLogs] = useState<string[]>([]);
  const [currentStage, setCurrentStage] = useState('idle');
  const [filterProgress, setFilterProgress] = useState<StageProgress>({ current: 0, total: 0, status: 'idle' });
  const [scorerProgress, setScorerProgress] = useState<StageProgress>({ current: 0, total: 0, status: 'idle' });
  const [rankerProgress, setRankerProgress] = useState<StageProgress>({ current: 0, total: 0, status: 'idle' });

  // UI Tabs
  const [activeTab, setActiveTab] = useState<'filter' | 'scorer' | 'ranker'>('filter');
  
  // Modals for analysis
  const [selectedResume, setSelectedResume] = useState<ResumeResult | null>(null);
  const [modalType, setModalType] = useState<'filter' | 'scorer' | 'ranker' | null>(null);

  const logsEndRef = useRef<HTMLDivElement | null>(null);
  const eventSourceRef = useRef<EventSource | null>(null);

  const baseUrl = 'http://localhost:8000';
  const token = localStorage.getItem('talentsift_token') || '';

  // Scroll logs terminal to bottom
  useEffect(() => {
    if (logsEndRef.current) {
      logsEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [logs]);

  // Load static job data once complete or on mount
  const loadJobData = async () => {
    try {
      const response = await fetch(`${baseUrl}/api/jobs/${jobId}`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      if (response.ok) {
        const data: JobDetails = await response.json();
        setJob(data);
        
        // If the job is already completed/failed, configure local progress state from DB values
        if (data.status === 'completed' || data.status === 'failed') {
          setCurrentStage(data.status);
          
          const totalResumes = data.resumes.length;
          const relevantResumes = data.resumes.filter(r => r.relevant === true).length;
          const scoredResumes = data.resumes.filter(r => r.score !== null).length;
          const rankedResumes = data.resumes.filter(r => r.rank !== null).length;

          setFilterProgress({ current: totalResumes, total: totalResumes, status: 'completed' });
          setScorerProgress({ current: scoredResumes, total: relevantResumes, status: scoredResumes > 0 ? 'completed' : 'idle' });
          setRankerProgress({ current: rankedResumes, total: scoredResumes, status: rankedResumes > 0 ? 'completed' : 'idle' });
          
          setLogs([`Job loaded from history. Status: ${data.status.toUpperCase()}`]);
        }
      }
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  // Connect to SSE stream
  useEffect(() => {
    loadJobData();

    // Start SSE stream
    const sseUrl = `${baseUrl}/api/jobs/${jobId}/stream?token=${encodeURIComponent(token)}`;
    const eventSource = new EventSource(sseUrl);
    eventSourceRef.current = eventSource;

    eventSource.onmessage = (event) => {
      try {
        const data: SSEEventData = JSON.parse(event.data);
        setLogs(data.logs || []);
        setCurrentStage(data.stage);
        setFilterProgress(data.filter);
        setScorerProgress(data.scorer);
        setRankerProgress(data.ranker);

        // If pipeline is finished, reload entire job details from DB
        if (data.stage === 'completed' || data.stage === 'failed') {
          loadJobData();
          eventSource.close();
        }
      } catch (err) {
        console.error("SSE parse error: ", err);
      }
    };

    eventSource.onerror = (err) => {
      console.error("SSE error: ", err);
      eventSource.close();
    };

    return () => {
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
      }
    };
  }, [jobId]);

  // Export results to CSV
  const handleExportCSV = () => {
    if (!job || job.resumes.length === 0) return;
    
    // Filter candidates that have rank and score
    const rankedCandidates = [...job.resumes]
      .filter(r => r.rank !== null)
      .sort((a, b) => (a.rank || 999) - (b.rank || 999));

    if (rankedCandidates.length === 0) {
      alert("No ranked candidates available to export yet.");
      return;
    }

    let csvContent = "data:text/csv;charset=utf-8,";
    csvContent += "Rank,Candidate Filename,Score,Filter Decision,Filter Analysis,Scorer Evaluation,Ranker Justification\n";

    rankedCandidates.forEach(r => {
      const row = [
        r.rank,
        `"${r.filename.replace(/"/g, '""')}"`,
        r.score,
        r.relevant ? "Relevant" : "Irrelevant",
        `"${(r.filter_analysis || "").replace(/"/g, '""')}"`,
        `"${(r.scorer_analysis || "").replace(/"/g, '""')}"`,
        `"${(r.ranker_analysis || "").replace(/"/g, '""')}"`
      ];
      csvContent += row.join(",") + "\n";
    });

    const encodedUri = encodeURI(csvContent);
    const link = document.createElement("a");
    link.setAttribute("href", encodedUri);
    link.setAttribute("download", `talentsift_ranking_${jobId.slice(0,8)}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const getProgressPercent = (prog: StageProgress) => {
    if (prog.total === 0) return 0;
    return Math.round((prog.current / prog.total) * 100);
  };

  const getStageStatusText = (prog: StageProgress) => {
    if (prog.status === 'running') return `Processing (${prog.current}/${prog.total})`;
    if (prog.status === 'completed') return `Done (${prog.total}/${prog.total})`;
    if (prog.status === 'failed') return 'Failed';
    return 'Pending';
  };

  return (
    <div className="animate-fade-in" style={styles.container}>
      
      {/* Header bar */}
      <div className="flex-between" style={styles.header}>
        <div>
          <button onClick={onBackToDashboard} style={styles.backBtn}>
            ⬅️ Back to Dashboard
          </button>
          <h2 style={styles.title}>{job ? job.title : 'Pipeline Campaign'}</h2>
          <p style={styles.subtitle}>ID: {jobId}</p>
        </div>

        {job && (job.status === 'completed') && (
          <button onClick={handleExportCSV} className="btn btn-primary">
            📥 Export Rankings (CSV)
          </button>
        )}
      </div>

      {/* Main progress block */}
      <div className="card" style={styles.progressCard}>
        <div style={styles.stagesGrid}>
          
          {/* Stage 1: Filter */}
          <div style={styles.stageItem}>
            <div style={styles.stageHeader}>
              <div style={styles.stageNum}>1</div>
              <div>
                <h4 style={styles.stageTitle}>Filter Agent</h4>
                <span style={styles.stageStatusSub}>{getStageStatusText(filterProgress)}</span>
              </div>
            </div>
            <div style={styles.stageProgressBarBg}>
              <div style={{ ...styles.stageProgressBarFill, width: `${getProgressPercent(filterProgress)}%`, background: '#7c3aed' }}></div>
            </div>
          </div>

          {/* Stage 2: Scorer */}
          <div style={styles.stageItem}>
            <div style={styles.stageHeader}>
              <div style={styles.stageNum}>2</div>
              <div>
                <h4 style={styles.stageTitle}>Scorer Agent</h4>
                <span style={styles.stageStatusSub}>{getStageStatusText(scorerProgress)}</span>
              </div>
            </div>
            <div style={styles.stageProgressBarBg}>
              <div style={{ ...styles.stageProgressBarFill, width: `${getProgressPercent(scorerProgress)}%`, background: '#06b6d4' }}></div>
            </div>
          </div>

          {/* Stage 3: Ranker */}
          <div style={styles.stageItem}>
            <div style={styles.stageHeader}>
              <div style={styles.stageNum}>3</div>
              <div>
                <h4 style={styles.stageTitle}>Ranker Agent</h4>
                <span style={styles.stageStatusSub}>{getStageStatusText(rankerProgress)}</span>
              </div>
            </div>
            <div style={styles.stageProgressBarBg}>
              <div style={{ ...styles.stageProgressBarFill, width: `${getProgressPercent(rankerProgress)}%`, background: '#10b981' }}></div>
            </div>
          </div>

        </div>
      </div>

      {/* Logs / Console view */}
      <div className="card" style={styles.terminalCard}>
        <div style={styles.terminalHeader}>
          <div style={styles.terminalDotContainer}>
            <span style={{ ...styles.terminalDot, background: '#f43f5e' }}></span>
            <span style={{ ...styles.terminalDot, background: '#f59e0b' }}></span>
            <span style={{ ...styles.terminalDot, background: '#10b981' }}></span>
          </div>
          <span style={styles.terminalTitle}>Pipeline logs console</span>
          <span style={styles.stageBadge}>{currentStage.toUpperCase()}</span>
        </div>
        <div style={styles.terminalBody}>
          {logs.map((log, index) => (
            <div key={index} style={styles.terminalLine}>
              <span style={styles.terminalTime}>&gt;</span> {log}
            </div>
          ))}
          <div ref={logsEndRef} />
        </div>
      </div>

      {/* Tabs list */}
      <div style={styles.tabsContainer}>
        <button
          style={{ ...styles.tabBtn, ...(activeTab === 'filter' ? styles.tabBtnActive : {}) }}
          onClick={() => setActiveTab('filter')}
        >
          📂 Filter Stage ({job ? job.resumes.length : 0})
        </button>
        <button
          style={{ ...styles.tabBtn, ...(activeTab === 'scorer' ? styles.tabBtnActive : {}) }}
          onClick={() => setActiveTab('scorer')}
          disabled={!job || job.resumes.filter(r => r.score !== null).length === 0}
        >
          📊 Scorer Stage ({job ? job.resumes.filter(r => r.score !== null).length : 0})
        </button>
        <button
          style={{ ...styles.tabBtn, ...(activeTab === 'ranker' ? styles.tabBtnActive : {}) }}
          onClick={() => setActiveTab('ranker')}
          disabled={!job || job.resumes.filter(r => r.rank !== null).length === 0}
        >
          🏆 Ranker Stage ({job ? job.resumes.filter(r => r.rank !== null).length : 0})
        </button>
      </div>

      {/* Tab Contents */}
      {loading ? (
        <p>Loading result data...</p>
      ) : !job ? (
        <p>Error: Job not loaded.</p>
      ) : (
        <div style={styles.tabContent}>
          
          {/* Tab 1: Filter */}
          {activeTab === 'filter' && (
            <div style={styles.resumesGrid}>
              {job.resumes.map(res => (
                <div key={res.id} className="card" style={styles.resumeCard}>
                  <div style={styles.resumeCardHeader}>
                    <span style={styles.resumeIcon}>📄</span>
                    <span style={styles.resumeName}>{res.filename}</span>
                  </div>
                  
                  <div style={styles.cardStatusRow}>
                    {res.relevant === null ? (
                      <span className="badge badge-warning">Awaiting filter</span>
                    ) : res.relevant ? (
                      <span className="badge badge-success">Relevant</span>
                    ) : (
                      <span className="badge badge-danger">Filtered Out</span>
                    )}
                  </div>

                  {res.filter_analysis && (
                    <button
                      type="button"
                      className="btn btn-secondary"
                      style={styles.inspectBtn}
                      onClick={() => {
                        setSelectedResume(res);
                        setModalType('filter');
                      }}
                    >
                      💡 Read analysis
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}

          {/* Tab 2: Scorer */}
          {activeTab === 'scorer' && (
            <div style={styles.resumesGrid}>
              {[...job.resumes]
                .filter(r => r.score !== null)
                .sort((a, b) => (b.score || 0) - (a.score || 0))
                .map(res => (
                  <div key={res.id} className="card" style={styles.resumeCard}>
                    <div style={styles.resumeCardHeader}>
                      <span style={styles.resumeIcon}>📄</span>
                      <span style={styles.resumeName}>{res.filename}</span>
                    </div>

                    <div style={styles.scoreMetric}>
                      <span style={styles.scoreVal}>{res.score}</span>
                      <span style={styles.scoreTotal}>/100</span>
                    </div>

                    <div style={styles.scoreBarBg}>
                      <div style={{ ...styles.scoreBarFill, width: `${res.score}%` }}></div>
                    </div>

                    {res.scorer_analysis && (
                      <button
                        type="button"
                        className="btn btn-secondary"
                        style={styles.inspectBtn}
                        onClick={() => {
                          setSelectedResume(res);
                          setModalType('scorer');
                        }}
                      >
                        💡 View suitability report
                      </button>
                    )}
                  </div>
                ))}
            </div>
          )}

          {/* Tab 3: Ranker */}
          {activeTab === 'ranker' && (
            <div className="card" style={styles.rankTableCard}>
              <table style={styles.table}>
                <thead>
                  <tr>
                    <th style={{ ...styles.th, width: '80px', textAlign: 'center' }}>Rank</th>
                    <th style={styles.th}>Candidate Filename</th>
                    <th style={{ ...styles.th, width: '100px', textAlign: 'center' }}>Score</th>
                    <th style={styles.th}>Ranker Agent Analysis</th>
                  </tr>
                </thead>
                <tbody>
                  {[...job.resumes]
                    .filter(r => r.rank !== null)
                    .sort((a, b) => (a.rank || 999) - (b.rank || 999))
                    .map(res => (
                      <tr key={res.id} style={styles.tr}>
                        <td style={{ ...styles.td, textAlign: 'center' }}>
                          <span style={{
                            ...styles.rankBadge,
                            ...(res.rank === 1 ? styles.rank1 : res.rank === 2 ? styles.rank2 : res.rank === 3 ? styles.rank3 : styles.rankOther)
                          }}>
                            #{res.rank}
                          </span>
                        </td>
                        <td style={{ ...styles.td, fontWeight: 'bold' }}>{res.filename}</td>
                        <td style={{ ...styles.td, textAlign: 'center' }}>
                          <span style={styles.scoreTextBadge}>{res.score}/100</span>
                        </td>
                        <td style={styles.td}>
                          <div style={styles.rankerTextColumn}>
                            {res.ranker_analysis}
                            <button
                              type="button"
                              style={styles.viewFullComparisonBtn}
                              onClick={() => {
                                setSelectedResume(res);
                                setModalType('ranker');
                              }}
                            >
                              🔎 Read Scorer detail
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          )}

        </div>
      )}

      {/* Analysis Modals */}
      {selectedResume && modalType && (
        <div style={styles.modalOverlay} onClick={() => { setSelectedResume(null); setModalType(null); }}>
          <div style={styles.modalContent} onClick={(e) => e.stopPropagation()}>
            <div className="flex-between" style={styles.modalHeader}>
              <h3>
                {modalType === 'filter' ? 'Filter Relevancy analysis' :
                 modalType === 'scorer' ? 'Scorer Suitability analysis' : 'Ranker Comparison details'}
              </h3>
              <button style={styles.modalCloseBtn} onClick={() => { setSelectedResume(null); setModalType(null); }}>
                ❌
              </button>
            </div>
            <div style={styles.modalBody}>
              <div style={styles.modalResumeMeta}>
                <span style={{ fontWeight: 'bold', color: 'var(--text-primary)' }}>Candidate File:</span> {selectedResume.filename}
              </div>

              {modalType === 'filter' && (
                <div style={styles.modalSection}>
                  <div style={{ marginBottom: '1rem' }}>
                    <span style={{ marginRight: '0.5rem' }}>Status:</span>
                    {selectedResume.relevant ? (
                      <span className="badge badge-success">Relevant</span>
                    ) : (
                      <span className="badge badge-danger">Filtered Out</span>
                    )}
                  </div>
                  <div style={styles.modalText}>{selectedResume.filter_analysis}</div>
                </div>
              )}

              {modalType === 'scorer' && (
                <div style={styles.modalSection}>
                  <div style={{ marginBottom: '1rem', display: 'flex', alignItems: 'center', gap: '1rem' }}>
                    <span>Candidate Suitability Score:</span>
                    <span style={styles.modalScore}>{selectedResume.score}/100</span>
                  </div>
                  <div style={styles.modalText}>{selectedResume.scorer_analysis}</div>
                </div>
              )}

              {modalType === 'ranker' && (
                <div style={styles.modalSection}>
                  <div style={{ marginBottom: '1rem', display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                    <div>
                      <span>Assigned Rank:</span> <span style={styles.modalScore}>#{selectedResume.rank}</span>
                    </div>
                    <div>
                      <span>Score:</span> <span style={styles.modalScore}>{selectedResume.score}/100</span>
                    </div>
                  </div>
                  <h4 style={{ color: 'var(--text-primary)', marginBottom: '0.5rem' }}>Ranker Justification:</h4>
                  <div style={{ ...styles.modalText, marginBottom: '1.5rem' }}>{selectedResume.ranker_analysis}</div>
                  
                  <h4 style={{ color: 'var(--text-primary)', marginBottom: '0.5rem' }}>Scorer suitability report:</h4>
                  <div style={styles.modalText}>{selectedResume.scorer_analysis}</div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

    </div>
  );
};

const styles: Record<string, React.CSSProperties> = {
  container: {
    maxWidth: '1200px',
    margin: '0 auto',
  },
  header: {
    marginBottom: '2rem',
    borderBottom: '1px solid var(--border-color)',
    paddingBottom: '1.5rem',
  },
  backBtn: {
    background: 'none',
    border: 'none',
    color: 'var(--text-muted)',
    cursor: 'pointer',
    marginBottom: '0.5rem',
    display: 'block',
    fontSize: '0.9rem',
  },
  title: {
    fontSize: '1.75rem',
    color: 'var(--text-primary)',
  },
  subtitle: {
    fontSize: '0.8rem',
    color: 'var(--text-muted)',
  },
  progressCard: {
    marginBottom: '2rem',
    padding: '1.5rem 2rem',
  },
  stagesGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
    gap: '2.5rem',
  },
  stageItem: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.75rem',
  },
  stageHeader: {
    display: 'flex',
    alignItems: 'center',
    gap: '1rem',
  },
  stageNum: {
    width: '32px',
    height: '32px',
    borderRadius: '50%',
    background: 'rgba(255,255,255,0.05)',
    border: '1px solid var(--border-color)',
    color: 'var(--text-primary)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontWeight: 'bold',
    fontSize: '0.9rem',
  },
  stageTitle: {
    fontSize: '0.95rem',
    color: 'var(--text-primary)',
  },
  stageStatusSub: {
    fontSize: '0.75rem',
    color: 'var(--text-muted)',
  },
  stageProgressBarBg: {
    height: '6px',
    background: '#1e293b',
    borderRadius: '3px',
    overflow: 'hidden',
  },
  stageProgressBarFill: {
    height: '100%',
    transition: 'width 0.4s ease',
  },
  terminalCard: {
    background: '#04060a',
    border: '1px solid #111827',
    padding: '0',
    overflow: 'hidden',
    marginBottom: '2rem',
  },
  terminalHeader: {
    background: '#0c0f17',
    borderBottom: '1px solid #111827',
    padding: '0.65rem 1.25rem',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  terminalDotContainer: {
    display: 'flex',
    gap: '0.4rem',
  },
  terminalDot: {
    width: '10px',
    height: '10px',
    borderRadius: '50%',
    display: 'inline-block',
  },
  terminalTitle: {
    fontSize: '0.75rem',
    fontFamily: 'monospace',
    color: 'var(--text-muted)',
  },
  stageBadge: {
    fontSize: '0.7rem',
    fontWeight: 'bold',
    color: 'var(--color-secondary)',
    background: 'rgba(6, 182, 212, 0.1)',
    border: '1px solid rgba(6, 182, 212, 0.2)',
    padding: '0.15rem 0.4rem',
    borderRadius: '4px',
  },
  terminalBody: {
    padding: '1.25rem',
    maxHeight: '220px',
    overflowY: 'auto',
    fontFamily: 'monospace',
    fontSize: '0.85rem',
    color: '#e2e8f0',
    display: 'flex',
    flexDirection: 'column',
    gap: '0.4rem',
    background: 'rgba(0,0,0,0.4)',
  },
  terminalLine: {
    wordBreak: 'break-all',
  },
  terminalTime: {
    color: 'var(--color-primary-hover)',
    fontWeight: 'bold',
  },
  tabsContainer: {
    display: 'flex',
    gap: '0.5rem',
    borderBottom: '1px solid var(--border-color)',
    marginBottom: '1.5rem',
    paddingBottom: '1px',
  },
  tabBtn: {
    background: 'none',
    border: 'none',
    borderBottom: '2px solid transparent',
    padding: '0.75rem 1.25rem',
    color: 'var(--text-secondary)',
    cursor: 'pointer',
    fontWeight: 'bold',
    fontSize: '0.95rem',
    transition: 'var(--transition-fast)',
  },
  tabBtnActive: {
    color: 'var(--color-primary-hover)',
    borderBottomColor: 'var(--color-primary)',
  },
  tabContent: {
    marginBottom: '3rem',
  },
  resumesGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
    gap: '1.5rem',
  },
  resumeCard: {
    display: 'flex',
    flexDirection: 'column',
    justifyContent: 'space-between',
    gap: '1rem',
    minHeight: '180px',
  },
  resumeCardHeader: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: '0.5rem',
  },
  resumeIcon: {
    fontSize: '1.25rem',
  },
  resumeName: {
    fontWeight: '700',
    fontSize: '0.95rem',
    color: 'var(--text-primary)',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    display: '-webkit-box',
    WebkitLineClamp: 2,
    WebkitBoxOrient: 'vertical',
  },
  cardStatusRow: {
    margin: '0.25rem 0',
  },
  inspectBtn: {
    width: '100%',
    padding: '0.5rem',
    fontSize: '0.85rem',
    marginTop: 'auto',
  },
  scoreMetric: {
    display: 'flex',
    alignItems: 'baseline',
  },
  scoreVal: {
    fontSize: '2rem',
    fontWeight: '800',
    color: 'var(--color-secondary-hover)',
    lineHeight: 1,
  },
  scoreTotal: {
    fontSize: '0.85rem',
    color: 'var(--text-muted)',
    marginLeft: '0.15rem',
  },
  scoreBarBg: {
    height: '6px',
    background: '#1e293b',
    borderRadius: '3px',
    overflow: 'hidden',
    marginTop: '-0.25rem',
  },
  scoreBarFill: {
    height: '100%',
    background: 'linear-gradient(90deg, var(--color-primary) 0%, var(--color-secondary) 100%)',
  },
  rankTableCard: {
    padding: '0',
    overflow: 'hidden',
  },
  table: {
    width: '100%',
    borderCollapse: 'collapse',
    textAlign: 'left',
  },
  th: {
    padding: '1rem 1.5rem',
    background: 'rgba(255,255,255,0.01)',
    borderBottom: '1px solid var(--border-color)',
    color: 'var(--text-secondary)',
    fontWeight: 'bold',
    fontSize: '0.85rem',
    textTransform: 'uppercase',
  },
  tr: {
    borderBottom: '1px solid var(--border-color)',
    transition: 'var(--transition-fast)',
  },
  td: {
    padding: '1.25rem 1.5rem',
    fontSize: '0.95rem',
    color: 'var(--text-primary)',
    verticalAlign: 'top',
  },
  rankBadge: {
    display: 'inline-flex',
    width: '36px',
    height: '36px',
    borderRadius: '50%',
    alignItems: 'center',
    justifyContent: 'center',
    fontWeight: '800',
    fontSize: '1rem',
  },
  rank1: { background: 'rgba(245,158,11,0.15)', color: '#f59e0b', border: '1px solid rgba(245,158,11,0.3)' },
  rank2: { background: 'rgba(203,213,225,0.15)', color: '#cbd5e1', border: '1px solid rgba(203,213,225,0.3)' },
  rank3: { background: 'rgba(180,83,9,0.15)', color: '#b45309', border: '1px solid rgba(180,83,9,0.3)' },
  rankOther: { background: 'rgba(255,255,255,0.05)', color: 'var(--text-muted)', border: '1px solid var(--border-color)' },
  scoreTextBadge: {
    color: 'var(--color-secondary)',
    fontWeight: '700',
    background: 'rgba(6, 182, 212, 0.1)',
    padding: '0.25rem 0.5rem',
    borderRadius: '6px',
    border: '1px solid rgba(6, 182, 212, 0.2)',
  },
  rankerTextColumn: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.5rem',
    color: 'var(--text-secondary)',
    lineHeight: 1.4,
  },
  viewFullComparisonBtn: {
    background: 'none',
    border: 'none',
    color: 'var(--color-primary-hover)',
    fontWeight: 'bold',
    cursor: 'pointer',
    fontSize: '0.85rem',
    alignSelf: 'flex-start',
    padding: '0',
    textDecoration: 'underline',
  },
  modalOverlay: {
    position: 'fixed',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    background: 'rgba(4, 6, 10, 0.85)',
    backdropFilter: 'blur(8px)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 1000,
    padding: '1.5rem',
  },
  modalContent: {
    background: 'var(--bg-secondary)',
    border: '1px solid var(--border-color)',
    borderRadius: '20px',
    width: '100%',
    maxWidth: '650px',
    boxShadow: '0 25px 50px -12px rgba(0, 0, 0, 0.5)',
    display: 'flex',
    flexDirection: 'column',
    maxHeight: '90vh',
  },
  modalHeader: {
    padding: '1.5rem 2rem',
    borderBottom: '1px solid var(--border-color)',
  },
  modalCloseBtn: {
    background: 'none',
    border: 'none',
    cursor: 'pointer',
    fontSize: '1.1rem',
  },
  modalBody: {
    padding: '2rem',
    overflowY: 'auto',
  },
  modalResumeMeta: {
    background: 'rgba(255,255,255,0.02)',
    padding: '0.75rem 1rem',
    borderRadius: '10px',
    border: '1px solid var(--border-color)',
    marginBottom: '1.5rem',
    fontSize: '0.9rem',
    color: 'var(--text-secondary)',
  },
  modalSection: {
    display: 'flex',
    flexDirection: 'column',
  },
  modalScore: {
    fontWeight: '800',
    fontSize: '1.25rem',
    color: 'var(--color-secondary-hover)',
  },
  modalText: {
    lineHeight: 1.6,
    color: 'var(--text-secondary)',
    fontSize: '0.98rem',
    whiteSpace: 'pre-wrap',
  },
};
