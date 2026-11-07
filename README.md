# catcam

Wildlife detection using a USB camera and YOLOv8. Detects cats, birds, dogs,
and other animals, records video clips of activity, and sends push notifications
with snapshots via [ntfy.sh](https://ntfy.sh).

The system has three parts:

- **Pi (detector)** — captures camera frames, runs YOLO, records video, serves a live MJPEG stream
- **Server (web UI)** — .NET API + Angular frontend for browsing events, viewing recordings, watching the live feed, and handling H.264 transcoding
- **Server (auto-label)** — optional GPU service that pre-draws bounding boxes on snapshots using YOLOWorld, feeding an annotation workflow for retraining YOLO on the Pi

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
- **Diagnostics** (`/diagnostics`) — health checks, where the detector is
  actually writing, both disks, and a live tail of the detector's log. A status
  pill in the header shows the same verdict from every page. See
  [Health and alerting](#health-and-alerting).

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
directory shared from the server — over NFS if the server runs Linux, or over
SMB/CIFS if it runs Windows.

> **Read [Keeping the share honest](#keeping-the-share-honest) before you
> finish.** If the share ever fails to mount, the mount point is still a
> perfectly writable local directory, and the detector will happily fill the
> Pi's SD card for months without an obvious error.

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

<details>
<summary><strong>Windows server box instead?</strong> Share over SMB.</summary>

Create a dedicated local account for the Pi rather than reusing your own login —
a Microsoft-account credential breaks on password change or MFA, and it would
have to sit in a file on the Pi. In an elevated PowerShell:

```powershell
New-LocalUser -Name catcam -Description 'SMB access for the CatCam Pi' -PasswordNeverExpires
New-SmbShare -Name MediaShare -Path 'D:\MediaShare' -ChangeAccess catcam
Enable-NetFirewallRule -DisplayGroup 'File and Printer Sharing'
```

Then grant the account NTFS `Modify` on the folder itself, and make sure the
adapter's network profile is `Private` — on `Public`, Windows Firewall silently
blocks inbound SMB:

```powershell
Get-NetConnectionProfile                     # check NetworkCategory
Set-NetConnectionProfile -InterfaceAlias Ethernet -NetworkCategory Private
```

</details>

#### Step 2 — Mount the share on the Pi

```bash
sudo apt install nfs-common
sudo mkdir -p /mnt/catcam
```

Add to `/etc/fstab` so it mounts automatically on boot (replace `server-ip`):

```
server-ip:/srv/catcam  /mnt/catcam  nfs  defaults,_netdev,nofail,rw  0  0
```

For an SMB share, install `cifs-utils` and keep the credentials out of `fstab`
(which is world-readable) by putting them in a root-only file:

```bash
sudo apt install cifs-utils
printf 'username=catcam\npassword=SECRET\ndomain=SERVERNAME\n' \
  | sudo tee /etc/samba/catcam.cred > /dev/null
sudo chmod 600 /etc/samba/catcam.cred
```

```
//SERVERNAME/MediaShare  /mnt/catcam  cifs  credentials=/etc/samba/catcam.cred,uid=1000,gid=1000,_netdev,nofail  0  0
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
RequiresMountsFor=/mnt/catcam

[Service]
Type=simple
User=pi
WorkingDirectory=/home/pi/catcam
Environment=PYTHONUNBUFFERED=1
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

Two lines here are load-bearing:

- **`RequiresMountsFor=/mnt/catcam`** makes systemd pull in the corresponding
  mount unit and refuse to start the detector unless the share is genuinely
  mounted. Without it, a failed mount leaves an ordinary empty directory that
  the detector will fill with captures nobody ever sees.
- **`Environment=PYTHONUNBUFFERED=1`** makes the detector's output reach
  `journalctl` as it happens. Without it Python block-buffers into the journal,
  so errors only surface when the process dies — you can be hours or months into
  a failure while `journalctl -f` shows nothing at all.

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

**Auto-label GPU service**

The compose file includes an `auto-label` service that uses YOLOWorld to pre-draw bounding boxes on snapshots (see [Annotation](#annotation)). It requires an Nvidia GPU and [nvidia-container-toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/install-guide.html).

Install the toolkit on the server box (Manjaro/Arch):

```bash
pamac install nvidia-container-toolkit   # or: yay -S nvidia-container-toolkit
sudo nvidia-ctk runtime configure --runtime=docker
sudo systemctl restart docker
```

On Ubuntu/Debian:

```bash
curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey | sudo gpg --dearmor -o /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg
curl -s -L https://nvidia.github.io/libnvidia-container/stable/deb/nvidia-container-toolkit.list \
  | sed 's#deb https://#deb [signed-by=/usr/share/keyrings/nvidia-container-toolkit-keyring.gpg] https://#g' \
  | sudo tee /etc/apt/sources.list.d/nvidia-container-toolkit.list
sudo apt update && sudo apt install -y nvidia-container-toolkit
sudo nvidia-ctk runtime configure --runtime=docker
sudo systemctl restart docker
```

Verify it works:

```bash
docker run --rm --runtime=nvidia --gpus all nvidia/cuda:12.4.1-runtime-ubuntu22.04 nvidia-smi
```

On first start the service downloads `yolov8x-worldv2.pt` (~137 MB) into `./models/` and keeps it there across restarts.

If you don't have an Nvidia GPU, just run the stack without it:

```bash
docker compose up -d api frontend
```

The annotation UI still works; the "Auto-label" button will return an error until the service is running.

> **Linux + Docker Desktop:** Docker Desktop runs inside its own VM and cannot access the host GPU. Use native Docker Engine (`pamac install docker` on Arch/Manjaro, `apt install docker-ce` on Ubuntu/Debian) instead. If you have both installed, make sure the CLI is pointed at the native daemon: `docker context use default`.

> **Permission denied on the Docker socket:** After adding your user to the `docker` group (`sudo usermod -aG docker $USER`), you need to fully log out and back in for the change to take effect. In the meantime, prefix docker commands with `sudo`.

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
Environment=PYTHONUNBUFFERED=1
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

## Health and alerting

The server continuously checks whether the system is actually doing its job, and
pushes to ntfy when the answer changes. Set `HEALTH_NTFY_TOPIC` in `.env` to
enable pushes — it can be the same topic the Pi uses for detections.

| Check | What it catches |
|---|---|
| Recent captures | Nothing recorded for 12h (warn) / 48h (fail). The catch-all: whatever broke, the event feed stopped. |
| Captures destination | The detector is writing to its own disk because the share isn't mounted. |
| Write errors | The detector is running but its last save failed. |
| Detector reachable | The Pi is off, unreachable, or running without `--stream`. |
| Detector disk | The Pi's own disk is filling — often the first symptom of a dropped share. |
| Captures volume | The server's storage is filling. |
| Power and throttling | Under-voltage or thermal throttling, which shows up as dropped frames. |

Everything is visible at `/diagnostics`, and the header pill turns amber or red
from any page. Alerts fire on transitions — degraded *and* recovered — and
repeat every `HEALTH_REMINDER_HOURS` while a problem persists, so a fault can't
scroll off your notification list and be forgotten.

Thresholds and the poll interval are configurable; see the health block in
`.env.example`. For an all-in-one install set `HEALTH_EXPECT_SHARED_CAPTURES=false`,
otherwise writing to local disk is correctly reported as a fault.

> **`PI_METRICS_URL` must be resolvable from inside the API container.** An
> mDNS name like `catcam.local` works from your browser but not from Docker,
> where it fails silently and the metrics panel quietly falls back to showing
> the *server's* stats instead of the Pi's. Use an IP address.

## Keeping the share honest

The split setup has one failure mode worth designing against: **a mount point is
still a writable directory when nothing is mounted on it.** If the share drops —
the server reboots, its IP changes, a firewall profile flips to `Public`, an OS
reinstall takes the share definition with it — the Pi does not error out. It
writes captures to the bare mount point on the local SD card instead, at a few
gigabytes a week, until the card is full. The detector looks healthy the entire
time; the web UI just quietly stops showing new events.

Guard against it on three levels:

- **Refuse to run without the mount.** `RequiresMountsFor=` in the unit (see
  [Step 3](#step-3--pi-systemd-service)) turns a silent misroute into a service
  that visibly fails to start.
- **Use `nofail` in `fstab`.** Without it a missing share can hang boot; with it
  the mount fails cleanly and `RequiresMountsFor=` catches the rest.
- **Watch for silence.** Nothing above helps if no one is looking. Treat "no new
  events in a couple of days" as a fault worth alerting on, not as a quiet week
  for wildlife.

To check the current state:

```bash
findmnt /mnt/catcam        # empty output means NOT mounted
df -h /                    # SD card filling up is the tell
du -xh -d1 /mnt            # -x stays on one filesystem, so anything
                           # reported here is local, not on the share
```

If you find stranded captures, stop the detector before cleaning up, and confirm
the mount really is down before deleting anything — `rm -rf` against a mount
point that *did* come back will erase the share itself:

```bash
sudo systemctl stop catcam
mountpoint -q /mnt/catcam && echo "MOUNTED — do not delete" || echo "local — safe to clean"
```

---

## Annotation

The web UI includes an annotation workflow for labeling snapshots and building a training dataset to fine-tune the Pi's YOLO model.

**Workflow:**

1. Open any event and add **subjects** in the sidebar — give each animal a name and species (cat, dog, raccoon, possum, deer).
2. Click **"Auto-label all snapshots"** to run the GPU service across all snapshots in the event. It detects animals and proposes bounding boxes.
3. Click any snapshot thumbnail to open the annotator. The **Suggestions** panel lists each detected animal with its confidence. Pick a subject from the dropdown to assign a bounding box — it appears on the canvas immediately. Dismiss suggestions that are wrong.
4. For any box the auto-labeler missed, use the **draw bbox** button to draw it manually.
5. Toggle **include in training** for each subject you want in the dataset.
6. Click **Save** to write `annotations.json` to the event directory.

**Running the auto-label service without Docker:**

```bash
# Install deps (ideally in a venv)
pip install -r auto_label/requirements.txt

# Run from the project root
uvicorn auto_label.main:app --host 0.0.0.0 --port 8090
```

Then tell the .NET backend where to find it — either via environment variable:

```bash
AutoLabel__Url=http://localhost:8090 dotnet run
```

Or in `backend/CatCam.Api/appsettings.json`:

```json
"AutoLabel": { "Url": "http://localhost:8090" }
```

The auto-label service reads image files directly from disk, so both processes need access to the same captures directory.

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

# Terminal 3 (optional) — auto-label GPU service
pip install -r auto_label/requirements.txt
AutoLabel__Url=http://localhost:8090 uvicorn auto_label.main:app --port 8090
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

auto_label/          GPU auto-label service (runs on the server box)
  labeler.py         YOLOWorld wrapper — detects cat/dog/raccoon/possum/deer
  main.py            FastAPI app exposing POST /label and GET /health
  Dockerfile         Nvidia CUDA base image

backend/             .NET API (runs on the server box)
  CatCam.Api/
    Program.cs       Minimal API: events, media, annotations, auto-label proxy, metrics
    TranscodeService.cs  Background H.264 transcoder (picks up recording-raw.mp4)
    MetricsReader.cs     Pi/host device metrics via /proc

frontend/            Angular web UI (runs on the server box)
  src/app/
    events-list/     Paginated event grid with thumbnails
    event-detail/    Event detail: live MJPEG or recorded video + snapshots
    annotation/      Snapshot annotator: bounding box canvas, subject editor, auto-label suggestions
    live/            Dedicated live stream page with theater and fullscreen modes
    device-metrics/  Pi health dashboard
```

## Detected species

The detector filters for these COCO classes: bird, cat, dog, horse, sheep, cow,
elephant, bear, zebra, giraffe. Edit `WILDLIFE_CLASSES` in `detector.py` to
change the list.
