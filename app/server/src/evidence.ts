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
}

/** SVG of a plan with the shapes behind an answer highlighted and numbered 1..n, so a person can check them. */
export function renderPlanSvg({ solid = [], outlines = [], highlights, labels = [] }: PlanDrawing): string {
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
    ...highlights.map((p) => `<path d="${path(p)}" fill="#ff7a00" fill-opacity="0.4" stroke="#c44d00" stroke-width="2"/>`),
  ];
  highlights.forEach((p, i) => {
    const [cx, cy] = centroid(p);
    const text = labels[i] ? `${i + 1} · ${labels[i]}` : String(i + 1);
    const w = 10 + text.length * 7.2;
    parts.push(
      `<g transform="translate(${px(cx)},${py(cy)})">` +
        `<rect x="${(-w / 2).toFixed(1)}" y="-10" width="${w.toFixed(1)}" height="20" rx="10" fill="#1d1d1b"/>` +
        `<text y="4.5" text-anchor="middle" font-size="13" font-weight="600" fill="#ffffff">${escapeXml(text)}</text></g>`,
    );
  });
  parts.push("</svg>");
  return parts.join("\n");
}

export function escapeXml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c]!);
}
