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

# Adjust confidence threshold and video framerate
python -m cat_detect.main --threshold 0.5 --fps 20

# Run detection less often to save CPU; snap every 3s during an event
python -m cat_detect.main --detect-interval 2.0 --snapshot-interval 3.0

# Use a different camera and captures directory
python -m cat_detect.main --camera 1 --captures-dir /mnt/storage/wildlife
```

## How it works

Frame capture, YOLO detection, and video recording run on decoupled cadences:

- **`--fps`** paces the main loop and video recording. Drop it for choppier but
  cheaper video; raise it for smoother playback.
- **`--detect-interval`** caps how often YOLO runs on a background thread. The
  worker grabs the newest frame each tick, so slow inference never stalls the
  video loop. Detection bboxes are cached between runs and redrawn on every
  frame so they don't flicker.
- **`--snapshot-interval`** throttles snapshot saves during an active event. The
  first detection of an event always saves a trigger snapshot regardless.

## Video recording

Video recording is always active. When wildlife is detected, catcam begins
writing frames to an MP4 file and continues recording until there are no
detections for 20 seconds (configurable with `--record-timeout`). Videos are
saved alongside snapshots in the captures directory.

Recordings are written with OpenCV's `mp4v` codec and transcoded to H.264
(`libx264`, yuv420p, faststart) via ffmpeg on event close so they play in
browsers. Install ffmpeg on the host (`sudo apt install ffmpeg`) — without it,
catcam falls back to raw mp4v which browsers can't play.

Snapshots (JPEGs) are still used for ntfy notifications since ntfy doesn't
support video attachments well.

## Options

| Flag | Default | Description |
|------|---------|-------------|
| `--camera` | `0` | Camera device index |
| `--width` | `1920` | Capture width in pixels |
| `--height` | `1080` | Capture height in pixels |
| `--mjpg` / `--no-mjpg` | on | Request MJPEG from camera (much higher fps at 1080p; disable for raw YUYV) |
| `--model` | `yolov8n.pt` | YOLO model name |
| `--threshold` | `0.35` | Minimum detection confidence (0-1) |
| `--fps` | `15` | Video framerate / main loop rate |
| `--detect-interval` | `1.0` | Min seconds between YOLO detection runs |
| `--snapshot-interval` | `2.0` | Min seconds between snapshots during an event |
| `--show` | off | Show live preview window |
| `--save` | off | Save snapshot JPEGs on detection |
| `--ntfy` | off | ntfy.sh topic for push notifications |
| `--cooldown` | `30` | Seconds between notifications |
| `--flip` | off | Rotate camera image 180° |
| `--stream` | off | Serve MJPEG video stream over HTTP |
| `--stream-port` | `8085` | Port for MJPEG stream |
| `--record-timeout` | `20` | Seconds of quiet before stopping a recording |
| `--captures-dir` | `captures` | Directory for snapshots and recordings |

## Running as a service

To run catcam automatically on boot (e.g. on a Raspberry Pi):

```bash
sudo nano /etc/systemd/system/catcam.service
```

```ini
[Unit]
Description=Catcam wildlife detector
After=network.target

[Service]
Type=simple
User=pi
WorkingDirectory=/home/pi/catcam
ExecStart=/home/pi/catcam/.venv/bin/python -m cat_detect.main --save --ntfy my-topic --flip --captures-dir /mnt/share/catcam
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

Adjust `User`, `WorkingDirectory`, `ExecStart`, and flags to match your setup.
Then enable and start it:

```bash
sudo systemctl daemon-reload
sudo systemctl enable catcam
sudo systemctl start catcam
```

Check status and logs:

```bash
sudo systemctl status catcam
journalctl -u catcam -f
```

## Project structure

```
cat_detect/
  main.py          — Entry point and main loop
  camera.py        — USB camera capture (OpenCV)
  detector.py      — YOLOv8 inference + wildlife filtering
  detect_worker.py — Background thread running detection against latest frame
  notify.py        — Push notifications via ntfy.sh
  recorder.py      — Video recording triggered by detections
  stream.py        — MJPEG HTTP server for live viewing
```

## Detected species

The detector filters for these COCO classes: bird, cat, dog, horse, sheep, cow,
elephant, bear, zebra, giraffe. Edit `WILDLIFE_CLASSES` in `detector.py` to
change the list.
