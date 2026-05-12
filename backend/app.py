from flask import Flask, request, jsonify, send_from_directory
from flask_cors import CORS
from ultralytics import YOLO
import cv2
import numpy as np
import sqlite3
import os
from datetime import datetime

app = Flask(__name__)
CORS(app, origins=["http://localhost:5173", "http://127.0.0.1:5173"])

# Configuration
VIOLATIONS_DIR = "violations"
DB_PATH = "database.db"

if not os.path.exists(VIOLATIONS_DIR):
    os.makedirs(VIOLATIONS_DIR)

@app.route('/violations/<filename>')
def serve_violation(filename):
    return send_from_directory(VIOLATIONS_DIR, filename)

def init_db():
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS violations (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            timestamp TEXT,
            type TEXT,
            vehicle_type TEXT,
            confidence REAL,
            video_path TEXT,
            status TEXT
        )
    ''')
    conn.commit()
    conn.close()

init_db()

model = YOLO("yolov8n.pt")

@app.route("/", methods=["GET"])
def health():
    """Health check endpoint."""
    return jsonify({"status": "ok", "model": "yolov8n"})


@app.route("/detect", methods=["POST"])
def detect():
    """
  
    Accept an image file via multipart form upload,
    run YOLOv8 inference, and return detections.

    Returns JSON array of detections, each containing:
      - object: class name
      - confidence: float 0-1
      - bbox: [x1, y1, x2, y2] pixel coordinates
    """
    if "image" not in request.files:
        return jsonify({"error": "No image file provided"}), 400

    file = request.files["image"]
    image_bytes = file.read()

    if not image_bytes:
        return jsonify({"error": "Empty image file"}), 400

    npimg = np.frombuffer(image_bytes, np.uint8)
    img = cv2.imdecode(npimg, cv2.IMREAD_COLOR)

    if img is None:
        return jsonify({"error": "Could not decode image"}), 400

    results = model(img, verbose=False)

    detections = []
    violation_detected = False
    h, w = img.shape[:2]
    
    # First pass: find traffic lights and their states
    traffic_light_state = "unknown" # "red", "yellow", "green", "unknown"
    light_y_threshold = 0.8 # Default if no light found
    
    for result in results:
        boxes = result.boxes
        for box in boxes:
            cls = int(box.cls[0])
            name = model.names[cls]
            if name == "traffic light":
                xyxy = box.xyxy[0].tolist()
                lx1, ly1, lx2, ly2 = map(int, xyxy)
                
                # Set threshold for crossing
                light_y_threshold = ly2 / h
                
                # Analyze light state
                if ly2 > ly1 and lx2 > lx1:
                    crop = img[ly1:ly2, lx1:lx2]
                    # Convert to HSV for better color/brightness detection
                    hsv = cv2.cvtColor(crop, cv2.COLOR_BGR2HSV)
                    v_channel = hsv[:, :, 2] # Brightness
                    
                    height = v_channel.shape[0]
                    third = height // 3
                    
                    if third > 0:
                        red_part = np.mean(v_channel[0:third, :])
                        yellow_part = np.mean(v_channel[third:2*third, :])
                        green_part = np.mean(v_channel[2*third:height, :])
                        
                        if red_part > yellow_part and red_part > green_part and red_part > 100:
                            traffic_light_state = "red"
                        elif yellow_part > red_part and yellow_part > green_part and yellow_part > 100:
                            traffic_light_state = "yellow"
                        elif green_part > red_part and green_part > yellow_part and green_part > 100:
                            traffic_light_state = "green"

    # Second pass: detect vehicles and check for violations
    allowed_classes = ["car", "motorcycle", "bus", "truck", "traffic light"]
    
    for result in results:
        boxes = result.boxes
        for box in boxes:
            cls = int(box.cls[0])
            name = model.names[cls]
            
            if name not in allowed_classes:
                continue
                
            conf = float(box.conf[0])
            xyxy = box.xyxy[0].tolist()
            
            y2_pct = xyxy[3] / h
            is_vehicle = name in ["car", "motorcycle", "bus", "truck"]
            
            # Violation if light is red/yellow and vehicle crosses the threshold
            is_violating = False
            if is_vehicle and conf > 0.4:
                if traffic_light_state in ["red", "yellow"]:
                    if y2_pct > light_y_threshold:
                        is_violating = True
                        violation_detected = True

            detections.append({
                "object": name,
                "confidence": round(conf, 3),
                "bbox": [round(c, 1) for c in xyxy],
                "is_violating": is_violating,
                "light_state": traffic_light_state if name == "traffic light" else None
            })

    detections.sort(key=lambda d: d["confidence"], reverse=True)
    
    return jsonify({
        "detections": detections,
        "count": len(detections),
        "image_shape": [h, w],
        "violation_detected": violation_detected,
        "traffic_light_state": traffic_light_state
    })


@app.route("/report_violation", methods=["POST"])
def report_violation():
    """
    Endpoint to report a confirmed violation.
    Saves the image and records metadata in the database.
    """
    if "image" not in request.files:
        return jsonify({"error": "No image file provided"}), 400

    file = request.files["image"]
    v_type = request.form.get("type", "General Violation")
    vehicle = request.form.get("vehicle", "Unknown")
    conf = float(request.form.get("confidence", 0.0))

    timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    filename = f"violation_{datetime.now().strftime('%Y%m%d_%H%M%S')}.jpg"
    filepath = os.path.join(VIOLATIONS_DIR, filename)
    
    file.save(filepath)

    # Save to Database
    try:
        conn = sqlite3.connect(DB_PATH)
        cursor = conn.cursor()
        cursor.execute('''
            INSERT INTO violations (timestamp, type, vehicle_type, confidence, video_path, status)
            VALUES (?, ?, ?, ?, ?, ?)
        ''', (timestamp, v_type, vehicle, conf, filepath, "Pending"))
        conn.commit()
        conn.close()
        return jsonify({"status": "success", "id": cursor.lastrowid})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/violations", methods=["GET"])
def get_violations():
    """Returns a list of all recorded violations."""
    try:
        conn = sqlite3.connect(DB_PATH)
        cursor = conn.cursor()
        cursor.execute('SELECT * FROM violations ORDER BY id DESC')
        rows = cursor.fetchall()
        conn.close()

        violations = []
        for row in rows:
            violations.append({
                "id": row[0],
                "timestamp": row[1],
                "type": row[2],
                "vehicle_type": row[3],
                "confidence": row[4],
                "video_path": row[5],
                "status": row[6]
            })
        return jsonify(violations)
    except Exception as e:
        return jsonify({"error": str(e)}), 500


if __name__ == "__main__":
    print("RuleCam YOLO Backend starting...")
    print("Detection endpoint: http://localhost:5005/detect")
    app.run(host="0.0.0.0", port=5005, debug=True)
