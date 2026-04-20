import threading
import time

from cat_detect.detector import Detector


class DetectWorker:
    """Runs YOLO detection on a background thread against the newest frame.

    Main loop publishes frames via `submit_frame(frame)` at video fps. The worker
    wakes on a cadence (`detect_interval`), grabs whatever the latest frame is,
    runs the model, and publishes `(detections, frame_id)` back to main via
    `take_result()`. Main polls that each tick — cheap and lock-protected.
    """

    def __init__(self, detector: Detector, detect_interval: float):
        self._detector = detector
        self._detect_interval = detect_interval
        self._lock = threading.Lock()
        self._latest_frame = None
        self._latest_frame_id = 0
        self._pending_result: tuple[list[dict], int] | None = None
        self._last_consumed_frame_id = 0
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._run, name="detect-worker", daemon=True)

    def start(self):
        self._thread.start()

    def stop(self):
        self._stop.set()
        self._thread.join(timeout=5.0)

    def submit_frame(self, frame):
        with self._lock:
            self._latest_frame = frame
            self._latest_frame_id += 1

    def take_result(self) -> tuple[list[dict], int] | None:
        """Return the newest detection result if one is pending, else None.
        Each result is returned exactly once."""
        with self._lock:
            result = self._pending_result
            self._pending_result = None
            return result

    def _run(self):
        while not self._stop.is_set():
            with self._lock:
                frame = self._latest_frame
                frame_id = self._latest_frame_id

            if frame is None or frame_id == self._last_consumed_frame_id:
                if self._stop.wait(0.05):
                    return
                continue

            self._last_consumed_frame_id = frame_id
            tick_started = time.monotonic()
            detections = self._detector.detect(frame)

            with self._lock:
                self._pending_result = (detections, frame_id)

            elapsed = time.monotonic() - tick_started
            remaining = self._detect_interval - elapsed
            if remaining > 0 and self._stop.wait(remaining):
                return
