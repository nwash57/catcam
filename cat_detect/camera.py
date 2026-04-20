import cv2


class Camera:
    """Captures frames from a USB UVC camera via OpenCV."""

    def __init__(self, device_index: int = 0, width: int = 1280, height: int = 720, mjpg: bool = False):
        self.cap = cv2.VideoCapture(device_index)
        if not self.cap.isOpened():
            raise RuntimeError(
                f"Could not open camera at index {device_index}. "
                "Check that your USB camera is connected."
            )
        if mjpg:
            # Request MJPEG from the camera — most UVC cams deliver much higher
            # fps in MJPG than in uncompressed YUYV, especially at 1080p.
            self.cap.set(cv2.CAP_PROP_FOURCC, cv2.VideoWriter_fourcc(*"MJPG"))
        self.cap.set(cv2.CAP_PROP_FRAME_WIDTH, width)
        self.cap.set(cv2.CAP_PROP_FRAME_HEIGHT, height)

    def read_frame(self):
        """Return a single BGR frame as a numpy array, or None on failure."""
        ok, frame = self.cap.read()
        return frame if ok else None

    def release(self):
        self.cap.release()

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.release()
