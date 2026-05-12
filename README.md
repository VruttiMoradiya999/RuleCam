# RuleCam

RuleCam is a real-time object detection application powered by YOLOv8 and React.

## Features

- **Real-time Detection**: Captures camera frames and identifies objects using YOLOv8.
- **Dynamic Overlays**: Renders bounding boxes and confidence scores directly over the video feed.
- **Modern UI**: Sleek dark-mode interface with live stats (FPS, object count).
- **Dual Camera Support**: Switch between front and back cameras easily.

## Tech Stack

- **Frontend**: React, Vite, Vanilla CSS
- **Backend**: Flask, YOLOv8 (Ultralytics), OpenCV, NumPy

## Getting Started

### 1. Prerequisites

- Node.js (v18+)
- Python 3.9+
- pip

### 2. Backend Setup

```bash
cd backend
pip install -r requirements.txt
python app.py
```

The backend will start on `http://localhost:5005`.

### 3. Frontend Setup

```bash
# From the root directory
npm install
npm run dev
```

The frontend will start on `http://localhost:5173`.

## Troubleshooting

- **Port Conflicts**: If port `5005` is in use, you can change it in `backend/app.py` and `src/App.jsx`.
- **Camera Permissions**: Ensure you grant camera access to the browser when prompted.
- **CORS Issues**: The backend is configured to allow requests from `http://localhost:5173`. If your frontend runs on a different port, update the `origins` list in `backend/app.py`.

## License

MIT
