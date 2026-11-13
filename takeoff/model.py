from dataclasses import dataclass, field


@dataclass
class Intent:
    kind: str
    name: str | None = None
    number: str | None = None
    unit: str | None = None


@dataclass
class Answer:
    value: float
    method: str
    # Polygons (point lists) the value was derived from, for the human-check overlay.
    highlights: list = field(default_factory=list)
