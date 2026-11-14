/**
 * Quantity take-off from layered DXF floor plans (Swiss Dwellings layout).
 * Layers: ROOM_OUTLINE, UNIT_OUTLINE, WALL, DOOR, WINDOW, FIXTURE, ROOM_TEXT.
 */
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { contains, distanceTo, mid, polygonArea } from "../geometry.js";
import type { Intent } from "../questions.js";
import { SCRIPTS, script } from "../source.js";
import type { Point, Polygon, Solved } from "../types.js";

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
// A door or window is drawn across the wall and reaches the outlines of the rooms it serves; a fixture lies inside its room.
const TOUCH = 0.05;

export const SYMBOL_KINDS = ["doors", "windows", "toilets", "washbasins", "bathtubs", "showers"] as const;
export type SymbolKind = (typeof SYMBOL_KINDS)[number];

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
  /** What was counted or measured, as a plural noun phrase, e.g. "rooms labelled 'Bad'". */
  subject?: string;
  /** The shapes the value was derived from, in drawing coordinates. */
  highlights: Polygon[];
  /** Per highlight, the rings that are not part of it. */
  cutouts?: Polygon[][];
}

/** Narrows the rooms of a plan; a filter that is left out keeps every room. */
export interface RoomFilter {
  labels?: string[];
  numbers?: string[];
  units?: string[];
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

  /** The apartment each room lies in. */
  unitOf(): Map<Room, string> {
    const units = new Map<Room, string>();
    for (const letter of [...this.unitLabels.keys()].sort()) for (const room of this.unitRooms(letter)) units.set(room, letter);
    return units;
  }

  /** What this plan can be asked about, in its own words: its room labels with their room counts, room numbers and apartments. */
  vocabulary(): { labels: [string, number][]; numbers: string[]; units: string[] } {
    const labels = new Map<string, number>();
    for (const room of this.rooms) if (room.name) labels.set(room.name, (labels.get(room.name) ?? 0) + 1);
    return {
      labels: [...labels].sort((a, b) => b[1] - a[1]),
      numbers: this.rooms.flatMap((r) => (r.number ? [r.number] : [])),
      units: [...this.unitLabels.keys()].sort(),
    };
  }

  select({ labels, numbers, units }: RoomFilter): Room[] {
    const names = labels && new Set(labels.map((l) => l.toLowerCase()));
    const inUnits = units && new Set(units.flatMap((unit) => this.unitRooms(unit)));
    return this.rooms.filter(
      (r) => (!names || names.has((r.name ?? "").toLowerCase())) && (!numbers || (r.number !== null && numbers.includes(r.number))) && (!inUnits || inUnits.has(r)),
    );
  }

  /** The number of `rooms`, or their summed area; null when an area is missing or nothing was selected to add up. */
  measure(rooms: Room[], quantity: "count" | "area", method: string): TakeoffResult | null {
    return quantity === "count" ? { value: rooms.length, method, ...shapes(rooms) } : totalArea(rooms, method);
  }

  /** The drawn symbols of a kind, and what tells them apart on the drawing. */
  symbols(kind: SymbolKind): { shapes: Polygon[]; method: string } {
    switch (kind) {
      case "doors": return { shapes: this.doors, method: "door symbols on layer DOOR" };
      case "windows": return { shapes: this.windows, method: "window symbols on layer WINDOW" };
      case "toilets": return { shapes: this.toilets, method: "bowl symbols with a cistern stroke" };
      case "washbasins": return { shapes: this.washbasins, method: "bowl symbols with a tap" };
      case "bathtubs": return { shapes: this.bathtubs, method: "bathtub symbols" };
      case "showers": return { shapes: this.showers, method: "shower tray symbols" };
    }
  }

  /** The symbols of a kind that lie in, or reach the outline of, one of `rooms`; an entrance door belongs to the room it opens into. */
  symbolsIn(kind: SymbolKind, rooms: Room[]): Polygon[] {
    const outlines = rooms.flatMap((r) => (r.polygon ? [r.polygon] : []));
    return this.symbols(kind).shapes.filter((shape) => outlines.some((outline) => [...shape, mid(shape)].some((point) => distanceTo(outline, point) <= TOUCH)));
  }

  /** How many of `shapes` lie on each layer of this plan, e.g. "5 room outlines on layer ROOM_OUTLINE". */
  drawnOn(shapes: Polygon[]): string {
    const layers: [string, string, Polygon[]][] = [
      ["room outline", "ROOM_OUTLINE", this.roomOutlines],
      ["apartment outline", "UNIT_OUTLINE", this.unitOutlines],
      ["door symbol", "DOOR", this.doors],
      ["window symbol", "WINDOW", this.windows],
      ["sanitary symbol", "FIXTURE", [...this.toilets, ...this.washbasins, ...this.bathtubs, ...this.showers]],
    ];
    return layers
      .map(([noun, layer, drawn]) => {
        const onLayer = new Set(drawn);
        const n = shapes.filter((shape) => onLayer.has(shape)).length;
        return n > 0 ? `${n} ${noun}${n === 1 ? "" : "s"} on layer ${layer}` : "";
      })
      .filter(Boolean)
      .join(", ");
  }

  answer(intent: Intent): TakeoffResult | null {
    const { kind } = intent;
    if (kind === "count_rooms_labelled" && intent.name) {
      const rooms = this.labelled(intent.name);
      return { value: rooms.length, method: `room labels equal to '${intent.name}'`, subject: `rooms labelled '${intent.name}'`, ...shapes(rooms) };
    }
    if (kind === "count_apartments") {
      const labels = [...this.unitLabels.values()];
      return { value: labels.length, method: "unit labels", subject: "apartments", highlights: this.unitOutlines.filter((o) => labels.some((p) => contains(o, p))) };
    }
    const symbol = SYMBOL_KINDS.find((each) => kind === `count_${each}`);
    if (symbol) {
      const { shapes, method } = this.symbols(symbol);
      return { value: shapes.length, method, subject: symbol, highlights: shapes };
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

export function isIndoor(room: Room): boolean {
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

/** The source of a value this solver computed: `what` was measured, and the shapes behind it by layer. */
export function takeoffSource(dxfPath: string, plan: Plan, what: string, shapes: Polygon[]): Solved["source"] {
  const drawn = plan.drawnOn(shapes);
  // "door symbols on layer DOOR" says nothing that "2 door symbols on layer DOOR" does not.
  const used = drawn && /^\w+ symbols on layer \w+(?:, \w+ symbols on layer \w+)*$/.test(what) ? drawn : [what, drawn].filter(Boolean).join(": ");
  return { calculatedBy: [script(SCRIPTS.dxf)], from: { file: basename(dxfPath), used } };
}

/** True when the file uses the layer names this solver understands. */
export function isLayeredPlan(plan: Plan): boolean {
  return plan.roomOutlines.length > 0 && plan.rooms.length > 0;
}
