/**
 * Quantity take-off from layered DXF floor plans (Swiss Dwellings layout).
 * Layers: ROOM_OUTLINE, UNIT_OUTLINE, WALL, DOOR, WINDOW, FIXTURE, ROOM_TEXT.
 */
import { readFile } from "node:fs/promises";
import { contains, mid, polygonArea } from "../geometry.js";
import type { Intent } from "../questions.js";
import type { Point, Polygon } from "../types.js";

interface Entity {
  type: string;
  layer: string;
  points: Polygon;
  closed: boolean;
  text: string;
}

export function parseDxf(source: string): Entity[] {
  const lines = source.split(/\r?\n/);
  const entities: Entity[] = [];
  let current: Entity | null = null;
  let inEntities = false;
  let sectionNameNext = false;
  let pendingX: number | null = null;

  for (let i = 0; i + 1 < lines.length; i += 2) {
    const code = Number.parseInt(lines[i].trim(), 10);
    if (Number.isNaN(code)) continue;
    const value = lines[i + 1].trim();

    if (code === 0) {
      current = null;
      if (value === "SECTION") sectionNameNext = true;
      else if (value === "ENDSEC") inEntities = false;
      else if (inEntities) {
        current = { type: value, layer: "", points: [], closed: false, text: "" };
        entities.push(current);
      }
      continue;
    }
    if (sectionNameNext && code === 2) {
      inEntities = value === "ENTITIES";
      sectionNameNext = false;
      continue;
    }
    if (!current) continue;

    if (code === 8) current.layer = value;
    else if (code === 70 && current.type === "LWPOLYLINE") current.closed = (Number.parseInt(value, 10) & 1) === 1;
    else if (code === 10) pendingX = Number.parseFloat(value);
    else if (code === 20 && pendingX !== null) {
      current.points.push([pendingX, Number.parseFloat(value)]);
      pendingX = null;
    } else if (code === 1) current.text = value;
  }
  return entities;
}

const ROOM_NUMBER = /^[A-Z]?\d+\.\d+$/;
const AREA_TEXT = /^(\d+(?:\.\d+)?)\s*m/;
const UNIT_LABEL = /^\S{1,8}\.? ([A-Z])$/; // 'App. A', 'Whg. B'
const OUTDOOR = new Set(["balkon", "balcon", "balcone", "loggia", "terrasse", "terrazza"]);

// Vertex counts the drawing generator uses for fixture symbols.
const BOWL_VERTICES = 48, BATHTUB_VERTICES = 69, SHOWER_VERTICES = 5;
const STACK_GAP = 0.6; // max vertical distance between the stacked name / number / area labels of one room

export interface Room {
  name: string | null;
  number: string | null;
  polygon: Polygon | null;
  /** Rings cut out of `polygon`: a room with a hole is drawn as its outer ring plus the inner rings on the same layer. */
  holes: Polygon[];
  area: number | null;
  point: Point;
}

export interface TakeoffResult {
  value: number;
  method: string;
  /** The shapes the value was derived from, in drawing coordinates. */
  highlights: Polygon[];
  /** Per highlight, the rings that are not part of it. */
  cutouts?: Polygon[][];
}

export class Plan {
  roomOutlines: Polygon[];
  unitOutlines: Polygon[];
  walls: Polygon[];
  doors: Polygon[];
  windows: Polygon[];
  unitLabels = new Map<string, Point>();
  rooms: Room[];
  bathtubs: Polygon[] = [];
  showers: Polygon[] = [];
  toilets: Polygon[] = [];
  washbasins: Polygon[] = [];

  constructor(entities: Entity[]) {
    const byLayer = new Map<string, Entity[]>();
    for (const e of entities) {
      if (!byLayer.has(e.layer)) byLayer.set(e.layer, []);
      byLayer.get(e.layer)!.push(e);
    }
    const polygons = (layer: string) =>
      (byLayer.get(layer) ?? []).filter((e) => e.type === "LWPOLYLINE" && e.points.length >= 3).map((e) => e.points);

    this.roomOutlines = polygons("ROOM_OUTLINE");
    this.unitOutlines = polygons("UNIT_OUTLINE");
    this.walls = polygons("WALL");
    this.doors = polygons("DOOR");
    this.windows = polygons("WINDOW");

    const texts = (byLayer.get("ROOM_TEXT") ?? [])
      .filter((e) => e.points.length > 0)
      .map((e) => ({ text: e.text.trim(), point: e.points[0] }));
    for (const { text, point } of texts) {
      const unit = UNIT_LABEL.exec(text);
      if (unit) this.unitLabels.set(unit[1], point);
    }
    this.rooms = this.buildRooms(texts);
    this.buildFixtures(byLayer.get("FIXTURE") ?? []);
  }

  private buildRooms(texts: { text: string; point: Point }[]): Room[] {
    const isName = (t: string) => !(ROOM_NUMBER.test(t) || AREA_TEXT.test(t) || UNIT_LABEL.test(t));
    // Labels in the same column, nearest first; direction +1 looks above, -1 below.
    const stacked = (point: Point, direction: 1 | -1) =>
      texts
        .filter((t) => Math.abs(t.point[0] - point[0]) < 1e-3)
        .map((t) => ({ gap: (t.point[1] - point[1]) * direction, text: t.text }))
        .filter((t) => t.gap > 0 && t.gap < STACK_GAP)
        .sort((a, b) => a.gap - b.gap)
        .map((t) => t.text);
    const room = (name: string | null, number: string | null, point: Point): Room => {
      const printed = stacked(point, -1).map((t) => AREA_TEXT.exec(t)).find(Boolean);
      const polygon = this.roomOutlines.filter((o) => contains(o, point)).sort((a, b) => polygonArea(a) - polygonArea(b))[0] ?? null;
      const holes = polygon ? outermostWithin(this.roomOutlines, polygon) : [];
      const area = polygon
        ? polygonArea(polygon) - holes.reduce((sum, hole) => sum + polygonArea(hole), 0)
        : printed ? Number.parseFloat(printed[1]) : null;
      return { name, number, polygon, holes, area, point };
    };

    // Rooms too small for a full label carry only their number.
    const numbered = texts
      .filter((t) => ROOM_NUMBER.test(t.text))
      .map((t) => room(stacked(t.point, 1).find(isName) ?? null, t.text, t.point));
    const unnumbered = texts
      .filter((t) => isName(t.text) && !stacked(t.point, -1).some((s) => ROOM_NUMBER.test(s)))
      .map((t) => room(t.text, null, t.point));
    return [...numbered, ...unnumbered];
  }

  private buildFixtures(entities: Entity[]): void {
    const open = entities.filter((e) => e.type === "LWPOLYLINE" && !e.closed).map((e) => e.points);
    const boxes = entities.filter((e) => e.type === "LWPOLYLINE" && e.closed && e.points.length >= 3).map((e) => e.points);
    const strokes = open.filter((p) => p.length === 2).map(mid);

    this.bathtubs = open.filter((p) => p.length === BATHTUB_VERTICES);
    this.showers = open.filter((p) => p.length === SHOWER_VERTICES);
    for (const bowl of open.filter((p) => p.length === BOWL_VERTICES)) {
      const centre = mid(bowl);
      const box = boxes.filter((b) => contains(b, centre)).sort((a, b) => polygonArea(a) - polygonArea(b))[0];
      // A toilet symbol has a cistern stroke inside its box; a washbasin has a tap circle instead.
      const isToilet = box !== undefined && strokes.some((s) => contains(box, s));
      (isToilet ? this.toilets : this.washbasins).push(box ?? bowl);
    }
  }

  labelled(name: string): Room[] {
    return this.rooms.filter((r) => (r.name ?? "").toLowerCase() === name.toLowerCase());
  }

  unitRooms(letter: string): Room[] {
    const label = this.unitLabels.get(letter);
    if (!label) return [];
    const outlines = this.unitOutlines.filter((o) => contains(o, label));
    // A ring nested in the unit's outline that does not hold the unit label is a hole in the unit.
    const holes = this.unitOutlines.filter((h) => !contains(h, label) && outlines.some((o) => within(h, o)));
    return this.rooms.filter((r) => outlines.some((o) => contains(o, r.point)) && !holes.some((h) => contains(h, r.point)));
  }

  answer(intent: Intent): TakeoffResult | null {
    const { kind } = intent;
    if (kind === "count_rooms_labelled" && intent.name) {
      const rooms = this.labelled(intent.name);
      return { value: rooms.length, method: `room labels equal to '${intent.name}'`, ...shapes(rooms) };
    }
    if (kind === "count_apartments") {
      const labels = [...this.unitLabels.values()];
      return { value: labels.length, method: "unit labels", highlights: this.unitOutlines.filter((o) => labels.some((p) => contains(o, p))) };
    }
    const symbols: Record<string, [Polygon[], string]> = {
      count_doors: [this.doors, "door symbols on layer DOOR"],
      count_windows: [this.windows, "window symbols on layer WINDOW"],
      count_toilets: [this.toilets, "bowl symbols with a cistern stroke"],
      count_washbasins: [this.washbasins, "bowl symbols with a tap"],
      count_bathtubs: [this.bathtubs, "bathtub symbols"],
      count_showers: [this.showers, "shower tray symbols"],
    };
    if (kind in symbols) {
      const [shapes, method] = symbols[kind];
      return { value: shapes.length, method, highlights: shapes };
    }
    if (kind === "area_room" && intent.number) {
      const rooms = this.rooms.filter((r) => r.number === intent.number);
      return rooms.length === 1 ? totalArea(rooms, `outline of room ${intent.number}`) : null;
    }
    if (kind === "area_rooms_labelled" && intent.name) return totalArea(this.labelled(intent.name), `outlines of rooms labelled '${intent.name}'`);
    if (kind === "area_all_indoor") return totalArea(this.rooms.filter((r) => r.number && isIndoor(r)), "outlines of numbered indoor rooms");
    if (kind === "area_apartment" && intent.unit) {
      return totalArea(this.unitRooms(intent.unit).filter(isIndoor), `indoor room outlines inside unit ${intent.unit}`);
    }
    return null;
  }
}

function isIndoor(room: Room): boolean {
  return !OUTDOOR.has((room.name ?? "").toLowerCase());
}

function within(inner: Polygon, outer: Polygon): boolean {
  return inner !== outer && inner.every((p) => contains(outer, p));
}

/** The rings nested directly in `outer`; a ring nested deeper belongs to one of those. */
function outermostWithin(rings: Polygon[], outer: Polygon): Polygon[] {
  const nested = rings.filter((r) => within(r, outer));
  return nested.filter((r) => !nested.some((n) => within(r, n)));
}

function shapes(rooms: Room[]): Pick<TakeoffResult, "highlights" | "cutouts"> {
  const drawn = rooms.filter((r) => r.polygon !== null);
  return { highlights: drawn.map((r) => r.polygon as Polygon), cutouts: drawn.map((r) => r.holes) };
}

function totalArea(rooms: Room[], method: string): TakeoffResult | null {
  if (rooms.length === 0 || rooms.some((r) => r.area === null)) return null;
  const sum = rooms.reduce((s, r) => s + (r.area as number), 0);
  return { value: Math.round(sum * 100) / 100, method, ...shapes(rooms) };
}

const plans = new Map<string, Promise<Plan>>();

export function loadPlan(dxfPath: string): Promise<Plan> {
  if (!plans.has(dxfPath)) plans.set(dxfPath, readFile(dxfPath, "utf8").then((source) => new Plan(parseDxf(source))));
  return plans.get(dxfPath)!;
}

/** True when the file uses the layer names this solver understands. */
export function isLayeredPlan(plan: Plan): boolean {
  return plan.roomOutlines.length > 0 && plan.rooms.length > 0;
}
