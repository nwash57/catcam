import datetime
import time
from pathlib import Path

import cv2

class Recorder:
    """Records video clips triggered by detections, stopping after a quiet period."""

    def __init__(self, timeout: float = 20.0, fps: float = 10.0, captures_dir: Path | None = None):
        self.timeout = timeout
        self.fps = fps
        self.captures_dir = captures_dir or Path("captures")
        self._writer = None
        self._last_detection = None
        self._video_path = None

    @property
    def recording(self) -> bool:
        return self._writer is not None

    def detection(self):
        """Call each time a detection occurs to start or extend recording."""
        self._last_detection = time.monotonic()

    def write_frame(self, frame):
        """Feed every frame here. Starts/stops the video writer as needed."""
        if self._last_detection is None:
            return

        elapsed = time.monotonic() - self._last_detection

        if elapsed <= self.timeout:
            # Should be recording
            if not self._writer:
                self._start(frame)
            self._writer.write(frame)
        else:
            # Quiet period exceeded — stop recording
            if self._writer:
                self._stop()

    def close(self):
        """Flush and close any in-progress recording."""
        if self._writer:
            self._stop()

    def _start(self, frame):
        self.captures_dir.mkdir(parents=True, exist_ok=True)
        ts = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
        self._video_path = self.captures_dir / f"recording_{ts}.mp4"
        h, w = frame.shape[:2]
        fourcc = cv2.VideoWriter_fourcc(*"mp4v")
        self._writer = cv2.VideoWriter(str(self._video_path), fourcc, self.fps, (w, h))
        print(f"  Recording started → {self._video_path}")

    def _stop(self):
        self._writer.release()
        print(f"  Recording saved → {self._video_path}")
        self._writer = None
        self._video_path = None
        self._last_detection = None
