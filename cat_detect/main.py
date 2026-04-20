import argparse
import datetime
import time
from pathlib import Path

import cv2

from cat_detect.camera import Camera
from cat_detect.detect_worker import DetectWorker
from cat_detect.detector import Detector
from cat_detect.notify import send_notification
from cat_detect.recorder import Recorder
from cat_detect.stream import start_stream


def parse_args():
    p = argparse.ArgumentParser(description="Wildlife detector — USB camera + YOLOv8")
    p.add_argument("--camera", type=int, default=0, help="Camera device index (default: 0)")
    p.add_argument("--model", default="yolov8n.pt", help="YOLO model name (default: yolov8n.pt)")
    p.add_argument("--threshold", type=float, default=0.35, help="Min confidence (0-1)")
    p.add_argument("--fps", type=float, default=15.0,
                   help="Video framerate / main loop rate (default: 15)")
    p.add_argument("--detect-interval", type=float, default=1.0,
                   help="Min seconds between YOLO detection runs (default: 1.0)")
    p.add_argument("--snapshot-interval", type=float, default=2.0,
                   help="Min seconds between snapshots during an event (default: 2.0)")
    p.add_argument("--show", action="store_true", help="Show live preview window")
    p.add_argument("--save", action="store_true", help="Save frames with detections to captures/")
    p.add_argument("--ntfy", type=str, default=None, help="ntfy.sh topic name for push notifications")
    p.add_argument("--cooldown", type=int, default=30, help="Seconds between notifications (default: 30)")
    p.add_argument("--flip", action="store_true", help="Rotate camera image 180°")
    p.add_argument("--stream", action="store_true", help="Serve MJPEG video stream over HTTP")
    p.add_argument("--stream-port", type=int, default=8085, help="Port for MJPEG stream (default: 8085)")
    p.add_argument("--record-timeout", type=float, default=20.0,
                   help="Seconds of no detections before stopping video recording (default: 20)")
    p.add_argument("--captures-dir", type=str, default="captures",
                   help="Directory to save snapshots and recordings (default: captures)")
    return p.parse_args()


def draw_detections(frame, detections):
    for det in detections:
        x1, y1, x2, y2 = det["bbox"]
        label = f"{det['label']} {det['confidence']:.0%}"
        cv2.rectangle(frame, (x1, y1), (x2, y2), (0, 255, 0), 2)
        cv2.putText(frame, label, (x1, y1 - 8), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 255, 0), 2)


def save_frame(frame, event_dir):
    event_dir.mkdir(parents=True, exist_ok=True)
    ts = datetime.datetime.now().strftime("%Y%m%d_%H%M%S_%f")[:-3]
    filename = f"snapshot_{ts}.jpg"
    path = event_dir / filename
    cv2.imwrite(str(path), frame)
    return path, filename


def run():
    args = parse_args()
    detector = Detector(args.model, args.threshold)
    cooldown_tracker = {}
    captures_dir = Path(args.captures_dir)

    recorder = Recorder(timeout=args.record_timeout, fps=args.fps, captures_dir=captures_dir)
    worker = DetectWorker(detector, detect_interval=args.detect_interval)

    stream = None
    if args.stream:
        stream = start_stream(args.stream_port)

    print(f"Starting wildlife detector (camera={args.camera}, fps={args.fps}, "
          f"detect_interval={args.detect_interval}s, snapshot_interval={args.snapshot_interval}s)")
    if stream:
        print(f"MJPEG stream → http://0.0.0.0:{args.stream_port}/")
    if args.ntfy:
        print(f"Notifications → ntfy.sh/{args.ntfy} (cooldown={args.cooldown}s)")
    print(f"Video recording enabled (timeout={args.record_timeout}s)")
    print("Press Ctrl+C to stop.\n")

    frame_period = 1.0 / args.fps
    cached_detections: list[dict] = []
    last_snapshot_at: float | None = None
    active_event_dir: Path | None = None

    worker.start()
    with Camera(args.camera) as cam:
        try:
            while True:
                tick_started = time.monotonic()

                frame = cam.read_frame()
                if frame is None:
                    print("Warning: failed to grab frame, retrying...")
                    time.sleep(0.5)
                    continue

                if args.flip:
                    frame = cv2.flip(frame, -1)

                worker.submit_frame(frame)

                result = worker.take_result()
                if result is not None:
                    detections, _ = result
                    cached_detections = detections

                    if detections:
                        species = [d["label"] for d in detections]
                        recorder.detection(species=species)

                        if recorder.event_dir != active_event_dir:
                            active_event_dir = recorder.event_dir
                            last_snapshot_at = None

                        now = time.monotonic()
                        should_snapshot = (
                            last_snapshot_at is None
                            or (now - last_snapshot_at) >= args.snapshot_interval
                        )
                        frame_path = None
                        if should_snapshot and (args.save or args.ntfy) and recorder.event_dir is not None:
                            saved_path, saved_name = save_frame(frame, recorder.event_dir)
                            recorder.note_snapshot(saved_name)
                            frame_path = str(saved_path)
                            last_snapshot_at = now

                        send_notification(
                            detections,
                            frame_path=frame_path,
                            ntfy_topic=args.ntfy,
                            cooldown_tracker=cooldown_tracker,
                            cooldown_seconds=args.cooldown,
                        )

                if cached_detections:
                    draw_detections(frame, cached_detections)

                recorder.write_frame(frame)

                if recorder.event_dir is None and active_event_dir is not None:
                    active_event_dir = None
                    last_snapshot_at = None

                if stream:
                    stream.set_frame(frame)

                if args.show:
                    cv2.imshow("Wildlife Detector", frame)
                    if cv2.waitKey(1) & 0xFF == ord("q"):
                        break

                elapsed = time.monotonic() - tick_started
                sleep_for = frame_period - elapsed
                if sleep_for > 0:
                    time.sleep(sleep_for)
        finally:
            worker.stop()
            recorder.close()

    if args.show:
        cv2.destroyAllWindows()
    print("Stopped.")


if __name__ == "__main__":
    run()
