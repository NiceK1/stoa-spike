"""Map a natural-language take-off question (EN/DE/FR/IT) to a structured intent."""
import re

from .model import Intent

APARTMENT = re.compile(r"(?i:\b(?:apartment|appartement|appartamento|wohnung))\s+([A-Z])\b")
ROOM_NUMBER = re.compile(r"(?i:\b(?:room|pièce|locale|raum))\s+([A-Z]?\d+(?:\.\d+)?)")

ALL_INDOOR = ("numbered indoor rooms", "intérieures numérotées", "nummerierten innenräume", "interni numerati")
AREA_BY_LABEL = ("all rooms labelled", "toutes les pièces désignées", "aller räume mit der bezeichnung",
                 "tutti i locali denominati")
COUNT_BY_LABEL = ("rooms labelled", "pièces portant la désignation", "räume mit der bezeichnung",
                  "locali con la denominazione")

# Checked in order; room-label templates are matched before these, so French "portant" never reaches "porte".
COUNT_KINDS = (
    ("count_apartments", re.compile(r"\b(apartments|appartements|wohnungen|appartamenti)\b")),
    ("count_doors", re.compile(r"\b(doors|portes|türen|porte)\b")),
    ("count_windows", re.compile(r"\b(windows|fenêtres|fenster|finestre)\b")),
    ("count_toilets", re.compile(r"\b(toilets|wcs?)\b")),
    ("count_washbasins", re.compile(r"\b(washbasins|lavabos|lavabi)\b")),
    ("count_bathtubs", re.compile(r"\b(bathtubs|baignoires|badewannen|vasche da bagno)\b")),
    ("count_showers", re.compile(r"\b(showers|douches|duschen|docce)\b")),
)

QUOTE_PAIRS = (("«", "»"), ("„", "“"), ("„", "”"), ("“", "”"), ("‘", "’"), ("'", "'"), ('"', '"'))


def quoted_name(question):
    """Text between the first opening and the last closing quote; names may contain apostrophes."""
    for opening, closing in QUOTE_PAIRS:
        start = question.find(opening)
        end = question.rfind(closing)
        if 0 <= start < end:
            return question[start + 1:end].strip()
    return None


def parse(question, qtype):
    lowered = question.lower()
    if qtype == "area":
        apartment = APARTMENT.search(question)
        if apartment:
            return Intent("area_apartment", unit=apartment.group(1))
        if any(k in lowered for k in ALL_INDOOR):
            return Intent("area_all_indoor")
        if any(k in lowered for k in AREA_BY_LABEL):
            return Intent("area_rooms_labelled", name=quoted_name(question))
        room = ROOM_NUMBER.search(question)
        if room:
            return Intent("area_room", number=room.group(1))
    elif qtype == "count":
        if any(k in lowered for k in COUNT_BY_LABEL):
            return Intent("count_rooms_labelled", name=quoted_name(question))
        for kind, pattern in COUNT_KINDS:
            if pattern.search(lowered):
                return Intent(kind)
    return None
