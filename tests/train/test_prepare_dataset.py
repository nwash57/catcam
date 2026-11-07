"""Tests for the dataset-prep helpers in train/prepare_dataset.py."""

import json

import prepare_dataset


def _write_annotations(event_dir, subjects, snapshots):
    event_dir.mkdir(parents=True, exist_ok=True)
    (event_dir / "annotations.json").write_text(
        json.dumps({"subjects": subjects, "snapshots": snapshots})
    )


def test_get_label_prefers_subject_name():
    assert prepare_dataset.get_label({"name": "Mittens", "species": "cat"}) == "Mittens"


def test_get_label_falls_back_to_species_when_name_blank():
    assert prepare_dataset.get_label({"name": "   ", "species": "cat"}) == "cat"


def test_get_label_falls_back_to_species_when_name_missing():
    assert prepare_dataset.get_label({"species": "raccoon"}) == "raccoon"


def test_build_class_list_orders_named_classes_before_species(tmp_path):
    _write_annotations(
        tmp_path / "event_1",
        subjects=[
            {"id": "s1", "species": "cat", "name": "Mittens"},
            {"id": "s2", "species": "dog", "name": ""},
        ],
        snapshots=[
            {
                "filename": "a.jpg",
                "annotations": [
                    {
                        "subjectId": "s1",
                        "includeInTraining": True,
                        "boundingBox": {"x": 0, "y": 0, "width": 1, "height": 1},
                    },
                    {
                        "subjectId": "s2",
                        "includeInTraining": True,
                        "boundingBox": {"x": 0, "y": 0, "width": 1, "height": 1},
                    },
                ],
            }
        ],
    )

    # Named subjects sort first (alphabetical), bare species after.
    assert prepare_dataset.build_class_list(tmp_path) == ["Mittens", "dog"]


def test_build_class_list_skips_annotations_not_marked_for_training(tmp_path):
    _write_annotations(
        tmp_path / "event_1",
        subjects=[{"id": "s1", "species": "cat", "name": "Mittens"}],
        snapshots=[
            {
                "filename": "a.jpg",
                "annotations": [
                    {
                        "subjectId": "s1",
                        "includeInTraining": False,
                        "boundingBox": {"x": 0, "y": 0, "width": 1, "height": 1},
                    }
                ],
            }
        ],
    )

    assert prepare_dataset.build_class_list(tmp_path) == []
