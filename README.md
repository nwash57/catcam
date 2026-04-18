# cat-detect

Wildlife detection using a USB camera and TFLite (EfficientDet).

## Setup

```bash
# Create a virtual environment
python3 -m venv .venv
source .venv/bin/activate

# Install dependencies
pip install -r requirements.txt

# Download the detection model (~4MB)
./download_model.sh
```

## Usage

```bash
# Basic — prints detections to terminal
python -m cat_detect.main

# With live preview window
python -m cat_detect.main --show

# Save frames when wildlife is detected
python -m cat_detect.main --save

# Adjust confidence threshold and check interval
python -m cat_detect.main --threshold 0.5 --interval 2.0

# Use a different camera
python -m cat_detect.main --camera 1
```

## Project structure

```
cat_detect/
  camera.py     — USB camera capture (OpenCV)
  detector.py   — TFLite inference + wildlife filtering
  notify.py     — Notification stub (prints to terminal for now)
  main.py       — Entry point, ties everything together
models/         — TFLite model + labels (downloaded via script)
captures/       — Saved detection frames
```
