from pathlib import Path

from ultralytics import YOLO, YOLOWorld


class AutoLabeler:
    CLASSES = ["cat", "dog", "raccoon", "possum", "deer"]

    def __init__(self, model: str = "yolov8x-worldv2.pt", conf: float = 0.25):
        if Path(model).is_absolute():
            # Fine-tuned model — class names are embedded; may be species or individual subject names
            self.model = YOLO(model)
            self.CLASSES = None
        else:
            # Stock YOLOWorld — use open-vocab detection with explicit class list
            self.model = YOLOWorld(model)
            self.model.set_classes(self.CLASSES)
        self.conf = conf

    def label_file(self, image_path: str) -> list[dict]:
        results = self.model(image_path, conf=self.conf, verbose=False)[0]
        names = self.CLASSES if self.CLASSES else results.names
        h, w = results.orig_shape
        out = []
        for box in results.boxes:
            x1, y1, x2, y2 = box.xyxy[0].tolist()
            out.append({
                "species": names[int(box.cls[0])],
                "confidence": float(box.conf[0]),
                "bbox": {
                    "x": x1 / w,
                    "y": y1 / h,
                    "width": (x2 - x1) / w,
                    "height": (y2 - y1) / h,
                },
            })
        return out
