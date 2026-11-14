"""COCO copy of the symbols dataset for RF-DETR: every drawing letterboxed onto a square of SIDE pixels.

    rfdetr_data.py        # writes /data/round3/rfdetr/data/{train,valid,dev}; test is a link to valid

RF-DETR resizes its input to a square, which would squash a wide drawing. Letterboxing first keeps the aspect ratio
and the geometry the YOLO runs see (long side SIDE, grey padding, centred). Parts train, val and dev of
/data/sweep/data/yolo_sym; the test part is never read. meta.json maps canvas pixels back to the drawing.
"""
import json
import os
from multiprocessing import Pool

import cv2
import numpy as np

SOURCE = "/data/sweep/data/yolo_sym"
OUT = "/data/round3/rfdetr/data"
SIDE = 1280
FOLDER = {"train": "train", "val": "valid", "dev": "dev"}
NAMES = [l.split(": ", 1)[1].strip() for l in open(f"{SOURCE}/data.yaml") if l.startswith("  ")]


def letterbox(image):
    """The drawing scaled to fit a SIDE x SIDE grey canvas, with (scale, left, top)."""
    h, w = image.shape[:2]
    scale = SIDE / max(h, w)
    nw, nh = round(w * scale), round(h * scale)
    resized = cv2.resize(image, (nw, nh), interpolation=cv2.INTER_AREA if scale < 1 else cv2.INTER_LINEAR)
    canvas = np.full((SIDE, SIDE, 3), 114, np.uint8)
    left, top = (SIDE - nw) // 2, (SIDE - nh) // 2
    canvas[top:top + nh, left:left + nw] = resized
    return canvas, scale, left, top


def job(args):
    part, stem = args
    image = cv2.imread(f"{SOURCE}/images/{part}/{stem}.png", cv2.IMREAD_COLOR)
    h, w = image.shape[:2]
    canvas, scale, left, top = letterbox(image)
    cv2.imwrite(f"{OUT}/{FOLDER[part]}/{stem}.png", canvas, [cv2.IMWRITE_PNG_COMPRESSION, 1])
    boxes = []
    for line in open(f"{SOURCE}/labels/{part}/{stem}.txt"):
        if line.strip():
            cls, xc, yc, bw, bh = line.split()
            bw, bh = float(bw) * w * scale, float(bh) * h * scale
            boxes.append([int(cls), float(xc) * w * scale + left - bw / 2, float(yc) * h * scale + top - bh / 2, bw, bh])
    return part, stem, [scale, left, top, w, h], boxes


def main():
    jobs = []
    for part, folder in FOLDER.items():
        os.makedirs(f"{OUT}/{folder}", exist_ok=True)
        jobs += [(part, l.strip()) for l in open(f"{SOURCE}/splits/{part}.txt") if l.strip()]
    with Pool(12) as pool:
        rows = pool.map(job, jobs, chunksize=16)
    meta = {}
    for part, folder in FOLDER.items():
        images, annotations = [], []
        for _, stem, placed, boxes in (r for r in rows if r[0] == part):
            meta[stem] = placed
            images.append({"id": len(images) + 1, "file_name": f"{stem}.png", "width": SIDE, "height": SIDE})
            for cls, x, y, bw, bh in boxes:
                annotations.append({"id": len(annotations) + 1, "image_id": len(images), "category_id": cls + 1,
                                    "bbox": [round(x, 2), round(y, 2), round(bw, 2), round(bh, 2)],
                                    "area": round(bw * bh, 2), "iscrowd": 0})
        categories = [{"id": i + 1, "name": n} for i, n in enumerate(NAMES)]
        json.dump({"info": {}, "licenses": [], "images": images, "annotations": annotations, "categories": categories},
                  open(f"{OUT}/{folder}/_annotations.coco.json", "w"))
        print(f"{folder}: {len(images)} drawings, {len(annotations)} boxes, per class "
              f"{ {n: sum(a['category_id'] == i + 1 for a in annotations) for i, n in enumerate(NAMES)} }")
    json.dump(meta, open(f"{OUT}/meta.json", "w"))
    # The trainer looks for a test folder; it gets the validation drawings, never the test part.
    if not os.path.lexists(f"{OUT}/test"):
        os.symlink("valid", f"{OUT}/test")


if __name__ == "__main__":
    main()
