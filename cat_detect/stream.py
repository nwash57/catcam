import threading
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler

import cv2


class MJPEGHandler(BaseHTTPRequestHandler):
    """Serves the latest camera frame as an MJPEG stream."""

    def do_GET(self):
        if self.path != "/":
            self.send_error(404)
            return

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

    def log_message(self, format, *args):
        pass  # silence per-request logs


class StreamServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, port: int = 8085):
        super().__init__(("0.0.0.0", port), MJPEGHandler)
        self.frame_bytes = None
        self.frame_cond = threading.Condition()

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
