import json
import platform
import socket
import subprocess
import threading
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler

import cv2


class MJPEGHandler(BaseHTTPRequestHandler):
    """Serves the latest camera frame as MJPEG and device metrics as JSON."""

    def do_GET(self):
        if self.path == "/metrics":
            self._serve_metrics()
        elif self.path == "/":
            self._serve_stream()
        else:
            self.send_error(404)

    def _serve_stream(self):
        self.send_response(200)
        self.send_header("Content-Type", "multipart/x-mixed-replace; boundary=frame")
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()

        server = self.server
        while True:
            with server.frame_cond:
                server.frame_cond.wait()
                frame_bytes = server.frame_bytes

            if frame_bytes is None:
                continue
            try:
                self.wfile.write(b"--frame\r\n")
                self.wfile.write(b"Content-Type: image/jpeg\r\n\r\n")
                self.wfile.write(frame_bytes)
                self.wfile.write(b"\r\n")
            except BrokenPipeError:
                break

    def _serve_metrics(self):
        data = _build_metrics(self.server)
        body = json.dumps(data).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format, *args):
        pass  # silence per-request logs


class StreamServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, port: int = 8085):
        super().__init__(("0.0.0.0", port), MJPEGHandler)
        self.frame_bytes = None
        self.frame_cond = threading.Condition()
        self._prev_cpu = None
        self._cpu_lock = threading.Lock()

    def set_frame(self, frame):
        """Push a new BGR numpy frame to all connected viewers."""
        ok, buf = cv2.imencode(".jpg", frame)
        if not ok:
            return
        with self.frame_cond:
            self.frame_bytes = buf.tobytes()
            self.frame_cond.notify_all()


def start_stream(port: int = 8085) -> StreamServer:
    """Start the MJPEG server in a background thread and return it."""
    server = StreamServer(port)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server


# ── metrics helpers ──────────────────────────────────────────────────────────

def _read_uptime():
    try:
        with open("/proc/uptime") as f:
            return float(f.read().split()[0])
    except Exception:
        return None


def _read_cpu_temp():
    try:
        with open("/sys/class/thermal/thermal_zone0/temp") as f:
            return int(f.read().strip()) / 1000.0
    except Exception:
        return None


def _read_cpu_snapshot():
    try:
        with open("/proc/stat") as f:
            line = f.readline()
        if not line.startswith("cpu "):
            return None
        values = [int(x) for x in line.split()[1:]]
        total = sum(values)
        idle = values[3] + (values[4] if len(values) > 4 else 0)
        return (total, idle)
    except Exception:
        return None


def _read_cpu_freq():
    try:
        with open("/sys/devices/system/cpu/cpu0/cpufreq/scaling_cur_freq") as f:
            return int(f.read().strip()) / 1000.0
    except Exception:
        return None


def _read_load_avg():
    try:
        with open("/proc/loadavg") as f:
            parts = f.read().split()
        return {
            "oneMinute": float(parts[0]),
            "fiveMinute": float(parts[1]),
            "fifteenMinute": float(parts[2]),
        }
    except Exception:
        return None


def _read_memory():
    try:
        total_kb = avail_kb = free_kb = None
        with open("/proc/meminfo") as f:
            for line in f:
                if line.startswith("MemTotal:"):
                    total_kb = int(line.split()[1])
                elif line.startswith("MemAvailable:"):
                    avail_kb = int(line.split()[1])
                elif line.startswith("MemFree:"):
                    free_kb = int(line.split()[1])
                if total_kb is not None and avail_kb is not None:
                    break
        if total_kb is None:
            return None
        avail = avail_kb if avail_kb is not None else (free_kb or 0)
        return {
            "totalBytes": total_kb * 1024,
            "availableBytes": avail * 1024,
            "usedBytes": (total_kb - avail) * 1024,
        }
    except Exception:
        return None


def _read_throttled():
    """Read Pi throttle/undervoltage state via vcgencmd (Raspberry Pi only)."""
    try:
        result = subprocess.run(
            ["vcgencmd", "get_throttled"],
            capture_output=True, text=True, timeout=1,
        )
        if result.returncode != 0:
            return None
        val = int(result.stdout.strip().split("=")[1], 16)
        return {
            "underVoltageNow": bool(val & 0x1),
            "throttledNow": bool(val & 0x4),
            "underVoltageEver": bool(val & 0x10000),
            "throttledEver": bool(val & 0x40000),
        }
    except Exception:
        return None


def _build_metrics(server: StreamServer) -> dict:
    cpu_usage = None
    snapshot = _read_cpu_snapshot()
    if snapshot is not None:
        with server._cpu_lock:
            prev = server._prev_cpu
            server._prev_cpu = snapshot
        if prev is not None:
            total_delta = snapshot[0] - prev[0]
            idle_delta = snapshot[1] - prev[1]
            if total_delta > 0:
                cpu_usage = max(0.0, min(100.0, (total_delta - idle_delta) * 100.0 / total_delta))

    return {
        "hostname": socket.gethostname(),
        "os": platform.platform(),
        "uptimeSeconds": _read_uptime(),
        "cpuTemperatureC": _read_cpu_temp(),
        "cpuUsagePercent": cpu_usage,
        "cpuFrequencyMhz": _read_cpu_freq(),
        "loadAverage": _read_load_avg(),
        "memory": _read_memory(),
        "throttled": _read_throttled(),
    }
