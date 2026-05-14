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

  // Chatbot State
  const [chatMessages, setChatMessages] = useState([
    { sender: 'bot', text: "Hello! Upload a video of a traffic violation, and our VideoDB AI will analyze it to detect the vehicle and the rules broken." }
  ]);
  const [isUploading, setIsUploading] = useState(false);
  const fileInputRef = useRef(null);
  
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);

  // Chatbot File Upload Logic
  const handleFileUpload = async (event) => {
    const file = event.target.files[0];
    if (!file) return;

    setChatMessages(prev => [...prev, { sender: 'user', text: `Uploaded: ${file.name}` }]);
    setIsUploading(true);

    const formData = new FormData();
    formData.append('media', file);
    formData.append('type', "Manual VideoDB Upload");

    try {
      setChatMessages(prev => [...prev, { sender: 'bot', text: "Uploading and processing with VideoDB AI... This might take a minute." }]);
      
      const res = await fetch(`${BACKEND_URL}/report_violation`, {
        method: 'POST',
        body: formData
      });
      const data = await res.json();
      
      if (res.ok) {
        const recordId = data.id;
        // Poll for AI analysis
        const pollInterval = setInterval(async () => {
          const vRes = await fetch(`${BACKEND_URL}/violations`);
          const vData = await vRes.json();
          const record = vData.find(v => v.id === recordId);
          
          if (record && record.ai_analysis) {
            setChatMessages(prev => [...prev, { sender: 'bot', text: `Analysis Complete: ${record.ai_analysis}` }]);
            clearInterval(pollInterval);
            setIsUploading(false);
            fetchViolations(); // refresh history
          }
        }, 5000);
      } else {
        setChatMessages(prev => [...prev, { sender: 'bot', text: "Sorry, upload failed." }]);
        setIsUploading(false);
      }
    } catch (err) {
      console.error(err);
      setChatMessages(prev => [...prev, { sender: 'bot', text: "An error occurred during upload." }]);
      setIsUploading(false);
    }
  };

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
    <div className="desktop-app">
      <header className="desktop-header">
        <div className="header-content">
          <div className="header-left">
            <h1 className="app-title">GuardLane</h1>
          </div>
          
          <div className="filter-pills desktop-only">
            <button className={`pill ${activeTab === 'live' ? 'active' : ''}`} onClick={() => setActiveTab('live')}>Live Monitor</button>
            <button className={`pill ${activeTab === 'history' ? 'active' : ''}`} onClick={() => setActiveTab('history')}>Violations</button>
          </div>

          <div className="header-actions">
            <button className="icon-btn mobile-menu-btn" onClick={() => setIsMobileMenuOpen(!isMobileMenuOpen)}>
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="3" y1="12" x2="21" y2="12"></line><line x1="3" y1="6" x2="21" y2="6"></line><line x1="3" y1="18" x2="21" y2="18"></line></svg>
            </button>
            <button className="icon-btn">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 8 A6 6 0 0 0 6 8 c0 7-3 9-3 9h18s-3-2-3-9"></path><path d="M13.73 21a2 2 0 0 1-3.46 0"></path></svg>
              <span className="badge">2</span>
            </button>
            <button className="icon-btn">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg>
            </button>
          </div>
        </div>
      </header>

      {isMobileMenuOpen && (
        <div className="mobile-dropdown">
          <button className={`pill ${activeTab === 'live' ? 'active' : ''}`} onClick={() => {setActiveTab('live'); setIsMobileMenuOpen(false);}}>Live Monitor</button>
          <button className={`pill ${activeTab === 'history' ? 'active' : ''}`} onClick={() => {setActiveTab('history'); setIsMobileMenuOpen(false);}}>Violations</button>
        </div>
      )}

      <main className="desktop-content">
        {activeTab === 'live' ? (
          <div className="live-container">
            <div className="live-left">
              <div className="video-card">
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
                  <div className="light-indicator">
                    {lightState.toUpperCase()} SIGNAL
                  </div>
                )}

                {(isMonitoringSignal || isMonitoringTriple) && (
                  <div className="stats-overlay">
                    FPS {fps}
                  </div>
                )}

                {isViolationFound && (
                  <div className="violation-alert">
                    Recording Evidence...
                  </div>
                )}
              </div>

              <div className="action-buttons">
                <div className="action-row">
                  <button
                    className={`card-btn ${isMonitoringSignal ? 'active' : ''}`}
                    onClick={toggleSignalMonitoring}
                  >
                    {isMonitoringSignal ? 'Stop Signal' : 'Start Signal'}
                  </button>
                  <button
                    className={`card-btn ${isMonitoringTriple ? 'active' : ''}`}
                    onClick={toggleTripleMonitoring}
                  >
                    {isMonitoringTriple ? 'Stop Triple' : 'Start Triple'}
                  </button>
                </div>
              </div>
            </div>

            <div className="chatbot-section">
              <div className="chat-header">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg>
                VideoDB AI Assistant
              </div>
              <div className="chat-messages">
                {chatMessages.map((msg, idx) => (
                  <div key={idx} className={`message ${msg.sender}`}>
                    {msg.text}
                  </div>
                ))}
                {isUploading && (
                  <div className="message bot" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <span style={{ display: 'inline-block', width: '8px', height: '8px', background: 'var(--teal)', borderRadius: '50%', animation: 'pulse-detect 1s infinite' }}></span> Analyzing...
                  </div>
                )}
              </div>
              <div className="chat-input-area">
                <input 
                  type="file" 
                  accept="video/*,image/*" 
                  style={{ display: 'none' }} 
                  ref={fileInputRef}
                  onChange={handleFileUpload} 
                />
                <button 
                  className="upload-btn" 
                  onClick={() => fileInputRef.current.click()}
                  disabled={isUploading}
                  style={{ opacity: isUploading ? 0.7 : 1 }}
                >
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="17 8 12 3 7 8"></polyline><line x1="12" y1="3" x2="12" y2="15"></line></svg>
                  Upload Violation Video
                </button>
              </div>
            </div>
          </div>
        ) : (
          <div className="history-container">
            <div className="controls-bar">
              <div className="dropdown-style">
                <span>Show latest first</span>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="6 9 12 15 18 9"></polyline></svg>
              </div>
              <button className="filter-btn" onClick={clearViolations} title="Clear All">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
              </button>
            </div>

            <div className="card-grid">
              {violations.length === 0 ? (
                <div className="empty-state">No violations recorded yet.</div>
              ) : (
                violations.map((v, idx) => {
                  const isVideo = v.video_path && v.video_path.endsWith('.webm');
                  const mediaUrl = v.video_path ? `${BACKEND_URL}/violations/${v.video_path.split('/').pop()}` : null;
                  
                  let dateStr = v.timestamp;
                  try {
                    dateStr = new Date(v.timestamp).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }).toLowerCase();
                  } catch(e){}

                  return (
                    <div className="result-card" key={v.id}>
                      <div className="result-card-header">
                        <div className="result-logo">
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><circle cx="8.5" cy="8.5" r="1.5"></circle><polyline points="21 15 16 10 5 21"></polyline></svg>
                          <span>{v.vehicle_type}</span>
                        </div>
                        <button className="info-btn" onClick={() => deleteViolation(v.id)} title="Delete Record">
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
                        </button>
                      </div>

                      <div className="result-card-body">
                        <h3 className="result-title">
                          {v.type}
                          {idx === 0 && <span className="new-badge">New</span>}
                        </h3>
                        <span className="result-date">{dateStr}</span>
                      </div>
                      
                      {mediaUrl && (
                        isVideo ? (
                          <video className="media-preview" src={mediaUrl} controls autoPlay muted loop />
                        ) : (
                          <img className="media-preview" src={mediaUrl} alt="Violation" />
                        )
                      )}
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
