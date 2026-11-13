"""Minimal ASCII DXF entity reader: enough for layered 2D plans, no dependencies."""
from dataclasses import dataclass, field


@dataclass
class Entity:
    type: str
    layer: str = ""
    handle: str = ""
    points: list = field(default_factory=list)
    closed: bool = False
    text: str = ""
    radius: float = 0.0


def read_entities(path):
    with open(path, encoding="utf-8", errors="replace") as f:
        lines = f.read().splitlines()

    entities = []
    current = None
    in_entities = False
    section_name_next = False
    pending_x = None

    for i in range(0, len(lines) - 1, 2):
        try:
            code = int(lines[i].strip())
        except ValueError:
            continue
        value = lines[i + 1].strip()

        if code == 0:
            current = None
            if value == "SECTION":
                section_name_next = True
            elif value == "ENDSEC":
                in_entities = False
            elif in_entities:
                current = Entity(type=value)
                entities.append(current)
            continue
        if section_name_next and code == 2:
            in_entities = value == "ENTITIES"
            section_name_next = False
            continue
        if current is None:
            continue

        if code == 8:
            current.layer = value
        elif code == 5:
            current.handle = value
        elif code == 70 and current.type == "LWPOLYLINE":
            current.closed = bool(int(value) & 1)
        elif code == 10:
            pending_x = float(value)
        elif code == 20 and pending_x is not None:
            current.points.append((pending_x, float(value)))
            pending_x = None
        elif code == 1:
            current.text = value
        elif code == 40 and current.type in ("CIRCLE", "ARC"):
            current.radius = float(value)
    return entities
