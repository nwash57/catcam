"""Tests for auto_label.labeler.AutoLabeler.

The real `ultralytics` model is replaced with `FakeWorldModel`; see conftest.py
for why the package itself is stubbed.
"""

import pytest

from auto_label.labeler import AutoLabeler


class _Tensor:
    def __init__(self, values):
        self._values = list(values)

    def tolist(self):
        return list(self._values)


class FakeBox:
    def __init__(self, cls_id, confidence, xyxy):
        self.cls = [cls_id]
        self.conf = [confidence]
        self.xyxy = [_Tensor(xyxy)]


class FakeResults:
    def __init__(self, boxes, orig_shape, names=None):
        self.boxes = boxes
        self.orig_shape = orig_shape
        self.names = names or {}


class FakeWorldModel:
    def __init__(self, results):
        self._results = results
        self.classes = None

    def set_classes(self, classes):
        self.classes = classes

    def __call__(self, image_path, conf=None, verbose=None):
        return [self._results]


def test_absolute_model_path_must_exist(tmp_path):
    missing = tmp_path / "nope.pt"  # absolute path that does not exist
    with pytest.raises(FileNotFoundError):
        AutoLabeler(str(missing))


def test_stock_model_classes_are_registered(monkeypatch):
    fake = FakeWorldModel(FakeResults([], orig_shape=(100, 100)))
    monkeypatch.setattr("auto_label.labeler.YOLOWorld", lambda model: fake)

    AutoLabeler("yolov8x-worldv2.pt")

    assert fake.classes == ["cat", "dog", "raccoon", "possum", "deer"]


def test_label_file_normalizes_bounding_boxes(monkeypatch):
    box = FakeBox(0, 0.7, [50, 100, 150, 300])  # class 0 -> "cat"
    results = FakeResults([box], orig_shape=(400, 200))  # h=400, w=200
    monkeypatch.setattr(
        "auto_label.labeler.YOLOWorld", lambda model: FakeWorldModel(results)
    )
    labeler = AutoLabeler("yolov8x-worldv2.pt")

    out = labeler.label_file("frame.jpg")

    assert out == [
        {
            "species": "cat",
            "confidence": pytest.approx(0.7),
            "bbox": {"x": 0.25, "y": 0.25, "width": 0.5, "height": 0.5},
        }
    ]
