# catcam

Wildlife detection using a USB camera and YOLOv8. Detects cats, birds, dogs,
and other animals, records video clips of activity, and sends push notifications
with snapshots via [ntfy.sh](https://ntfy.sh).

The system has two parts:

- **Pi (detector)** — captures camera frames, runs YOLO, records video, serves a live MJPEG stream
- **Server (web UI)** — .NET API + Angular frontend for browsing events, viewing recordings, and watching the live feed; handles H.264 transcoding so the Pi doesn't have to

These can run on the same machine or on separate ones. The typical setup is the Pi
on the camera and a more powerful box (with the storage drive) running the web UI.

## Pi setup

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
python -m cat_detect.main --stream --stream-port 8085

# Flip camera 180° (useful for upside-down mounts)
python -m cat_detect.main --flip

# Adjust confidence threshold and video framerate
python -m cat_detect.main --threshold 0.5 --fps 20

# Run detection less often to save CPU; snap every 3s during an event
python -m cat_detect.main --detect-interval 2.0 --snapshot-interval 3.0

# Save to a network share and let the server box transcode (recommended split setup)
python -m cat_detect.main --save --stream --captures-dir /mnt/share/catcam --no-transcode
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

By default, recordings are transcoded to browser-friendly H.264 (`libx264`,
yuv420p, faststart) via ffmpeg at the end of each event — this runs in a
background thread so it doesn't interrupt the stream. Install ffmpeg on the Pi
(`sudo apt install ffmpeg`) if you're using this mode.

With **`--no-transcode`**, the Pi skips ffmpeg entirely and writes only a raw
`recording-raw.mp4`. The server's background `TranscodeService` picks it up
within 30 seconds, transcodes it on the more powerful hardware, and updates the
event. This is the recommended mode when the captures directory is on a separate
server.

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
| `--no-transcode` | off | Skip local ffmpeg; leave raw file for the server to transcode |

## Deployment

### All-in-one (Pi only)

Run the detector, web UI, and transcoding all on the Pi. Straightforward, but
the Pi will be busy during transcodes. No web UI setup required beyond the Pi.

Set up as a systemd service:

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
ExecStart=/home/pi/catcam/.venv/bin/python -m cat_detect.main \
  --save \
  --stream \
  --ntfy my-topic \
  --flip \
  --captures-dir /home/pi/captures
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

Then run the .NET API and Angular frontend on the same Pi (see the server setup
below, or run them manually for development).

### Split: Pi detector + server box

The Pi runs only the detector and MJPEG stream. A separate server box (with the
storage drive) runs the web UI and handles transcoding.

**Step 1 — Share the captures directory**

Export the captures directory from the server box over NFS or SMB so the Pi can
write to it. Exact steps depend on your OS; the Pi just needs write access to a
mounted path like `/mnt/share/catcam`.

**Step 2 — Pi systemd service**

```ini
[Unit]
Description=Catcam wildlife detector
After=network.target

[Service]
Type=simple
User=pi
WorkingDirectory=/home/pi/catcam
ExecStart=/home/pi/catcam/.venv/bin/python -m cat_detect.main \
  --save \
  --stream \
  --stream-port 8085 \
  --ntfy my-topic \
  --flip \
  --captures-dir /mnt/share/catcam \
  --no-transcode
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

Key differences from all-in-one: `--stream` starts the MJPEG feed, `--no-transcode`
leaves the raw recording for the server to handle.

**Step 3 — Server box: Docker Compose**

Clone the repo on the server box, copy `.env.example` to `.env`, and fill it in:

```bash
cp .env.example .env
nano .env
```

```env
CAPTURES_DIR=/mnt/share/CatCam     # path to your captures drive
STREAM_URL=http://catcam.local:8085/ # Pi's MJPEG stream URL
```

Then bring it up:

```bash
docker compose up -d
```

The web UI will be available at `http://<server-ip>/`. The `TranscodeService`
runs inside the API container and polls for new recordings every 30 seconds.
ffmpeg is included in the API container image.

To rebuild after a code change:

```bash
docker compose up -d --build
```

**Step 4 — Enable and start the Pi service**

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

### Development

Run the .NET API and Angular dev server locally:

```bash
# Terminal 1 — .NET API (port 5077)
cd backend/CatCam.Api
dotnet run

# Terminal 2 — Angular dev server (port 4200, proxies /api and /media to 5077)
cd frontend
pnpm install
pnpm start
```

## Project structure

```
cat_detect/          Python detector (runs on the Pi)
  main.py            Entry point and main loop
  camera.py          USB camera capture (OpenCV)
  detector.py        YOLOv8 inference + wildlife filtering
  detect_worker.py   Background thread running detection against latest frame
  notify.py          Push notifications via ntfy.sh
  recorder.py        Video recording triggered by detections
  stream.py          MJPEG HTTP server for live viewing

backend/             .NET API (runs on the server box)
  CatCam.Api/
    Program.cs       Minimal API: events, media, stream config, metrics
    TranscodeService.cs  Background H.264 transcoder (picks up recording-raw.mp4)
    MetricsReader.cs     Pi/host device metrics via /proc

frontend/            Angular web UI (runs on the server box)
  src/app/
    events-list/     Paginated event grid with thumbnails
    event-detail/    Event detail: live MJPEG stream or recorded video + snapshots
    device-metrics/  Pi health dashboard
```

## Detected species

The detector filters for these COCO classes: bird, cat, dog, horse, sheep, cow,
elephant, bear, zebra, giraffe. Edit `WILDLIFE_CLASSES` in `detector.py` to
change the list.
