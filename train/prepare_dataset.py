#!/usr/bin/env python3
"""Build a YOLO-format dataset from annotated CatCam event snapshots.

Classes are derived dynamically from the annotations:
  - Named subjects (e.g. "mittens", "whiskers") get their own class
  - Unnamed subjects fall back to species (e.g. "cat", "dog")
  - Named classes are listed first (alphabetical), species fallbacks after

Reads all annotations.json files under CAPTURES_DIR, selects snapshots where
includeInTraining=True and a bounding box exists, then writes:
  OUTPUT_DIR/images/{train,val}/*.jpg
  OUTPUT_DIR/labels/{train,val}/*.txt
  OUTPUT_DIR/dataset.yaml
"""

import argparse
import json
import random
import shutil
from pathlib import Path

SPECIES = {"cat", "dog", "raccoon", "possum", "deer"}


def get_label(subject: dict) -> str:
    name = (subject.get("name") or "").strip()
    return name if name else subject["species"]


def build_class_list(captures_dir: Path) -> list[str]:
    """First pass: collect all labels that appear in training-eligible annotations."""
    labels: set[str] = set()
    for ann_path in sorted(captures_dir.glob("*/annotations.json")):
        try:
            data = json.loads(ann_path.read_text())
        except Exception:
            continue
        subjects = {s["id"]: s for s in data.get("subjects", [])}
        for snap in data.get("snapshots", []):
            for ann in snap.get("annotations", []):
                if not ann.get("includeInTraining") or not ann.get("boundingBox"):
                    continue
                subject = subjects.get(ann.get("subjectId", ""))
                if subject:
                    labels.add(get_label(subject))

    named = sorted(l for l in labels if l not in SPECIES)
    species = sorted(l for l in labels if l in SPECIES)
    return named + species


def collect_samples(captures_dir: Path, class_id: dict) -> list[tuple[Path, list]]:
    samples = []
    for ann_path in sorted(captures_dir.glob("*/annotations.json")):
        try:
            data = json.loads(ann_path.read_text())
        except Exception as e:
            print(f"Warning: skipping {ann_path}: {e}")
            continue

        event_dir = ann_path.parent
        subjects = {s["id"]: s for s in data.get("subjects", [])}

        for snap in data.get("snapshots", []):
            img_path = event_dir / snap["filename"]
            if not img_path.exists():
                continue

            labels = []
            for ann in snap.get("annotations", []):
                if not ann.get("includeInTraining") or not ann.get("boundingBox"):
                    continue
                subject = subjects.get(ann.get("subjectId", ""))
                if not subject:
                    continue
                label = get_label(subject)
                if label not in class_id:
                    continue

                bbox = ann["boundingBox"]
                xc = bbox["x"] + bbox["width"] / 2
                yc = bbox["y"] + bbox["height"] / 2
                labels.append((class_id[label], xc, yc, bbox["width"], bbox["height"]))

            if labels:
                samples.append((img_path, labels))

    return samples


def write_split(samples: list, img_dir: Path, lbl_dir: Path) -> None:
    img_dir.mkdir(parents=True, exist_ok=True)
    lbl_dir.mkdir(parents=True, exist_ok=True)

    for img_path, labels in samples:
        stem = f"{img_path.parent.name}__{img_path.stem}"
        dest_img = img_dir / f"{stem}.jpg"
        shutil.copy2(img_path, dest_img)

        lbl_path = lbl_dir / f"{stem}.txt"
        lines = [f"{cls} {xc:.6f} {yc:.6f} {w:.6f} {h:.6f}" for cls, xc, yc, w, h in labels]
        lbl_path.write_text("\n".join(lines) + "\n")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--captures-dir", default="/captures")
    parser.add_argument("--output-dir", default="/datasets/catcam")
    parser.add_argument("--val-fraction", type=float, default=0.2)
    parser.add_argument("--seed", type=int, default=42)
    args = parser.parse_args()

    captures_dir = Path(args.captures_dir)
    output_dir = Path(args.output_dir)

    print(f"Scanning {captures_dir} for annotated snapshots...")
    classes = build_class_list(captures_dir)
    if not classes:
        print("No training-eligible samples found. Annotate some snapshots first.")
        raise SystemExit(1)

    class_id = {name: i for i, name in enumerate(classes)}
    print(f"Classes ({len(classes)}): {classes}")

    samples = collect_samples(captures_dir, class_id)
    if not samples:
        print("No samples with bounding boxes found.")
        raise SystemExit(1)

    random.seed(args.seed)
    random.shuffle(samples)

    if len(samples) < 2:
        train_samples = samples
        val_samples = samples
    else:
        split = min(max(1, int(len(samples) * (1 - args.val_fraction))), len(samples) - 1)
        train_samples = samples[:split]
        val_samples = samples[split:]

    print(f"Writing dataset: {len(train_samples)} train, {len(val_samples)} val")
    write_split(train_samples, output_dir / "images/train", output_dir / "labels/train")
    write_split(val_samples, output_dir / "images/val", output_dir / "labels/val")

    yaml_path = output_dir / "dataset.yaml"
    yaml_path.write_text(
        f"path: {output_dir.absolute()}\n"
        f"train: images/train\n"
        f"val: images/val\n"
        f"nc: {len(classes)}\n"
        f"names: {classes}\n"
    )
    print(f"Dataset ready: {yaml_path}")


if __name__ == "__main__":
    main()
