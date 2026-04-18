from ultralytics import YOLO

# COCO class IDs that count as "wildlife" — extend as you like
WILDLIFE_CLASSES = {
    14: "bird",
    15: "cat",
    16: "dog",
    17: "horse",
    18: "sheep",
    19: "cow",
    20: "elephant",
    21: "bear",
    22: "zebra",
    23: "giraffe",
}


class Detector:
    """Run YOLOv8 object detection and filter for wildlife classes."""

    def __init__(self, model_name: str = "yolov8n.pt", confidence_threshold: float = 0.35):
        self.threshold = confidence_threshold
        self.model = YOLO(model_name)

    def detect(self, bgr_frame) -> list[dict]:
        """Run detection on a BGR OpenCV frame. Returns list of detections."""
        results = self.model(bgr_frame, conf=self.threshold, verbose=False)[0]

        detections = []
        for box in results.boxes:
            cls_id = int(box.cls[0])
            if cls_id not in WILDLIFE_CLASSES:
                continue
            x1, y1, x2, y2 = box.xyxy[0].int().tolist()
            detections.append({
                "label": WILDLIFE_CLASSES[cls_id],
                "confidence": float(box.conf[0]),
                "bbox": (x1, y1, x2, y2),
            })
        return detections
