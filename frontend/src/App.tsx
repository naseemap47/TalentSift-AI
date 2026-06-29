import React, { useState, useEffect } from 'react';
import { Auth } from './components/Auth';
import { Dashboard } from './components/Dashboard';
import { JobView } from './components/JobView';

interface UserProfile {
  id: number;
  email: string;
  full_name: string | null;
}

function App() {
  const [isAuthenticated, setIsAuthenticated] = useState<boolean>(false);
  const [user, setUser] = useState<UserProfile | null>(null);
  const [view, setView] = useState<'dashboard' | 'job-view'>('dashboard');
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(true);

  const baseUrl = import.meta.env.VITE_API_BASE_URL || 'http://localhost:8000';

  const checkAuth = async () => {
    const token = localStorage.getItem('talentsift_token');
    if (!token) {
      setIsAuthenticated(false);
      setUser(null);
      setLoading(false);
      return;
    }

    try {
      const response = await fetch(`${baseUrl}/api/auth/me`, {
        headers: {
          'Authorization': `Bearer ${token}`
        }
      });
      if (response.ok) {
        const data = await response.json();
        setUser(data);
        setIsAuthenticated(true);
      } else {
        // Token expired or invalid
        localStorage.removeItem('talentsift_token');
        setIsAuthenticated(false);
        setUser(null);
      }
    } catch (err) {
      console.error("Auth check failed:", err);
      // In case of network error, keep token but set loading false
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    checkAuth();
  }, []);

  const handleAuthSuccess = () => {
    setIsAuthenticated(true);
    checkAuth();
    setView('dashboard');
    setSelectedJobId(null);
  };

  const handleLogout = () => {
    localStorage.removeItem('talentsift_token');
    setIsAuthenticated(false);
    setUser(null);
    setView('dashboard');
    setSelectedJobId(null);
  };

  const handleStartJob = (jobId: string) => {
    setSelectedJobId(jobId);
    setView('job-view');
  };

  const handleViewJob = (jobId: string) => {
    setSelectedJobId(jobId);
    setView('job-view');
  };

  const handleBackToDashboard = () => {
    setSelectedJobId(null);
    setView('dashboard');
  };

  if (loading) {
    return (
      <div style={styles.loadingContainer}>
        <div style={styles.spinner}></div>
        <p style={{ marginTop: '1rem', color: 'var(--text-secondary)' }}>Verifying HR session...</p>
      </div>
    );
  }

  return (
    <div>
      {/* Top Navbar for authenticated users */}
      {isAuthenticated && (
        <nav className="navbar">
          <div className="nav-container">
            <div className="logo" style={{ cursor: 'pointer' }} onClick={handleBackToDashboard}>
              <span>🔍</span> TalentSift-AI
            </div>
            
            {user && (
              <div style={styles.userInfo}>
                <span style={styles.userIcon}>👤</span>
                <div style={styles.userDetails}>
                  <div style={styles.userName}>{user.full_name || 'HR Recruiter'}</div>
                  <div style={styles.userEmail}>{user.email}</div>
                </div>
              </div>
            )}
          </div>
        </nav>
      )}

      {/* Main Content Area */}
      <div className="container">
        {!isAuthenticated ? (
          <Auth onAuthSuccess={handleAuthSuccess} />
        ) : view === 'dashboard' ? (
          <Dashboard
            onStartJob={handleStartJob}
            onViewJob={handleViewJob}
            onLogout={handleLogout}
          />
        ) : (
          selectedJobId && (
            <JobView
              jobId={selectedJobId}
              onBackToDashboard={handleBackToDashboard}
            />
          )
        )}
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  loadingContainer: {
    display: 'flex',
    flexDirection: 'column',
    justifyContent: 'center',
    alignItems: 'center',
    minHeight: '100vh',
    background: 'var(--bg-primary)',
  },
  spinner: {
    width: '40px',
    height: '40px',
    border: '4px solid rgba(255, 255, 255, 0.05)',
    borderTop: '4px solid var(--color-primary)',
    borderRadius: '50%',
    animation: 'spin 1s linear infinite',
  },
  userInfo: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.75rem',
    background: 'rgba(255,255,255,0.03)',
    border: '1px solid var(--border-color)',
    padding: '0.4rem 0.85rem',
    borderRadius: '10px',
  },
  userIcon: {
    fontSize: '1.25rem',
  },
  userDetails: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'flex-start',
  },
  userName: {
    fontWeight: 'bold',
    fontSize: '0.85rem',
    color: 'var(--text-primary)',
    lineHeight: 1.2,
  },
  userEmail: {
    fontSize: '0.75rem',
    color: 'var(--text-muted)',
    lineHeight: 1.2,
  },
};

// Add standard keyframe for spinning to head dynamically if needed, 
// but since we are overriding index.css, we added fade animations there.
// We can also inject simple CSS for loader spin.
if (typeof document !== 'undefined') {
  const styleEl = document.createElement('style');
  styleEl.textContent = `
    @keyframes spin {
      0% { transform: rotate(0deg); }
      100% { transform: rotate(360deg); }
    }
  `;
  document.head.appendChild(styleEl);
}

export default App;
