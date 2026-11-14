import { bbox, centroid } from "./geometry.js";
import type { Polygon } from "./types.js";

const WIDTH = 1200;
const MARGIN = 24;

export interface PlanDrawing {
  /** Solid context shapes, e.g. walls. */
  solid?: Polygon[];
  /** Thin context outlines, e.g. every room. */
  outlines?: Polygon[];
  /** The shapes the answer was derived from; each gets a number. */
  highlights: Polygon[];
  /** Optional text per highlight, shown next to its number. */
  labels?: string[];
  /** Plain text at a drawing point, written to the right of and below it, e.g. a storey name in a corner of its frame. */
  titles?: { at: [number, number]; text: string }[];
}

/** SVG of a plan with the shapes behind an answer highlighted and numbered 1..n, so a person can check them. */
export function renderPlanSvg({ solid = [], outlines = [], highlights, labels = [], titles = [] }: PlanDrawing, cutouts: Polygon[][] = []): string {
  const all = [...solid, ...outlines, ...highlights].flat();
  if (all.length === 0) return "";
  const [x0, y0, x1, y1] = bbox(all);
  const scale = (WIDTH - 2 * MARGIN) / Math.max(x1 - x0, 1e-9);
  const height = (y1 - y0) * scale + 2 * MARGIN;
  // Drawing y grows upwards, SVG y downwards.
  const px = (x: number) => (MARGIN + (x - x0) * scale).toFixed(1);
  const py = (y: number) => (MARGIN + (y1 - y) * scale).toFixed(1);
  const path = (points: Polygon) => `M${points.map(([x, y]) => `${px(x)},${py(y)}`).join(" L")} Z`;

  const parts = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${WIDTH} ${height.toFixed(0)}" font-family="system-ui, sans-serif">`,
    `<rect width="100%" height="100%" fill="#ffffff"/>`,
    ...outlines.map((p) => `<path d="${path(p)}" fill="none" stroke="#c9c9c4" stroke-width="1"/>`),
    ...solid.map((p) => `<path d="${path(p)}" fill="#4b4b48"/>`),
    // Even-odd fill leaves the cut-out rings (holes in a room) unpainted.
    ...highlights.map((p, i) => `<path d="${[p, ...(cutouts[i] ?? [])].map(path).join(" ")}" fill="#ff7a00" fill-opacity="0.4" fill-rule="evenodd" stroke="#c44d00" stroke-width="2"/>`),
  ];
  highlights.forEach((p, i) => {
    const [cx, cy] = centroid(p);
    const text = labels[i] ? `${i + 1} · ${labels[i]}` : String(i + 1);
    const w = 10 + text.length * 7.2;
    // A badge would hide a small symbol such as a door or window, so it sits just above the shape instead.
    const [bx0, by0, bx1, by1] = bbox(p);
    const small = Math.min(bx1 - bx0, by1 - by0) * scale < 26;
    const x = Number(px(cx));
    const y = small ? Math.max(12, Number(py(by1)) - 13) : Number(py(cy));
    parts.push(
      `<g transform="translate(${x.toFixed(1)},${y.toFixed(1)})">` +
        `<rect x="${(-w / 2).toFixed(1)}" y="-10" width="${w.toFixed(1)}" height="20" rx="10" fill="#1d1d1b"/>` +
        `<text y="4.5" text-anchor="middle" font-size="13" font-weight="600" fill="#ffffff">${escapeXml(text)}</text></g>`,
    );
  });
  for (const { at: [x, y], text } of titles) {
    const left = Number(px(x)) + 4, top = Number(py(y)) + 4;
    parts.push(
      `<rect x="${left.toFixed(1)}" y="${top.toFixed(1)}" width="${(16 + text.length * 11).toFixed(1)}" height="26" rx="3" fill="#ffffff" stroke="#c9c9c4"/>` +
        `<text x="${(left + 7).toFixed(1)}" y="${(top + 19).toFixed(1)}" font-size="17" font-weight="600" fill="#1f2421">${escapeXml(text)}</text>`,
    );
  }
  parts.push("</svg>");
  return parts.join("\n");
}

export function escapeXml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c]!);
}
