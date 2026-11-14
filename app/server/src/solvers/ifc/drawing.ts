/** Plan drawings behind an IFC answer: a storey's rooms and walls as context, the measured elements highlighted. */
import { renderPlanSvg, type PlanDrawing } from "../../evidence.js";
import { bbox } from "../../geometry.js";
import type { Evidence, Polygon } from "../../types.js";
import type { IfcModel, Storey } from "./model.js";

interface Panel extends Required<PlanDrawing> {
  /** Elements that have no body in the model and so could not be drawn. */
  undrawn: number;
}

/** The elements behind an answer that stand on one storey; `storey` is undefined for elements outside every storey. */
export interface StoreyGroup {
  storey: Storey | undefined;
  ids: number[];
}

// More numbered marks than this bury the plan; the elements are then drawn as solid shapes without numbers.
const MAX_NUMBERED = 600;
// Marks start to cover each other when a storey holds more than about this many per sheet width.
const MARKS_PER_SHEET = 150;

/**
 * Evidence for elements on one or more storeys: each storey in plan, lowest first, with the elements highlighted
 * and numbered in the order given. `label` adds text beside the number.
 */
export function planEvidence(model: IfcModel, groups: StoreyGroup[], caption: string, label?: (id: number) => string): Evidence | undefined {
  const numbered = groups.reduce((n, group) => n + group.ids.length, 0) <= MAX_NUMBERED;
  const panel = panelGrid(groups.map(({ storey, ids }) => storeyPanel(model, storey, ids, numbered, label)));
  if (panel.labels.some(Boolean)) {
    // A label is centred on its shape and would be cut off at the left and right edges of the sheet;
    // two single-point outlines widen the sheet without drawing anything.
    const [x0, y0, x1] = bbox([...panel.outlines, ...panel.solid, ...panel.highlights].flat());
    const room = 0.06 * (x1 - x0);
    panel.outlines.push([[x0 - room, y0]], [[x1 + room, y0]]);
  }
  const svg = renderPlanSvg(panel);
  if (!svg) return undefined;
  const notes = [
    caption,
    ...(numbered ? [] : ["too many to number, so drawn as solid shapes"]),
    ...(panel.undrawn ? [`${panel.undrawn} have no geometry in the model and are not drawn`] : []),
  ];
  return { kind: "svg", svg, caption: notes.join("; ") };
}

/**
 * One storey in plan. Rooms and walls that are not marked give the context; a model without either
 * (a services model) shows its pipe and duct runs instead.
 */
function storeyPanel(model: IfcModel, storey: Storey | undefined, marked: number[], numbered: boolean, label?: (id: number) => string): Panel {
  const skip = new Set(marked);
  const others = (ids: number[]) => ids.filter((id) => !skip.has(id));
  const outlineOf = (id: number) => model.shape(id)?.outline;
  const drawable = (outline: Polygon | undefined): outline is Polygon => outline !== undefined && outline.length >= 3;
  const spaces = storey ? model.elements("space", storey) : [];
  const walls = storey ? model.elements("wall", storey) : [];

  const panel: Panel = {
    outlines: others(spaces).flatMap((id) => model.shape(id)?.shapes ?? []),
    // Unnumbered elements are drawn solid themselves, so the walls step back.
    solid: numbered ? others(walls).flatMap((id) => model.shape(id)?.shapes ?? []) : [],
    highlights: [],
    labels: [],
    undrawn: 0,
  };
  if (storey && spaces.length === 0 && walls.length === 0) panel.outlines = others(model.elements("pipe", storey)).map(outlineOf).filter(drawable);

  for (const id of marked) {
    const outline = outlineOf(id);
    if (!drawable(outline)) panel.undrawn++;
    else if (numbered) {
      panel.highlights.push(outline);
      panel.labels.push(label?.(id) ?? "");
    } else panel.solid.push(outline);
  }
  return panel;
}

/**
 * Storey plans in a grid of frames, reading left to right and top to bottom.
 * Storeys with many highlights get fewer columns, down to one storey per row, so the numbers stay apart.
 */
function panelGrid(panels: Panel[]): Panel {
  const drawn = panels.filter((panel) => panel.outlines.length + panel.solid.length + panel.highlights.length > 0);
  const undrawn = panels.reduce((n, panel) => n + panel.undrawn, 0);
  if (drawn.length <= 1) return { ...(drawn[0] ?? { outlines: [], solid: [], highlights: [], labels: [] }), undrawn };

  const boxes = drawn.map((panel) => bbox([...panel.outlines, ...panel.solid, ...panel.highlights].flat()));
  const width = Math.max(...boxes.map(([x0, , x1]) => x1 - x0));
  const height = Math.max(...boxes.map(([, y0, , y1]) => y1 - y0));
  const pad = 0.04 * Math.max(width, height);
  const densest = Math.max(1, ...drawn.map((panel) => panel.highlights.length));
  const columns = Math.max(1, Math.min(Math.ceil(Math.sqrt(drawn.length)), Math.floor(Math.sqrt(MARKS_PER_SHEET / densest))));

  const grid: Panel = { outlines: [], solid: [], highlights: [], labels: [], undrawn };
  drawn.forEach((panel, i) => {
    const [x0, y0, x1, y1] = boxes[i];
    const left = (i % columns) * (width + 4 * pad);
    const bottom = -Math.floor(i / columns) * (height + 4 * pad);
    // Centre the storey in its cell.
    const dx = left + (width - (x1 - x0)) / 2 - x0;
    const dy = bottom + (height - (y1 - y0)) / 2 - y0;
    const move = (polygons: Polygon[]) => polygons.map((polygon) => polygon.map(([x, y]) => [x + dx, y + dy] as [number, number]));
    grid.outlines.push(
      [[left - pad, bottom - pad], [left + width + pad, bottom - pad], [left + width + pad, bottom + height + pad], [left - pad, bottom + height + pad]],
      ...move(panel.outlines),
    );
    grid.solid.push(...move(panel.solid));
    grid.highlights.push(...move(panel.highlights));
    grid.labels.push(...panel.labels);
  });
  return grid;
}
