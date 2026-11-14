"""Parse CubiCasa5k model.svg files into per-drawing features in Stoa image coordinates.

Output: /data/feat/features.jsonl, one line per Stoa drawing:
  {"stem", "width", "height", "floors", "windows": [box], "doors": [{"kind", "box"}],
   "fixtures": [{"name", "box"}], "spaces": [{"kind", "label", "box"}]}
Boxes are [x0, y0, x1, y1] in pixels of the Stoa PNG (CubiCasa's F1_original.png); each item carries its floor number.
Plans that are not in Stoa's set are kept too (image = CubiCasa's own F1_original.png) as extra training data.
"""
import glob
import json
import math
import os
import re
import struct
from multiprocessing import Pool

from lxml import etree

CUBI = "/data/cubi/cubicasa5k"
STOA = "/data/stoa/junction-dataset/data/cubicasa5k"
OUT = "/data/feat"
NUM = re.compile(r"[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?")
IDENTITY = (1.0, 0.0, 0.0, 1.0, 0.0, 0.0)


def png_size(path):
    with open(path, "rb") as f:
        return struct.unpack(">II", f.read(24)[16:24])


def compose(m, n):
    """Matrix for applying n first, then m (both as SVG a,b,c,d,e,f)."""
    a, b, c, d, e, f = m
    g, h, i, j, k, l = n
    return (a * g + c * h, b * g + d * h, a * i + c * j, b * i + d * j, a * k + c * l + e, b * k + d * l + f)


def parse_transform(text):
    m = IDENTITY
    for name, args in re.findall(r"(\w+)\s*\(([^)]*)\)", text or ""):
        v = [float(x) for x in NUM.findall(args)]
        if name == "matrix" and len(v) == 6:
            t = tuple(v)
        elif name == "translate":
            t = (1, 0, 0, 1, v[0], v[1] if len(v) > 1 else 0)
        elif name == "scale":
            t = (v[0], 0, 0, v[1] if len(v) > 1 else v[0], 0, 0)
        elif name == "rotate":
            r = math.radians(v[0])
            t = (math.cos(r), math.sin(r), -math.sin(r), math.cos(r), 0, 0)
            if len(v) == 3:
                t = compose(compose((1, 0, 0, 1, v[1], v[2]), t), (1, 0, 0, 1, -v[1], -v[2]))
        else:
            continue
        m = compose(m, t)
    return m


def apply(m, x, y):
    return m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]


def path_points(d):
    """Vertices and control points of an SVG path, absolute. Enough for a bounding box."""
    points, x, y, start = [], 0.0, 0.0, (0.0, 0.0)
    for cmd, args in re.findall(r"([MmLlHhVvCcSsQqTtAaZz])([^MmLlHhVvCcSsQqTtAaZz]*)", d or ""):
        v = [float(n) for n in NUM.findall(args)]
        rel = cmd.islower()
        c = cmd.upper()
        if c == "Z":
            x, y = start
            continue
        step = {"M": 2, "L": 2, "T": 2, "H": 1, "V": 1, "C": 6, "S": 4, "Q": 4, "A": 7}[c]
        for i in range(0, len(v) - step + 1, step):
            chunk = v[i:i + step]
            if c == "H":
                x = x + chunk[0] if rel else chunk[0]
            elif c == "V":
                y = y + chunk[0] if rel else chunk[0]
            elif c == "A":
                x, y = (x + chunk[5], y + chunk[6]) if rel else (chunk[5], chunk[6])
            else:
                pairs = [(chunk[j], chunk[j + 1]) for j in range(0, step, 2)]
                pairs = [(x + px, y + py) for px, py in pairs] if rel else pairs
                points.extend(pairs[:-1])
                x, y = pairs[-1]
            points.append((x, y))
            if c == "M" and i == 0:
                start = (x, y)
    return points


def own_points(el):
    tag = etree.QName(el).localname
    if tag == "polygon" or tag == "polyline":
        v = [float(n) for n in NUM.findall(el.get("points") or "")]
        return list(zip(v[0::2], v[1::2]))
    if tag == "rect":
        x, y, w, h = (float(el.get(k) or 0) for k in ("x", "y", "width", "height"))
        return [(x, y), (x + w, y), (x + w, y + h), (x, y + h)]
    if tag == "circle":
        cx, cy, r = (float(el.get(k) or 0) for k in ("cx", "cy", "r"))
        return [(cx - r, cy - r), (cx + r, cy + r), (cx - r, cy + r), (cx + r, cy - r)]
    if tag == "line":
        return [(float(el.get("x1") or 0), float(el.get("y1") or 0)), (float(el.get("x2") or 0), float(el.get("y2") or 0))]
    if tag == "path":
        return path_points(el.get("d"))
    return []


def subtree_points(el, matrix, skip=()):
    """Transformed points of every shape under el; `matrix` already includes el's own transform."""
    points = []
    for child in el:
        if not isinstance(child.tag, str):
            continue
        cls = (child.get("class") or "").split()
        if cls and cls[0] in skip:
            continue
        m = compose(matrix, parse_transform(child.get("transform")))
        points += [apply(m, x, y) for x, y in own_points(child)]
        points += subtree_points(child, m, skip)
    return points


def box(points, sx, sy):
    xs = [p[0] * sx for p in points]
    ys = [p[1] * sy for p in points]
    return [round(min(xs), 1), round(min(ys), 1), round(max(xs), 1), round(max(ys), 1)]


def parse(svg_path):
    folder = os.path.dirname(svg_path)
    category, plan_id = folder.split("/")[-2:]
    stem = f"{category}-{plan_id}"
    png = f"{STOA}/{stem}.png"
    in_stoa = os.path.exists(png)
    if not in_stoa:
        png = f"{folder}/F1_original.png"
    width, height = png_size(png)
    scaled_w, scaled_h = png_size(f"{folder}/F1_scaled.png")
    sx, sy = width / scaled_w, height / scaled_h
    out = {"stem": stem, "image": png, "in_stoa": in_stoa, "width": width, "height": height, "floors": 0,
           "windows": [], "doors": [], "fixtures": [], "spaces": []}

    def walk(el, matrix, floor=0):
        for child in el:
            if not isinstance(child.tag, str):
                continue
            m = compose(matrix, parse_transform(child.get("transform")))
            cls = (child.get("class") or "").split()
            head = cls[0] if cls else ""
            if head == "Floorplan":
                out["floors"] += 1
                floor = out["floors"]
            if head == "Window":
                pts = subtree_points(child, m)
                if pts:
                    out["windows"].append({"kind": " ".join(cls[1:]), "box": box(pts, sx, sy), "floor": floor})
                continue
            if head == "Door":
                pts = subtree_points(child, m)
                if pts:
                    out["doors"].append({"kind": " ".join(cls[1:]), "box": box(pts, sx, sy), "floor": floor})
                continue
            if head == "FixedFurniture":
                boundary = [g for g in child if isinstance(g.tag, str) and (g.get("class") or "").startswith("BoundaryPolygon")]
                pts = subtree_points(boundary[0], compose(m, parse_transform(boundary[0].get("transform")))) if boundary else subtree_points(child, m, skip=("Direction", "Name"))
                if pts:
                    out["fixtures"].append({"name": " ".join(cls[1:]), "box": box(pts, sx, sy), "floor": floor})
                continue
            if head == "Space":
                pts = [apply(m, x, y) for g in child if isinstance(g.tag, str) and etree.QName(g).localname == "polygon" for x, y in own_points(g)]
                label = ""
                for g in child.iter():
                    if isinstance(g.tag, str) and "NameLabel" in (g.get("class") or ""):
                        label = " ".join(t.strip() for t in g.itertext() if t.strip())
                        break
                if pts:
                    out["spaces"].append({"kind": " ".join(cls[1:]), "label": label, "box": box(pts, sx, sy), "floor": floor})
                continue
            walk(child, m, floor)

    walk(etree.parse(svg_path).getroot(), IDENTITY)
    return out


if __name__ == "__main__":
    os.makedirs(OUT, exist_ok=True)
    plans = sorted(glob.glob(f"{CUBI}/*/*/model.svg"))
    with Pool(20) as pool, open(f"{OUT}/features.jsonl", "w") as f:
        n = 0
        for result in pool.imap(parse, plans, chunksize=20):
            if result:
                f.write(json.dumps(result) + "\n")
                n += 1
    print("wrote features for", n, "drawings")
