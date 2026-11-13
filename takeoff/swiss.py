"""Quantity take-off from layered DXF floor plans (Swiss Dwellings layout).

Layers: ROOM_OUTLINE, UNIT_OUTLINE, DOOR, WINDOW, FIXTURE, ROOM_TEXT.
"""
import os
import re
from dataclasses import dataclass
from functools import lru_cache

from .dxf import read_entities
from .evidence import render_svg
from .geometry import contains, polygon_area
from .model import Answer
from .questions import parse

ROOM_NUMBER = re.compile(r"^[A-Z]?\d+\.\d+$")
AREA_TEXT = re.compile(r"^(\d+(?:\.\d+)?)\s*m")
UNIT_LABEL = re.compile(r"^\S{1,8}\.? ([A-Z])$")  # 'App. A', 'Whg. B'
OUTDOOR = {"balkon", "balcon", "balcone", "loggia", "terrasse", "terrazza"}

# Vertex counts the drawing generator uses for fixture symbols.
BOWL_VERTICES, BATHTUB_VERTICES, SHOWER_VERTICES = 48, 69, 5
STACK_GAP = 0.6  # max vertical distance between the stacked name / number / area labels of one room


@dataclass
class Room:
    name: str | None
    number: str | None
    polygon: list | None
    area: float | None
    point: tuple


class Plan:
    def __init__(self, entities):
        by_layer = {}
        for e in entities:
            by_layer.setdefault(e.layer, []).append(e)

        def polygons(layer):
            return [e.points for e in by_layer.get(layer, []) if e.type == "LWPOLYLINE" and len(e.points) >= 3]

        self.room_outlines = polygons("ROOM_OUTLINE")
        self.unit_outlines = polygons("UNIT_OUTLINE")
        self.walls = polygons("WALL")
        self.doors = polygons("DOOR")
        self.windows = polygons("WINDOW")

        texts = [(e.text.strip(), e.points[0]) for e in by_layer.get("ROOM_TEXT", []) if e.points]
        self.unit_labels = {m.group(1): p for t, p in texts if (m := UNIT_LABEL.match(t))}
        self.rooms = self._rooms(texts)
        self._fixtures(by_layer.get("FIXTURE", []))

    def _rooms(self, texts):
        def is_name(text):
            return not (ROOM_NUMBER.match(text) or AREA_TEXT.match(text) or UNIT_LABEL.match(text))

        def stacked(point, direction):
            """Labels in the same column, nearest first; direction +1 looks above, -1 below."""
            return [t for _, t in sorted((abs(p[1] - point[1]), t) for t, p in texts
                                         if abs(p[0] - point[0]) < 1e-3
                                         and 0 < (p[1] - point[1]) * direction < STACK_GAP)]

        def room(name, number, point):
            printed = next((float(m.group(1)) for t in stacked(point, -1) if (m := AREA_TEXT.match(t))), None)
            polygon = min((o for o in self.room_outlines if contains(o, point)), key=polygon_area, default=None)
            return Room(name, number, polygon, polygon_area(polygon) if polygon else printed, point)

        # Rooms too small for a full label carry only their number.
        rooms = [room(next((t for t in stacked(point, +1) if is_name(t)), None), text, point)
                 for text, point in texts if ROOM_NUMBER.match(text)]
        rooms += [room(text, None, point) for text, point in texts
                  if is_name(text) and not any(ROOM_NUMBER.match(t) for t in stacked(point, -1))]
        return rooms

    def _fixtures(self, entities):
        open_lines = [e.points for e in entities if e.type == "LWPOLYLINE" and not e.closed]
        boxes = [e.points for e in entities if e.type == "LWPOLYLINE" and e.closed and len(e.points) >= 3]
        strokes = [mid(p) for p in open_lines if len(p) == 2]

        self.bathtubs = [p for p in open_lines if len(p) == BATHTUB_VERTICES]
        self.showers = [p for p in open_lines if len(p) == SHOWER_VERTICES]
        self.toilets, self.washbasins = [], []
        for bowl in (p for p in open_lines if len(p) == BOWL_VERTICES):
            box = min((b for b in boxes if contains(b, mid(bowl))), key=polygon_area, default=None)
            # A toilet symbol has a cistern stroke inside its box; a washbasin has a tap circle instead.
            is_toilet = box is not None and any(contains(box, s) for s in strokes)
            (self.toilets if is_toilet else self.washbasins).append(box or bowl)

    def labelled(self, name):
        return [r for r in self.rooms if (r.name or "").lower() == name.lower()]

    def unit_rooms(self, letter):
        label = self.unit_labels.get(letter)
        if label is None:
            return []
        outlines = [o for o in self.unit_outlines if contains(o, label)]
        return [r for r in self.rooms if any(contains(o, r.point) for o in outlines)]

    def answer(self, intent):
        kind = intent.kind
        if kind == "count_rooms_labelled" and intent.name:
            return count(self.labelled(intent.name), f"room labels equal to '{intent.name}'")
        if kind == "count_apartments":
            outlines = [o for o in self.unit_outlines if any(contains(o, p) for p in self.unit_labels.values())]
            return Answer(len(self.unit_labels), "unit labels", outlines)
        symbols = {
            "count_doors": (self.doors, "door symbols on layer DOOR"),
            "count_windows": (self.windows, "window symbols on layer WINDOW"),
            "count_toilets": (self.toilets, "bowl symbols with a cistern stroke"),
            "count_washbasins": (self.washbasins, "bowl symbols with a tap"),
            "count_bathtubs": (self.bathtubs, "bathtub symbols"),
            "count_showers": (self.showers, "shower tray symbols"),
        }
        if kind in symbols:
            shapes, method = symbols[kind]
            return Answer(len(shapes), method, shapes)
        if kind == "area_room" and intent.number:
            rooms = [r for r in self.rooms if r.number == intent.number]
            return total_area(rooms, f"outline of room {intent.number}") if len(rooms) == 1 else None
        if kind == "area_rooms_labelled" and intent.name:
            return total_area(self.labelled(intent.name), f"outlines of rooms labelled '{intent.name}'")
        if kind == "area_all_indoor":
            return total_area([r for r in self.rooms if r.number and is_indoor(r)], "outlines of numbered indoor rooms")
        if kind == "area_apartment" and intent.unit:
            rooms = [r for r in self.unit_rooms(intent.unit) if is_indoor(r)]
            return total_area(rooms, f"indoor room outlines inside unit {intent.unit}")
        return None


def mid(points):
    return sum(x for x, _ in points) / len(points), sum(y for _, y in points) / len(points)


def is_indoor(room):
    return (room.name or "").lower() not in OUTDOOR


def count(rooms, method):
    return Answer(len(rooms), method, [r.polygon for r in rooms if r.polygon])


def total_area(rooms, method):
    if not rooms or any(r.area is None for r in rooms):
        return None
    return Answer(round(sum(r.area for r in rooms), 2), method, [r.polygon for r in rooms if r.polygon])


@lru_cache(maxsize=None)
def load(dxf_path):
    return Plan(read_entities(dxf_path))


def cad_path(dataset_root, drawing_path):
    """The DXF twin of a drawing: files sharing a name are the same drawing in another format."""
    path = os.path.join(dataset_root, os.path.splitext(drawing_path)[0] + ".dxf")
    return path if os.path.exists(path) else None


def solve(dataset_root, row):
    intent = parse(row["question"], row["type"])
    if intent is None:
        return "unparsed", None
    path = cad_path(dataset_root, row["path"])
    return intent.kind, load(path).answer(intent) if path else None


def render(dataset_root, row, answer, out_path):
    render_svg(load(cad_path(dataset_root, row["path"])), answer, row["question"], out_path)
