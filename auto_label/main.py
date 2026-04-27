import os
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

from auto_label.labeler import AutoLabeler

labeler: AutoLabeler | None = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    global labeler
    labeler = AutoLabeler(
        os.environ.get("AUTOLABEL_MODEL", "yolov8x-worldv2.pt"),
        float(os.environ.get("AUTOLABEL_CONF", "0.25")),
    )
    yield


app = FastAPI(lifespan=lifespan)


class LabelRequest(BaseModel):
    image_path: str


@app.post("/label")
def label_image(req: LabelRequest):
    p = Path(req.image_path)
    if not p.is_file():
        raise HTTPException(status_code=404, detail="Image not found")
    return {"detections": labeler.label_file(str(p))}


@app.get("/health")
def health():
    return {"ok": labeler is not None}
