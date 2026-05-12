from flask import Flask, request, jsonify, send_from_directory
from flask_cors import CORS
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

@app.route("/", methods=["GET"])
def health():
    """Health check endpoint."""
    return jsonify({"status": "ok", "backend": "lightweight"})


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
    port = int(os.environ.get("PORT", 5005))
    app.run(host="0.0.0.0", port=port, debug=False)
