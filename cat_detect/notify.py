import datetime
import requests


def send_notification(
    detections: list[dict],
    frame_path: str | None = None,
    ntfy_topic: str | None = None,
    cooldown_tracker: dict | None = None,
    cooldown_seconds: int = 30,
):
    """Send a push notification via ntfy.sh with the detection image."""
    timestamp = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")

    # Console log always
    for det in detections:
        print(
            f"[{timestamp}] Detected {det['label']} "
            f"(confidence={det['confidence']:.0%}) "
            f"bbox={det['bbox']}"
        )

    if not ntfy_topic:
        return

    # Cooldown — don't spam notifications for the same animal hanging around
    now = datetime.datetime.now()
    if cooldown_tracker is not None:
        last_sent = cooldown_tracker.get("last_sent")
        if last_sent and (now - last_sent).total_seconds() < cooldown_seconds:
            return
        cooldown_tracker["last_sent"] = now

    labels = ", ".join(f"{d['label']} ({d['confidence']:.0%})" for d in detections)
    title = f"Wildlife detected!"
    body = f"{labels}\n{timestamp}"

    try:
        if frame_path:
            with open(frame_path, "rb") as f:
                requests.post(
                    f"https://ntfy.sh/{ntfy_topic}",
                    data=f,
                    headers={
                        "Title": title,
                        "Filename": "detection.jpg",
                        "Tags": "camera,eyes",
                    },
                    timeout=10,
                )
        else:
            requests.post(
                f"https://ntfy.sh/{ntfy_topic}",
                data=body,
                headers={"Title": title, "Tags": "camera,eyes"},
                timeout=10,
            )
        print(f"  Notification sent to ntfy.sh/{ntfy_topic}")
    except requests.RequestException as e:
        print(f"  Failed to send notification: {e}")
