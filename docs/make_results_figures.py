"""Draws docs/results.svg and docs/progress.svg from the measurements below.

    .venv/Scripts/python.exe -I docs/make_results_figures.py
    node docs/render_results_figures.mjs            # SVG -> results.png, progress.png
"""
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))  # -I keeps the script's folder off the import path

from make_training_figure import (AXIS, BORDER, CARD, FONT, GRID, INK, INK2, MUTED, RUN_COLOR, SURFACE,  # noqa: E402
                                  WASH, Svg, text_width, wrap)

# ---------------------------------------------------------------- measurements

TOTAL_QUESTIONS = 127_044
PARTS = [
    {"name": "Raster floor plans (images)",
     "how": "our own trained detectors count every kind; no outside model is called",
     "questions": 85_514, "right": 1_530, "asked": 1_781, "sample": True,
     "basis": "200 held-out drawings the detectors never saw"},
    {"name": "Swiss apartment floors (vector)", "how": "exact geometry code, no model calls",
     "questions": 37_584, "right": 37_376, "asked": 37_584, "basis": "every question measured"},
    {"name": "IFC building models, numeric answers", "how": "geometry and stored quantities, no model calls",
     "questions": 3_062, "right": 3_044, "asked": 3_062, "basis": "every question measured"},
    {"name": "IFC building models, free-text answers", "how": "facts extracted by code, worded by a language model",
     "questions": 820, "right": 25, "partly": 13, "wrong": 8, "asked": 46, "sample": True,
     "basis": "46 graded questions it was not tuned on"},
    {"name": "Practice drawing sheets", "how": "the sheet's text layer and a language model",
     "questions": 64, "right": 48, "asked": 48, "basis": "every sheet question with a numeric answer"},
]

RASTER_DRAWINGS, RASTER_ASKED = 200, 1_781
# who answers: (key, label, right, outside calls per drawing, what those calls cost)
WHO = [
    ("sonnet", "Outside vision model alone: Claude Sonnet 5.5", 1_373, "1", "about $0.009 and 5 seconds per drawing"),
    ("gemini", "Outside vision model alone: Gemini 4 Hydrogen", 1_507, "1",
     "about $0.02 and 8 seconds per drawing"),
    ("detectors", "Blueline only: our trained detectors answer every kind", 1_530, "0",
     "nothing leaves the server; 3 seconds of CPU per drawing"),
    ("best", "Best accuracy: the detectors and one Gemini reading vote on symbols, Gemini reads room types", 1_576,
     "1", "about $0.02 and 8 seconds per drawing"),
]
# kind: asked, Gemini 4 Hydrogen alone, our detectors alone, best accuracy
SYMBOL_KINDS = {
    "toilet bowls": (200, 184, 188, 192),
    "sinks": (199, 163, 174, 179),
    "showers and bathtubs": (182, 159, 162, 170),
    "doors": (156, 99, 119, 117),
    "windows": (200, 87, 97, 103),
}
ROOM_KINDS = {
    "storeys": (200, 199, 191, 199),
    "WC rooms": (98, 95, 95, 95),
    "kitchens": (129, 125, 118, 125),
    "saunas": (137, 133, 133, 133),
    "balconies": (61, 58, 55, 58),
    "bedrooms": (125, 115, 111, 115),
    "bathrooms": (94, 90, 87, 90),
}

STEP_ASKED, STEP_DRAWINGS = 280, 30
# (who counts, step, right of 280, note)
STEPS = [
    ("vision", "Vision model, one count question at a time", 198, ""),
    ("vision", "Vision model, one inventory per drawing with the position of every item", 202, ""),
    ("vision", "Inventory with scope and fixture rules, the middle of three readings", 221, ""),
    ("detectors", "Our first trained detector alone", 228, ""),
    ("default", "Detector for the drawn symbols, vision model for room types", 240, ""),
    ("vote", "Two detectors and the vision model vote on each symbol", 245, "a vision call for every drawing"),
    ("default", "Voting removed: the two detectors count the symbols", 237, "no vision call to count a symbol"),
]

# reworded dataset questions: drawing type, asked, right with the keyword parser, right with the interpreter
REWORDED = [("Swiss plans", 120, 53, 120), ("Raster plans", 90, 33, 76), ("IFC models", 40, 17, 40)]
INTERPRETATION_USD = 0.0007

IFC_NUMERIC_HISTORY = [("first spike, preview dataset", 89.4, "938 of 1,049"), ("in between", 94.6, ""),
                       ("now, full dataset", 99.4, "3,044 of 3,062")]

# ---------------------------------------------------------------- drawing

W, MARGIN = 1200, 20
BLUE, ORANGE, AQUA = RUN_COLOR[1], RUN_COLOR[2], RUN_COLOR[3]
BLUE_TINT, NEUTRAL, TRACK = "#9ec5f4", "#a8a69d", "#eceae3"
WHO_COLOR = {"vision": ORANGE, "detectors": AQUA, "default": BLUE, "vote": NEUTRAL}
WHO_LEGEND = {"vision": "vision model alone", "detectors": "trained detectors alone",
              "default": "default: detectors for symbols, vision model for room types",
              "vote": "detectors and vision model vote (removed)"}
RESULT_COLOR = {"sonnet": NEUTRAL, "gemini": ORANGE, "detectors": AQUA, "best": BLUE}
RESULT_LEGEND = {"gemini": "outside vision model alone (Gemini 4 Hydrogen)",
                 "detectors": "Blueline only: our trained detectors",
                 "best": "Best accuracy: detectors and one Gemini reading per drawing"}


class Figure(Svg):
    def render(self, height):
        return (f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{height}" viewBox="0 0 {W} {height}" '
                f'font-family="{FONT}">\n<rect width="{W}" height="{height}" fill="{SURFACE}"/>\n'
                + "\n".join(self.parts) + "\n</svg>\n")

    def bar(self, x0, y, length, thick, fill, r=4):
        """Horizontal bar: square at the baseline, rounded at the data end."""
        if length <= 0:
            return
        r = min(r, length, thick / 2)
        self.add(f'<path d="M{x0:.1f},{y:.1f} H{x0 + length - r:.1f} a{r},{r} 0 0 1 {r},{r} v{thick - 2 * r:.1f} '
                 f'a{r},{r} 0 0 1 -{r},{r} H{x0:.1f} Z" fill="{fill}"/>')

    def para(self, x, y, s, width, size=14, fill=INK2, weight=400, pitch=None):
        """Wrapped text; returns the baseline of the last line."""
        pitch = pitch or round(size * 1.3)
        parts = wrap(s, width, size, weight >= 600)
        for i, part in enumerate(parts):
            self.text(x, y + i * pitch, part, size=size, fill=fill, weight=weight)
        return y + (len(parts) - 1) * pitch

    def tag(self, x, y, s):
        """Small capital tag; returns its width."""
        w = text_width(s, 11.5, True) + len(s) * 0.6 + 14
        self.rect(x, y - 13, w, 18, fill=WASH, r=4)
        self.text(x + 7, y, s, size=11.5, fill=INK2, weight=700, extra=' letter-spacing="0.6"')
        return w

    def legend(self, x, y, keys, size=14, colors=WHO_COLOR, names=WHO_LEGEND):
        for key in keys:
            self.rect(x, y - 10, 12, 12, fill=colors[key], r=3)
            self.text(x + 18, y + 1, names[key], size=size, fill=INK2)
            x += 18 + text_width(names[key], size) + 26
        return x


def share(a, b):
    return f"{100 * a / b:.1f}%"


def whole_percent(a, b):
    """Rounds half up, so 97 of 200 reads 49%."""
    return f"{(200 * a + b) // (2 * b)}%"


def header(svg, title, subtitle):
    y = 42
    for part in wrap(title, W - 2 * MARGIN, 25, True):
        svg.text(MARGIN, y, part, size=25, weight=700)
        y += 32
    return svg.para(MARGIN, y - 4, subtitle, W - 2 * MARGIN, 15, INK2, pitch=20)


def percent_axis(svg, x0, full, top, bottom, size=13):
    for frac, label in ((0, "0%"), (0.5, "50%"), (1, "100%")):
        gx = x0 + frac * full
        svg.line(gx, top, gx, bottom, stroke=AXIS if frac == 0 else GRID)
        svg.text(gx, bottom + 17, label, size=size, fill=MUTED, anchor="middle")


def dataset_panel(svg, y):
    c1, c2, c3 = MARGIN, 400, 620
    share_w, meter_w = 120, 160
    svg.text(c1, y, f"All {TOTAL_QUESTIONS:,} questions, by part of the dataset", size=17.5, weight=700)
    y += 26
    svg.text(c1, y, "part, and how it is answered", size=13.5, fill=INK2)
    svg.text(c2, y, "questions, share of all", size=13.5, fill=INK2)
    svg.text(c3, y, "answered right", size=13.5, fill=INK2)
    y += 10
    for p in PARTS:
        how = wrap(p["how"], c2 - c1 - 30, 13.5)
        row_h = 40 + 18 * len(how)
        svg.line(MARGIN, y, W - MARGIN, y, stroke=GRID)
        svg.text(c1, y + 26, p["name"], size=15.5, weight=600)
        for i, part in enumerate(how):
            svg.text(c1, y + 46 + i * 18, part, size=13.5, fill=INK2)

        svg.text(c2 + 56, y + 26, f'{p["questions"]:,}', size=15, weight=600, anchor="end")
        length = max(share_w * p["questions"] / TOTAL_QUESTIONS, 1.5)
        svg.bar(c2 + 68, y + 15, length, 12, NEUTRAL)
        svg.text(c2 + 68 + length + 7, y + 26, share(p["questions"], TOTAL_QUESTIONS), size=14, fill=INK2)

        svg.rect(c3, y + 15, meter_w, 12, fill=TRACK)
        right = meter_w * p["right"] / p["asked"]
        tx = c3 + meter_w + 14
        if "partly" in p:
            svg.rect(c3, y + 15, right, 12, fill=BLUE)
            svg.bar(c3 + right + 2, y + 15, meter_w * p["partly"] / p["asked"] - 2, 12, BLUE_TINT)
            value, detail = f'{p["right"]} of {p["asked"]} right', f'{p["partly"]} partly right, {p["wrong"]} wrong'
        elif p["asked"] < 100:
            svg.bar(c3, y + 15, right, 12, BLUE)
            value, detail = f'{p["right"]} of {p["asked"]}', ""
        else:
            svg.bar(c3, y + 15, right, 12, BLUE)
            value, detail = share(p["right"], p["asked"]), f'{p["right"]:,} of {p["asked"]:,}'
        svg.text(tx, y + 26, value, size=16, weight=700)
        svg.text(tx + text_width(value, 16, True) + 9, y + 26, detail, size=14, fill=INK2)
        bx = tx
        if p.get("sample"):
            bx += svg.tag(tx, y + 46, "SAMPLE") + 7
        svg.para(bx, y + 46, p["basis"], W - MARGIN - bx, 13.5, INK if p.get("sample") else INK2, pitch=18)
        y += row_h

    numeric = sum(p["right"] for p in PARTS if not p.get("sample"))
    raster = PARTS[0]
    projected = raster["questions"] * raster["right"] / raster["asked"] + numeric
    svg.line(MARGIN, y, W - MARGIN, y, stroke=AXIS)
    svg.text(c1, y + 27, "Whole dataset", size=15.5, weight=600)
    svg.text(c2 + 56, y + 27, f"{TOTAL_QUESTIONS:,}", size=15, weight=600, anchor="end")
    tw = svg.tag(c3, y + 27, "PROJECTION")
    svg.text(c3 + tw + 9, y + 27, f"about {100 * projected / TOTAL_QUESTIONS:.0f}% answered right", size=16,
             weight=700)
    not_numeric = PARTS[4]["questions"] - PARTS[4]["asked"]
    end = svg.para(c3, y + 47, f'raster projected from its {RASTER_DRAWINGS} held-out drawings; free-text answers '
                               f'and the {not_numeric} sheet questions without a numeric answer counted as not right',
                   W - MARGIN - c3, 13.5, pitch=18)
    return end + 14


def who_panel(svg, y):
    x0, full, calls_x = 430, 290, 890
    svg.text(MARGIN, y, "Who answers a raster question, and what it costs in calls to an outside model", size=17.5,
             weight=700)
    y += 23
    svg.text(MARGIN, y, f"The same {RASTER_DRAWINGS} held-out drawings and {RASTER_ASKED:,} questions for every "
                        "row. Our detectors need no outside model.", size=14, fill=INK2)
    y += 28
    svg.text(x0, y, f"questions answered right, of {RASTER_ASKED:,}", size=13.5, fill=INK2)
    svg.text(calls_x, y, "outside calls per drawing", size=13.5, fill=INK2)
    top = y + 10
    heights = []
    for key, label, right, calls, note in WHO:
        lines = max(len(wrap(label, x0 - MARGIN - 24, 15, key == "detectors")),
                    len(wrap(note, W - MARGIN - calls_x - 62, 13.5)))
        heights.append(22 + 19 * lines)
    bottom = top + sum(heights) + 4
    percent_axis(svg, x0, full, top, bottom)
    y = top + 4
    for (key, label, right, calls, note), h in zip(WHO, heights):
        mid = y + h / 2
        parts = wrap(label, x0 - MARGIN - 24, 15, key == "detectors")
        for i, part in enumerate(parts):
            svg.text(MARGIN, mid + 5 - (len(parts) - 1) * 9.5 + i * 19, part, size=15,
                     weight=700 if key == "detectors" else 400)
        length = full * right / RASTER_ASKED
        svg.bar(x0, mid - 7, length, 14, RESULT_COLOR[key])
        value = share(right, RASTER_ASKED)
        svg.text(x0 + length + 8, mid + 5, value, size=15, weight=700)
        svg.text(x0 + length + 8 + text_width(value, 15, True) + 7, mid + 5, f"{right:,}", size=13.5, fill=INK2)
        svg.text(calls_x, mid + 5.5, calls, size=16, weight=700)
        notes = wrap(note, W - MARGIN - calls_x - 62, 13.5)
        for i, part in enumerate(notes):
            svg.text(calls_x + 62, mid + 5 - (len(notes) - 1) * 9 + i * 18, part, size=13.5, fill=INK2)
        y += h
    return bottom + 30


KIND_PITCH = 54


def kinds_card(svg, title, how, kinds, x, y, w, h, note=""):
    pad, label_w, thick, gap, pitch = 16, 150, 11, 3, KIND_PITCH
    svg.rect(x + 0.5, y + 0.5, w - 1, h - 1, fill=CARD, stroke=BORDER, r=8)
    svg.text(x + pad, y + 28, title, size=15.5, weight=700)
    svg.text(x + pad, y + 48, how, size=13.5, fill=INK2)
    x0 = x + pad + label_w
    full = w - 2 * pad - label_w - 76
    top = y + 64
    order = sorted(kinds, key=lambda k: -kinds[k][3] / kinds[k][0])
    bottom = top + len(order) * pitch
    percent_axis(svg, x0, full, top, bottom)
    for i, kind in enumerate(order):
        asked, *rights = kinds[kind]
        mid = top + (i + 0.5) * pitch
        svg.text(x0 - 12, mid - 1, kind, size=14.5, anchor="end")
        svg.text(x0 - 12, mid + 16, f"of {asked}", size=13, fill=INK2, anchor="end")
        by = mid - (3 * thick + 2 * gap) / 2
        for key, right in zip(("gemini", "detectors", "best"), rights):
            length = full * right / asked
            svg.bar(x0, by, length, thick, RESULT_COLOR[key])
            svg.text(x0 + length + 6, by + thick - 0.5, str(right), size=13.5, weight=600)
            svg.text(x0 + length + 6 + text_width(str(right), 13.5, True) + 5, by + thick - 0.5,
                     whole_percent(right, asked), size=13, fill=INK2)
            by += thick + gap
    if note:
        svg.para(x + pad, bottom + 52, note, w - 2 * pad, 13.5, pitch=18)


def kinds_panel(svg, y):
    svg.text(MARGIN, y, "By kind of question: our detectors lead on drawn symbols, the outside model on room types; "
                        "windows and doors stay hard", size=17.5, weight=700)
    y += 23
    y = svg.para(MARGIN, y, f"Bar: share of the questions of that kind answered with exactly the right count, on the "
                            f"same {RASTER_DRAWINGS} held-out drawings. The figure at the bar is that count.",
                 W - 2 * MARGIN, 14, pitch=19)
    y += 27
    svg.legend(MARGIN, y, ("gemini", "detectors", "best"), colors=RESULT_COLOR, names=RESULT_LEGEND)
    y += 16
    gap = 20
    w = (W - 2 * MARGIN - gap) / 2
    h = 64 + len(ROOM_KINDS) * KIND_PITCH + 32
    windows, doors = SYMBOL_KINDS["windows"], SYMBOL_KINDS["doors"]
    kinds_card(svg, "Drawn symbols", "Best accuracy takes the middle of three counts: two detectors, one reading",
               SYMBOL_KINDS, MARGIN, y, w, h,
               note=f"Still open: windows {windows[2]} of {windows[0]} and doors {doors[2]} of {doors[0]} with our "
                    "detectors alone. A bigger detector and gentler augmentation did not move them: see "
                    "docs/training-history.png.")
    kinds_card(svg, "Room types and storeys", "Best accuracy takes them from the outside reading of the drawing",
               ROOM_KINDS, MARGIN + w + gap, y, w, h)
    return y + h


def results():
    for kinds in (SYMBOL_KINDS, ROOM_KINDS):
        for asked, *rights in kinds.values():
            assert max(rights) <= asked
    columns = list(zip(*list(SYMBOL_KINDS.values()) + list(ROOM_KINDS.values())))
    right_of = {key: right for key, _, right, _, _ in WHO}
    assert [sum(c) for c in columns] == [RASTER_ASKED] + [right_of[key] for key in ("gemini", "detectors", "best")]
    assert sum(p["questions"] for p in PARTS) == TOTAL_QUESTIONS

    svg = Figure()
    swiss, raster = PARTS[1], PARTS[0]
    y = header(svg,
               f'Code alone answers the vector drawings {share(swiss["right"], swiss["asked"])} right; our own detectors '
               f'answer raster floor plans {whole_percent(raster["right"], raster["asked"])} right with no outside '
               f'model, {whole_percent(right_of["best"], RASTER_ASKED)} with one outside reading per drawing',
               f"Where the solution stands on the Stoa dataset, measured 15 November 2026. Scored with the dataset's "
               f"rules: counts exact; areas, lengths and volumes within 2%.")
    y = dataset_panel(svg, y + 44)
    y = who_panel(svg, y + 30)
    y = kinds_panel(svg, y + 22)
    height = y + 44
    svg.text(MARGIN, height - 16, f"Raster figures come from {RASTER_DRAWINGS} drawings held out of detector "
                                  "training. The vector parts are measured on every question.",
             size=13.5, fill=MUTED)
    return svg.render(round(height))


def steps_panel(svg, y):
    name_x, x0, full = MARGIN + 34, 500, 390
    change_x, note_x = 990, 1040
    first = STEPS[0][2]
    svg.text(MARGIN, y, f"Raster floor plans, step by step on one fixed test sample: {STEP_DRAWINGS} drawings, "
                        f"{STEP_ASKED} questions", size=17.5, weight=700)
    y += 23
    svg.text(MARGIN, y, "Steps in the order they were taken on 13 and 14 November. None of the 30 drawings was used "
                        "to train the detectors. The colour says who counts.", size=14, fill=INK2)
    y += 27
    x = MARGIN
    for keys in (("vision", "detectors"), ("default", "vote")):
        svg.legend(x, y, keys)
        y += 22
    y += 8
    svg.text(x0, y, f"questions answered right, of {STEP_ASKED}", size=13.5, fill=INK2)
    svg.text(change_x, y, "change", size=13.5, fill=INK2, anchor="end")
    top, pitch = y + 10, 48
    bottom = top + len(STEPS) * pitch + 4
    percent_axis(svg, x0, full, top, bottom)
    previous = None
    for i, (key, name, right, note) in enumerate(STEPS):
        mid = top + 4 + (i + 0.5) * pitch
        svg.add(f'<circle cx="{MARGIN + 12}" cy="{mid:.1f}" r="12" fill="{WASH}"/>')
        svg.text(MARGIN + 12, mid + 5, str(i + 1), size=14, fill=INK, weight=700, anchor="middle")
        parts = wrap(name, x0 - name_x - 20, 15)
        for j, part in enumerate(parts):
            svg.text(name_x, mid + 5 - (len(parts) - 1) * 9.5 + j * 19, part, size=15,
                     weight=700 if i == len(STEPS) - 1 else 400)
        length = full * right / STEP_ASKED
        svg.bar(x0, mid - 8, length, 16, WHO_COLOR[key])
        svg.text(x0 + length + 8, mid + 5, str(right), size=15, weight=700)
        svg.text(x0 + length + 8 + text_width(str(right), 15, True) + 7, mid + 5, share(right, STEP_ASKED),
                 size=13.5, fill=INK2)
        change = "start" if previous is None else f"{right - previous:+d}".replace("-", "−")
        svg.text(change_x, mid + 5, change, size=15, weight=400 if previous is None else 700,
                 fill=INK2 if previous is None else INK, anchor="end")
        notes = wrap(note, W - MARGIN - note_x, 13.5)
        for j, part in enumerate(notes):
            svg.text(note_x, mid + 5 - (len(notes) - 1) * 9 + j * 18, part, size=13.5, fill=INK2)
        previous = right
    last = STEPS[-1][2]
    y = bottom + 46
    svg.para(MARGIN, y, f"From {first} to {last} of {STEP_ASKED}: {last - first} more questions right. The last step "
                        f"gave back {STEPS[-2][2] - last} of them so that a symbol count costs no hosted-model call.",
             W - 2 * MARGIN, 14.5, INK)
    return y + 14


def reworded_panel(svg, x, y, w):
    label_w, thick, gap, pitch = 112, 12, 4, 58
    before_all, after_all, asked_all = (sum(r[i] for r in REWORDED) for i in (2, 3, 1))
    svg.text(x, y, "Questions worded differently from the dataset", size=17.5, weight=700)
    y = svg.para(x, y + 23, "Dataset questions with known answers, reworded: casual, terse, show/where requests, "
                            "other languages, typos. A small language model (Haiku 5.5) now turns every question "
                            "into a structured call that the exact scripts run.", w, 14, pitch=19)
    y += 28
    for fill, label in ((NEUTRAL, "keyword parser only"), (BLUE, "language model interprets the question")):
        svg.rect(x, y - 10, 12, 12, fill=fill, r=3)
        svg.text(x + 18, y + 1, label, size=14, fill=INK2)
        x_next = x + 18 + text_width(label, 14) + 26
        if fill == NEUTRAL:
            keep, x = x, x_next
    x = keep
    top = y + 18
    x0 = x + label_w
    full = w - label_w - 96
    bottom = top + len(REWORDED) * pitch
    percent_axis(svg, x0, full, top, bottom)
    for i, (name, asked, before, after) in enumerate(REWORDED):
        mid = top + (i + 0.5) * pitch
        svg.text(x0 - 12, mid - 1, name, size=14.5, anchor="end")
        svg.text(x0 - 12, mid + 16, f"of {asked}", size=13, fill=INK2, anchor="end")
        by = mid - (2 * thick + gap) / 2
        for fill, right in ((NEUTRAL, before), (BLUE, after)):
            length = full * right / asked
            svg.bar(x0, by, length, thick, fill)
            svg.text(x0 + length + 7, by + thick - 0.5, f"{right} of {asked}", size=14,
                     weight=700 if fill == BLUE else 400)
            by += thick + gap
    misses = REWORDED[1][1] - REWORDED[1][3]
    y = svg.para(x, bottom + 48, f"All {misses} raster misses are counting errors of the detectors or the vision "
                                 f"model, not misread questions. In total {before_all} of {asked_all} before, "
                                 f"{after_all} of {asked_all} after. One interpretation costs about "
                                 f"{INTERPRETATION_USD} USD ({INTERPRETATION_USD * 1000:.2f} USD per 1,000 questions).",
                 w, 14, INK, pitch=19)
    return y


def other_parts_panel(svg, x, y, w):
    label_w, thick, pitch = 200, 12, 30
    svg.text(x, y, "The other parts, from the first spike to now", size=17.5, weight=700)
    y += 32
    svg.text(x, y, "IFC building models, numeric answers", size=15, weight=600)
    top = y + 12
    x0 = x + label_w
    full = w - label_w - 150
    bottom = top + len(IFC_NUMERIC_HISTORY) * pitch
    percent_axis(svg, x0, full, top, bottom)
    for i, (when, value, counts) in enumerate(IFC_NUMERIC_HISTORY):
        mid = top + (i + 0.5) * pitch
        svg.text(x0 - 12, mid + 5, when, size=13.5, fill=INK2, anchor="end")
        length = full * value / 100
        svg.bar(x0, mid - thick / 2, length, thick, BLUE if i == len(IFC_NUMERIC_HISTORY) - 1 else NEUTRAL)
        label = f"{value}%"
        svg.text(x0 + length + 7, mid + 5, label, size=14, weight=700)
        svg.text(x0 + length + 7 + text_width(label, 14, True) + 6, mid + 5, counts, size=13, fill=INK2)
    y = bottom + 52
    rows = [("Practice drawing sheets", "no solver", "48 of 48 numeric answers right"),
            ("IFC models, free-text answers", "no solver", "25 of 46 right, 13 partly right, 8 wrong (graded sample)")]
    svg.text(x0, y, "first spike", size=13.5, fill=INK2)
    svg.text(x0 + 100, y, "now", size=13.5, fill=INK2)
    y += 8
    for name, before, now in rows:
        svg.line(x, y, x + w, y, stroke=GRID)
        now_lines = wrap(now, w - label_w - 100, 14, True)
        for i, part in enumerate(wrap(name, label_w - 14, 14.5, True)):
            svg.text(x, y + 24 + i * 19, part, size=14.5, weight=600)
        svg.text(x0, y + 24, before, size=14, fill=INK2)
        for i, part in enumerate(now_lines):
            svg.text(x0 + 100, y + 24 + i * 19, part, size=14, weight=700)
        y += 16 + 19 * max(2, len(now_lines))
    return y


def progress():
    first, last = STEPS[0][2], STEPS[-1][2]
    before, after, asked = (sum(r[i] for r in REWORDED) for i in (2, 3, 1))
    svg = Figure()
    y = header(svg,
               f"In two days the raster score rose from {whole_percent(first, STEP_ASKED)} to "
               f"{whole_percent(last, STEP_ASKED)}, and reworded questions answered right from {before} to {after} of "
               f"{asked}",
               "How the solution got here, 13 and 14 November 2026. Every score is the number of questions answered "
               "right under the dataset's rules (counts exact).")
    y = steps_panel(svg, y + 44)
    y += 38
    left_w = 580
    right_x = MARGIN + left_w + 50
    end_left = reworded_panel(svg, MARGIN, y, left_w)
    end_right = other_parts_panel(svg, right_x, y, W - MARGIN - right_x)
    height = max(end_left, end_right) + 62
    svg.text(MARGIN, height - 18, "How the detectors themselves were trained, run by run, is in "
                                  "docs/training-history.png.", size=13.5, fill=MUTED)
    return svg.render(round(height))


def main():
    for name, draw in (("results", results), ("progress", progress)):
        text = draw()
        (HERE / f"{name}.svg").write_text(text, encoding="utf-8")
        print("wrote", HERE / f"{name}.svg", text.split('height="', 1)[1].split('"', 1)[0])


if __name__ == "__main__":
    main()
