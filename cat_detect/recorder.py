import datetime
import json
import shutil
import subprocess
import time
from pathlib import Path

import cv2


class Recorder:
    """Owns the lifecycle of a detection event.

    An event begins on the first detection after a quiet period and ends after
    `timeout` seconds of no detections. All snapshots, the recording, and an
    `event.json` summary for a single event live together in one folder.
    """

    def __init__(self, timeout: float = 20.0, fps: float = 10.0, captures_dir: Path | None = None):
        self.timeout = timeout
        self.fps = fps
        self.captures_dir = captures_dir or Path("captures")
        self._writer = None
        self._last_detection = None
        self._event_dir: Path | None = None
        self._event_started_at: datetime.datetime | None = None
        self._video_path: Path | None = None
        self._raw_path: Path | None = None
        self._snapshot_count = 0
        self._species: set[str] = set()
        self._trigger_file: str | None = None

    @property
    def recording(self) -> bool:
        return self._writer is not None

    @property
    def event_dir(self) -> Path | None:
        """The current event's folder, or None if no event is active."""
        return self._event_dir

    def detection(self, species: list[str] | None = None):
        """Call on every detection tick. Starts a new event if none is active."""
        self._last_detection = time.monotonic()
        if self._event_dir is None:
            self._start_event()
        if species:
            self._species.update(species)

    def note_snapshot(self, filename: str):
        """Record that a snapshot was saved into the active event."""
        if self._event_dir is None:
            return
        if self._trigger_file is None:
            self._trigger_file = filename
        self._snapshot_count += 1

    def write_frame(self, frame):
        """Feed every frame here. Starts/stops the video writer as needed."""
        if self._last_detection is None:
            return

        elapsed = time.monotonic() - self._last_detection

        if elapsed <= self.timeout:
            if not self._writer:
                self._start_writer(frame)
            self._writer.write(frame)
        else:
            if self._writer or self._event_dir:
                self._end_event()

    def close(self):
        """Flush and close any in-progress event."""
        if self._writer or self._event_dir:
            self._end_event()

    def _start_event(self):
        started_at = datetime.datetime.now()
        event_id = f"event_{started_at.strftime('%Y%m%d_%H%M%S')}"
        self._event_dir = self.captures_dir / event_id
        self._event_dir.mkdir(parents=True, exist_ok=True)
        self._event_started_at = started_at
        self._snapshot_count = 0
        self._species = set()
        self._trigger_file = None

    def _start_writer(self, frame):
        assert self._event_dir is not None
        # Write with mp4v (MPEG-4 Part 2) for reliable OpenCV support, then
        # transcode to H.264 on close so browsers can play the file.
        self._raw_path = self._event_dir / "recording-raw.mp4"
        self._video_path = self._event_dir / "recording.mp4"
        h, w = frame.shape[:2]
        fourcc = cv2.VideoWriter_fourcc(*"mp4v")
        self._writer = cv2.VideoWriter(str(self._raw_path), fourcc, self.fps, (w, h))
        print(f"  Recording started → {self._raw_path}")

    def _end_event(self):
        ended_at = datetime.datetime.now()

        final_video: Path | None = None
        if self._writer:
            self._writer.release()
            final_video = self._finalize_video()
            if final_video is not None:
                print(f"  Recording saved → {final_video}")

        if self._event_dir is not None and self._event_started_at is not None:
            summary = {
                "id": self._event_dir.name,
                "startedAt": self._event_started_at.astimezone().isoformat(timespec="seconds"),
                "endedAt": ended_at.astimezone().isoformat(timespec="seconds"),
                "snapshotCount": self._snapshot_count,
                "videoFile": final_video.name if final_video else None,
                "triggerFile": self._trigger_file,
                "species": sorted(self._species),
            }
            (self._event_dir / "event.json").write_text(json.dumps(summary, indent=2))

        self._writer = None
        self._video_path = None
        self._raw_path = None
        self._last_detection = None
        self._event_dir = None
        self._event_started_at = None
        self._snapshot_count = 0
        self._species = set()
        self._trigger_file = None

    def _finalize_video(self) -> Path | None:
        """Transcode the raw mp4v recording to browser-friendly H.264. Returns
        the final video path, or None if the raw file is missing."""
        if self._raw_path is None or self._video_path is None or not self._raw_path.exists():
            return None

        ffmpeg = shutil.which("ffmpeg")
        if ffmpeg is None:
            print("  Warning: ffmpeg not found; keeping raw mp4v recording (may not play in browsers).")
            self._raw_path.rename(self._video_path)
            return self._video_path

        try:
            subprocess.run(
                [
                    ffmpeg, "-y", "-loglevel", "error",
                    "-i", str(self._raw_path),
                    "-c:v", "libx264",
                    "-preset", "veryfast",
                    "-crf", "23",
                    "-pix_fmt", "yuv420p",
                    "-movflags", "+faststart",
                    str(self._video_path),
                ],
                check=True,
            )
            self._raw_path.unlink(missing_ok=True)
            return self._video_path
        except (subprocess.CalledProcessError, FileNotFoundError) as e:
            print(f"  Warning: ffmpeg transcode failed ({e}); keeping raw mp4v recording.")
            if self._video_path.exists():
                self._video_path.unlink()
            self._raw_path.rename(self._video_path)
            return self._video_path
