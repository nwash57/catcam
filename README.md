# catcam

Wildlife detection using a USB camera and YOLOv8. Detects cats, birds, dogs,
and other animals, records video clips of activity, and sends push notifications
with snapshots via [ntfy.sh](https://ntfy.sh).

The system has two parts:

- **Pi (detector)** — captures camera frames, runs YOLO, records video, serves a live MJPEG stream
- **Server (web UI)** — .NET API + Angular frontend for browsing events, viewing recordings, watching the live feed, and handling H.264 transcoding

**The recommended setup is a Pi for the camera and a separate always-on server box (with a storage drive) for the web UI.** The Pi skips the heavy ffmpeg transcode step (`--no-transcode`) and writes raw recordings directly to a network share; the server box picks them up and transcodes in the background. This keeps the Pi's CPU free and means you get a proper web UI without running it on constrained hardware.

Both parts can run on one machine if you prefer — see [All-in-one](#all-in-one-pi-only) below.

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

# Recommended split setup: write to network share, skip local transcode
python -m cat_detect.main --save --stream --captures-dir /mnt/catcam --no-transcode
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
yuv420p, faststart) via ffmpeg at the end of each event. This runs in a
background thread so it doesn't interrupt the stream. Install ffmpeg on the Pi
(`sudo apt install ffmpeg`) if you want to use this mode.

With **`--no-transcode`**, the Pi skips ffmpeg entirely and writes only
`recording-raw.mp4`. The server's background `TranscodeService` finds it within
30 seconds, transcodes it on the more powerful hardware, and updates the event.
The web UI shows "Video processing…" while this is in flight. This is the
recommended mode when the captures directory is on a network share — the Pi
needs no ffmpeg install and barely notices the recording step.

> **Stuck recordings?** If the server wasn't running when events were recorded,
> `recording-raw.mp4` files may have accumulated. Start (or restart) the server
> and the `TranscodeService` will find and transcode them automatically on the
> next 30-second poll. Make sure `ffmpeg` is installed on the server box
> (`sudo apt install ffmpeg` or included automatically in the Docker image).

## Web UI

The web UI is served by the .NET backend and Angular frontend running on the
server box.

- **Captures** (`/`) — paginated grid of detection events with thumbnail
  previews, species tags, and duration. Click any event to see the recording
  and snapshots.
- **Live** (`/live`) — live MJPEG stream from the Pi. Has a **theater mode**
  button (fills the browser window) and a **fullscreen** button (OS-level
  fullscreen, shows on hover over the stream). Requires `STREAM_URL` to be
  configured.
- **Device metrics** — CPU temperature, memory, disk, and load average pulled
  from the Pi (when `PI_METRICS_URL` is set) or the server box.

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

### Split: Pi detector + server box (recommended)

The Pi handles only camera capture, detection, and streaming. The server box
handles storage, transcoding, and the web UI. The Pi writes directly to a
directory shared from the server over NFS.

#### Step 1 — Set up the NFS share on the server box

```bash
sudo apt install nfs-kernel-server
sudo mkdir -p /srv/catcam
sudo chown $USER:$USER /srv/catcam
```

Add an exports entry (replace `192.168.1.0/24` with your local subnet):

```bash
echo '/srv/catcam  192.168.1.0/24(rw,sync,no_subtree_check,all_squash,anonuid=1000,anongid=1000)' \
  | sudo tee -a /etc/exports
sudo exportfs -ra
sudo systemctl enable --now nfs-kernel-server
```

> `all_squash` maps any remote user to the local `anonuid`/`anongid` (1000 by
> default — your first user). Adjust if your user has a different UID
> (`id -u` to check).

#### Step 2 — Mount the share on the Pi

```bash
sudo apt install nfs-common
sudo mkdir -p /mnt/catcam
```

Add to `/etc/fstab` so it mounts automatically on boot (replace `server-ip`):

```
server-ip:/srv/catcam  /mnt/catcam  nfs  defaults,_netdev,rw  0  0
```

Mount it now without rebooting:

```bash
sudo mount -a
```

Verify the Pi can write:

```bash
touch /mnt/catcam/.test && echo "OK" && rm /mnt/catcam/.test
```

#### Step 3 — Pi systemd service

```bash
sudo nano /etc/systemd/system/catcam.service
```

```ini
[Unit]
Description=Catcam wildlife detector
After=network-online.target
Wants=network-online.target

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
  --captures-dir /mnt/catcam \
  --no-transcode
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

> `After=network-online.target` ensures the NFS mount is available before the
> detector starts. If the Pi boots faster than the NFS comes up, also add
> `After=mnt-catcam.mount` (systemd auto-generates a unit name from the
> fstab mount point).

#### Step 4 — Server box: Docker Compose

Clone the repo on the server box and create your `.env`:

```bash
cp .env.example .env
nano .env
```

```env
CAPTURES_DIR=/srv/catcam          # local path to your captures directory
STREAM_URL=http://pi-ip:8085/     # Pi's MJPEG stream URL
PI_METRICS_URL=http://pi-ip:8085/ # same host; used for the metrics panel
```

Bring it up:

```bash
docker compose up -d
```

The web UI will be available at `http://server-ip/`. The `TranscodeService`
runs inside the API container and polls for new `recording-raw.mp4` files every
30 seconds; ffmpeg is included in the container image.

To rebuild after a code change:

```bash
docker compose up -d --build
```

#### Step 5 — Enable and start the Pi service

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

---

### All-in-one (Pi only)

Run the detector, web UI, and transcoding all on one machine. Simpler to set up
but the machine will be busy during transcodes, and you'll need ffmpeg installed
locally. Suitable for a dedicated always-on NAS or mini PC with a USB camera.

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

Run the Docker Compose stack on the same machine, pointing `CAPTURES_DIR` at
the same local path:

```env
CAPTURES_DIR=/home/pi/captures
STREAM_URL=http://localhost:8085/
```

```bash
docker compose up -d
```

Without `--no-transcode` the Pi does its own ffmpeg transcode after each event.
Install ffmpeg first: `sudo apt install ffmpeg`.

---

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
    event-detail/    Event detail: live MJPEG or recorded video + snapshots
    live/            Dedicated live stream page with theater and fullscreen modes
    device-metrics/  Pi health dashboard
```

## Detected species

The detector filters for these COCO classes: bird, cat, dog, horse, sheep, cow,
elephant, bear, zebra, giraffe. Edit `WILDLIFE_CLASSES` in `detector.py` to
change the list.
