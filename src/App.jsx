import * as React from 'react';
import './App.css';
const { useEffect, useRef, useState, useCallback } = React;

const BACKEND_URL = "http://localhost:5005";

const App = () => {
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const overlayCanvasRef = useRef(null);
  const intervalRef = useRef(null);

  const [activeTab, setActiveTab] = useState("live");
  const [facingMode, setFacingMode] = useState("environment");
  const [detections, setDetections] = useState([]);
  const [isDetecting, setIsDetecting] = useState(false);
  const [backendStatus, setBackendStatus] = useState("checking");
  const [fps, setFps] = useState(0);
  const [error, setError] = useState(null);
  const [violations, setViolations] = useState([]);
  const [isViolationFound, setIsViolationFound] = useState(false);
  const [isReporting, setIsReporting] = useState(false);
  const [lightState, setLightState] = useState("unknown");

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

    // Draw detected light state indicator
    ctx.fillStyle = lightColor;
    ctx.beginPath();
    ctx.arc(30, 30, 10, 0, Math.PI * 2);
    ctx.fill();
    ctx.font = 'bold 14px Inter';
    ctx.fillText(`SIGNAL: ${currentLightState.toUpperCase()}`, 50, 35);

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
      const label = isTrafficLight ? `LIGHT: ${currentLightState}` : `${det.object} ${(det.confidence * 100).toFixed(0)}%`;
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

  // Capture frame and send to backend
  const captureAndDetect = useCallback(async () => {
    if (!videoRef.current || !canvasRef.current) return;
    const video = videoRef.current;
    const canvas = canvasRef.current;

    if (video.readyState < 2) return;

    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(video, 0, 0);

    const startTime = performance.now();

    canvas.toBlob(async (blob) => {
      if (!blob) return;
      const formData = new FormData();
      formData.append('image', blob, 'frame.jpg');

      try {
        const res = await fetch(`${BACKEND_URL}/detect`, {
          method: 'POST',
          body: formData
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
        console.error("Detection error:", err);
      }
    }, 'image/jpeg', 0.8);
  }, [drawOverlay]);

  // Report Violation
  const reportViolation = async () => {
    if (!canvasRef.current || isReporting) return;
    setIsReporting(true);
    
    const canvas = canvasRef.current;
    const potentialViolation = detections.find(d => ["car", "motorcycle", "bus", "truck"].includes(d.object));

    canvas.toBlob(async (blob) => {
      if (!blob) return;
      const formData = new FormData();
      formData.append('image', blob, 'violation.jpg');
      formData.append('type', 'Signal Jumping');
      formData.append('vehicle', potentialViolation ? potentialViolation.object : 'Unknown');
      formData.append('confidence', potentialViolation ? potentialViolation.confidence : 0);

      try {
        const res = await fetch(`${BACKEND_URL}/report_violation`, {
          method: 'POST',
          body: formData
        });
        if (res.ok) {
          alert("Signal jumping reported successfully!");
          setIsViolationFound(false);
        }
      } catch (err) {
        console.error("Reporting error:", err);
      } finally {
        setIsReporting(false);
      }
    }, 'image/jpeg', 0.9);
  };

  const toggleDetection = () => {
    if (isDetecting) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
      setIsDetecting(false);
      setDetections([]);
      setFps(0);
      setIsViolationFound(false);
      const overlay = overlayCanvasRef.current;
      if (overlay) {
        const ctx = overlay.getContext('2d');
        ctx.clearRect(0, 0, overlay.width, overlay.height);
      }
    } else {
      setIsDetecting(true);
      captureAndDetect();
      intervalRef.current = setInterval(captureAndDetect, 800);
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
              <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
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

                <div className={`light-indicator ${lightState}`}>
                  <div className="indicator-dot"></div>
                  <span>{lightState.toUpperCase()} SIGNAL</span>
                </div>

                {isDetecting && (
                  <div className="stats-overlay">
                    <div className="stat-chip">
                      <span className="stat-label">FPS</span>
                      <span className="stat-value">{fps}</span>
                    </div>
                  </div>
                )}

                <div className="camera-controls">
                  <button className="cam-btn" onClick={toggleCamera}>
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>
                  </button>
                </div>
                
                {isViolationFound && (
                  <div className="violation-alert">
                    <div className="alert-content">
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="alert-icon"><path d="m10.29 3.86 7.39 12.79a2 2 0 0 1-1.73 3H4.34a2 2 0 0 1-1.73-3L9.99 3.86a2 2 0 0 1 3.46 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
                      <span>Signal Jumping Detected!</span>
                    </div>
                    <button className="report-now-btn" onClick={reportViolation} disabled={isReporting}>
                      {isReporting ? "Reporting..." : "Report Now"}
                    </button>
                  </div>
                )}
              </div>

              <div className="action-row">
                <button className={`detect-btn ${isDetecting ? 'active' : ''}`} onClick={toggleDetection} disabled={backendStatus !== "connected"}>
                  {isDetecting ? "Stop Monitoring" : "Start Monitoring"}
                </button>
              </div>
            </div>

            <div className="detections-panel">
              <div className="panel-header">
                <h2>Live Objects</h2>
                {detections.length > 0 && <span className="detection-count">{detections.length}</span>}
              </div>
              
              <div className="detection-list">
                {detections.length === 0 ? (
                  <div className="empty-state">
                    <p>{isDetecting ? "Scanning..." : "Ready to monitor"}</p>
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
              <h2>Violation History</h2>
              <span className="detection-count">{violations.length}</span>
            </div>
            
            <div className="history-grid">
              {violations.length === 0 ? (
                <div className="empty-state">
                  <p>No violations recorded yet.</p>
                </div>
              ) : (
                violations.map((v) => (
                  <div className="violation-card" key={v.id}>
                    <div className="card-media">
                      <img src={`${BACKEND_URL}/violations/${v.video_path.split('/').pop()}`} alt="Violation" />
                      <span className={`status-tag ${v.status.toLowerCase()}`}>{v.status}</span>
                    </div>
                    <div className="card-details">
                      <h3>{v.vehicle_type} - {v.type}</h3>
                      <p>{v.timestamp}</p>
                      <div className="card-footer">
                        <span className="reward-info">Potential Reward: $15.00</span>
                      </div>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        )}
      </main>
    </div>
  );
};

export default App;
