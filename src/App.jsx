import * as React from 'react';
const { useEffect, useRef, useState } = React;

const VideoFeed = () => {
  const videoRef = useRef(null);
  const [facingMode, setFacingMode] = useState("user");
  const startVideo = async () => {
    // 1. Kill any existing stream to "release" the camera hardware
    if (videoRef.current && videoRef.current.srcObject) {
      const tracks = videoRef.current.srcObject.getTracks();
      tracks.forEach(track => track.stop());
    }

    try {
      // 2. Request the new stream based on state
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: facingMode }
      });

      if (videoRef.current) {
        videoRef.current.srcObject = stream;
      }
    } catch (err) {
      console.error("Error accessing camera:", err);
    }
  };

  // Re-run whenever facingMode changes
  useEffect(() => {
    startVideo();
  }, [facingMode]);

  const toggleCamera = () => {
    setFacingMode(prev => (prev === "user" ? "environment" : "user"));
  };

  return (
    <div style={{ textAlign: 'center' }}>
      <video
        ref={videoRef}
        autoPlay
        playsInline
        style={{
          width: '100%',
          maxWidth: '500px',
          // Mirror ONLY the front camera
          transform: facingMode === "user" ? 'scaleX(-1)' : 'none',
          backgroundColor: '#000'
        }}
      />
      <br />
      <button
        onClick={toggleCamera}
        style={{ padding: '10px 20px', marginTop: '10px', cursor: 'pointer' }}
      >
        Switch to {facingMode === "user" ? "Back" : "Front"} Camera
      </button>
    </div>
  );
};

export default VideoFeed;
