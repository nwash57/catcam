from ultralytics import YOLO

WILDLIFE_NAMES = {"cat", "dog", "raccoon", "possum", "deer"}


class Detector:
    def __init__(self, model_name: str = "yolov8n.pt", confidence_threshold: float = 0.35):
        self.threshold = confidence_threshold
        self.model = YOLO(model_name)
        if len(self.model.names) > 20:
            # Stock COCO model (80 classes) — filter to wildlife only
            self._active_ids = {
                cls_id: name
                for cls_id, name in self.model.names.items()
                if name in WILDLIFE_NAMES
            }
        else:
            # Custom-trained model — every class is one of our animals
            self._active_ids = dict(self.model.names)

    def detect(self, bgr_frame) -> list[dict]:
        results = self.model(bgr_frame, conf=self.threshold, verbose=False)[0]

        detections = []
        for box in results.boxes:
            name = self._active_ids.get(int(box.cls[0]))
            if name is None:
                continue
            x1, y1, x2, y2 = box.xyxy[0].int().tolist()
            detections.append({
                "label": name,
                "confidence": float(box.conf[0]),
                "bbox": (x1, y1, x2, y2),
            })
        return detections
