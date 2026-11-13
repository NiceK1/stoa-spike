"""Quantity take-off from IFC models: room areas from space geometry, element counts per storey."""
import os
import re
from functools import lru_cache

import ifcopenshell
import ifcopenshell.geom
import ifcopenshell.util.element
import ifcopenshell.util.shape

from .model import Answer

QUOTED = re.compile(r"'([^']+)'|„([^“”]+)[“”]|«([^»]+)»|»([^«]+)«|“([^”]+)”|\"([^\"]+)\"")
NAME_WITH_NUMBER = re.compile(r"^(.*) \(([^()]+)\)$")
ALL_ROOMS = ("all rooms", "alle rum", "kõigi ruumide")
WHOLE_MODEL = ("in the model",)
ELEMENT_WORDS = (
    ("IfcSpace", re.compile(r"rooms \(spaces\)|\brum\b|\bruumi\b")),
    ("IfcDoor", re.compile(r"\b(doors|døre|ust)\b")),
    ("IfcWindow", re.compile(r"\b(windows|vinduer)\b")),
    ("IfcWall", re.compile(r"\b(walls|vægge|seina)\b")),
    ("IfcColumn", re.compile(r"\b(columns|søjler)\b")),
    ("IfcStair", re.compile(r"\b(stairs|treppi)\b")),
    ("IfcBeam", re.compile(r"\bbeams\b")),
)


class Model:
    def __init__(self, path):
        self.file = ifcopenshell.open(path)
        self.settings = ifcopenshell.geom.settings()
        self.storeys = {s.Name: s for s in self.file.by_type("IfcBuildingStorey")}
        self._members = {}
        self._areas = {}

    def members(self, storey_name):
        if storey_name not in self._members:
            storey = self.storeys.get(storey_name)
            self._members[storey_name] = (
                list(ifcopenshell.util.element.get_decomposition(storey)) if storey else None)
        return self._members[storey_name]

    def footprint(self, space):
        if space.id() not in self._areas:
            shape = ifcopenshell.geom.create_shape(self.settings, space)
            self._areas[space.id()] = ifcopenshell.util.shape.get_footprint_area(shape.geometry)
        return self._areas[space.id()]


@lru_cache(maxsize=4)
def load(path):
    return Model(path)


def model_path(dataset_root, drawing_path):
    """The IFC behind a drawing: `<model>_plan-<level>.pdf` was rendered from `<model>.ifc`."""
    stem = os.path.splitext(drawing_path)[0].split("_plan-")[0]
    path = os.path.join(dataset_root, stem + ".ifc")
    return path if os.path.exists(path) else None


def quoted(question):
    return [next(g for g in m.groups() if g) for m in QUOTED.finditer(question)]


def space_matches(space, label):
    numbered = NAME_WITH_NUMBER.match(label)
    if numbered:
        return (space.LongName, space.Name) == numbered.groups()
    return label in (space.Name, space.LongName)


def solve(dataset_root, row):
    path = model_path(dataset_root, row["path"])
    names = quoted(row["question"])
    lowered = row["question"].lower()
    qtype = row["type"]

    if qtype == "area" and len(names) == 2:
        kind = "area_room"
        if not path:
            return kind, None
        model = load(path)
        spaces = [e for e in model.members(names[1]) or [] if e.is_a("IfcSpace") and space_matches(e, names[0])]
        if len(spaces) != 1:
            return kind, None
        return kind, Answer(round(model.footprint(spaces[0]), 2), f"footprint of IfcSpace {spaces[0].GlobalId}")

    if qtype == "area" and len(names) == 1 and any(k in lowered for k in ALL_ROOMS):
        kind = "area_storey_rooms"
        members = load(path).members(names[0]) if path else None
        if members is None:
            return kind, None
        model = load(path)
        spaces = [e for e in members if e.is_a("IfcSpace")]
        return kind, Answer(round(sum(model.footprint(s) for s in spaces), 2),
                            f"footprints of {len(spaces)} IfcSpace on {names[0]}")

    if qtype == "count" and len(names) == 1:
        ifc_class = next((c for c, words in ELEMENT_WORDS if words.search(lowered)), None)
        if ifc_class is None:
            return "unparsed", None
        whole_model = any(k in lowered for k in WHOLE_MODEL)
        kind = f"count_{ifc_class[3:].lower()}_{'model' if whole_model else 'storey'}"
        if not path:
            return kind, None
        model = load(path)
        elements = model.file.by_type(ifc_class) if whole_model else model.members(names[0])
        if elements is None:
            return kind, None
        n = sum(1 for e in elements if e.is_a(ifc_class))
        return kind, Answer(n, f"{ifc_class} elements {'in the model' if whole_model else 'on ' + names[0]}")

    return "unparsed", None
