import datetime
import json
import shutil
import subprocess
import threading
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
        self._writer_started_at: float | None = None
        self._frames_written = 0
        self._finalize_threads: list[threading.Thread] = []

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
            self._frames_written += 1
        else:
            if self._writer or self._event_dir:
                self._end_event()

    def close(self):
        """Flush and close any in-progress event, then wait for background finalization."""
        if self._writer or self._event_dir:
            self._end_event()
        for t in self._finalize_threads:
            t.join()

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
        self._writer_started_at = time.monotonic()
        self._frames_written = 0
        print(f"  Recording started → {self._raw_path}")

    def _end_event(self):
        ended_at = datetime.datetime.now()

        # Snapshot all state needed for finalization before clearing it so the
        # main loop can continue immediately while the background thread works.
        writer = self._writer
        raw_path = self._raw_path
        video_path = self._video_path
        measured_fps = self._measured_fps()
        event_dir = self._event_dir
        event_started_at = self._event_started_at
        snapshot_count = self._snapshot_count
        species = self._species.copy()
        trigger_file = self._trigger_file

        self._writer = None
        self._video_path = None
        self._raw_path = None
        self._writer_started_at = None
        self._frames_written = 0
        self._last_detection = None
        self._event_dir = None
        self._event_started_at = None
        self._snapshot_count = 0
        self._species = set()
        self._trigger_file = None

        t = threading.Thread(
            target=self._finalize_event,
            args=(writer, raw_path, video_path, measured_fps,
                  event_dir, event_started_at, snapshot_count, species, trigger_file, ended_at),
            daemon=True,
        )
        self._finalize_threads.append(t)
        t.start()

    def _finalize_event(self, writer, raw_path, video_path, measured_fps,
                        event_dir, event_started_at, snapshot_count, species, trigger_file, ended_at):
        final_video: Path | None = None
        if writer:
            writer.release()
            final_video = self._finalize_video(raw_path, video_path, measured_fps)
            if final_video is not None:
                print(f"  Recording saved → {final_video} (measured {measured_fps:.1f}fps)")

        if event_dir is not None and event_started_at is not None:
            summary = {
                "id": event_dir.name,
                "startedAt": event_started_at.astimezone().isoformat(timespec="seconds"),
                "endedAt": ended_at.astimezone().isoformat(timespec="seconds"),
                "snapshotCount": snapshot_count,
                "videoFile": final_video.name if final_video else None,
                "triggerFile": trigger_file,
                "species": sorted(species),
            }
            (event_dir / "event.json").write_text(json.dumps(summary, indent=2))

    def _measured_fps(self) -> float:
        """Actual frame rate written to the raw file. Falls back to declared fps
        if we don't have enough data to measure."""
        if self._writer_started_at is None or self._frames_written < 2:
            return self.fps
        elapsed = time.monotonic() - self._writer_started_at
        if elapsed <= 0:
            return self.fps
        return self._frames_written / elapsed

    def _finalize_video(self, raw_path: Path | None, video_path: Path | None, measured_fps: float) -> Path | None:
        """Transcode the raw mp4v recording to browser-friendly H.264, retagging
        the framerate to the measured rate so playback matches wall-clock time.
        Returns the final video path, or None if the raw file is missing."""
        if raw_path is None or video_path is None or not raw_path.exists():
            return None

        ffmpeg = shutil.which("ffmpeg")
        if ffmpeg is None:
            print("  Warning: ffmpeg not found; keeping raw mp4v recording (may not play in browsers).")
            raw_path.rename(video_path)
            return video_path

        try:
            subprocess.run(
                [
                    ffmpeg, "-y", "-loglevel", "error",
                    "-r", f"{measured_fps:.3f}",
                    "-i", str(raw_path),
                    "-c:v", "libx264",
                    "-preset", "veryfast",
                    "-crf", "23",
                    "-pix_fmt", "yuv420p",
                    "-movflags", "+faststart",
                    str(video_path),
                ],
                check=True,
            )
            raw_path.unlink(missing_ok=True)
            return video_path
        except (subprocess.CalledProcessError, FileNotFoundError) as e:
            print(f"  Warning: ffmpeg transcode failed ({e}); keeping raw mp4v recording.")
            if video_path.exists():
                video_path.unlink()
            raw_path.rename(video_path)
            return video_path
