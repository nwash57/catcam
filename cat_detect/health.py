"""Diagnostic state the detector exposes to the server.

The detector's worst failure modes are silent ones. A network share that stops
being mounted leaves an ordinary writable directory behind, so captures keep
"succeeding" onto the local disk until it fills — no error, no crash, just an
event feed that quietly stops growing. Nothing in the process itself notices.

This module keeps the few signals that make those failures visible from the
outside: a rolling log buffer, where the captures directory physically lives,
and whether events are still landing.
"""

import datetime
import os
import shutil
import threading
from collections import deque
from pathlib import Path

MAX_LOG_LINES = 500

_log_lock = threading.Lock()
_log_lines: deque[dict] = deque(maxlen=MAX_LOG_LINES)


def _now_iso() -> str:
    return datetime.datetime.now().astimezone().isoformat(timespec="seconds")


def log(message, level: str = "info") -> None:
    """Print to stdout (journald) and keep a copy for the /logs endpoint.

    Use in place of print() anywhere the server might want to see the output.
    """
    with _log_lock:
        _log_lines.append({"at": _now_iso(), "level": level, "message": str(message)})
    print(message, flush=True)


def recent_logs(limit: int = 200) -> list[dict]:
    """Most recent log lines, oldest first."""
    with _log_lock:
        lines = list(_log_lines)
    return lines[-limit:] if limit > 0 else lines


def _disk_usage(path) -> dict | None:
    try:
        usage = shutil.disk_usage(path)
        return {
            "totalBytes": usage.total,
            "freeBytes": usage.free,
            "usedBytes": usage.used,
            "percentUsed": round(usage.used * 100.0 / usage.total, 1) if usage.total else None,
        }
    except Exception:
        return None


def _nearest_mount_point(path: Path) -> str | None:
    """Walk up from `path` to the first directory that is a mount point."""
    try:
        current = path.resolve()
    except Exception:
        return None
    while True:
        if os.path.ismount(current):
            return str(current)
        if current.parent == current:
            return str(current)
        current = current.parent


def _on_root_filesystem(path: Path) -> bool | None:
    """True if `path` lives on the same device as /.

    This is the mount check that matters. The captures directory is typically a
    *subdirectory* of the mount point (/mnt/share/CatCam under /mnt/share), so
    os.path.ismount() on it returns False even when everything is fine. The
    device ID does not lie: when the share drops, the path silently falls back
    to the root filesystem's device.
    """
    try:
        return os.stat(path).st_dev == os.stat("/").st_dev
    except Exception:
        return None


class HealthState:
    """Thread-safe record of whether captures are actually reaching disk."""

    def __init__(self):
        self._lock = threading.Lock()
        self._captures_dir: Path | None = None
        self._last_event_at: str | None = None
        self._last_event_id: str | None = None
        self._last_write_error: dict | None = None
        self._started_at = _now_iso()

    def set_captures_dir(self, path: Path) -> None:
        with self._lock:
            self._captures_dir = Path(path)

    def note_event(self, event_id: str) -> None:
        """An event directory was created successfully — the happy path."""
        with self._lock:
            self._last_event_at = _now_iso()
            self._last_event_id = event_id
            self._last_write_error = None

    def note_write_error(self, message) -> None:
        with self._lock:
            self._last_write_error = {"at": _now_iso(), "message": str(message)}

    def snapshot(self) -> dict:
        with self._lock:
            captures_dir = self._captures_dir
            data = {
                "path": str(captures_dir) if captures_dir else None,
                "detectorStartedAt": self._started_at,
                "lastEventAt": self._last_event_at,
                "lastEventId": self._last_event_id,
                "lastWriteError": self._last_write_error,
            }

        if captures_dir is None:
            data.update(mountPoint=None, onRootFilesystem=None, writable=None, disk=None)
            return data

        data["mountPoint"] = _nearest_mount_point(captures_dir)
        data["onRootFilesystem"] = _on_root_filesystem(captures_dir)
        data["writable"] = os.access(captures_dir, os.W_OK)
        data["disk"] = _disk_usage(captures_dir)
        return data


def root_disk() -> dict | None:
    """Usage of the filesystem the OS itself lives on (the SD card, on a Pi)."""
    return _disk_usage("/")


state = HealthState()
