"""Draws docs/training-history.svg from the logs saved in docs/training-data.

    .venv/Scripts/python.exe -I docs/make_training_figure.py
    node docs/render_training_figure.mjs            # SVG -> training-history.png
"""
import csv
import json
from datetime import datetime, timedelta
from html import escape
from pathlib import Path

HERE = Path(__file__).resolve().parent
DATA = HERE / "training-data"

W = 1400
MARGIN = 20
FONT = "'Segoe UI', system-ui, -apple-system, 'Helvetica Neue', Arial, sans-serif"
SURFACE, CARD, WASH = "#fcfcfb", "#ffffff", "#f1efe8"
INK, INK2, MUTED = "#0b0b0b", "#52514e", "#77756f"
GRID, AXIS, BORDER = "#e1e0d9", "#c3c2b7", "#cfcdc4"
# Categorical slots 1-6 of the dataviz reference palette, in order: one hue per run, everywhere.
RUN_COLOR = {1: "#2a78d6", 2: "#eb6834", 3: "#1baf7a", 4: "#eda100", 5: "#e87ba4", 6: "#008300"}
BADGE_INK = {4: INK}

KIND_LABEL = {"windows": "windows", "doors": "doors", "toilets": "toilet bowls", "sinks": "sinks",
              "showers_bathtubs": "showers, bathtubs"}
RUN_SHORT = {1: "all classes", 2: "symbols", 3: "bigger model", 4: "reference", 5: "drawing-safe", 6: "YOLO26l"}


def text_width(s, size, bold=False):
    em = 0.0
    for ch in s:
        if ch in "ijl.,:;'|!":
            em += 0.26
        elif ch == " ":
            em += 0.28
        elif ch in "ftrI()-·":
            em += 0.36
        elif ch in "mwMW%":
            em += 0.86
        elif ch.isdigit():
            em += 0.55
        elif ch.isupper():
            em += 0.66
        else:
            em += 0.53
    return em * size * (1.07 if bold else 1.0)


def wrap(s, width, size, bold=False):
    lines, line = [], ""
    for word in s.split():
        trial = f"{line} {word}".strip()
        if line and text_width(trial, size, bold) > width:
            lines.append(line)
            line = word
        else:
            line = trial
    return lines + [line] if line else lines


class Svg:
    def __init__(self):
        self.parts = []

    def add(self, s):
        self.parts.append(s)

    def text(self, x, y, s, size=13, fill=INK, weight=400, anchor="start", extra=""):
        self.add(f'<text x="{x:.1f}" y="{y:.1f}" font-size="{size}" fill="{fill}" font-weight="{weight}" '
                 f'text-anchor="{anchor}"{extra}>{escape(s)}</text>')

    def rect(self, x, y, w, h, fill="none", stroke="none", r=0, extra=""):
        self.add(f'<rect x="{x:.1f}" y="{y:.1f}" width="{w:.1f}" height="{h:.1f}" rx="{r}" fill="{fill}" '
                 f'stroke="{stroke}"{extra}/>')

    def line(self, x1, y1, x2, y2, stroke=GRID, width=1, extra=""):
        self.add(f'<line x1="{x1:.1f}" y1="{y1:.1f}" x2="{x2:.1f}" y2="{y2:.1f}" stroke="{stroke}" '
                 f'stroke-width="{width}"{extra}/>')

    def path(self, d, stroke=INK2, width=1.5, fill="none", extra=""):
        self.add(f'<path d="{d}" stroke="{stroke}" stroke-width="{width}" fill="{fill}" '
                 f'stroke-linejoin="round" stroke-linecap="round"{extra}/>')

    def badge(self, x, y, n, r=11, hollow=False):
        color = RUN_COLOR[n]
        if hollow:
            self.add(f'<circle cx="{x:.1f}" cy="{y:.1f}" r="{r - 1}" fill="{SURFACE}" stroke="{color}" stroke-width="2"/>')
            self.text(x, y + r * 0.4, str(n), size=round(r * 1.15), fill=INK, weight=700, anchor="middle")
        else:
            self.add(f'<circle cx="{x:.1f}" cy="{y:.1f}" r="{r}" fill="{color}"/>')
            self.text(x, y + r * 0.4, str(n), size=round(r * 1.15), fill=BADGE_INK.get(n, "#ffffff"), weight=700,
                      anchor="middle")

    def arrow_down(self, x, y):
        self.add(f'<path d="M{x - 5:.1f},{y - 8:.1f} L{x + 5:.1f},{y - 8:.1f} L{x:.1f},{y:.1f} Z" fill="{INK2}"/>')

    def render(self, height):
        return (f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{height}" viewBox="0 0 {W} {height}" '
                f'font-family="{FONT}">\n<rect width="{W}" height="{height}" fill="{SURFACE}"/>\n'
                + "\n".join(self.parts) + "\n</svg>\n")


def load():
    doc = json.loads((DATA / "runs.json").read_text())
    for run in doc["runs"]:
        with (DATA / run["csv"]).open() as f:
            rows = [{k.strip(): v.strip() for k, v in r.items()} for r in csv.DictReader(f)]
        run["curve"] = [float(r["metrics/mAP50-95(B)"]) for r in rows]
    return doc


def local(doc, stamp):
    t = datetime.strptime(stamp, "%Y-%m-%dT%H:%M:%SZ") + timedelta(hours=doc["local_utc_offset_hours"])
    return t.strftime("%H:%M")


def of(pair):
    return f"{pair[0]:,} of {pair[1]:,}"


def symbol_total(doc, run):
    return [sum(run["kinds"][k][i] for k in doc["symbol_kinds"]) for i in (0, 1)]


def run_card(doc, run, title, went_in):
    n = run["run"]
    hours = run["train_seconds"] / 3600
    recipe = f'{run["imgsz"]} px · {run["epochs_planned"]} epochs'
    drawings = f'{run["train_drawings"]:,} train drawings'
    if run["status"] == "scored":
        header = f'Run {n} · {local(doc, run["start_utc"])}–{local(doc, run["last_epoch_utc"])}'
        came_out = [(f'5 symbol kinds: {of(symbol_total(doc, run))}', True),
                    (f'windows {of(run["kinds"]["windows"])}', False),
                    (f'doors {of(run["kinds"]["doors"])}', False)]
        if len(run["kinds"]) > len(doc["symbol_kinds"]):
            share = 100 * run["all_kinds"][0] / run["all_kinds"][1]
            came_out += [(f'all {len(run["kinds"])} kinds: {of(run["all_kinds"])}', False),
                         (f'({share:.1f}% of all questions)', False)]
        recipe += f' · {hours:.1f} h GPU'
    else:
        header = f'Run {n} · started {local(doc, run["start_utc"])}'
        came_out = [("still training", True),
                    (f'epoch {run["epochs_run"]} of {run["epochs_planned"]} at {local(doc, run["last_epoch_utc"])}', False),
                    ("not scored yet", False)]
    return {"kind": "run", "n": n, "header": header, "title": title,
            "blocks": [("IN", [(s, False) for s in went_in(recipe, drawings)]), ("OUT", came_out)]}


def cards(doc):
    d = doc["drawings"]
    runs = {r["run"]: r for r in doc["runs"]}
    ea = doc["error_analysis"]["percent"]
    data = {"kind": "step", "header": "Input", "title": f'{d["all"]:,} public floor plans', "paras": [
        "CubiCasa5k drawings. Boxes are derived from its SVG annotations so that counts equal the challenge's answers.",
        f'Split by drawing: {d["train"]:,} train, {d["validation"]} validation (thresholds are tuned there), '
        f'{d["test"]} test (held out).',
        "Every run starts from COCO-pretrained weights and trains on one Nvidia A100."]}
    analysis = {"kind": "step", "header": "No training · validation drawings", "title": "Error analysis", "paras": [
        "Wrong window objects: "
        + ", ".join(f"{pct}% {name}" for name, pct in ea.items()) + ".",
        f'On drawings the model trained on, still only '
        f'{doc["error_analysis"]["window_counts_exact_on_training_drawings_percent"]}% of window counts are exact.',
        "A web research pass agreed."]}
    split = {"kind": "step", "header": "No training · data", "title": "New selection split", "paras": [
        f'{d["dev"]} "dev" drawings moved out of train, so recipes can be compared without touching test.',
        f'Now: train {d["train_after_dev_split"]:,} · dev {d["dev"]} · validation {d["validation"]} · '
        f'test {d["test"]} (untouched).',
        "Thresholds are still tuned on validation."]}
    row1 = [
        data,
        run_card(doc, runs[1], "YOLO11m, all 13 classes", lambda recipe, drawings: [
            "symbols, rooms and storeys", recipe, drawings, "not mirrored (rooms are read from their label text)"]),
        run_card(doc, runs[2], "YOLO11l, symbols only", lambda recipe, drawings: [
            "6 symbol classes + open doorway (not counted)", recipe, f"{drawings}, mirrored"]),
        run_card(doc, runs[3], "YOLO11x at 1536 px", lambda recipe, drawings: [
            "6 symbol classes, without the open-doorway class", recipe, f"{drawings}, mirrored"]),
        analysis,
    ]
    row2 = [
        split,
        run_card(doc, runs[4], "YOLO11l, the reference", lambda recipe, drawings: [
            "run 2's recipe on the new split", recipe, f"{drawings}, mirrored"]),
        run_card(doc, runs[5], "Drawing-safe augmentation", lambda recipe, drawings: [
            "run 4 with mosaic off, scale 0.2, shift 0.05, no hue or saturation jitter", recipe,
            f"{drawings}, mirrored"]),
        run_card(doc, runs[6], "YOLO26l, newer model", lambda recipe, drawings: [
            "run 4's recipe, other model", recipe, f"{drawings}, mirrored"]),
        {"kind": "queue", "items": [
            ("Relabelled windows and doors", "windows as consistent runs plus a panes-per-run classifier; three door "
                                             "classes. Follows from the error analysis."),
            ("Room-type model", ""), ("Thicker boxes for thin windows", ""), ("RT-DETR", "")]},
    ]
    return row1, row2


PAD = 14
LINE = 17


def draw_card(svg, spec, x, y, w, h=None):
    """Draws the card when h is given; returns the height its content needs either way."""
    draw = h is not None
    if spec["kind"] == "queue":
        cy = y + 16
        if draw:
            svg.text(x + 2, cy, "Queued, not started", size=13, fill=INK2, weight=600)
        cy += 12
        for title, note in spec["items"]:
            lines = wrap(note, w - 2 * PAD, 12.5) if note else []
            box_h = 32 + len(lines) * 16 + (4 if lines else 0)
            if draw:
                svg.rect(x + 0.5, cy, w - 1, box_h, stroke=MUTED, r=8, extra=' stroke-dasharray="4 4"')
                svg.text(x + PAD, cy + 21, title, size=13.5, fill=INK2, weight=600)
                for i, s in enumerate(lines):
                    svg.text(x + PAD, cy + 39 + i * 16, s, size=12.5, fill=INK2)
            cy += box_h + 8
        return cy - 8 - y

    is_run = spec["kind"] == "run"
    if draw:
        if is_run:
            svg.rect(x + 0.5, y + 0.5, w - 1, h - 1, fill=CARD, stroke=BORDER, r=8)
        else:
            svg.rect(x, y, w, h, fill=WASH, r=8)
    cy = y + PAD + 9
    if draw:
        if is_run:
            svg.badge(x + PAD + 11, cy - 4, spec["n"], hollow="started" in spec["header"])
            svg.text(x + PAD + 30, cy, spec["header"], size=13, fill=INK2)
        else:
            svg.text(x + PAD, cy, spec["header"], size=13, fill=INK2)
    cy += 26
    if draw:
        svg.text(x + PAD, cy, spec["title"], size=15.5, weight=700)
    cy += 12
    if is_run:
        gutter = 36
        for tag, lines in spec["blocks"]:
            if draw:
                svg.line(x + PAD, cy, x + w - PAD, cy, stroke=GRID)
                svg.text(x + PAD, cy + 19, tag, size=11.5, fill=INK2, weight=700, extra=' letter-spacing="0.6"')
            cy += 2
            for s, bold in lines:
                for part in wrap(s, w - 2 * PAD - gutter, 13, bold):
                    cy += LINE
                    if draw:
                        svg.text(x + PAD + gutter, cy, part, size=13, weight=700 if bold else 400)
            cy += 9
        return cy + PAD - 9 - y
    for para in spec["paras"]:
        cy += 5
        for part in wrap(para, w - 2 * PAD, 13):
            cy += LINE
            if draw:
                svg.text(x + PAD, cy, part, size=13)
    return cy + PAD - y


def reason(svg, x_mid, y_line, s, width=236):
    lines = wrap(s, width, 13)
    for i, part in enumerate(lines):
        svg.text(x_mid, y_line - 8 - (len(lines) - 1 - i) * 16, part, size=13, fill=INK2, anchor="middle",
                 extra=' font-style="italic"')


def lineage_row(svg, specs, reasons, y_top, bracket):
    """One row of cards with an elbow arrow and its reason above each gap. Returns (xs, card top, card bottom)."""
    gap = 22.5
    w = (W - 2 * MARGIN - gap * (len(specs) - 1)) / len(specs)
    xs = [MARGIN + i * (w + gap) for i in range(len(specs))]
    y_line = y_top + 36
    y_card = y_line + 12
    h = max(draw_card(None, s, x, y_card, w) for s, x in zip(specs, xs))
    for s, x in zip(specs, xs):
        draw_card(svg, s, x, y_card, w, h)
    for i, text in enumerate(reasons):
        x1, x2 = xs[i] + w - 30, xs[i + 1] + 30
        svg.path(f"M{x1:.1f},{y_card - 1:.1f} V{y_line} H{x2:.1f} V{y_card - 8:.1f}")
        svg.arrow_down(x2, y_card - 1)
        reason(svg, (x1 + x2) / 2, y_line, text)
    first, last, label = bracket
    bx1, bx2, by = xs[first], xs[last] + w, y_card + h + 12
    svg.path(f"M{bx1:.1f},{by - 6:.1f} V{by} H{bx2:.1f} V{by - 6:.1f}", stroke=AXIS)
    svg.text((bx1 + bx2) / 2, by + 19, label, size=13.5, fill=INK, weight=600, anchor="middle")
    return xs, w, y_card, y_card + h


def spread(ys, gap):
    """Moves label positions apart to at least `gap`, keeping their order and their centre."""
    order = sorted(range(len(ys)), key=lambda i: ys[i])
    out = [ys[i] for i in order]
    for i in range(1, len(out)):
        out[i] = max(out[i], out[i - 1] + gap)
    shift = (sum(out) - sum(ys[i] for i in order)) / len(out)
    placed = [0.0] * len(ys)
    for rank, i in enumerate(order):
        placed[i] = out[rank] - shift
    return placed


def curves(svg, doc, x, y, w, h):
    lo, hi = 0.3, 0.75
    left, right = x + 40, x + w - 78
    epochs = max(r["epochs_planned"] for r in doc["runs"])

    def px(epoch):
        return left + (epoch - 1) / (epochs - 1) * (right - left)

    def py(value):
        return y + h - (value - lo) / (hi - lo) * h

    for i in range(int(round((hi - lo) / 0.1)) + 1):
        value = lo + i * 0.1
        svg.line(left, py(value), right, py(value), stroke=AXIS if i == 0 else GRID)
        svg.text(left - 8, py(value) + 4, f"{value:.1f}", size=12.5, fill=MUTED, anchor="end")
    for epoch in (1, 10, 20, 30, 40, 50, 60):
        svg.line(px(epoch), y + h, px(epoch), y + h + 4, stroke=AXIS)
        svg.text(px(epoch), y + h + 19, str(epoch), size=12.5, fill=MUTED, anchor="middle")
    svg.text(right + 12, y + h + 19, "epoch", size=12.5, fill=MUTED)

    for run in doc["runs"]:
        pts = " ".join(f"{px(i + 1):.1f},{py(v):.1f}" for i, v in enumerate(run["curve"]))
        svg.add(f'<polyline points="{pts}" fill="none" stroke="{RUN_COLOR[run["run"]]}" stroke-width="2" '
                f'stroke-linejoin="round" stroke-linecap="round"/>')

    at_end = [r for r in doc["runs"] if len(r["curve"]) == epochs]
    label_y = spread([py(r["curve"][-1]) for r in at_end], 24)
    for run, ly in zip(at_end, label_y):
        ex, ey = px(epochs), py(run["curve"][-1])
        svg.line(ex, ey, right + 20, ly, stroke=RUN_COLOR[run["run"]], width=1)
        svg.add(f'<circle cx="{ex:.1f}" cy="{ey:.1f}" r="4" fill="{RUN_COLOR[run["run"]]}" stroke="{SURFACE}" stroke-width="2"/>')
        svg.badge(right + 30, ly, run["run"], r=10)
        svg.text(right + 45, ly + 4.5, f'{run["curve"][-1]:.2f}', size=13)
    for run in doc["runs"]:
        if len(run["curve"]) == epochs:
            continue
        n, training = run["run"], run["status"] == "training"
        ex, ey = px(len(run["curve"])), py(run["curve"][-1])
        by = ey + 78 if training else ey - 30
        svg.line(ex, ey, ex, by, stroke=RUN_COLOR[n], width=1)
        fill = SURFACE if training else RUN_COLOR[n]
        svg.add(f'<circle cx="{ex:.1f}" cy="{ey:.1f}" r="4" fill="{fill}" stroke="{RUN_COLOR[n]}" stroke-width="2"/>')
        svg.badge(ex, by, n, r=10, hollow=training)
        note = (f'still training: {run["curve"][-1]:.2f} at epoch {len(run["curve"])}' if training
                else f'{run["curve"][-1]:.2f} after its {len(run["curve"])} epochs')
        svg.text(ex - 15, by + 4.5, note, size=13, anchor="end")


def outcome_panel(svg, doc, runs, title, x, y, w, h):
    svg.rect(x + 0.5, y + 0.5, w - 1, h - 1, fill=CARD, stroke=BORDER, r=8)
    svg.text(x + PAD, y + 25, title, size=14.5, weight=700)
    lx = x + PAD + 9
    for run in runs:
        scored = run["status"] == "scored"
        label = RUN_SHORT[run["run"]] if scored else "not scored yet"
        svg.badge(lx, y + 46, run["run"], r=9, hollow=not scored)
        svg.text(lx + 14, y + 50.5, label, size=12.5, fill=INK2)
        lx += 14 + text_width(label, 12.5) + 20
    scored = [r for r in runs if r["status"] == "scored"]
    x0 = x + PAD + 122
    full = w - PAD - 122 - PAD - 68
    top, bottom = y + 66, h + y - 28
    pitch = (bottom - top) / len(doc["symbol_kinds"])
    for frac, label in ((0, "0%"), (0.5, "50%"), (1, "100%")):
        gx = x0 + frac * full
        svg.line(gx, top, gx, bottom, stroke=AXIS if frac == 0 else GRID)
        svg.text(gx, bottom + 16, label, size=12, fill=MUTED, anchor="middle")
    thick, gap = 10, 3
    for k, kind in enumerate(doc["symbol_kinds"]):
        mid = top + (k + 0.5) * pitch
        asked = scored[0]["kinds"][kind][1]
        svg.text(x0 - 10, mid - 1, KIND_LABEL[kind], size=13, anchor="end")
        svg.text(x0 - 10, mid + 14, f"of {asked}", size=12, fill=INK2, anchor="end")
        by = mid - (len(scored) * thick + (len(scored) - 1) * gap) / 2
        for run in scored:
            exact, n_asked = run["kinds"][kind]
            length = full * exact / n_asked
            r = 4
            svg.add(f'<path d="M{x0:.1f},{by:.1f} H{x0 + length - r:.1f} a{r},{r} 0 0 1 {r},{r} v{thick - 2 * r} '
                    f'a{r},{r} 0 0 1 -{r},{r} H{x0:.1f} Z" fill="{RUN_COLOR[run["run"]]}"/>')
            svg.text(x0 + length + 6, by + thick - 0.5, str(exact), size=12.5, weight=600)
            svg.text(x0 + length + 6 + text_width(str(exact), 12.5, True) + 5, by + thick - 0.5,
                     f"{100 * exact / n_asked:.0f}%", size=12, fill=INK2)
            by += thick + gap


def main():
    doc = load()
    svg = Svg()
    row1, row2 = cards(doc)
    d = doc["drawings"]

    svg.text(MARGIN, 40, "A bigger model and gentler augmentation did not improve window and door counts: "
                         "the labels set the ceiling", size=23, weight=700)
    svg.text(MARGIN, 66, "History of the detector training for raster floor plans, 14 Nov 2026 (local time). The score "
                         "is the number of questions answered with exactly the right count per drawing.",
             size=14, fill=INK2)

    xs, w, top1, bottom1 = lineage_row(
        svg, row1,
        ["start: one detector for everything", "symbols read the same mirrored: specialise on them",
         "try more capacity and resolution", "bigger was worse on every kind, so study the errors"],
        80, (1, 3, f'Runs 1–3 are scored on the {d["test"]} held-out test drawings'))

    y_wrap = bottom1 + 58
    x_from, x_to = xs[4] + w / 2, xs[0] + w / 2
    wrap_text = "the labels, not the model size, set the ceiling: compare recipes on drawings kept apart from test"
    tw = text_width(wrap_text, 13) + 24
    xm = (x_from + x_to) / 2
    svg.path(f"M{x_from:.1f},{bottom1 + 1:.1f} V{y_wrap} H{xm + tw / 2:.1f}")
    svg.text(xm, y_wrap + 4.5, wrap_text, size=13, fill=INK2, anchor="middle", extra=' font-style="italic"')

    xs2, w2, top2, bottom2 = lineage_row(
        svg, row2,
        ["retrain run 2's recipe as the yardstick", "try drawing-safe augmentation",
         "same recipe on a newer architecture", "next in the queue"],
        y_wrap + 20, (1, 3, f'Runs 4–6 are scored on the {d["dev"]} dev drawings: other drawings, '
                           f'not comparable with runs 1–3'))
    svg.path(f"M{xm - tw / 2:.1f},{y_wrap} H{x_to:.1f} V{top2 - 8:.1f}")
    svg.arrow_down(x_to, top2 - 1)

    y0 = bottom2 + 76
    plot_h = 252
    left_w = 540
    svg.text(MARGIN, y0, "Learning curves: validation mAP50-95 after each epoch", size=15.5, weight=700)
    for i, part in enumerate(wrap(
            f'Higher is better, on the {d["validation"]} validation drawings. Each run averages over its own classes '
            "(run 1: 13, run 3: 6, the others: 7), so heights compare only among runs 2, 4, 5 and 6.",
            left_w - 10, 13)):
        svg.text(MARGIN, y0 + 21 + i * 17, part, size=13, fill=INK2)
    curves(svg, doc, MARGIN, y0 + 70, left_w, plot_h)

    rx = MARGIN + left_w + 40
    rw = W - MARGIN - rx
    svg.text(rx, y0, "What came out, per symbol kind", size=15.5, weight=700)
    for i, part in enumerate(wrap(
            "Bar: share of the questions of that kind answered with exactly the right count; the figure is that "
            "count. The two panels use different drawings: compare within a panel, never across.", rw - 10, 13)):
        svg.text(rx, y0 + 21 + i * 17, part, size=13, fill=INK2)
    runs = {r["run"]: r for r in doc["runs"]}
    pw = (rw - 20) / 2
    panel_y, panel_h = y0 + 56, plot_h + 40
    outcome_panel(svg, doc, [runs[1], runs[2], runs[3]], f'{d["test"]} test drawings · runs 1–3', rx, panel_y, pw,
                  panel_h)
    outcome_panel(svg, doc, [runs[4], runs[5], runs[6]], f'{d["dev"]} dev drawings · runs 4–6', rx + pw + 20, panel_y,
                  pw, panel_h)

    height = panel_y + panel_h + 44
    svg.text(MARGIN, height - 16, "Source: Ultralytics results.csv and the exact-count report of each run "
                                  "(docs/training-data). Thresholds are tuned on the validation drawings.",
             size=12.5, fill=MUTED)
    (HERE / "training-history.svg").write_text(svg.render(round(height)), encoding="utf-8")
    print("wrote", HERE / "training-history.svg", f"{W}x{round(height)}")


if __name__ == "__main__":
    main()
