#!/usr/bin/env python3
"""Fine-tune YOLO models on the prepared CatCam dataset.

Expects prepare_dataset.py to have run first. Trains each base model and saves
the best checkpoint to OUTPUT_DIR/catcam_{model_stem}_best.pt.

  catcam_yolov8n_best.pt        → deploy to Pi via --model
  catcam_yolov8x-worldv2_best.pt → swap into auto-label via AUTOLABEL_MODEL
"""

import argparse
import os
import shutil
from pathlib import Path

from ultralytics import YOLO, YOLOWorld


def load_model(base_model: str):
    """Load YOLO or YOLOWorld depending on the model name."""
    if "world" in Path(base_model).stem.lower():
        return YOLOWorld(base_model)
    return YOLO(base_model)


def train_one(base_model: str, dataset: Path, epochs: int, imgsz: int, batch: int, fraction: float, output_dir: Path):
    stem = Path(base_model).stem
    run_name = f"catcam_{stem}"

    print(f"\n{'='*60}")
    print(f"Training: {base_model}  →  {run_name}")
    print(f"{'='*60}")

    model = load_model(base_model)
    model.train(
        data=str(dataset),
        epochs=epochs,
        imgsz=imgsz,
        batch=batch,
        fraction=fraction,
        project=str(output_dir),
        name=run_name,
        exist_ok=True,
    )

    best = output_dir / run_name / "weights" / "best.pt"
    if best.exists():
        dest = output_dir / f"{run_name}_best.pt"
        shutil.copy2(best, dest)
        print(f"Best model saved to: {dest}")
        return dest
    return None


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dataset", default="/datasets/catcam/dataset.yaml")
    parser.add_argument(
        "--base-models",
        default=os.environ.get("BASE_MODELS", "yolov8n.pt,yolov8x-worldv2.pt"),
        help="Comma-separated list of base models to fine-tune",
    )
    parser.add_argument("--epochs", type=int, default=int(os.environ.get("EPOCHS", "100")))
    parser.add_argument("--imgsz", type=int, default=640)
    parser.add_argument("--batch", type=int, default=-1, help="-1 = auto-batch")
    parser.add_argument("--fraction", type=float, default=float(os.environ.get("TRAIN_VRAM_FRACTION", "0.9")), help="fraction of VRAM for auto-batch (default 0.9)")
    parser.add_argument("--output-dir", default="/models/trained")
    args = parser.parse_args()

    dataset = Path(args.dataset)
    if not dataset.exists():
        raise FileNotFoundError(f"Dataset YAML not found: {dataset}. Run prepare_dataset.py first.")

    output_dir = Path(args.output_dir)
    base_models = [m.strip() for m in args.base_models.split(",") if m.strip()]
    trained = []

    for base_model in base_models:
        dest = train_one(base_model, dataset, args.epochs, args.imgsz, args.batch, args.fraction, output_dir)
        if dest:
            trained.append((base_model, dest))

    print(f"\n{'='*60}")
    print("Training complete. Deployment:")
    for base_model, dest in trained:
        if "world" in Path(base_model).stem.lower():
            print(f"  Auto-label: set AUTOLABEL_MODEL={dest}")
        else:
            print(f"  Pi detector: copy {dest} to Pi, then --model {dest.name}")
    print(f"{'='*60}")


if __name__ == "__main__":
    main()
