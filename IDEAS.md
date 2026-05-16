# Ideas

## Move detection to the server (offload from RPi)

Currently `cat_detect` runs on the RPi — opens the USB camera, runs YOLOv8 per-frame, and writes event files to `captures/`. The RPi does all the heavy lifting.

**Proposed change:** RPi streams only; server handles all detection and recording.

**How it would work:**
- RPi runs in stream-only mode (`--stream`, no local YOLO, no saving)
- Server runs `cat_detect` as a new Docker service, pulling from the RPi's MJPEG stream on port 8085
- `cv2.VideoCapture` already accepts HTTP URLs, so `Camera` just needs to accept a URL string in addition to a device int
- Shared `captures/` volume means the existing API, TranscodeService, and auto-label workflow all stay untouched

**Changes needed:**
- Add `--camera-url` arg to `cat_detect/main.py` (mutually exclusive with `--camera`)
- Update `camera.py` to pass the URL string to `VideoCapture`
- Add a `cat_detect` service to `docker-compose.yml` pointing at the RPi's stream URL

**Tradeoff:** A few frames of MJPEG latency before the server sees motion — irrelevant for wildlife detection. Benefit: can use a much larger/better model since it runs on the server GPU instead of the RPi.
