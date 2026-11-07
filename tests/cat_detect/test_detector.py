"""Tests for cat_detect.detector.Detector.

The real `ultralytics` model is replaced with `FakeModel`; see conftest.py for
why the package itself is stubbed.
"""

import pytest

from cat_detect.detector import Detector

# A COCO-style names map (>20 entries triggers Detector's wildlife-filter path).
COCO_NAMES = {i: f"class{i}" for i in range(25)}
COCO_NAMES[0] = "person"
COCO_NAMES[15] = "cat"
COCO_NAMES[16] = "dog"


class _Tensor:
    """Mimics the slice of the ultralytics tensor API that Detector touches."""

    def __init__(self, values):
        self._values = list(values)

    def int(self):
        return self

    def tolist(self):
        return list(self._values)


class FakeBox:
    def __init__(self, cls_id, confidence, xyxy):
        self.cls = [cls_id]
        self.conf = [confidence]
        self.xyxy = [_Tensor(xyxy)]


class FakeResults:
    def __init__(self, boxes):
        self.boxes = boxes


class FakeModel:
    def __init__(self, names, boxes=()):
        self.names = names
        self._boxes = list(boxes)
        self.calls = []

    def __call__(self, frame, conf=None, verbose=None):
        self.calls.append({"frame": frame, "conf": conf})
        return [FakeResults(self._boxes)]


@pytest.fixture
def patch_yolo(monkeypatch):
    """Return a helper that wires a FakeModel in as the loaded YOLO model."""

    def _install(model):
        monkeypatch.setattr("cat_detect.detector.YOLO", lambda name: model)
        return model

    return _install


def test_coco_model_keeps_only_wildlife_classes(patch_yolo):
    patch_yolo(FakeModel(COCO_NAMES))
    detector = Detector()
    assert set(detector._active_ids.values()) == {"cat", "dog"}


def test_custom_model_keeps_every_class(patch_yolo):
    patch_yolo(FakeModel({0: "cat", 1: "raccoon", 2: "mittens"}))
    detector = Detector()
    assert detector._active_ids == {0: "cat", 1: "raccoon", 2: "mittens"}


def test_detect_maps_boxes_and_drops_non_wildlife(patch_yolo):
    boxes = [
        FakeBox(15, 0.91, [10, 20, 110, 220]),  # cat — kept
        FakeBox(0, 0.88, [0, 0, 50, 50]),       # person — dropped
    ]
    patch_yolo(FakeModel(COCO_NAMES, boxes))
    detector = Detector(confidence_threshold=0.5)

    result = detector.detect("frame-sentinel")

    assert result == [
        {"label": "cat", "confidence": pytest.approx(0.91), "bbox": (10, 20, 110, 220)},
    ]


def test_detect_passes_confidence_threshold_to_model(patch_yolo):
    model = patch_yolo(FakeModel(COCO_NAMES))
    detector = Detector(confidence_threshold=0.42)

    detector.detect("frame-sentinel")

    assert model.calls[0]["conf"] == 0.42
