#!/usr/bin/env bash
# Downloads EfficientDet-Lite0 (COCO) — a lightweight model good for real-time detection.
set -euo pipefail

MODEL_DIR="models"
MODEL_URL="https://raw.githubusercontent.com/schu-lab/Tensorflow-Object-Detection/main/efficientdet_lite0.tflite"
LABELS_URL="https://raw.githubusercontent.com/google-coral/test_data/master/coco_labels.txt"

echo "Downloading EfficientDet-Lite0 model..."
curl -L -o "${MODEL_DIR}/efficientdet_lite0.tflite" "${MODEL_URL}"

echo "Downloading COCO labels..."
curl -L -o "${MODEL_DIR}/coco_labels.txt" "${LABELS_URL}"

echo "Done! Model saved to ${MODEL_DIR}/"
