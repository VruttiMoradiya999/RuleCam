from flask import Flask, request, jsonify, send_from_directory
from flask_cors import CORS
from ultralytics import YOLO
import cv2
import numpy as np
import sqlite3
import os
from datetime import datetime
import threading
import time
import videodb
from videodb import SceneExtractionType
from videodb.editor import Timeline, Track, Clip, VideoAsset
from dotenv import load_dotenv
import base64

load_dotenv()

app = Flask(__name__)
# Enable CORS for all routes
CORS(app, resources={r"/*": {"origins": "*"}})

# Disable Flask default request logging to keep console clean for VideoDB logs
import logging
log = logging.getLogger('werkzeug')
log.setLevel(logging.ERROR)

# Lock for sequential VideoDB processing to avoid bandwidth saturation
videodb_lock = threading.Lock()

# Global state for temporal smoothing
light_state_history = []
HISTORY_SIZE = 5

# Configuration
VIOLATIONS_DIR = "violations"
DB_PATH = "database.db"
VIDEODB_API_KEY = os.getenv("VIDEODB_API_KEY", "")

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
            videodb_url TEXT,
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


@app.route("/detect_signal", methods=["POST"])
def detect_signal():
    """Handles real-time detection for Signal Jumping."""
    data = request.json
    img_data = data.get("image", "")
    if not img_data: return jsonify({"error": "No image data"}), 400
    
    img_bytes = base64.b64decode(img_data.split(",")[1])
    nparr = np.frombuffer(img_bytes, np.uint8)
    img = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
    results = model(img)
    violation_detected = False
    h, w = img.shape[:2]
    detections = []
    
    traffic_light_state = "unknown"
    light_y_threshold = 0.8
    for result in results:
        for box in result.boxes:
            if model.names[int(box.cls[0])] == "traffic light":
                xyxy = box.xyxy[0].tolist()
                lx1, ly1, lx2, ly2 = map(int, xyxy)
                light_y_threshold = ly2 / h
                if ly2 > ly1 and lx2 > lx1:
                    crop = img[ly1:ly2, lx1:lx2]
                    hsv_crop = cv2.cvtColor(crop, cv2.COLOR_BGR2HSV)
                    mask_red = cv2.addWeighted(cv2.inRange(hsv_crop, np.array([0, 70, 50]), np.array([10, 255, 255])), 1.0, cv2.inRange(hsv_crop, np.array([170, 70, 50]), np.array([180, 255, 255])), 1.0, 0)
                    mask_yellow = cv2.inRange(hsv_crop, np.array([20, 100, 100]), np.array([30, 255, 255]))
                    mask_green = cv2.inRange(hsv_crop, np.array([40, 50, 50]), np.array([90, 255, 255]))
                    height = crop.shape[0]
                    third = height // 3
                    if third > 0:
                        ri, yi, gi = np.sum(mask_red[0:third, :]), np.sum(mask_yellow[third:2*third, :]), np.sum(mask_green[2*third:height, :])
                        max_i = max(ri, yi, gi)
                        if max_i > 800:
                            cs = "red" if ri == max_i else "yellow" if yi == max_i else "green"
                            light_state_history.append(cs)
                            if len(light_state_history) > HISTORY_SIZE: light_state_history.pop(0)
                    if light_state_history:
                        from collections import Counter
                        traffic_light_state = Counter(light_state_history).most_common(1)[0][0]

    for result in results:
        for box in result.boxes:
            name = model.names[int(box.cls[0])]
            if name in ["car", "motorcycle", "bus", "truck", "traffic light"]:
                conf = float(box.conf[0])
                xyxy = box.xyxy[0].tolist()
                is_violating = False
                if name != "traffic light" and conf > 0.45 and traffic_light_state in ["red", "yellow"]:
                    if (xyxy[3]/h) > light_y_threshold and (xyxy[1]/h) < light_y_threshold + 0.1:
                        is_violating = True
                        violation_detected = True
                detections.append({
                    "bbox": [round(c, 1) for c in xyxy],
                    "object": name,
                    "confidence": round(conf, 2),
                    "is_violating": is_violating,
                    "light_state": traffic_light_state if name == "traffic light" else None
                })
    return jsonify({"detections": detections, "image_shape": [h, w], "violation_detected": violation_detected, "traffic_light_state": traffic_light_state})


@app.route("/detect_triple", methods=["POST"])
def detect_triple():
    """Handles real-time detection for Triple Riding."""
    data = request.json
    img_data = data.get("image", "")
    if not img_data: return jsonify({"error": "No image data"}), 400
    
    img_bytes = base64.b64decode(img_data.split(",")[1])
    nparr = np.frombuffer(img_bytes, np.uint8)
    img = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
    results = model(img)
    violation_detected = False
    h, w = img.shape[:2]
    detections = []
    
    persons, motorcycles = [], []
    for result in results:
        for box in result.boxes:
            name = model.names[int(box.cls[0])]
            conf = float(box.conf[0])
            if conf < 0.3: continue
            xyxy = box.xyxy[0].tolist()
            if name == "person": persons.append(xyxy)
            elif name == "motorcycle": motorcycles.append({"box": xyxy, "conf": conf, "people_count": 0})
    
    for bike in motorcycles:
        bx1, by1, bx2, by2 = bike["box"]
        for px1, py1, px2, py2 in persons:
            p_cx, p_cy = (px1 + px2) / 2, (py1 + py2) / 2
            if bx1-20 <= p_cx <= bx2+20 and by1-50 <= p_cy <= by2+20: bike["people_count"] += 1
        is_violating = bike["people_count"] >= 3
        if is_violating: violation_detected = True
        detections.append({
            "bbox": [round(c, 1) for c in bike["box"]],
            "object": f"Motorcycle ({bike['people_count']} riders)",
            "confidence": round(bike["conf"], 2),
            "is_violating": is_violating
        })
    for p in persons:
        detections.append({"bbox": [round(c, 1) for c in p], "object": "person", "confidence": 0.5, "is_violating": False})
        
    return jsonify({"detections": detections, "image_shape": [h, w], "violation_detected": violation_detected, "traffic_light_state": "N/A"})


def process_videodb_workflow(file_path, record_id):
    """Background task to handle VideoDB upload, streaming, and AI analysis."""
    if not VIDEODB_API_KEY:
        print(f"[{datetime.now().strftime('%H:%M:%S')}] [VideoDB] No API Key found.")
        return
    
    with videodb_lock:
        try:
            print(f"[{datetime.now().strftime('%H:%M:%S')}] [VideoDB] Processing record {record_id}...")
            
            # Use a timeout for the entire process if possible, or just log steps
            start_time = time.time()
            conn = videodb.connect(api_key=VIDEODB_API_KEY)
            
            # 1. Upload
            print(f"[{datetime.now().strftime('%H:%M:%S')}] [VideoDB] Uploading {file_path} (Size: {os.path.getsize(file_path)} bytes)...")
            video = conn.upload(file_path)
            upload_time = time.time() - start_time
            print(f"[{datetime.now().strftime('%H:%M:%S')}] [VideoDB] Upload success in {upload_time:.1f}s. ID: {video.id}")
            
            # 2. Generate Stream URL (Asset -> Clip -> Track -> Timeline)
            timeline = Timeline(conn)
            video_asset = VideoAsset(id=video.id, start=0)
            # Create a clip of the whole video using its actual length
            clip = Clip(asset=video_asset, duration=video.length)
            track = Track()
            track.add_clip(0, clip)
            timeline.add_track(track)
            
            stream_url = timeline.generate_stream()
            
            # Update DB
            conn_db = sqlite3.connect(DB_PATH)
            cursor = conn_db.cursor()
            cursor.execute('UPDATE violations SET videodb_url = ? WHERE id = ?', (stream_url, record_id))
            conn_db.commit()
            
            # 3. AI Analysis
            conn_db = sqlite3.connect(DB_PATH)
            cursor = conn_db.cursor()
            cursor.execute('SELECT type FROM violations WHERE id = ?', (record_id,))
            v_type = cursor.fetchone()[0]
            
            prompt = "Analyze this traffic camera footage."
            if "Signal" in v_type:
                prompt += " Identify if any vehicle crosses the stop line while the traffic light is red or yellow. Focus on 'signal jumping'."
            else:
                prompt += " Identify if there are 3 or more people riding on a single motorcycle. Focus on 'triple riding'."
            prompt += " Describe the vehicle type and color clearly."
            
            print(f"[{datetime.now().strftime('%H:%M:%S')}] [VideoDB] AI Analyzing for {v_type}...")
            index_id = video.index_scenes(extraction_type=SceneExtractionType.shot_based, prompt=prompt)
            
            # Wait for AI processing
            print(f"[{datetime.now().strftime('%H:%M:%S')}] [VideoDB] Index ID: {index_id}. Waiting for processing...")
            time.sleep(15) 
            
            try:
                scene_index = video.get_scene_index(index_id)
                analysis_text = "No clear violation description found."
                if scene_index:
                    # Collect descriptions from all scenes
                    descriptions = [scene.get('description', '') for scene in scene_index]
                    analysis_text = " ".join([d for d in descriptions if d])
                    print(f"[{datetime.now().strftime('%H:%M:%S')}] [VideoDB] AI Analysis Success.")
            except Exception as e:
                print(f"[{datetime.now().strftime('%H:%M:%S')}] [VideoDB] Fetch Error: {e}")
                analysis_text = "Analysis fetch failed, please check VideoDB dashboard."
            
            cursor.execute('UPDATE violations SET ai_analysis = ? WHERE id = ?', (analysis_text, record_id))
            conn_db.commit()
            conn_db.close()
            print(f"[{datetime.now().strftime('%H:%M:%S')}] [VideoDB] Done for record {record_id}.")
            
        except Exception as e:
            print(f"[{datetime.now().strftime('%H:%M:%S')}] [VideoDB] ERROR: {e}")

# Note: upload_to_videodb is now deprecated in favor of process_videodb_workflow


@app.route("/report_violation", methods=["POST"])
def report_violation():
    """
    Endpoint to report a confirmed violation.
    Saves the media (image or video) and records metadata in the database.
    """
    if "media" not in request.files:
        return jsonify({"error": "No media file provided"}), 400

    file = request.files["media"]
    v_type = request.form.get("type", "General Violation")
    vehicle = request.form.get("vehicle", "Unknown")
    conf = float(request.form.get("confidence", 0.0))

    timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    
    # Determine extension based on content type or filename
    ext = ".jpg"
    if file.filename:
        _, file_ext = os.path.splitext(file.filename)
        if file_ext:
            ext = file_ext
    
    filename = f"violation_{datetime.now().strftime('%Y%m%d_%H%M%S')}{ext}"
    filepath = os.path.join(VIOLATIONS_DIR, filename)
    
    file.save(filepath)

    # Save to Database first to get the ID
    try:
        conn = sqlite3.connect(DB_PATH)
        cursor = conn.cursor()
        cursor.execute('''
            INSERT INTO violations (timestamp, type, vehicle_type, confidence, video_path, status)
            VALUES (?, ?, ?, ?, ?, ?)
        ''', (timestamp, v_type, vehicle, conf, filename, "Pending"))
        record_id = cursor.lastrowid
        conn.commit()
        conn.close()
        
        # Start the entire VideoDB workflow in a separate thread
        threading.Thread(target=process_videodb_workflow, args=(filepath, record_id)).start()
        
        return jsonify({"status": "success", "id": record_id, "local_path": filename})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/violations", methods=["GET"])
def get_violations():
    """Returns a list of all recorded violations."""
    try:
        conn = sqlite3.connect(DB_PATH)
        cursor = conn.cursor()
        # Use explicit column names for safety
        cursor.execute('SELECT id, timestamp, type, vehicle_type, confidence, video_path, videodb_url, status, ai_analysis FROM violations ORDER BY id DESC')
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
                "videodb_url": row[6],
                "status": row[7],
                "ai_analysis": row[8] if len(row) > 8 else None
            })
        return jsonify(violations)
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/delete_violation/<int:violation_id>", methods=["POST"])
def delete_violation(violation_id):
    """Deletes a specific violation record and its local media file."""
    try:
        conn = sqlite3.connect(DB_PATH)
        cursor = conn.cursor()
        
        # Get filename before deleting
        cursor.execute('SELECT video_path FROM violations WHERE id = ?', (violation_id,))
        row = cursor.fetchone()
        
        if row:
            filename = row[0]
            file_path = os.path.join(VIOLATIONS_DIR, filename)
            if os.path.exists(file_path):
                os.remove(file_path)
        
        cursor.execute('DELETE FROM violations WHERE id = ?', (violation_id,))
        conn.commit()
        conn.close()
        return jsonify({"status": "success", "message": f"Violation {violation_id} deleted"})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/clear_violations", methods=["POST"])
def clear_violations():
    """Deletes all violation records and local media files."""
    try:
        # Delete from database
        conn = sqlite3.connect(DB_PATH)
        cursor = conn.cursor()
        cursor.execute('DELETE FROM violations')
        conn.commit()
        conn.close()
        
        # Delete local files
        for filename in os.listdir(VIOLATIONS_DIR):
            file_path = os.path.join(VIOLATIONS_DIR, filename)
            try:
                if os.path.isfile(file_path):
                    os.unlink(file_path)
            except Exception as e:
                print(f"Error deleting file {file_path}: {e}")
                
        return jsonify({"status": "success", "message": "All violations cleared"})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


if __name__ == "__main__":
    print("RuleCam YOLO Backend starting...")
    print("Detection endpoint: http://localhost:5005/detect")
    app.run(host="0.0.0.0", port=5005, debug=True)
