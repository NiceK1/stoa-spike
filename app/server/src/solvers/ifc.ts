/**
 * Quantity take-off from an IFC model: room areas, element counts, wall and slab totals per storey.
 * Values come from the model's stored base quantities where the exporter wrote them, otherwise from geometry.
 */
import type { Answer, Evidence, QuestionType } from "../types.js";
import { planEvidence, type StoreyGroup } from "./ifc/drawing.js";
import { answerText } from "./ifc/facts.js";
import { longSide } from "./ifc/footprint.js";
import { NOUNS, loadModel, roomLabel, type ElementShape, type IfcModel, type Space, type Storey } from "./ifc/model.js";
import { mentions, parseIfcQuestion, type ElementKind, type IfcIntent } from "./ifc/question.js";

const PIPELINE = "ifc-geometry";

/** Per-storey totals of a base quantity that exporters store on walls and slabs. */
const TOTALS = {
  wall_length: { element: "wall", quantity: "Length", unit: "m", symbol: "m", kind: "length_walls_storey", what: "length" },
  wall_side_area: { element: "wall", quantity: "NetSideArea", unit: "m2", symbol: "m²", kind: "area_wall_sides_storey", what: "net side area" },
  wall_volume: { element: "wall", quantity: "NetVolume", unit: "m3", symbol: "m³", kind: "volume_walls_storey", what: "net volume" },
  slab_volume: { element: "slab", quantity: "NetVolume", unit: "m3", symbol: "m³", kind: "volume_slabs_storey", what: "net volume" },
} as const;

/** What stands in for a base quantity when the exporter wrote none. Net side area has no stand-in. */
const FROM_GEOMETRY: Record<string, { measure: (shape: ElementShape) => number; source: string; note?: string }> = {
  // The body comes with its openings cut out, so its volume is the net volume.
  NetVolume: { measure: (shape) => shape.volume, source: "the volume of each element's body" },
  Length: {
    measure: (shape) => longSide(shape.outline),
    source: "the longer side of each wall's plan footprint",
    note: "The model stores no wall lengths; this is an estimate that takes every wall as straight and measures it to the ends of its footprint.",
  },
};

// Above this many highlights, text beside every number hides the plan.
const MAX_LABELLED = 40;

const round = (value: number, digits: number) => Math.round(value * 10 ** digits) / 10 ** digits;
const loose = (name: string) => name.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
const plural = (n: number, kind: ElementKind) => `${n} ${NOUNS[kind][n === 1 ? 0 : 1]}`;

/** Answers a take-off question from an IFC model, or returns null when the question is not understood. */
export async function solveIfc(ifcPath: string, question: string, qtype: QuestionType): Promise<Answer | null> {
  const intent = parseIfcQuestion(question, qtype);
  if (!intent) return null;
  const model = await loadModel(ifcPath);
  switch (intent.kind) {
    case "area_room": return roomArea(model, intent.room, intent.storey);
    case "area_storey_rooms": return storeyRoomArea(model, intent.storey, question);
    case "count": return count(model, intent, question);
    case "text": return answerText(model, intent.ask, question);
    default: return storeyTotal(model, intent.kind, intent.storey, question);
  }
}

function result(kind: string, value: number, unit: string, method: string, evidence?: Evidence, note?: string): Answer {
  return { value, unit, pipeline: PIPELINE, exact: true, kind, method, evidence, note };
}

/** The question was understood but the model cannot answer it; says why instead of handing over to a guessing pipeline. */
function unanswered(kind: string, method: string, evidence?: Evidence): Answer {
  return { value: null, pipeline: PIPELINE, exact: true, kind, method, evidence };
}

/** The storey with this name; without a name, the storey whose name appears in the question. */
function findStorey(model: IfcModel, name: string | null, question = ""): Storey | undefined {
  if (name !== null) {
    return model.storeys.find((storey) => storey.name === name) ?? model.storeys.find((storey) => loose(storey.name) === loose(name));
  }
  return model.storeys.filter((storey) => mentions(question, storey.name)).sort((a, b) => b.name.length - a.name.length)[0];
}

function noStorey(kind: string, model: IfcModel, name: string | null): Answer {
  const names = model.storeys.map((storey) => `'${storey.name}'`).join(", ");
  return unanswered(kind, name === null ? `the question names no storey; the model has ${names}` : `the model has no storey named '${name}'; it has ${names}`);
}

/** Rooms matching a label such as 'KORIDOR (119)', '119' or 'KORIDOR': exact spelling first, then ignoring case and spacing. */
function findRooms(model: IfcModel, storey: Storey | undefined, label: string): Space[] {
  const spaces = model.elements("space", storey).map((id) => model.space(id));
  const tiers: ((space: Space) => boolean)[] = [
    (space) => roomLabel(space) === label,
    (space) => space.number === label || space.name === label,
    (space) => loose(roomLabel(space)) === loose(label),
    (space) => loose(space.number) === loose(label) || loose(space.name) === loose(label),
  ];
  for (const matches of tiers) {
    const found = spaces.filter(matches);
    if (found.length > 0) return found;
  }
  return [];
}

function roomArea(model: IfcModel, room: string, storeyName: string | null): Answer | null {
  const kind = "area_room";
  let storey = storeyName !== null ? findStorey(model, storeyName) : undefined;
  if (storeyName !== null && !storey && findStorey(model, room)) {
    // The two names came in the other order.
    [storey, room] = [findStorey(model, room), storeyName];
  }
  if (storeyName !== null && !storey) return noStorey(kind, model, storeyName);

  const rooms = findRooms(model, storey, room);
  const where = storey ? `on ${storey.name}` : "in the model";
  if (rooms.length === 0) {
    // An area question that names only a storey, in wording this solver does not know: not ours to guess which area.
    if (storeyName === null && findStorey(model, room)) return null;
    return unanswered(kind, `no room named '${room}' ${where}`);
  }
  if (rooms.length > 1) {
    const home = storey ?? model.storeyOf(rooms[0].id);
    const candidates = rooms.map((each) => each.id).filter((id) => model.storeyOf(id)?.id === home?.id);
    return unanswered(
      kind, `${rooms.length} rooms are named '${room}' ${where}; add the room number or the storey`,
      planEvidence(model, [{ storey: home, ids: candidates }], `Rooms named '${room}'${home ? ` on ${home.name}` : ""}`, (id) => roomLabel(model.space(id))),
    );
  }

  const [space] = rooms;
  const area = model.floorArea(space.id);
  if (!area) return unanswered(kind, `room '${roomLabel(space)}' has neither a stored floor area nor geometry in the model`);
  const home = storey ?? model.storeyOf(space.id);
  const value = round(area.value, 2);
  const source = area.stored ? "the NetFloorArea quantity stored on its IfcSpace" : "the plan footprint of its IfcSpace geometry";
  return result(
    kind, value, "m2",
    `net floor area of room '${roomLabel(space)}'${home ? ` on ${home.name}` : ""}, from ${source}`,
    planEvidence(
      model, [{ storey: home, ids: [space.id] }],
      `Room '${roomLabel(space)}'${home ? ` on the plan of ${home.name}` : ""}, ${value.toFixed(2)} m²`,
      () => `${roomLabel(space)} · ${value.toFixed(2)} m²`,
    ),
  );
}

function storeyRoomArea(model: IfcModel, storeyName: string | null, question: string): Answer {
  const kind = "area_storey_rooms";
  const storey = findStorey(model, storeyName, question);
  if (!storey) return noStorey(kind, model, storeyName);

  const rooms = model.elements("space", storey);
  const areas = new Map(rooms.map((id) => [id, model.floorArea(id)]));
  const measured = rooms.filter((id) => areas.get(id));
  if (measured.length === 0) return unanswered(kind, `no rooms (IfcSpace) with an area on ${storey.name}`);

  const total = round(measured.reduce((sum, id) => sum + areas.get(id)!.value, 0), 2);
  const stored = measured.filter((id) => areas.get(id)!.stored).length;
  const source =
    stored === measured.length ? "the NetFloorArea quantity stored on each IfcSpace"
    : stored === 0 ? "the plan footprint of each IfcSpace"
    : `the stored NetFloorArea of ${stored} and the plan footprint of the other ${measured.length - stored}`;
  return result(
    kind, total, "m2",
    `sum of the net floor areas of the ${plural(measured.length, "space")} on ${storey.name}, from ${source}`,
    planEvidence(
      model, [{ storey, ids: measured }],
      `The ${plural(measured.length, "space")} on ${storey.name}, ${total.toFixed(2)} m² together`,
      measured.length <= MAX_LABELLED ? (id) => `${areas.get(id)!.value.toFixed(2)} m²` : undefined,
    ),
    measured.length < rooms.length ? `${rooms.length - measured.length} rooms have neither a stored area nor geometry and are left out.` : undefined,
  );
}

function count(model: IfcModel, intent: Extract<IfcIntent, { kind: "count" }>, question: string): Answer {
  const { element } = intent;
  const ifcClass = NOUNS[element][2];
  const storey = intent.scope === "model" ? undefined : findStorey(model, intent.name) ?? findStorey(model, null, question);
  if (!storey && intent.scope === "storey") return noStorey(`count_${element}_storey`, model, intent.name);

  if (storey) {
    const ids = model.elements(element, storey);
    const label = element === "space" && ids.length <= MAX_LABELLED ? (id: number) => model.space(id).number || model.space(id).name : undefined;
    return result(
      `count_${element}_storey`, ids.length, "count",
      `${ifcClass} elements on storey ${storey.name}`,
      planEvidence(model, [{ storey, ids }], `The ${plural(ids.length, element)} on ${storey.name}`, label),
    );
  }

  const all = model.elements(element);
  const placed = new Set<number>();
  const groups: StoreyGroup[] = model.storeys.map((each) => {
    const ids = model.elements(element, each).filter((id) => !placed.has(id));
    ids.forEach((id) => placed.add(id));
    return { storey: each, ids };
  });
  const outside = all.filter((id) => !placed.has(id));
  if (outside.length > 0) groups.push({ storey: undefined, ids: outside });

  // Storeys with rooms stay in the picture even when they hold none of the elements, so the stack reads complete.
  const drawn = groups.filter(({ storey: each, ids }) => ids.length > 0 || (each && model.elements("space", each).length > 0));
  const breakdown = drawn.map(({ storey: each, ids }) => `${each?.name ?? "outside the storeys"} ${ids.length}`).join(", ");
  return result(
    `count_${element}_model`, all.length, "count",
    `${ifcClass} elements in the whole model${breakdown ? ` (${breakdown})` : ""}`,
    planEvidence(model, drawn, `The ${plural(all.length, element)} of the model; storeys left to right, top to bottom: ${breakdown}`),
  );
}

function storeyTotal(model: IfcModel, intentKind: keyof typeof TOTALS, storeyName: string | null, question: string): Answer {
  const { element, quantity, unit, symbol, kind, what } = TOTALS[intentKind];
  const [, elements, ifcClass] = NOUNS[element];
  const storey = findStorey(model, storeyName, question);
  if (!storey) return noStorey(kind, model, storeyName);

  const ids = model.elements(element, storey);
  if (ids.length === 0) return unanswered(kind, `no ${elements} (${ifcClass}) on ${storey.name}`);
  const values = new Map(ids.map((id) => [id, model.quantity(id, quantity)]));
  let source = `the ${quantity} quantity stored on each ${ifcClass}`;
  const notes: string[] = [];
  const geometry = FROM_GEOMETRY[quantity];
  if (geometry && ids.every((id) => values.get(id) === null)) {
    for (const id of ids) {
      const shape = model.shape(id);
      values.set(id, shape ? geometry.measure(shape) : null);
    }
    source = geometry.source;
    if (geometry.note) notes.push(geometry.note);
  }
  const measured = ids.filter((id) => values.get(id) !== null);
  if (measured.length === 0) {
    return unanswered(kind, `the ${elements} on ${storey.name} carry no stored ${quantity} quantity, and ${what} is not derived from geometry`);
  }
  if (measured.length < ids.length) notes.push(`${ids.length - measured.length} ${elements} have no ${quantity} and are left out.`);

  const total = round(measured.reduce((sum, id) => sum + values.get(id)!, 0), 3);
  const labelled = measured.length <= MAX_LABELLED;
  return result(
    kind, total, unit,
    `sum of the ${what} of the ${plural(measured.length, element)} on ${storey.name}, from ${source}`,
    planEvidence(
      model, [{ storey, ids: measured }],
      `The ${plural(measured.length, element)} on ${storey.name}${labelled ? ` with the ${what} of each` : ""}, ${total} ${symbol} together`,
      labelled ? (id) => `${values.get(id)!.toFixed(2)} ${symbol}` : undefined,
    ),
    notes.join(" ") || undefined,
  );
}
