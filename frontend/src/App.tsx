import { useState, useEffect, useRef } from 'react';
import './App.css';

// Interfaces
interface Candidate {
  id: string;
  candidateName: string;
  candidateType: 'intern' | 'employee';
  status: 'uploaded' | 'processing' | 'completed' | 'failed';
  overallScore: number | null;
  dominantEmotion: string | null;
  mbtiType: string | null;
}

interface InterviewDetail extends Candidate {
  videoUrl: string;
  videoWebUrl?: string;
  audioUrl: string | null;
  durationSeconds: number | null;
  summary: {
    dominantEmotion: string;
    emotionStabilityScore: number;
    avgPitchHz: number;
    pitchVariation: number;
    speakingRateWpm: number;
    fillerCount: number;
    fillerPercentage: number;
    mbtiType: string;
    overallScore: number;
    recommendations: string[];
    executiveSummary?: string;
  } | null;
  mbti: {
    predictedType: string;
    eScore: number;
    iScore: number;
    sScore: number;
    nScore: number;
    tScore: number;
    fScore: number;
    jScore: number;
    pScore: number;
    confidence: number;
    reasoning: {
      E_I: string;
      S_N: string;
      T_F: string;
      J_P: string;
    };
  } | null;
}

interface ExpressionData {
  id: string;
  timestampSec: number;
  emotion: string;
  confidence: number;
}

interface VoiceData {
  id: string;
  timestampSec: number;
  pitchHz: number | null;
  intensityDb: number | null;
  jitter: number | null;
  shimmer: number | null;
  hnr: number | null;
  audioEmotion: string | null;
}

interface TranscriptSegment {
  id: string;
  startTime: number;
  endTime: number;
  text: string;
  isFiller: boolean;
  fillerType: string | null;
  speaker?: 'interviewer' | 'candidate';
  speechAct?: 'question' | 'answer' | 'statement';
}

const API_BASE_URL = 'http://localhost:3001';

export default function App() {
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<InterviewDetail | null>(null);
  
  // Multimodal Data States
  const [expressions, setExpressions] = useState<ExpressionData[]>([]);
  const [voices, setVoices] = useState<VoiceData[]>([]);
  const [transcripts, setTranscripts] = useState<TranscriptSegment[]>([]);
  
  // UI Tabs & Form States
  const [activeTab, setActiveTab] = useState<'expressions' | 'voice' | 'transcript'>('transcript');
  const [isUploading, setIsUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState('');
  
  // Form values
  const [name, setName] = useState('');
  const [type, setType] = useState<'intern' | 'employee'>('intern');
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  
  const fileInputRef = useRef<HTMLInputElement>(null);
  const pollingIntervalRef = useRef<any>(null);
  const videoRef = useRef<HTMLVideoElement>(null);

  const handleSeek = (time: number) => {
    if (videoRef.current) {
      videoRef.current.currentTime = time;
      videoRef.current.play().catch(() => {});
    }
  };

  // 1. Fetch Candidates List
  const fetchCandidates = async () => {
    try {
      const res = await fetch(`${API_BASE_URL}/api/interviews`);
      if (res.ok) {
        const data = await res.json();
        setCandidates(data);
      }
    } catch (e) {
      console.error('Error fetching candidates:', e);
    }
  };

  useEffect(() => {
    fetchCandidates();
    return () => {
      if (pollingIntervalRef.current) clearInterval(pollingIntervalRef.current);
    };
  }, []);

  // 2. Fetch Selected Candidate Detail & Multimodal data
  const fetchCandidateDetail = async (id: string) => {
    try {
      const res = await fetch(`${API_BASE_URL}/api/interviews/${id}`);
      if (!res.ok) return;
      const data = await res.json();
      setDetail(data);

      // If status is completed, fetch timeline detail datasets
      if (data.status === 'completed') {
        const [exprRes, voiceRes, transRes] = await Promise.all([
          fetch(`${API_BASE_URL}/api/interviews/${id}/expressions`).then(r => r.json()),
          fetch(`${API_BASE_URL}/api/interviews/${id}/voice`).then(r => r.json()),
          fetch(`${API_BASE_URL}/api/interviews/${id}/transcript`).then(r => r.json())
        ]);
        setExpressions(exprRes);
        setVoices(voiceRes);
        setTranscripts(transRes);
      } else {
        setExpressions([]);
        setVoices([]);
        setTranscripts([]);
      }
    } catch (e) {
      console.error('Error fetching candidate detail:', e);
    }
  };

  useEffect(() => {
    if (selectedId) {
      fetchCandidateDetail(selectedId);
      
      // Setup status polling if candidate is in processing or uploaded state
      const currentCand = candidates.find(c => c.id === selectedId);
      if (currentCand && (currentCand.status === 'processing' || currentCand.status === 'uploaded')) {
        if (pollingIntervalRef.current) clearInterval(pollingIntervalRef.current);
        
        pollingIntervalRef.current = setInterval(() => {
          fetchCandidateDetail(selectedId);
          fetchCandidates();
          
          // Stop polling if status changes
          const updatedCand = candidates.find(c => c.id === selectedId);
          if (updatedCand && (updatedCand.status === 'completed' || updatedCand.status === 'failed')) {
            if (pollingIntervalRef.current) clearInterval(pollingIntervalRef.current);
          }
        }, 2000);
      } else {
        if (pollingIntervalRef.current) {
          clearInterval(pollingIntervalRef.current);
          pollingIntervalRef.current = null;
        }
      }
    }
  }, [selectedId, candidates]);

  // 3. Handle File Upload
  const handleUploadSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name || !selectedFile) return;

    setIsUploading(true);
    setUploadProgress('Mengunggah video kandidat...');

    const formData = new FormData();
    formData.append('candidateName', name);
    formData.append('candidateType', type);
    formData.append('video', selectedFile);

    try {
      const res = await fetch(`${API_BASE_URL}/api/interviews/upload`, {
        method: 'POST',
        body: formData
      });

      if (!res.ok) {
        throw new Error('Gagal mengunggah video ke server');
      }

      const result = await res.json();
      console.log('Upload success:', result);
      
      setName('');
      setSelectedFile(null);
      if (fileInputRef.current) fileInputRef.current.value = '';

      setUploadProgress('Selesai! Pipeline analisis sedang berjalan di background...');
      await fetchCandidates();
      setSelectedId(result.interviewId); // Auto-select the newly uploaded candidate
    } catch (err: any) {
      console.error(err);
      setUploadProgress(`Gagal: ${err.message}`);
    } finally {
      setTimeout(() => {
        setIsUploading(false);
        setUploadProgress('');
      }, 3000);
    }
  };

  // Helper formatting duration
  const formatDuration = (sec: number | null) => {
    if (!sec) return '--:--';
    const min = Math.floor(sec / 60);
    const s = Math.round(sec % 60);
    return `${min}:${s < 10 ? '0' : ''}${s}`;
  };

  // Helper to color overall scores
  const getScoreColorClass = (score: number) => {
    if (score >= 80) return 'text-[#34d399]';
    if (score >= 60) return 'text-[#fbbf24]';
    return 'text-[#f87171]';
  };

  return (
    <div className="app-container">
      {/* Header Bar */}
      <header className="header">
        <div className="logo-section">
          <div className="logo-icon">🎬</div>
          <div className="logo-text">Multimodal Interview Analyzer</div>
        </div>
        <div className="status-indicator">
          <span className="status-dot completed"></span>
          <span style={{ fontSize: '13px', fontWeight: 600 }}>PostgreSQL Connected</span>
        </div>
      </header>

      {/* Main Grid Layout */}
      <main className="main-content">
        
        {/* Left Sidebar (Candidates & Upload Button) */}
        <aside className="sidebar">
          {/* Candidates List Section */}
          <div>
            <h3 className="section-title">Kandidat Terdaftar</h3>
            <div className="candidate-list">
              {candidates.length === 0 ? (
                <div style={{ color: 'var(--text-muted)', fontSize: '13px', textAlign: 'center', padding: '15px' }}>
                  Belum ada kandidat. Silakan upload di panel kanan.
                </div>
              ) : (
                candidates.map((cand) => (
                  <button
                    key={cand.id}
                    className={`candidate-item ${selectedId === cand.id ? 'active' : ''}`}
                    onClick={() => setSelectedId(cand.id)}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', width: '100%' }}>
                      <span className="candidate-name">{cand.candidateName}</span>
                      <span className={`badge ${cand.candidateType === 'intern' ? 'badge-intern' : 'badge-employee'}`}>
                        {cand.candidateType === 'intern' ? 'Magang' : 'Karyawan'}
                      </span>
                    </div>
                    <div className="candidate-meta">
                      <div className="status-indicator">
                        <span className={`status-dot ${cand.status}`}></span>
                        <span style={{ textTransform: 'capitalize' }}>
                          {cand.status === 'completed' ? 'Completed' : cand.status === 'processing' ? 'Processing' : cand.status === 'failed' ? 'Failed' : 'Uploaded'}
                        </span>
                      </div>
                      {cand.status === 'completed' && cand.overallScore !== null && (
                        <span style={{ fontWeight: 700, color: cand.overallScore >= 70 ? 'var(--success)' : 'var(--warning)' }}>
                          {cand.overallScore} / 100
                        </span>
                      )}
                    </div>
                  </button>
                ))
              )}
            </div>
          </div>
          
          {/* Quick upload triggers or metadata */}
          <div style={{ marginTop: 'auto', borderTop: '1px solid var(--border-color)', paddingTop: '15px' }}>
            <p style={{ fontSize: '11px', color: 'var(--text-muted)', lineHeight: '1.4' }}>
              Didukung oleh ElysiaJS Bun backend, Drizzle ORM, dan Python FastAPI AI Core.
            </p>
          </div>
        </aside>

        {/* Right Main Panel */}
        <section className="detail-pane">
          {!selectedId ? (
            /* Upload Screen (Default Empty State) */
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 400px', gap: '30px', alignItems: 'start' }}>
              <div className="glass upload-card">
                <h2 style={{ fontFamily: 'var(--font-heading)', fontSize: '24px', fontWeight: 700, color: '#fff' }}>
                  Unggah Video Interview Baru
                </h2>
                <p style={{ color: 'var(--text-secondary)', fontSize: '14px', marginBottom: '10px' }}>
                  Sistem akan secara otomatis mengekstrak visual wajah, pitch audio, dan transkrip dialog untuk menilai profil soft-skills kandidat.
                </p>
                
                <form onSubmit={handleUploadSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '15px' }}>
                  <div className="upload-grid">
                    <div className="form-group">
                      <label>Nama Lengkap Kandidat</label>
                      <input 
                        type="text" 
                        placeholder="Contoh: Rian Sukmawan" 
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                        required
                      />
                    </div>
                    <div className="form-group">
                      <label>Kategori Rekrutmen</label>
                      <select 
                        value={type} 
                        onChange={(e) => setType(e.target.value as 'intern' | 'employee')}
                      >
                        <option value="intern">Anak Magang (Intern)</option>
                        <option value="employee">Karyawan Tetap/Kontrak</option>
                      </select>
                    </div>
                  </div>

                  <div 
                    className="dropzone"
                    onClick={() => fileInputRef.current?.click()}
                  >
                    <span style={{ fontSize: '32px' }}>📁</span>
                    <p style={{ fontWeight: 600, fontSize: '14px', color: '#fff' }}>
                      {selectedFile ? selectedFile.name : 'Pilih atau drop file video interview'}
                    </p>
                    <p style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>
                      Mendukung format .mp4, .webm hingga 150MB
                    </p>
                    <input 
                      type="file" 
                      ref={fileInputRef}
                      style={{ display: 'none' }}
                      accept="video/*"
                      onChange={(e) => setSelectedFile(e.target.files?.[0] || null)}
                      required
                    />
                  </div>

                  <button 
                    type="submit" 
                    className="btn"
                    disabled={isUploading || !name || !selectedFile}
                  >
                    {isUploading ? 'Menyimpan & Memproses...' : '🚀 Mulai Analisis Multimodal'}
                  </button>
                  
                  {uploadProgress && (
                    <div style={{ 
                      fontSize: '13px', 
                      color: uploadProgress.includes('Gagal') ? 'var(--danger)' : 'var(--primary)',
                      textAlign: 'center',
                      fontWeight: 500,
                      padding: '8px',
                      background: 'rgba(255,255,255,0.02)',
                      borderRadius: '8px'
                    }}>
                      {uploadProgress}
                    </div>
                  )}
                </form>
              </div>

              <div className="glass" style={{ padding: '24px', display: 'flex', flexDirection: 'column', gap: '15px' }}>
                <h3 className="section-title">Fitur Penilaian AI</h3>
                <ul style={{ listStyle: 'none', display: 'flex', flexDirection: 'column', gap: '15px', fontSize: '13.5px', color: 'var(--text-secondary)' }}>
                  <li style={{ display: 'flex', gap: '10px' }}>
                    <span style={{ color: 'var(--secondary)' }}>✓</span>
                    <div>
                      <strong style={{ color: '#fff' }}>Facial Expression (FER)</strong>
                      <p>Mendeteksi 7 emosi wajah dasar secara frame-by-frame.</p>
                    </div>
                  </li>
                  <li style={{ display: 'flex', gap: '10px' }}>
                    <span style={{ color: 'var(--secondary)' }}>✓</span>
                    <div>
                      <strong style={{ color: '#fff' }}>Voice Quality Analysis</strong>
                      <p>Menganalisis pitch, intensitas vokal, jitter, shimmer, dan HNR.</p>
                    </div>
                  </li>
                  <li style={{ display: 'flex', gap: '10px' }}>
                    <span style={{ color: 'var(--secondary)' }}>✓</span>
                    <div>
                      <strong style={{ color: '#fff' }}>Whisper Transcript & Filler words</strong>
                      <p>Mendeteksi filler words (seperti "ehm", "anu", "uh") serta menghitung WPM.</p>
                    </div>
                  </li>
                  <li style={{ display: 'flex', gap: '10px' }}>
                    <span style={{ color: 'var(--secondary)' }}>✓</span>
                    <div>
                      <strong style={{ color: '#fff' }}>Estimasi MBTI</strong>
                      <p>Prediksi kepribadian MBTI logis berdasarkan kombinasi sinyal multimodal.</p>
                    </div>
                  </li>
                </ul>
              </div>
            </div>
          ) : detail ? (
            /* Selected Candidate Analysis Screen */
            <>
              {/* Header Profile */}
              <div className="glass candidate-header-card">
                <div className="candidate-header-left">
                  <span className="candidate-header-name">{detail.candidateName}</span>
                  <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
                    <span className={`badge ${detail.candidateType === 'intern' ? 'badge-intern' : 'badge-employee'}`}>
                      {detail.candidateType === 'intern' ? 'Magang' : 'Karyawan'}
                    </span>
                    <span style={{ color: 'var(--text-secondary)', fontSize: '13px' }}>
                      Status: <strong style={{ textTransform: 'capitalize', color: '#fff' }}>{detail.status}</strong>
                    </span>
                    {detail.durationSeconds && (
                      <span style={{ color: 'var(--text-secondary)', fontSize: '13px' }}>
                        Durasi: <strong style={{ color: '#fff' }}>{formatDuration(detail.durationSeconds)}</strong>
                      </span>
                    )}
                  </div>
                </div>

                          <div style={{ display: 'flex', gap: '12px' }}>
                  <button 
                    className="btn" 
                    style={{ background: 'rgba(59, 130, 246, 0.1)', border: '1px solid rgba(59, 130, 246, 0.3)', color: '#3b82f6', boxShadow: 'none' }}
                    onClick={() => window.print()}
                  >
                    🖨️ Cetak PDF
                  </button>
                  <button 
                    className="btn" 
                    style={{ background: 'rgba(239, 68, 68, 0.1)', border: '1px solid rgba(239, 68, 68, 0.3)', color: '#ef4444', boxShadow: 'none' }}
                    onClick={async () => {
                      if (confirm('Hapus analisis kandidat ini?')) {
                        await fetch(`${API_BASE_URL}/api/interviews/${detail.id}`, { method: 'DELETE' });
                        setSelectedId(null);
                        setDetail(null);
                        fetchCandidates();
                      }
                    }}
                  >
                    🗑 Hapus
                  </button>
                  <button 
                    className="btn" 
                    style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid var(--border-color)', color: '#fff', boxShadow: 'none' }}
                    onClick={() => {
                      setSelectedId(null);
                      setDetail(null);
                    }}
                  >
                    + Tambah Baru
                  </button>
                </div>
              </div>

              {detail.status === 'processing' || detail.status === 'uploaded' ? (
                /* Processing State Screen */
                <div className="glass" style={{ padding: '60px 30px', textAlign: 'center', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '20px' }}>
                  <div style={{ 
                    width: '60px', 
                    height: '60px', 
                    border: '4px solid var(--primary-glow)', 
                    borderTopColor: 'var(--primary)', 
                    borderRadius: '50%',
                    animation: 'spin 1s linear infinite'
                  }} />
                  <h3 style={{ fontFamily: 'var(--font-heading)', fontSize: '20px', fontWeight: 700 }}>
                    Sedang Memproses Analisis...
                  </h3>
                  <p style={{ color: 'var(--text-secondary)', fontSize: '14px', maxWidth: '450px', lineHeight: '1.5' }}>
                    Model AI kami (DeepFace, Whisper, Praat, MBTI engine) sedang mengekstrak, menilai, dan menyusun data multimodal Anda. Halaman ini akan otomatis terupdate.
                  </p>
                  
                  <style>{`
                    @keyframes spin {
                      0% { transform: rotate(0deg); }
                      100% { transform: rotate(360deg); }
                    }
                  `}</style>
                </div>
              ) : detail.status === 'failed' ? (
                /* Failed State Screen */
                <div className="glass" style={{ padding: '40px', textAlign: 'center', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '15px' }}>
                  <span style={{ fontSize: '48px' }}>❌</span>
                  <h3 style={{ color: 'var(--danger)', fontSize: '20px', fontWeight: 700 }}>
                    Analisis Gagal Diproses
                  </h3>
                  <p style={{ color: 'var(--text-secondary)', fontSize: '14px' }}>
                    Terjadi kesalahan dalam pipeline komputasi AI. Pastikan format video sesuai dan server FastAPI AI terhubung dengan benar.
                  </p>
                </div>
              ) : (
                /* Completed State Full Dashboard Display */
                <>
                  {/* Video Player & Executive Summary Section */}
                  <div style={{ display: 'grid', gridTemplateColumns: '1.2fr 1fr', gap: '20px' }}>
                    {/* Interactive Video Player */}
                    {detail.videoWebUrl && (
                      <div className="glass" style={{ padding: '16px', borderRadius: '12px', display: 'flex', flexDirection: 'column', gap: '10px' }}>
                        <h3 className="section-title" style={{ color: '#fff', fontSize: '15px', marginBottom: 0 }}>Video Wawancara</h3>
                        <video 
                          ref={videoRef}
                          src={detail.videoWebUrl}
                          controls
                          style={{ width: '100%', borderRadius: '8px', border: '1px solid var(--border-color)', maxHeight: '320px', background: '#000' }}
                        />
                      </div>
                    )}
                    
                    {/* Executive Summary Card */}
                    <div className="glass" style={{ padding: '20px', borderRadius: '12px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
                      <h3 className="section-title" style={{ color: '#fff', fontSize: '15px', marginBottom: 0 }}>Executive Summary</h3>
                      <p style={{ fontSize: '14px', lineHeight: '1.6', color: '#f3f4f6', margin: 0 }}>
                        {detail.summary?.executiveSummary || "Rangkuman analisis belum dihasilkan untuk kandidat ini."}
                      </p>
                    </div>
                  </div>

                  {/* Summary Metric Cards */}
                  <div className="metrics-row">
                    <div className="glass metric-card overall-score-glow">
                      <span className="metric-label">Overall Score</span>
                      <span className={`metric-value ${getScoreColorClass(detail.summary?.overallScore || 0)}`}>
                        {detail.summary?.overallScore || 0} <span style={{ fontSize: '14px', color: 'var(--text-muted)' }}>/ 100</span>
                      </span>
                    </div>
                    <div className="glass metric-card">
                      <span className="metric-label">Speaking Rate</span>
                      <span className="metric-value">
                        {detail.summary?.speakingRateWpm || 0} <span style={{ fontSize: '14px', color: 'var(--text-secondary)' }}>WPM</span>
                      </span>
                      <span style={{ 
                        fontSize: '11px', 
                        color: (detail.summary?.speakingRateWpm || 0) >= 120 && (detail.summary?.speakingRateWpm || 0) <= 150 ? 'var(--success)' : 'var(--warning)',
                        fontWeight: 600
                      }}>
                        {(detail.summary?.speakingRateWpm || 0) >= 120 && (detail.summary?.speakingRateWpm || 0) <= 150 ? '● Tempo Bicara Ideal' : '● Tempo Non-Ideal'}
                      </span>
                    </div>
                    <div className="glass metric-card">
                      <span className="metric-label">Filler Words</span>
                      <span className="metric-value" style={{ color: (detail.summary?.fillerPercentage || 0) > 10 ? 'var(--danger)' : 'var(--success)' }}>
                        {detail.summary?.fillerPercentage || 0}%
                      </span>
                      <span style={{ fontSize: '11px', color: 'var(--text-secondary)' }}>
                        Total: {detail.summary?.fillerCount || 0} filler words
                      </span>
                    </div>
                    <div className="glass metric-card">
                      <span className="metric-label">Dominant Emotion</span>
                      <span className="metric-value" style={{ textTransform: 'capitalize', color: 'var(--secondary)' }}>
                        {detail.summary?.dominantEmotion || 'Neutral'}
                      </span>
                      <span style={{ fontSize: '11px', color: 'var(--text-secondary)' }}>
                        Stabilitas: {detail.summary?.emotionStabilityScore || 100}%
                      </span>
                    </div>
                  </div>

                  {/* MBTI Grid Display */}
                  <div className="mbti-grid">
                    
                    {/* Dynamic Bar sliders */}
                    <div className="glass mbti-bars-card">
                      <h3 className="section-title" style={{ color: '#fff', fontSize: '15px' }}>Profil Dimensi MBTI</h3>
                      
                      {/* E vs I */}
                      <div className="mbti-bar-row">
                        <span className="mbti-dimension-label left" style={{ color: (detail.mbti?.eScore || 0) > 0.5 ? 'var(--secondary)' : 'var(--text-muted)' }}>E</span>
                        <div className="mbti-progress-container">
                          <div 
                            className="mbti-progress-bar" 
                            style={{ 
                              width: `${(detail.mbti?.eScore || 0) * 100}%`,
                              background: 'linear-gradient(90deg, var(--secondary), var(--primary))'
                            }} 
                          />
                        </div>
                        <span className="mbti-dimension-label right" style={{ color: (detail.mbti?.iScore || 0) > 0.5 ? 'var(--primary)' : 'var(--text-muted)' }}>I</span>
                      </div>

                      {/* S vs N */}
                      <div className="mbti-bar-row">
                        <span className="mbti-dimension-label left" style={{ color: (detail.mbti?.sScore || 0) > 0.5 ? 'var(--secondary)' : 'var(--text-muted)' }}>S</span>
                        <div className="mbti-progress-container">
                          <div 
                            className="mbti-progress-bar" 
                            style={{ 
                              width: `${(detail.mbti?.sScore || 0) * 100}%`,
                              background: 'linear-gradient(90deg, var(--secondary), var(--primary))'
                            }} 
                          />
                        </div>
                        <span className="mbti-dimension-label right" style={{ color: (detail.mbti?.nScore || 0) > 0.5 ? 'var(--primary)' : 'var(--text-muted)' }}>N</span>
                      </div>

                      {/* T vs F */}
                      <div className="mbti-bar-row">
                        <span className="mbti-dimension-label left" style={{ color: (detail.mbti?.tScore || 0) > 0.5 ? 'var(--secondary)' : 'var(--text-muted)' }}>T</span>
                        <div className="mbti-progress-container">
                          <div 
                            className="mbti-progress-bar" 
                            style={{ 
                              width: `${(detail.mbti?.tScore || 0) * 100}%`,
                              background: 'linear-gradient(90deg, var(--secondary), var(--primary))'
                            }} 
                          />
                        </div>
                        <span className="mbti-dimension-label right" style={{ color: (detail.mbti?.fScore || 0) > 0.5 ? 'var(--primary)' : 'var(--text-muted)' }}>F</span>
                      </div>

                      {/* J vs P */}
                      <div className="mbti-bar-row">
                        <span className="mbti-dimension-label left" style={{ color: (detail.mbti?.jScore || 0) > 0.5 ? 'var(--secondary)' : 'var(--text-muted)' }}>J</span>
                        <div className="mbti-progress-container">
                          <div 
                            className="mbti-progress-bar" 
                            style={{ 
                              width: `${(detail.mbti?.jScore || 0) * 100}%`,
                              background: 'linear-gradient(90deg, var(--secondary), var(--primary))'
                            }} 
                          />
                        </div>
                        <span className="mbti-dimension-label right" style={{ color: (detail.mbti?.pScore || 0) > 0.5 ? 'var(--primary)' : 'var(--text-muted)' }}>P</span>
                      </div>
                    </div>

                    {/* Predicted Profile & Reasoning */}
                    <div className="glass mbti-predicted-card">
                      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                        <span style={{ fontSize: '11px', textTransform: 'uppercase', letterSpacing: '2px', color: 'var(--text-secondary)', fontWeight: 600 }}>
                          Kepribadian (Estimasi AI)
                        </span>
                        <span className="mbti-large-type">{detail.mbti?.predictedType || 'ENFJ'}</span>
                        <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
                          Confidence Level: {detail.mbti ? Math.round(detail.mbti.confidence * 100) : 0}%
                        </span>
                      </div>
                      
                      {detail.mbti?.reasoning && (
                        <div style={{ marginTop: '10px' }}>
                          <p className="mbti-reasoning-item">
                            💡 {detail.mbti.reasoning.E_I}
                          </p>
                          <p className="mbti-reasoning-item" style={{ borderLeftColor: 'var(--secondary)' }}>
                            🧠 {detail.mbti.reasoning.T_F}
                          </p>
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Multimodal Timeline view */}
                  <div className="glass timeline-card">
                    <div className="timeline-tabs">
                      <button 
                        className={`tab-btn ${activeTab === 'transcript' ? 'active' : ''}`}
                        onClick={() => setActiveTab('transcript')}
                      >
                        📝 Transkrip & Deteksi Filler
                      </button>
                      <button 
                        className={`tab-btn ${activeTab === 'expressions' ? 'active' : ''}`}
                        onClick={() => setActiveTab('expressions')}
                      >
                        🎭 Deteksi Ekspresi Wajah
                      </button>
                      <button 
                        className={`tab-btn ${activeTab === 'voice' ? 'active' : ''}`}
                        onClick={() => setActiveTab('voice')}
                      >
                        🔊 Level Pitch & Intensitas
                      </button>
                    </div>

                    <div className="timeline-content-pane">
                      {activeTab === 'transcript' && (
                        <div className="transcript-chat-timeline" style={{
                          display: 'flex',
                          flexDirection: 'column',
                          gap: '16px',
                          padding: '10px 0',
                          maxHeight: '600px',
                          overflowY: 'auto'
                        }}>
                          {transcripts.length === 0 ? (
                            <p style={{ color: 'var(--text-muted)', fontSize: '13px', textAlign: 'center' }}>Tidak ada data transkrip.</p>
                          ) : (
                            transcripts.map((seg) => {
                              // Helper to highlight filler words inside a sentence
                              const renderTextWithHighlights = (text: string) => {
                                const indonesianFillers = ["anu", "ehm", "ehh", "umm", "hmm", "gitu", "kayak", "jadi", "ya kan", "tuh", "nah", "kan", "sih", "kok", "deh"];
                                const englishFillers = ["um", "uh", "like", "you know", "basically", "actually", "literally", "so", "right", "well"];
                                const allFillers = [...indonesianFillers, ...englishFillers];
                                
                                // Sort by length descending to match longer phrases first
                                const sortedFillers = allFillers.sort((a, b) => b.length - a.length);
                                
                                const pattern = sortedFillers.map(f => `\\b${f.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&')}\\b`).join('|');
                                const regex = new RegExp(`(${pattern})`, 'gi');
                                
                                const parts = text.split(regex);
                                return parts.map((part, index) => {
                                  const isFillerWord = sortedFillers.some(f => f.toLowerCase() === part.toLowerCase());
                                  return isFillerWord ? (
                                    <span key={index} className="filler-highlight" style={{
                                      background: 'rgba(239, 68, 68, 0.25)',
                                      color: '#ef4444',
                                      border: '1px dashed #ef4444',
                                      padding: '1px 5px',
                                      borderRadius: '4px',
                                      fontWeight: 'bold',
                                      fontSize: '13px'
                                    }}>
                                      {part}
                                    </span>
                                  ) : part;
                                });
                              };

                              return (
                                <div 
                                  key={seg.id} 
                                  style={{
                                    display: 'flex',
                                    flexDirection: 'column',
                                    alignItems: 'flex-start',
                                    width: '100%'
                                  }}
                                >
                                  {/* Speaker tag + Timestamp */}
                                  <div style={{
                                    display: 'flex',
                                    alignItems: 'center',
                                    gap: '8px',
                                    marginBottom: '4px',
                                    fontSize: '11px',
                                    color: 'var(--text-secondary)'
                                  }}>
                                    <span style={{ fontWeight: 700, color: '#22d3ee' }}>
                                      👤 {detail?.candidateName || 'Pelamar'}
                                    </span>
                                    <span style={{ fontSize: '10px', color: 'var(--text-muted)' }}>
                                      ({seg.startTime.toFixed(1)}s - {seg.endTime.toFixed(1)}s)
                                    </span>
                                  </div>

                                  {/* Glassmorphic Chat Bubble */}
                                  <div 
                                    className="glass" 
                                    onClick={() => handleSeek(seg.startTime)}
                                    style={{
                                      maxWidth: '100%',
                                      width: '100%',
                                      padding: '12px 16px',
                                      borderRadius: '8px',
                                      border: '1px solid rgba(34, 211, 238, 0.2)',
                                      background: 'rgba(34, 211, 238, 0.04)',
                                      boxShadow: '0 4px 20px rgba(34, 211, 238, 0.02)',
                                      textAlign: 'left',
                                      cursor: 'pointer'
                                    }}
                                  >
                                    <p style={{ margin: 0, fontSize: '14px', lineHeight: '1.6', color: '#f3f4f6' }}>
                                      {renderTextWithHighlights(seg.text)}
                                    </p>
                                  </div>
                                </div>
                              );
                            })
                          )}
                        </div>
                      )}

                      {activeTab === 'expressions' && (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
                          {/* Emotion Distribution Summary Chart */}
                          {expressions.length > 0 && (
                            <div className="glass" style={{ padding: '16px', borderRadius: '10px' }}>
                              <h4 style={{ color: '#fff', fontSize: '13px', textTransform: 'uppercase', letterSpacing: '1px', marginBottom: '12px' }}>Distribusi Emosi Wajah</h4>
                              <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', width: '100%' }}>
                                {(() => {
                                  const counts: Record<string, number> = {};
                                  expressions.forEach(e => { counts[e.emotion] = (counts[e.emotion] || 0) + 1; });
                                  const total = expressions.length;
                                  return Object.entries(counts)
                                    .sort((a, b) => b[1] - a[1])
                                    .map(([emotion, count]) => {
                                      const pct = ((count / total) * 100).toFixed(1);
                                      return (
                                        <div key={emotion} style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                                          <span style={{ width: '80px', textTransform: 'capitalize', fontSize: '12px', color: '#fff', fontWeight: 600 }}>{emotion}</span>
                                          <div style={{ flexGrow: 1, height: '12px', background: 'rgba(255, 255, 255, 0.03)', borderRadius: '6px', overflow: 'hidden', border: '1px solid var(--border-color)' }}>
                                            <div style={{ width: `${pct}%`, height: '100%', background: 'linear-gradient(90deg, var(--secondary), var(--primary))', borderRadius: '6px' }} />
                                          </div>
                                          <span style={{ width: '45px', fontSize: '11px', color: 'var(--text-secondary)', textAlign: 'right' }}>{pct}%</span>
                                        </div>
                                      );
                                    });
                                })()}
                              </div>
                            </div>
                          )}

                          <div className="timeline-list">
                            {expressions.length === 0 ? (
                              <p style={{ color: 'var(--text-muted)', fontSize: '13px' }}>Tidak ada data ekspresi.</p>
                            ) : (
                              expressions.map((exp) => (
                                <div key={exp.id} className="timeline-item" onClick={() => handleSeek(exp.timestampSec)} style={{ cursor: 'pointer' }}>
                                  <span className="time-stamp">{exp.timestampSec.toFixed(1)}s</span>
                                  <div style={{ display: 'flex', justifyContent: 'space-between', width: '100%', alignItems: 'center' }}>
                                    <span style={{ fontSize: '14px', fontWeight: 600, color: '#fff', textTransform: 'capitalize' }}>
                                      🎭 Ekspresi: {exp.emotion}
                                    </span>
                                    <span style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>
                                      Confidence: {Math.round(exp.confidence * 100)}%
                                    </span>
                                  </div>
                                </div>
                              ))
                            )}
                          </div>
                        </div>
                      )}

                      {activeTab === 'voice' && (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
                          {/* Pitch and Intensity Line Chart */}
                          {voices.length > 0 && (
                            <div className="glass" style={{ padding: '16px', borderRadius: '10px' }}>
                              <h4 style={{ color: '#fff', fontSize: '13px', textTransform: 'uppercase', letterSpacing: '1px', marginBottom: '12px' }}>Visualisasi Pitch & Intensitas Suara</h4>
                              {(() => {
                                const validVoices = voices.filter(v => v.pitchHz !== null && v.pitchHz > 0);
                                                               const maxPitch = Math.max(...validVoices.map(v => v.pitchHz || 0), 200);
                                const maxIntensity = Math.max(...voices.map(v => v.intensityDb || 0), 80);
                                const width = 800;
                                const height = 150;
                                
                                const pitchPoints = voices.map((v, i) => {
                                  const divisor = voices.length > 1 ? voices.length - 1 : 1;
                                  const x = (i / divisor) * (width - 40) + 20;
                                  const y = height - ((v.pitchHz || 0) / maxPitch) * (height - 30) - 15;
                                  return `${x},${y}`;
                                });
                                
                                const intensityPoints = voices.map((v, i) => {
                                  const divisor = voices.length > 1 ? voices.length - 1 : 1;
                                  const x = (i / divisor) * (width - 40) + 20;
                                  const y = height - ((v.intensityDb || 0) / maxIntensity) * (height - 30) - 15;
                                  return `${x},${y}`;
                                });
                                
                                return (
                                  <div style={{ position: 'relative', width: '100%', overflowX: 'auto' }}>
                                    <svg width="100%" height={height} viewBox={`0 0 ${width} ${height}`} style={{ background: 'rgba(0,0,0,0.2)', borderRadius: '8px' }}>
                                      {validVoices.length > 1 && (
                                        <path
                                          d={`M ${pitchPoints.join(' L ')}`}
                                          fill="none"
                                          stroke="#22d3ee"
                                          strokeWidth="2.5"
                                        />
                                      )}
                                      {voices.length > 1 && (
                                        <path
                                          d={`M ${intensityPoints.join(' L ')}`}
                                          fill="none"
                                          stroke="#c084fc"
                                          strokeWidth="2"
                                          strokeDasharray="4 3"
                                        />
                                      )}
                                      <text x="20" y="20" fill="#22d3ee" fontSize="11" fontWeight="bold">● Pitch (Hz)</text>
                                      <text x="120" y="20" fill="#c084fc" fontSize="11" fontWeight="bold">- - Intensitas (dB)</text>
                                    </svg>
                                  </div>
                                );
                              })()}
                            </div>
                          )}

                          <div className="timeline-list">
                            {voices.length === 0 ? (
                              <p style={{ color: 'var(--text-muted)', fontSize: '13px' }}>Tidak ada data kualitas suara.</p>
                            ) : (
                              voices.map((v) => (
                                <div key={v.id} className="timeline-item" onClick={() => handleSeek(v.timestampSec)} style={{ cursor: 'pointer' }}>
                                  <span className="time-stamp">{v.timestampSec.toFixed(1)}s</span>
                                  <div style={{ display: 'flex', gap: '20px', width: '100%', fontSize: '13.5px' }}>
                                    {v.pitchHz && (
                                      <span>📈 Pitch: <strong>{v.pitchHz.toFixed(1)} Hz</strong></span>
                                    )}
                                    {v.intensityDb && (
                                      <span>🔊 Intensitas: <strong>{v.intensityDb.toFixed(1)} dB</strong></span>
                                    )}
                                    {v.audioEmotion && (
                                      <span style={{ color: 'var(--primary)', marginLeft: 'auto' }}>
                                        Vokal Emosi: <strong>{v.audioEmotion}</strong>
                                      </span>
                                    )}
                                  </div>
                                </div>
                              ))
                            )}
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                  
                </>
              )}
            </>
          ) : null}
        </section>
      </main>
    </div>
  );
}
