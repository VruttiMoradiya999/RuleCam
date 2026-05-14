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
CORS(app, resources={r"/*": {"origins": "*"}})

import logging
log = logging.getLogger('werkzeug')
log.setLevel(logging.ERROR)

videodb_lock = threading.Lock()
light_state_history = []
HISTORY_SIZE = 5
VIOLATIONS_DIR = "violations"
DB_PATH = "database.db"
VIDEODB_API_KEY = os.getenv("VIDEODB_API_KEY", "")
if not os.path.exists(VIOLATIONS_DIR):
    os.makedirs(VIOLATIONS_DIR)

@app.route('/violations/<filename>')
def serve_violation(filename):
    return send_from_directory(VIOLATIONS_DIR, filename)

@app.route("/", methods=["GET"])
def health():
    return jsonify({"status": "ok", "model": "yolov8n"})

def init_db():
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS violations (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            timestamp TEXT NOT NULL,
            type TEXT NOT NULL,
            video_path TEXT,
            vehicle_type TEXT,
            status TEXT,
            videodb_url TEXT,
            ai_analysis TEXT,
            videodb_id TEXT
        )
    ''')
    conn.commit()
    conn.close()

init_db()
model = YOLO("yolov8n.pt")

def clip_video_opencv(file_path, start_sec, duration, out_path):
    """Clip a video segment using OpenCV (no ffmpeg needed)."""
    cap = cv2.VideoCapture(file_path)
    fps = cap.get(cv2.CAP_PROP_FPS)
    if fps <= 0: fps = 30
    w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    
    fourcc = cv2.VideoWriter_fourcc(*'mp4v')
    out = cv2.VideoWriter(out_path, fourcc, fps, (w, h))
    
    cap.set(cv2.CAP_PROP_POS_MSEC, start_sec * 1000)
    frames_needed = int(fps * duration)
    written = 0
    
    while written < frames_needed:
        ret, frame = cap.read()
        if not ret: break
        out.write(frame)
        written += 1
    
    cap.release()
    out.release()
    print(f"[Clip] Wrote {written} frames to {os.path.basename(out_path)}")
    return written > 0

def yolo_extract_violation_clip(file_path, v_type):
    """Extract violation clips from video. For Manual uploads, just clips first 10s."""
    
    
    cap = cv2.VideoCapture(file_path)
    fps = cap.get(cv2.CAP_PROP_FPS)
    if fps <= 0: fps = 30
    
    violation_clips = []
    violation_times = []
    frame_count = 0
    
    total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    if total_frames <= 0: total_frames = int(fps * 600)
    total_duration = total_frames / fps
    
    # Scan the whole video
    scan_limit = total_frames
    
    # Scan every 5 seconds
    step = max(1, int(fps * 5))
    
    print(f"[YOLO] Scanning first {scan_limit/fps:.0f}s of {total_duration:.0f}s video (step={step})...")
    
    while frame_count < scan_limit:
        ret, frame = cap.read()
        if not ret: break
        
        if frame_count % step == 0:
            current_time = frame_count / fps
            print(f"[YOLO] Scanning at {current_time:.0f}s...")
            
            if any(abs(current_time - t) < 15 for t in violation_times):
                frame_count += 1
                continue
            
            results = model(frame, imgsz=320, verbose=False)
            h, w = frame.shape[:2]

            v_found = False
            # 1. Triple Riding Detection
            persons = []
            motorcycles = []
            for r in results:
                for box in r.boxes:
                    cls_name = model.names[int(box.cls[0])]
                    if cls_name == "person":
                        persons.append(box.xyxy[0].tolist())
                    elif cls_name == "motorcycle":
                        motorcycles.append({"box": box.xyxy[0].tolist(), "count": 0})
            
            for p in persons:
                px1, py1, px2, py2 = p
                p_area = (px2 - px1) * (py2 - py1)
                if p_area <= 0: continue
                for i, m in enumerate(motorcycles):
                    bx1, by1, bx2, by2 = m["box"]
                    ix1, iy1 = max(px1, bx1), max(py1, by1)
                    ix2, iy2 = min(px2, bx2), min(py2, by2)
                    if ix1 < ix2 and iy1 < iy2:
                        if ((ix2 - ix1) * (iy2 - iy1)) / p_area > 0.4:
                            motorcycles[i]["count"] += 1
            
            if any(m["count"] >= 3 for m in motorcycles):
                v_found = True
            
            # 2. Signal Violation Detection
            if not v_found:
                light_state = "unknown"
                light_y = 0.8
                for r in results:
                    for box in r.boxes:
                        if model.names[int(box.cls[0])] == "traffic light":
                            lx1, ly1, lx2, ly2 = map(int, box.xyxy[0].tolist())
                            light_y = ly2 / h
                            if ly2 > ly1 and lx2 > lx1:
                                crop = frame[ly1:ly2, lx1:lx2]
                                hsv = cv2.cvtColor(crop, cv2.COLOR_BGR2HSV)
                                r_m = cv2.inRange(hsv, np.array([0, 70, 50]), np.array([10, 255, 255]))
                                if np.sum(r_m) > 500: light_state = "red"
                
                if light_state == "red":
                    for r in results:
                        for box in r.boxes:
                            if model.names[int(box.cls[0])] in ["car", "motorcycle"]:
                                if (box.xyxy[0][3] / h) > light_y:
                                    v_found = True
            
            if v_found:
                print(f"[YOLO] Violation found at {current_time:.1f}s!")
                violation_times.append(current_time)
                start_clip = max(0, current_time - 5)
                out_filename = f"violation_{datetime.now().strftime('%Y%m%d_%H%M%S')}_v{len(violation_times)}.mp4"
                out_path = os.path.join(VIOLATIONS_DIR, out_filename)
                cap.release()  # Release before clipping
                clip_video_opencv(file_path, start_clip, 10, out_path)
                if os.path.exists(out_path):
                    violation_clips.append(out_path)
                # Re-open to continue scanning
                cap = cv2.VideoCapture(file_path)
                cap.set(cv2.CAP_PROP_POS_FRAMES, frame_count)

        frame_count += 1
        
    cap.release()
    
    # Fallback: clip first 10 seconds
    if not violation_clips:
        print("[YOLO] No violation found. Clipping first 10s as fallback.")
        fallback_name = f"violation_{datetime.now().strftime('%Y%m%d_%H%M%S')}_fallback.mp4"
        fallback_path = os.path.join(VIOLATIONS_DIR, fallback_name)
        if clip_video_opencv(file_path, 0, 10, fallback_path):
            violation_clips.append(fallback_path)
    
    print(f"[YOLO] Done. Found {len(violation_clips)} clip(s).")
    return violation_clips

def update_progress(record_id, text):
    try:
        conn_db = sqlite3.connect(DB_PATH)
        cursor = conn_db.cursor()
        cursor.execute('UPDATE violations SET ai_analysis = ? WHERE id = ?', (text, record_id))
        conn_db.commit()
        conn_db.close()
    except:
        pass

def process_videodb_workflow(file_path, record_id):
    if not VIDEODB_API_KEY:
        return
    
    # Small delay to ensure DB commit is finished
    time.sleep(0.5)
    
    conn_db = sqlite3.connect(DB_PATH)
    cursor = conn_db.cursor()
    cursor.execute('SELECT type FROM violations WHERE id = ?', (record_id,))
    row = cursor.fetchone()
    conn_db.close()
    
    if not row:
        print(f"Error: Record {record_id} not found in database.")
        return
    v_type = row[0]

    with videodb_lock:
        try:
            update_progress(record_id, "Analyzing video using YOLO to find potential violations...")
            clips = yolo_extract_violation_clip(file_path, v_type)
            
            if not clips:
                update_progress(record_id, "No violations detected by YOLO.")
                return

            conn = videodb.connect(api_key=VIDEODB_API_KEY)
            
            for i, clip_path in enumerate(clips):
                rid = record_id if i == 0 else -1
                if rid == -1:
                    conn_db = sqlite3.connect(DB_PATH)
                    cursor = conn_db.cursor()
                    cursor.execute('INSERT INTO violations (timestamp, type, status) VALUES (?, ?, ?)', 
                                   (datetime.now().strftime("%Y-%m-%d %H:%M:%S"), v_type, "Pending"))
                    rid = cursor.lastrowid
                    conn_db.commit()
                    conn_db.close()

                update_progress(rid, f"Uploading clip {i+1} to VideoDB...")
                video = conn.upload(clip_path)
                
                timeline = Timeline(conn)
                video_asset = VideoAsset(id=video.id, start=0)
                track = Track()
                track.add_clip(0, Clip(asset=video_asset, duration=video.length))
                timeline.add_track(track)
                stream_url = timeline.generate_stream()
                
                update_progress(rid, f"AI analysis for clip {i+1}...")
                video.index_scenes(extraction_type=SceneExtractionType.shot_based)
                
                # Poll for scenes (wait up to 60s)
                scenes = []
                scene_context = ""
                for attempt in range(6):
                    time.sleep(10)
                    try:
                        indexes = video.list_scene_index()
                        if indexes and len(indexes) > 0:
                            idx_id = indexes[0].get('scene_index_id') if isinstance(indexes[0], dict) else indexes[0]
                            scenes = video.get_scene_index(idx_id)
                            if scenes:
                                for j, s in enumerate(scenes[:8]):
                                    desc = s.get('description', '') if isinstance(s, dict) else str(s)
                                    if desc: scene_context += f"Scene {j+1}: {desc}\n"
                                break
                        print(f"[VideoDB] Waiting for indexing (attempt {attempt+1}/6)...")
                    except Exception as e:
                        print(f"[VideoDB] Indexing poll error: {e}")

                status = "Rejected"
                analysis = "No violation confirmed by AI."

                if scene_context:
                    # Use LLM to confirm violation based on scenes (matches chat logic)
                    coll = conn.get_collection()
                    prompt = f"""Analyze these video scenes and determine if there is a traffic violation (specifically looking for: {v_type}). 
SCENES:
{scene_context}

Respond with exactly 'VERDICT: CONFIRMED' if a violation is present, or 'VERDICT: REJECTED' if not. Then provide a one-sentence explanation."""
                    
                    try:
                        llm_res = coll.generate_text(prompt)
                        res_text = llm_res.get('output', str(llm_res)) if isinstance(llm_res, dict) else str(llm_res)
                        
                        if "CONFIRMED" in res_text.upper():
                            status = "Confirmed"
                            analysis = f"AI Confirmed: {res_text.split('CONFIRMED')[-1].strip(': ').strip()}"
                        else:
                            status = "Rejected"
                            analysis = f"AI Rejected: {res_text.split('REJECTED')[-1].strip(': ').strip()}"
                    except Exception as e:
                        print(f"[VideoDB] LLM Analysis error: {e}")
                        # Fallback to basic search if LLM fails
                        try:
                            search_results = video.search("identify traffic violation")
                            if search_results and len(search_results) > 0:
                                status = "Confirmed"
                                analysis = f"Confirmed via search fallback ({len(search_results)} results)."
                        except:
                            pass
                else:
                    # Fallback if scenes never ready
                    analysis = "Rejected: Video scene data never became available for analysis."
                
                conn_db = sqlite3.connect(DB_PATH)
                cursor = conn_db.cursor()
                cursor.execute('UPDATE violations SET videodb_url=?, video_path=?, videodb_id=?, status=?, ai_analysis=? WHERE id=?', 
                               (stream_url, os.path.basename(clip_path), video.id, status, analysis, rid))
                conn_db.commit()
                conn_db.close()

            if os.path.exists(file_path):
                os.remove(file_path)
                
        except Exception as e:
            import traceback
            traceback.print_exc()
            update_progress(record_id, f"Error: {str(e)}")

@app.route("/report_violation", methods=["POST"])
def report_violation():
    if "media" not in request.files:
        return jsonify({"error": "No media file provided"}), 400

    file = request.files["media"]
    v_type = request.form.get("type", "General Violation")
    timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    
    filename = f"violation_{datetime.now().strftime('%Y%m%d_%H%M%S')}.mp4"
    filepath = os.path.join(VIOLATIONS_DIR, filename)
    file.save(filepath)

    try:
        conn = sqlite3.connect(DB_PATH)
        cursor = conn.cursor()
        cursor.execute('INSERT INTO violations (timestamp, type, video_path, status) VALUES (?, ?, ?, ?)', 
                       (timestamp, v_type, filename, "Pending"))
        record_id = cursor.lastrowid
        conn.commit()
        conn.close()
    except Exception as e:
        print(f"DB Error: {e}")
        record_id = -1
        
    threading.Thread(target=process_videodb_workflow, args=(filepath, record_id)).start()
    return jsonify({"status": "success", "id": record_id})

@app.route('/violations', methods=['GET'])
def get_violations():
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()
    cursor.execute('SELECT id, timestamp, type, video_path, vehicle_type, status, videodb_url, ai_analysis, videodb_id FROM violations ORDER BY id DESC')
    rows = cursor.fetchall()
    conn.close()
    
    violations = []
    for r in rows:
        violations.append({
            "id": r[0], "timestamp": r[1], "type": r[2], "video_path": r[3], "vehicle_type": r[4], 
            "status": r[5], "videodb_url": r[6], "ai_analysis": r[7], "videodb_id": r[8]
        })
    return jsonify(violations)

@app.route('/chat_with_video', methods=['POST'])
def chat_with_video():
    data = request.json
    video_id = data.get('video_id')
    question = data.get('question')
    if not video_id or not question:
        return jsonify({"error": "Missing video_id or question"}), 400
    try:
        conn = videodb.connect(api_key=VIDEODB_API_KEY)
        coll = conn.get_collection()
        
        try:
            video = coll.get_video(video_id)
        except Exception:
            return jsonify({"answer": "This video is no longer available in VideoDB. It may have expired or been removed."})
        
        # Get scene descriptions
        scene_context = ""
        try:
            indexes = video.list_scene_index()
            if indexes and len(indexes) > 0:
                idx_id = indexes[0].get('scene_index_id') if isinstance(indexes[0], dict) else indexes[0]
                scenes = video.get_scene_index(idx_id)
                if scenes:
                    for i, s in enumerate(scenes[:8]):
                        desc = s.get('description', '') if isinstance(s, dict) else str(s)
                        if desc:
                            scene_context += f"Scene {i+1}: {desc}\n"
        except Exception as e:
            print(f"[Chat] Could not get scenes: {e}")
        
        if not scene_context:
            return jsonify({"answer": "Video scene data is not available yet. Please try again in a moment."})
        
        # Use VideoDB's built-in LLM to answer the question
        prompt = f"""You are a traffic violation analysis AI. Based on the following video scene descriptions, answer the user's question concisely and clearly.

VIDEO SCENES:
{scene_context}

USER QUESTION: {question}

Answer directly and specifically. If the user asks about violations, identify any traffic rules being broken (e.g., triple riding, signal jumping, no helmet, overspeeding). Keep your answer under 200 words."""

        try:
            result = coll.generate_text(prompt)
            if isinstance(result, dict):
                answer = result.get('output', str(result))
            else:
                answer = str(result)
        except Exception as e:
            print(f"[Chat] generate_text error: {e}")
            answer = f"AI could not process your question at this time."
        
        return jsonify({"answer": answer})
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route("/delete_violation/<int:violation_id>", methods=["POST"])
def delete_violation(violation_id):
    try:
        conn = sqlite3.connect(DB_PATH)
        cursor = conn.cursor()
        cursor.execute('SELECT video_path FROM violations WHERE id = ?', (violation_id,))
        row = cursor.fetchone()
        if row:
            file_path = os.path.join(VIOLATIONS_DIR, row[0])
            if os.path.exists(file_path): os.remove(file_path)
        cursor.execute('DELETE FROM violations WHERE id = ?', (violation_id,))
        conn.commit()
        conn.close()
        return jsonify({"status": "success"})
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route("/clear_violations", methods=["POST"])
def clear_violations():
    try:
        conn = sqlite3.connect(DB_PATH)
        cursor = conn.cursor()
        cursor.execute('DELETE FROM violations')
        conn.commit()
        conn.close()
        for filename in os.listdir(VIOLATIONS_DIR):
            file_path = os.path.join(VIOLATIONS_DIR, filename)
            if os.path.isfile(file_path): os.unlink(file_path)
        return jsonify({"status": "success"})
    except Exception as e:
        return jsonify({"error": str(e)}), 500

if __name__ == "__main__":
    print("RuleCam YOLO Backend starting...")
    app.run(host="0.0.0.0", port=5005, debug=False)
