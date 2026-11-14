"""Train one detector run. Usage: train.py <name> <weights> <imgsz> <epochs> <batch> [key=value ...]"""
import os
import sys

from ultralytics import RTDETR, YOLO


def parse(value):
    for cast in (int, float):
        try:
            return cast(value)
        except ValueError:
            pass
    return {"True": True, "False": False}.get(value, value)


name, weights, imgsz, epochs, batch = sys.argv[1], sys.argv[2], int(sys.argv[3]), int(sys.argv[4]), int(sys.argv[5])
extra = {}
for item in sys.argv[6:]:
    key, value = item.split("=", 1)
    extra[key] = parse(value)
settings = dict(
    data="/data/yolo/data.yaml", imgsz=imgsz, epochs=epochs, batch=batch, workers=16, cache="ram",
    project="/data/runs", name=name, exist_ok=True, cos_lr=True, patience=40, plots=False,
    # Room classes depend on reading label text, so no mirroring.
    fliplr=0.0, flipud=0.0, mosaic=0.5, close_mosaic=10, scale=0.4, hsv_h=0.0, hsv_s=0.3, hsv_v=0.2,
)
settings.update(extra)
model = (RTDETR if "rtdetr" in os.path.basename(weights) else YOLO)(weights)
model.train(**settings)
