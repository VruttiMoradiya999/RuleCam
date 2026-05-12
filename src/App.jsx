import * as React from 'react';
import './App.css';
const { useEffect, useRef, useState, useCallback } = React;

const rawBackendUrl = import.meta.env.VITE_BACKEND_URL || "http://localhost:5005";
const BACKEND_URL = rawBackendUrl.replace(/\/$/, "");

const App = () => {
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const overlayCanvasRef = useRef(null);
  const intervalRef = useRef(null);

  const [activeTab, setActiveTab] = useState("live");
  const [facingMode, setFacingMode] = useState("environment");
  const [detections, setDetections] = useState([]);
  const [isMonitoringSignal, setIsMonitoringSignal] = useState(false);
  const [isMonitoringTriple, setIsMonitoringTriple] = useState(false);
  const [backendStatus, setBackendStatus] = useState("checking");
  const [fps, setFps] = useState(0);
  const [detectionMode, setDetectionMode] = useState("signal_jumping"); // "signal_jumping" or "triple_riding"
  const [error, setError] = useState(null);
  const [violations, setViolations] = useState([]);
  const [isViolationFound, setIsViolationFound] = useState(false);
  const [isReporting, setIsReporting] = useState(false);
  const [lightState, setLightState] = useState("unknown");
  const [videoBlob, setVideoBlob] = useState(null);
  const [isAutoReporting, setIsAutoReporting] = useState(false);
  const mediaRecorderRef = useRef(null);
  const recordedChunksRef = useRef([]);

  // Check backend health
  useEffect(() => {
    const checkBackend = async () => {
      try {
        const res = await fetch(`${BACKEND_URL}/`);
        if (res.ok) {
          setBackendStatus("connected");
          setError(null);
        } else {
          setBackendStatus("error");
        }
      } catch {
        setBackendStatus("disconnected");
      }
    };
    checkBackend();
    const hInterval = setInterval(checkBackend, 5000);
    return () => clearInterval(hInterval);
  }, []);

  // Fetch Violations History
  const fetchViolations = useCallback(async () => {
    try {
      const res = await fetch(`${BACKEND_URL}/violations`);
      const data = await res.json();
      setViolations(data);
    } catch (err) {
      console.error("Error fetching violations:", err);
    }
  }, []);

  useEffect(() => {
    if (activeTab === "history") {
      fetchViolations();
    }
  }, [activeTab, fetchViolations]);

  // Start camera
  const startVideo = useCallback(async () => {
    if (videoRef.current && videoRef.current.srcObject) {
      videoRef.current.srcObject.getTracks().forEach(t => t.stop());
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode, width: { ideal: 640 }, height: { ideal: 480 } }
      });
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
      }
      setError(null);
    } catch (err) {
      console.error("Camera error:", err);
      setError("Could not access camera. Please grant permissions.");
    }
  }, [facingMode]);

  useEffect(() => {
    startVideo();
    return () => {
      if (videoRef.current && videoRef.current.srcObject) {
        videoRef.current.srcObject.getTracks().forEach(t => t.stop());
      }
    };
  }, [startVideo]);

  // Draw bounding box overlay
  const drawOverlay = useCallback((dets, imageShape, violationDetected, currentLightState) => {
    const overlay = overlayCanvasRef.current;
    const video = videoRef.current;
    if (!overlay || !video) return;

    overlay.width = video.videoWidth;
    overlay.height = video.videoHeight;
    const ctx = overlay.getContext('2d');
    ctx.clearRect(0, 0, overlay.width, overlay.height);

    const colors = {
      'red': '#ff3cac',
      'yellow': '#ffb800',
      'green': '#00ff87',
      'unknown': '#00f0ff'
    };

    const lightColor = colors[currentLightState] || colors.unknown;

    // Draw detected light state indicator (only for signal mode)
    if (currentLightState !== "N/A") {
      ctx.fillStyle = lightColor;
      ctx.beginPath();
      ctx.arc(30, 30, 10, 0, Math.PI * 2);
      ctx.fill();
      ctx.font = 'bold 14px Inter';
      ctx.fillText(`SIGNAL: ${currentLightState.toUpperCase()}`, 50, 35);
    }

    dets.forEach((det, i) => {
      const [x1, y1, x2, y2] = det.bbox;
      const isTrafficLight = det.object === "traffic light";
      const color = det.is_violating ? '#ff3cac' : (isTrafficLight ? lightColor : '#00f0ff');
      const w = x2 - x1;
      const h = y2 - y1;

      ctx.strokeStyle = color;
      ctx.lineWidth = det.is_violating ? 4 : 2.5;
      ctx.shadowColor = color;
      ctx.shadowBlur = det.is_violating ? 15 : 8;
      ctx.strokeRect(x1, y1, w, h);
      ctx.shadowBlur = 0;

      // Label
      const label = isTrafficLight ? `LIGHT: ${currentLightState}` : det.object;
      ctx.font = 'bold 12px Inter';
      const textWidth = ctx.measureText(label).width;
      ctx.fillStyle = color;
      ctx.globalAlpha = 0.8;
      ctx.fillRect(x1, y1 - 20, textWidth + 10, 20);
      ctx.globalAlpha = 1;
      ctx.fillStyle = '#000';
      ctx.fillText(label, x1 + 5, y1 - 5);
    });
  }, []);

  // Capture and Detect Signal Jumping
  const captureAndDetectSignal = useCallback(async () => {
    if (!videoRef.current || !canvasRef.current) return;
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (video.readyState < 2) return;
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(video, 0, 0);
    const startTime = performance.now();
    const imageData = canvas.toDataURL('image/jpeg', 0.5);

    try {
      const res = await fetch(`${BACKEND_URL}/detect_signal`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ image: imageData }),
      });
      if (!res.ok) throw new Error('Detection failed');
      const data = await res.json();
      setDetections(data.detections || []);
      setIsViolationFound(data.violation_detected || false);
      setLightState(data.traffic_light_state || "unknown");
      const elapsed = performance.now() - startTime;
      setFps(Math.round(1000 / elapsed));
      drawOverlay(data.detections || [], data.image_shape, data.violation_detected, data.traffic_light_state);
    } catch (err) {
      console.error("Signal detection error:", err);
    }
  }, [drawOverlay]);

  // Capture and Detect Triple Riding
  const captureAndDetectTriple = useCallback(async () => {
    if (!videoRef.current || !canvasRef.current) return;
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (video.readyState < 2) return;
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(video, 0, 0);
    const startTime = performance.now();
    const imageData = canvas.toDataURL('image/jpeg', 0.5);

    try {
      const res = await fetch(`${BACKEND_URL}/detect_triple`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ image: imageData }),
      });
      if (!res.ok) throw new Error('Detection failed');
      const data = await res.json();
      setDetections(data.detections || []);
      setIsViolationFound(data.violation_detected || false);
      setLightState("N/A");
      const elapsed = performance.now() - startTime;
      setFps(Math.round(1000 / elapsed));
      drawOverlay(data.detections || [], data.image_shape, data.violation_detected, "N/A");
    } catch (err) {
      console.error("Triple detection error:", err);
    }
  }, [drawOverlay]);

  // Start recording a clip
  const startRecording = useCallback(() => {
    if (!videoRef.current || !videoRef.current.srcObject || mediaRecorderRef.current) return;

    recordedChunksRef.current = [];
    const stream = videoRef.current.srcObject;
    const mimeType = MediaRecorder.isTypeSupported('video/mp4') ? 'video/mp4' : 'video/webm';

    // Use a lower bitrate (1 Mbps) to make uploads faster
    const recorder = new MediaRecorder(stream, {
      mimeType,
      videoBitsPerSecond: 1000000
    });

    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) {
        recordedChunksRef.current.push(e.data);
      }
    };

    recorder.onstop = () => {
      const blob = new Blob(recordedChunksRef.current, { type: mimeType });
      setVideoBlob(blob);
    };

    mediaRecorderRef.current = recorder;
    recorder.start();

    // Stop after 10 seconds
    setTimeout(() => {
      if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") {
        mediaRecorderRef.current.stop();
        mediaRecorderRef.current = null;
      }
    }, 10000);
  }, []);

  useEffect(() => {
    if (isViolationFound && !mediaRecorderRef.current && !videoBlob && !isAutoReporting) {
      setIsAutoReporting(true);
      startRecording();
    }

    // When a video blob is ready and we are in auto-reporting mode, send it
    if (videoBlob && isAutoReporting) {
      reportViolation();
      setIsAutoReporting(false);
    }

    if (!isViolationFound && !isAutoReporting) {
      setVideoBlob(null);
      if (mediaRecorderRef.current) {
        mediaRecorderRef.current.stop();
        mediaRecorderRef.current = null;
      }
    }
  }, [isViolationFound, startRecording, videoBlob, isAutoReporting]);

  // Report Violation
  const reportViolation = async () => {
    if (isReporting || (!videoBlob && !canvasRef.current)) return;
    setIsReporting(true);

    const potentialViolation = detections.find(d => d.is_violating) || detections.find(d => ["car", "motorcycle", "bus", "truck"].includes(d.object));

    const formData = new FormData();
    formData.append('type', isMonitoringSignal ? 'Signal Jumping' : 'Triple Riding');
    formData.append('vehicle', potentialViolation ? potentialViolation.object : 'Unknown');
    formData.append('confidence', potentialViolation ? potentialViolation.confidence : 0);

    const sendReport = async (blob, filename) => {
      formData.append('media', blob, filename);
      try {
        const res = await fetch(`${BACKEND_URL}/report_violation`, {
          method: 'POST',
          body: formData
        });
        if (res.ok) {
          console.log("Signal jumping clip reported automatically!");
          setIsViolationFound(false);
          setVideoBlob(null);
          fetchViolations();
        }
      } catch (err) {
        console.error("Reporting error:", err);
      } finally {
        setIsReporting(false);
        setIsAutoReporting(false);
      }
    };

    if (videoBlob) {
      const ext = videoBlob.type === 'video/mp4' ? '.mp4' : '.webm';
      sendReport(videoBlob, `violation_clip${ext}`);
    } else {
      canvasRef.current.toBlob((blob) => {
        if (blob) sendReport(blob, 'violation.jpg');
        else setIsReporting(false);
      }, 'image/jpeg', 0.9);
    }
  };

  // Clear All Violations
  const clearViolations = async () => {
    if (!window.confirm("Are you sure you want to delete all violation records and videos?")) return;

    try {
      const res = await fetch(`${BACKEND_URL}/clear_violations`, { method: 'POST' });
      if (res.ok) {
        fetchViolations();
      }
    } catch (err) {
      console.error("Error clearing violations:", err);
    }
  };

  // Delete Single Violation
  const deleteViolation = async (id) => {
    if (!window.confirm("Delete this record?")) return;
    try {
      const res = await fetch(`${BACKEND_URL}/delete_violation/${id}`, { method: 'POST' });
      if (res.ok) {
        fetchViolations();
      }
    } catch (err) {
      console.error("Error deleting violation:", err);
    }
  };

  const toggleSignalMonitoring = () => {
    if (isMonitoringSignal) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
      setIsMonitoringSignal(false);
      setDetections([]);
      setFps(0);
      setIsViolationFound(false);
    } else {
      if (isMonitoringTriple) toggleTripleMonitoring();
      setIsMonitoringSignal(true);
      captureAndDetectSignal();
      intervalRef.current = setInterval(captureAndDetectSignal, 150);
    }
  };

  const toggleTripleMonitoring = () => {
    if (isMonitoringTriple) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
      setIsMonitoringTriple(false);
      setDetections([]);
      setFps(0);
      setIsViolationFound(false);
    } else {
      if (isMonitoringSignal) toggleSignalMonitoring();
      setIsMonitoringTriple(true);
      captureAndDetectTriple();
      intervalRef.current = setInterval(captureAndDetectTriple, 150);
    }
  };

  const toggleCamera = () => {
    setFacingMode(prev => (prev === "user" ? "environment" : "user"));
  };

  return (
    <div className="app-container">
      <header className="app-header">
        <div className="header-left">
          <div className="logo-icon">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
            </svg>
          </div>
          <div>
            <h1 className="app-title">GuardLane</h1>
            <p className="app-subtitle">Smart Signal Guard</p>
          </div>
        </div>

        <nav className="header-nav">
          <button className={`nav-link ${activeTab === 'live' ? 'active' : ''}`} onClick={() => setActiveTab('live')}>Live</button>
          <button className={`nav-link ${activeTab === 'history' ? 'active' : ''}`} onClick={() => setActiveTab('history')}>History</button>
        </nav>

        <div className="header-right">
          <div className={`status-badge ${backendStatus}`}>
            <span className="status-dot"></span>
            {backendStatus === "connected" ? "AI Online" : "AI Offline"}
          </div>
        </div>
      </header>

      <main className="main-content">
        {activeTab === 'live' ? (
          <>
            <div className="video-section">
              <div className="video-wrapper">
                <video
                  ref={videoRef}
                  autoPlay
                  playsInline
                  muted
                  style={{ transform: facingMode === "user" ? 'scaleX(-1)' : 'none' }}
                />
                <canvas ref={canvasRef} style={{ display: 'none' }} />
                <canvas
                  ref={overlayCanvasRef}
                  className="overlay-canvas"
                  style={{ transform: facingMode === "user" ? 'scaleX(-1)' : 'none' }}
                />

                {isMonitoringSignal && (
                  <div className={`light-indicator ${lightState}`}>
                    <div className="indicator-dot"></div>
                    <span>{lightState.toUpperCase()} SIGNAL</span>
                  </div>
                )}

                {(isMonitoringSignal || isMonitoringTriple) && (
                  <div className="stats-overlay">
                    <div className="stat-chip">
                      <span className="stat-label">FPS</span>
                      <span className="stat-value">{fps}</span>
                    </div>
                  </div>
                )}
              </div>

              <div className="mode-selector">
                <button
                  className={`start-btn ${isMonitoringSignal ? 'active' : ''}`}
                  onClick={toggleSignalMonitoring}
                >
                  {isMonitoringSignal ? 'Stop Signal Monitor' : 'Start Signal Monitor'}
                </button>
                <button
                  className={`start-btn ${isMonitoringTriple ? 'active' : ''}`}
                  onClick={toggleTripleMonitoring}
                >
                  {isMonitoringTriple ? 'Stop Triple Monitor' : 'Start Triple Monitor'}
                </button>
              </div>

              <div className="camera-controls">
                <button className="cam-btn" onClick={toggleCamera}>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" /><circle cx="12" cy="13" r="4" /></svg>
                </button>
              </div>


              {isViolationFound && (
                <div className="violation-alert auto">
                  <div className="alert-content">
                    <div className="recording-dot"></div>
                    <span>Recording Evidence...</span>
                  </div>
                </div>
              )}
            </div>

            <div className="detections-panel">
              <div className="panel-header">
                <h2>Live Objects</h2>
                {detections.length > 0 && <span className="detection-count">{detections.length}</span>}
              </div>

              <div className="detection-list">
                {detections.length === 0 ? (
                  <div className="empty-state">
                    <p>{(isMonitoringSignal || isMonitoringTriple) ? "Scanning..." : "Ready to monitor"}</p>
                  </div>
                ) : (
                  detections.map((det, idx) => (
                    <div className={`detection-item ${det.is_violating ? 'violating' : ''}`} key={idx}>
                      <div className="det-info">
                        <span className="det-name">{det.object}</span>
                        <div className="conf-bar-bg"><div className="conf-bar-fill" style={{ width: `${det.confidence * 100}%` }}></div></div>
                      </div>
                      <span className="conf-text">{(det.confidence * 100).toFixed(0)}%</span>
                    </div>
                  ))
                )}
              </div>
            </div>
          </>
        ) : (
          <div className="history-section">
            <div className="history-summary">
              <div className="summary-card">
                <span className="summary-label">Total Reports</span>
                <span className="summary-value">{violations.length}</span>
              </div>
              <div className="summary-card">
                <span className="summary-label">Potential Rewards</span>
                <span className="summary-value text-green">${(violations.length * 15).toFixed(2)}</span>
              </div>
              <div className="summary-card">
                <span className="summary-label">Confirmed Fines</span>
                <span className="summary-value">0</span>
              </div>
            </div>

            <div className="panel-header">
              <div className="history-header">
                <h2>Violation Records</h2>
                <button className="clear-all-btn" onClick={clearViolations}>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="trash-icon"><path d="M3 6h18" /><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" /><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" /><line x1="10" y1="11" x2="10" y2="17" /><line x1="14" y1="11" x2="14" y2="17" /></svg>
                  Clear All
                </button>
              </div>
              <span className="detection-count">{violations.length}</span>
            </div>

            <div className="history-grid">
              {violations.length === 0 ? (
                <div className="empty-state">
                  <p>No violations recorded yet.</p>
                </div>
              ) : (
                violations.map((v) => {
                  const isVideo = v.video_path && v.video_path.endsWith('.webm');
                  const mediaUrl = v.video_path ? `${BACKEND_URL}/violations/${v.video_path.split('/').pop()}` : null;

                  if (!mediaUrl) return null;

                  return (
                    <div className="violation-card" key={v.id}>
                      <div className="card-media">
                        {isVideo ? (
                          <video src={mediaUrl} controls autoPlay muted loop />
                        ) : (
                          <img src={mediaUrl} alt="Violation" />
                        )}
                        <span className={`status-tag ${v.status.toLowerCase()}`}>{v.status}</span>
                      </div>
                      <div className="card-details">
                        <h3>{v.vehicle_type} - {v.type}</h3>
                        <p>{v.timestamp}</p>

                        {v.ai_analysis && (
                          <div className="ai-insight">
                            <span className="insight-label">AI Analysis:</span>
                            <p className="insight-text">{v.ai_analysis}</p>
                          </div>
                        )}

                        <div className="card-footer">
                          <span className="reward-info">Potential Reward: $15.00</span>
                          {v.videodb_url && (
                            <div className="violation-actions">
                              <a href={v.videodb_url} target="_blank" rel="noopener noreferrer" className="portal-btn">
                                Submit to Portal
                              </a>
                              <button className="card-delete-btn" onClick={() => deleteViolation(v.id)} title="Delete Record">
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 6h18" /><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" /><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" /></svg>
                              </button>
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        )}
      </main>
    </div>
  );
};

export default App;
