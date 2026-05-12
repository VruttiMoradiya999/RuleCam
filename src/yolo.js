import * as ort from 'onnxruntime-web';
import { YOLO_CLASSES } from './yolo_classes';

let session = null;

export const loadModel = async () => {
  if (session) return true;
  try {
    ort.env.wasm.wasmPaths = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.19.2/dist/';
    
    // Safari crashes with multi-threading due to strict SharedArrayBuffer rules.
    // Chrome and Edge handle it fine, giving much better FPS.
    const isSafari = /^((?!chrome|android).)*safari/i.test(navigator.userAgent);
    if (isSafari) {
      ort.env.wasm.numThreads = 1; 
    }

    // WebGL lacks the 'Split' operator for YOLOv8, so we must use WASM.
    session = await ort.InferenceSession.create('/models/yolov8n.onnx', { 
      executionProviders: ['wasm'] 
    });
    console.log(`ONNX Model loaded with WASM! (Threads: ${isSafari ? 1 : 'Auto'})`);
    return true;
  } catch (e) {
    console.error("Failed to load ONNX model", e);
    return false;
  }
};

export const detectObjects = async (canvas, videoElement) => {
  if (!session) return [];
  
  // Resize to 640x640 using letterboxing (preserve aspect ratio)
  const width = 640;
  const height = 640;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  
  const vWidth = videoElement.videoWidth;
  const vHeight = videoElement.videoHeight;
  const scale = Math.min(width / vWidth, height / vHeight);
  const newWidth = vWidth * scale;
  const newHeight = vHeight * scale;
  const dx = (width - newWidth) / 2;
  const dy = (height - newHeight) / 2;

  // YOLO expects padding to be 114 (gray)
  ctx.fillStyle = 'rgb(114, 114, 114)';
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(videoElement, dx, dy, newWidth, newHeight);
  
  const imgData = ctx.getImageData(0, 0, width, height);
  const data = imgData.data;

  // Float32Array [1, 3, 640, 640]
  const input = new Float32Array(3 * width * height);
  for (let i = 0; i < width * height; i++) {
    input[i] = data[i * 4] / 255.0; // R
    input[i + width * height] = data[i * 4 + 1] / 255.0; // G
    input[i + 2 * width * height] = data[i * 4 + 2] / 255.0; // B
  }

  const tensor = new ort.Tensor('float32', input, [1, 3, width, height]);
  
  try {
    const results = await session.run({ [session.inputNames[0]]: tensor });
    const output = results[session.outputNames[0]].data;
    
    // output shape: [1, 84, 8400]
    const numClasses = 80;
    const numBoxes = 8400;
    const detections = [];

    for (let i = 0; i < numBoxes; i++) {
      let maxScore = 0;
      let classId = -1;
      
      for (let c = 0; c < numClasses; c++) {
        const score = output[(4 + c) * numBoxes + i];
        if (score > maxScore) {
          maxScore = score;
          classId = c;
        }
      }

      // Slightly lower threshold for recall, precision handles it later
      if (maxScore > 0.3) {
        const cx = output[0 * numBoxes + i];
        const cy = output[1 * numBoxes + i];
        const w = output[2 * numBoxes + i];
        const h = output[3 * numBoxes + i];

        // Remove padding and scale back to original video size
        const original_cx = (cx - dx) / scale;
        const original_cy = (cy - dy) / scale;
        const original_w = w / scale;
        const original_h = h / scale;

        const x1 = original_cx - original_w / 2;
        const y1 = original_cy - original_h / 2;
        const x2 = original_cx + original_w / 2;
        const y2 = original_cy + original_h / 2;

        detections.push({
          bbox: [x1, y1, x2, y2],
          object: YOLO_CLASSES[classId],
          confidence: maxScore
        });
      }
    }

    return applyNMS(detections, 0.45);
  } catch (e) {
    console.error(e);
    return [];
  }
};

const applyNMS = (boxes, iouThreshold) => {
  boxes.sort((a, b) => b.confidence - a.confidence);
  const result = [];
  while (boxes.length > 0) {
    result.push(boxes[0]);
    boxes = boxes.filter(box => calculateIOU(boxes[0].bbox, box.bbox) < iouThreshold);
  }
  return result;
};

const calculateIOU = (box1, box2) => {
  const [x1, y1, x2, y2] = box1;
  const [x3, y3, x4, y4] = box2;
  const xA = Math.max(x1, x3);
  const yA = Math.max(y1, y3);
  const xB = Math.min(x2, x4);
  const yB = Math.min(y2, y4);
  const interArea = Math.max(0, xB - xA) * Math.max(0, yB - yA);
  const box1Area = (x2 - x1) * (y2 - y1);
  const box2Area = (x4 - x3) * (y4 - y3);
  return interArea / (box1Area + box2Area - interArea);
};

// --- Violation Logic ---

export const getTrafficLightState = (videoElement, bbox) => {
  const [x1, y1, x2, y2] = bbox.map(Math.round);
  const w = x2 - x1;
  const h = y2 - y1;
  if (w <= 0 || h <= 0) return "unknown";

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(videoElement, x1, y1, w, h, 0, 0, w, h);
  
  const imgData = ctx.getImageData(0, 0, w, h).data;
  let redInt = 0, yellowInt = 0, greenInt = 0;

  const third = Math.floor(h / 3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = (y * w + x) * 4;
      const r = imgData[idx];
      const g = imgData[idx + 1];
      const b = imgData[idx + 2];
      
      // Simple color heuristics
      if (r > 150 && g < 100 && b < 100) {
        if (y < third) redInt++;
      } else if (r > 150 && g > 150 && b < 100) {
        if (y >= third && y < 2*third) yellowInt++;
      } else if (g > 150 && r < 100 && b < 100) {
        if (y >= 2*third) greenInt++;
      }
    }
  }

  const max = Math.max(redInt, yellowInt, greenInt);
  if (max < 10) return "unknown";
  if (max === redInt) return "red";
  if (max === yellowInt) return "yellow";
  return "green";
};

export const processSignalViolations = (detections, videoElement, lightStateHistory) => {
  let trafficLightState = "unknown";
  let lightYThreshold = 0.8;
  const h = videoElement.videoHeight;

  // Find light state
  const lights = detections.filter(d => d.object === "traffic light");
  if (lights.length > 0) {
    const light = lights[0];
    const [lx1, ly1, lx2, ly2] = light.bbox;
    lightYThreshold = ly2 / h;
    const currentState = getTrafficLightState(videoElement, light.bbox);
    if (currentState !== "unknown") {
      lightStateHistory.push(currentState);
      if (lightStateHistory.length > 5) lightStateHistory.shift();
    }
    
    if (lightStateHistory.length > 0) {
      // Get most common
      const counts = {};
      let maxCount = 0;
      lightStateHistory.forEach(s => {
        counts[s] = (counts[s] || 0) + 1;
        if (counts[s] > maxCount) {
          maxCount = counts[s];
          trafficLightState = s;
        }
      });
    }
  }

  let violationDetected = false;
  detections.forEach(det => {
    det.is_violating = false;
    if (det.object === "traffic light") det.light_state = trafficLightState;
    if (["car", "motorcycle", "bus", "truck"].includes(det.object) && det.confidence > 0.45 && ["red", "yellow"].includes(trafficLightState)) {
      const [x1, y1, x2, y2] = det.bbox;
      if ((y2 / h) > lightYThreshold && (y1 / h) < lightYThreshold + 0.1) {
        det.is_violating = true;
        violationDetected = true;
      }
    }
  });

  return { detections, violationDetected, trafficLightState };
};

export const processTripleRiding = (detections) => {
  const persons = detections.filter(d => d.object === "person" && d.confidence > 0.3);
  const motorcycles = detections.filter(d => d.object === "motorcycle" && d.confidence > 0.3).map(m => ({ ...m, people_count: 0 }));

  let violationDetected = false;

  motorcycles.forEach(bike => {
    const [bx1, by1, bx2, by2] = bike.bbox;
    persons.forEach(p => {
      const [px1, py1, px2, py2] = p.bbox;
      const pcx = (px1 + px2) / 2;
      const pcy = (py1 + py2) / 2;
      if (pcx >= bx1 - 20 && pcx <= bx2 + 20 && pcy >= by1 - 50 && pcy <= by2 + 20) {
        bike.people_count++;
      }
    });
    
    bike.is_violating = bike.people_count >= 3;
    if (bike.is_violating) violationDetected = true;
    bike.object = `Motorcycle (${bike.people_count} riders)`;
  });

  return { detections: [...motorcycles, ...persons], violationDetected };
};
