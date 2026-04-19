# catcam

Wildlife detection using a USB camera and YOLOv8. Detects cats, birds, dogs,
and other animals, records video clips of activity, and sends push notifications
with snapshots via [ntfy.sh](https://ntfy.sh).

## Setup

```bash
# Create a virtual environment
python3 -m venv .venv
source .venv/bin/activate

# Install dependencies
pip install -r requirements.txt
```

The YOLOv8 nano model (`yolov8n.pt`) is downloaded automatically on first run.

## Usage

```bash
# Basic — prints detections to terminal
python -m cat_detect.main

# With live preview window (press q to quit)
python -m cat_detect.main --show

# Save snapshots when wildlife is detected
python -m cat_detect.main --save

# Push notifications via ntfy.sh with a 2-minute cooldown
python -m cat_detect.main --ntfy my-topic --cooldown 120

# Live MJPEG stream on a custom port
python -m cat_detect.main --stream --stream-port 8080

# Flip camera 180° (useful for upside-down mounts)
python -m cat_detect.main --flip

# Adjust confidence threshold and detection interval
python -m cat_detect.main --threshold 0.5 --interval 2.0

# Use a different camera and captures directory
python -m cat_detect.main --camera 1 --captures-dir /mnt/storage/wildlife
```

## Video recording

Video recording is always active. When wildlife is detected, catcam begins
writing frames to an MP4 file and continues recording until there are no
detections for 20 seconds (configurable with `--record-timeout`). Videos are
saved alongside snapshots in the captures directory.

Snapshots (JPEGs) are still used for ntfy notifications since ntfy doesn't
support video attachments well.

## Options

| Flag | Default | Description |
|------|---------|-------------|
| `--camera` | `0` | Camera device index |
| `--model` | `yolov8n.pt` | YOLO model name |
| `--threshold` | `0.35` | Minimum detection confidence (0-1) |
| `--interval` | `1.0` | Seconds between detection runs |
| `--show` | off | Show live preview window |
| `--save` | off | Save snapshot JPEGs on detection |
| `--ntfy` | off | ntfy.sh topic for push notifications |
| `--cooldown` | `30` | Seconds between notifications |
| `--flip` | off | Rotate camera image 180° |
| `--stream` | off | Serve MJPEG video stream over HTTP |
| `--stream-port` | `8085` | Port for MJPEG stream |
| `--record-timeout` | `20` | Seconds of quiet before stopping a recording |
| `--captures-dir` | `captures` | Directory for snapshots and recordings |

## Project structure

```
cat_detect/
  main.py       — Entry point and main loop
  camera.py     — USB camera capture (OpenCV)
  detector.py   — YOLOv8 inference + wildlife filtering
  notify.py     — Push notifications via ntfy.sh
  recorder.py   — Video recording triggered by detections
  stream.py     — MJPEG HTTP server for live viewing
```

## Detected species

The detector filters for these COCO classes: bird, cat, dog, horse, sheep, cow,
elephant, bear, zebra, giraffe. Edit `WILDLIFE_CLASSES` in `detector.py` to
change the list.
