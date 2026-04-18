import argparse
import datetime
import time
from pathlib import Path

import cv2

from cat_detect.camera import Camera
from cat_detect.detector import Detector
from cat_detect.notify import send_notification

CAPTURES_DIR = Path("captures")


def parse_args():
    p = argparse.ArgumentParser(description="Wildlife detector — USB camera + YOLOv8")
    p.add_argument("--camera", type=int, default=0, help="Camera device index (default: 0)")
    p.add_argument("--model", default="yolov8n.pt", help="YOLO model name (default: yolov8n.pt)")
    p.add_argument("--threshold", type=float, default=0.35, help="Min confidence (0-1)")
    p.add_argument("--interval", type=float, default=1.0, help="Seconds between detection runs")
    p.add_argument("--show", action="store_true", help="Show live preview window")
    p.add_argument("--save", action="store_true", help="Save frames with detections to captures/")
    p.add_argument("--ntfy", type=str, default=None, help="ntfy.sh topic name for push notifications")
    p.add_argument("--cooldown", type=int, default=30, help="Seconds between notifications (default: 30)")
    return p.parse_args()


def draw_detections(frame, detections):
    for det in detections:
        x1, y1, x2, y2 = det["bbox"]
        label = f"{det['label']} {det['confidence']:.0%}"
        cv2.rectangle(frame, (x1, y1), (x2, y2), (0, 255, 0), 2)
        cv2.putText(frame, label, (x1, y1 - 8), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 255, 0), 2)


def save_frame(frame):
    CAPTURES_DIR.mkdir(exist_ok=True)
    ts = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
    path = CAPTURES_DIR / f"detection_{ts}.jpg"
    cv2.imwrite(str(path), frame)
    return str(path)


def run():
    args = parse_args()
    detector = Detector(args.model, args.threshold)
    cooldown_tracker = {}

    print(f"Starting wildlife detector (camera={args.camera}, interval={args.interval}s)")
    if args.ntfy:
        print(f"Notifications → ntfy.sh/{args.ntfy} (cooldown={args.cooldown}s)")
    print("Press Ctrl+C to stop.\n")

    with Camera(args.camera) as cam:
        while True:
            frame = cam.read_frame()
            if frame is None:
                print("Warning: failed to grab frame, retrying...")
                time.sleep(0.5)
                continue

            detections = detector.detect(frame)

            frame_path = None
            if detections:
                draw_detections(frame, detections)
                if args.save or args.ntfy:
                    frame_path = save_frame(frame)
                send_notification(
                    detections,
                    frame_path=frame_path,
                    ntfy_topic=args.ntfy,
                    cooldown_tracker=cooldown_tracker,
                    cooldown_seconds=args.cooldown,
                )

            if args.show:
                if not detections:
                    draw_detections(frame, detections)
                cv2.imshow("Wildlife Detector", frame)
                if cv2.waitKey(1) & 0xFF == ord("q"):
                    break

            time.sleep(args.interval)

    if args.show:
        cv2.destroyAllWindows()
    print("Stopped.")


if __name__ == "__main__":
    run()
