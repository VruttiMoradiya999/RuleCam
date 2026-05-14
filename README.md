# RuleCam

RuleCam is a real-time object detection application powered by YOLOv8, React, and VideoDB.

## Features

- **Real-time Detection**: Captures camera frames and identifies objects using YOLOv8.
- **Dynamic Overlays**: Renders bounding boxes and detections directly over the video feed.
- **Modern UI**: Clean, neo-brutalist light-theme interface.
- **VideoDB AI Integration**: Upload traffic violation videos and have them analyzed by AI to detect rule-breaking and vehicle details.

## Screenshots

### 1. Live Monitor View
![Live Monitor](src/assests/1.PNG)
*The main view where real-time video is captured and analyzed.*

### 2. Violation History
![Violations History](src/assests/2.PNG)
*Review past violations with detailed AI analysis and playback options.*

### 3. AI Chatbot Analysis
![AI Chatbot](src/assests/3.PNG)
*Upload a video directly for VideoDB AI to process.*

## Tech Stack

- **Frontend**: React, Vite, Vanilla CSS
- **Backend**: Flask, YOLOv8 (Ultralytics), OpenCV, SQLite, VideoDB

## Getting Started

### 1. Prerequisites

- Node.js (v18+)
- Python 3.9+
- pip

### 2. Environment Variables

Create a `.env` file in the **backend** directory:
```env
VIDEODB_API_KEY=your_videodb_api_key_here
PORT=5005
```

Create a `.env` file in the **root** directory (for Frontend):
```env
VITE_BACKEND_URL=http://localhost:5005
```

### 3. Backend Setup

```bash
cd backend
pip install -r requirements.txt
python app.py
```

The backend will start on `http://localhost:5005`.

### 4. Frontend Setup

```bash
# From the root directory
npm install
npm run dev
```

The frontend will start on `http://localhost:5173`.

## Troubleshooting

- **Port Conflicts**: If port `5005` is in use, you can change it in `backend/.env` and `.env`.
- **Camera Permissions**: Ensure you grant camera access to the browser when prompted.
- **CORS Issues**: The backend is configured to allow requests from `*`. If your frontend runs on a different port, update the `origins` list in `backend/app.py`.
