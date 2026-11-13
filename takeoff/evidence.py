"""SVG overlay showing which shapes an answer was derived from."""
from html import escape

from .geometry import bbox

WIDTH = 1200
MARGIN = 30
HEADER = 70


def render_svg(plan, answer, question, out_path):
    shapes = plan.walls + plan.room_outlines + answer.highlights
    x0, y0, x1, y1 = bbox([p for shape in shapes for p in shape])
    scale = (WIDTH - 2 * MARGIN) / (x1 - x0)
    height = (y1 - y0) * scale + 2 * MARGIN + HEADER

    def path(points, closed=True):
        # DXF y grows upwards, SVG y downwards.
        coords = " ".join(f"{MARGIN + (x - x0) * scale:.1f},{HEADER + MARGIN + (y1 - y) * scale:.1f}" for x, y in points)
        return f"M{coords.replace(' ', ' L')}{' Z' if closed else ''}"

    parts = [
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {WIDTH} {height:.0f}" font-family="sans-serif">',
        '<rect width="100%" height="100%" fill="#fff"/>',
        f'<text x="{MARGIN}" y="28" font-size="17">{escape(question)}</text>',
        f'<text x="{MARGIN}" y="54" font-size="17" font-weight="bold">{answer.value:g} '
        f'<tspan font-weight="normal" fill="#666">from {escape(answer.method)} '
        f'({len(answer.highlights)} highlighted)</tspan></text>',
    ]
    parts += [f'<path d="{path(p)}" fill="none" stroke="#c8c8c8" stroke-width="1"/>' for p in plan.room_outlines]
    parts += [f'<path d="{path(p)}" fill="#555"/>' for p in plan.walls]
    parts += [f'<path d="{path(p)}" fill="#ff7a00" fill-opacity="0.45" stroke="#c44d00" stroke-width="2"/>'
              for p in answer.highlights]
    parts.append("</svg>")
    with open(out_path, "w", encoding="utf-8") as f:
        f.write("\n".join(parts))
