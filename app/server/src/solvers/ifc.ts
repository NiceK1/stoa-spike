/**
 * Quantity take-off from an IFC model: room areas, element counts, wall and slab totals per storey.
 * Values come from the model's stored base quantities where the exporter wrote them, otherwise from geometry.
 */
import { basename } from "node:path";
import type { IfcCall, IfcMenu } from "../planner.js";
import type { Answer, Evidence, QuestionType } from "../types.js";
import { planEvidence, type StoreyGroup } from "./ifc/drawing.js";
import { answerText, roomsOf, type Room } from "./ifc/facts.js";
import { longSide } from "./ifc/footprint.js";
import { NOUNS, loadModel, roomLabel, type ElementShape, type IfcModel, type Space, type Storey } from "./ifc/model.js";
import { mentions, parseIfcQuestion, type ElementKind, type IfcIntent } from "./ifc/question.js";

const PIPELINE = "ifc-geometry";

const previews = new Map<string, Promise<Evidence | null>>();
/** Lower-case letters and digits only, so "4.korrus" matches "4-korrus" and "Kælder" matches "klder" in a file name. */
const plain = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, "");

/**
 * Plan of the model before any question: every storey in a grid, or only `level` when given, as in a
 * `<model>_plan-<nn>-<storey>` sheet name. Null when the model has no plan geometry to draw.
 */
export function previewIfc(ifcPath: string, level?: string): Promise<Evidence | null> {
  const key = `${ifcPath}\n${level ?? ""}`;
  let running = previews.get(key);
  if (!running) {
    running = (async () => {
      const model = await loadModel(ifcPath);
      const wanted = level ? plain(level.replace(/^\d+-/, "")) : "";
      const storey = wanted ? model.storeys.find((each) => plain(each.name) === wanted) : undefined;
      const storeys = storey ? [storey] : model.storeys;
      const caption = storey ? `Storey ${storey.name}, from the building model` : "Every storey with a plan, from the building model";
      return planEvidence(model, storeys.map((each) => ({ storey: each, ids: [] })), caption) ?? null;
    })();
    previews.set(key, running);
    running.catch(() => previews.delete(key));
  }
  return running;
}

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

/**
 * Rooms matching a label such as 'KORIDOR (119)', '119' or 'KORIDOR': exact spelling first, then ignoring case and
 * spacing, then the name with a number that is one word of the room's number ('Kontor (214)' for 'Kontor (Rum nr. 214)').
 */
function findRooms(model: IfcModel, storey: Storey | undefined, label: string): Space[] {
  const spaces = model.elements("space", storey).map((id) => model.space(id));
  const [, name, number] = /^(.+?)\s*\(([^()]+)\)$/.exec(loose(label)) ?? [];
  const tiers: ((space: Space) => boolean)[] = [
    (space) => roomLabel(space) === label,
    (space) => space.number === label || space.name === label,
    (space) => loose(roomLabel(space)) === loose(label),
    (space) => loose(space.number) === loose(label) || loose(space.name) === loose(label),
    (space) => name !== undefined && loose(space.name) === name && loose(space.number).split(/[^\p{L}\p{N}.-]+/u).includes(number),
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

/** The elements of a kind on one storey, or in the whole model storey by storey, with those outside every storey last. */
function located(model: IfcModel, element: ElementKind, storey: Storey | undefined): { all: number[]; groups: StoreyGroup[] } {
  if (storey) {
    const ids = model.elements(element, storey);
    return { all: ids, groups: [{ storey, ids }] };
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
  return { all, groups };
}

function count(model: IfcModel, intent: Extract<IfcIntent, { kind: "count" }>, question: string): Answer {
  const { element } = intent;
  const ifcClass = NOUNS[element][2];
  const storey = intent.scope === "model" ? undefined : findStorey(model, intent.name) ?? findStorey(model, null, question);
  if (!storey && intent.scope === "storey") return noStorey(`count_${element}_storey`, model, intent.name);

  const { all, groups } = located(model, element, storey);
  if (storey) {
    const label = element === "space" && all.length <= MAX_LABELLED ? (id: number) => model.space(id).number || model.space(id).name : undefined;
    return result(
      `count_${element}_storey`, all.length, "count",
      `${ifcClass} elements on storey ${storey.name}`,
      planEvidence(model, groups, `The ${plural(all.length, element)} on ${storey.name}`, label),
    );
  }

  // Storeys with rooms stay in the picture even when they hold none of the elements, so the stack reads complete.
  const drawn = groups.filter(({ storey: each, ids }) => ids.length > 0 || (each && model.elements("space", each).length > 0));
  const breakdown = drawn.map(({ storey: each, ids }) => `${each?.name ?? "outside the storeys"} ${ids.length}`).join(", ");
  return result(
    `count_${element}_model`, all.length, "count",
    `${ifcClass} elements in the whole model${breakdown ? ` (${breakdown})` : ""}`,
    planEvidence(model, drawn, `The ${plural(all.length, element)} of the model; storeys left to right, top to bottom: ${breakdown}`),
  );
}

/** Several element classes in one answer: each counted as on its own, the total with what it consists of, all marked. */
function countSeveral(model: IfcModel, elements: ElementKind[], storeyName: string | null): Answer {
  const kind = `count_${elements.join("+")}_${storeyName === null ? "model" : "storey"}`;
  const storey = storeyName === null ? undefined : findStorey(model, storeyName);
  if (storeyName !== null && !storey) return noStorey(kind, model, storeyName);

  const parts = elements.map((element) => ({ element, ...located(model, element, storey) }));
  const total = parts.reduce((sum, part) => sum + part.all.length, 0);
  const kindOf = new Map(parts.flatMap((part) => part.all.map((id) => [id, NOUNS[part.element][0]] as const)));
  const homes = [...new Set(parts.flatMap((part) => part.groups.map((group) => group.storey)))];
  const groups = homes
    .map((home) => ({ storey: home, ids: parts.flatMap((part) => part.groups.find((group) => group.storey === home)?.ids ?? []) }))
    .filter((group) => group.ids.length > 0);
  const where = storey ? `on storey ${storey.name}` : "in the whole model";
  return result(
    kind, total, "count",
    `${parts.map((part) => NOUNS[part.element][2]).join(" and ")} elements ${where}`,
    planEvidence(model, groups, `The ${parts.map((part) => plural(part.all.length, part.element)).join(" and ")} ${where}`, total <= MAX_LABELLED ? (id) => kindOf.get(id) ?? "" : undefined),
    `The total of ${total} consists of ${parts.map((part) => plural(part.all.length, part.element)).join(" and ")}.`,
  );
}

/** A selection of rooms, counted, added up, averaged, listed, or narrowed to its largest or smallest room. */
function selectRooms(model: IfcModel, call: Extract<IfcCall, { operation: "rooms" }>, type: QuestionType, question: string): Answer {
  const { rooms: names, pick, measure } = call;
  const storey = call.storey === null ? undefined : findStorey(model, call.storey);
  if (call.storey !== null && !storey) return noStorey("rooms", model, call.storey);
  const where = storey ? `on ${storey.name}` : "in the model";

  // The dataset's own operations, so that a reworded dataset question is computed exactly like the original.
  if (pick === "all" && measure === "area" && names.length === 1 && findRooms(model, storey, names[0]).length <= 1) {
    return roomArea(model, names[0], call.storey) ?? unanswered("area_room", `no room named '${names[0]}' ${where}`);
  }
  if (pick === "all" && measure === "area" && names.length === 0 && storey) return storeyRoomArea(model, call.storey, question);
  if (pick === "all" && measure === "count" && names.length === 0) {
    return count(model, { kind: "count", element: "space", scope: storey ? "storey" : "model", name: call.storey }, question);
  }

  const scope = (storey ? [storey] : model.storeys).flatMap((each) => roomsOf(model, each));
  const byId = new Map(scope.map((room) => [room.id, room]));
  let selected = scope;
  if (names.length > 0) {
    const found = names.map((name) => ({ name, ids: findRooms(model, storey, name).map((space) => space.id) }));
    const absent = found.filter((each) => each.ids.length === 0).map((each) => `'${each.name}'`);
    if (absent.length > 0) return unanswered("rooms", `the model has no room named ${absent.join(", ")} ${where}`);
    selected = [...new Set(found.flatMap((each) => each.ids))].flatMap((id) => byId.get(id) ?? []);
  }
  const which = names.length > 0 ? `rooms named ${names.map((name) => `'${name}'`).join(", ")}` : "rooms";
  const drawn = (rooms: Room[], caption: string, label?: (room: Room) => string) =>
    planEvidence(
      model, model.storeys.map((each) => ({ storey: each, ids: rooms.filter((room) => room.storey.id === each.id).map((room) => room.id) })).filter((group) => group.ids.length > 0),
      caption, label && rooms.length <= MAX_LABELLED ? (id) => label(byId.get(id)!) : undefined,
    );
  const text = (kind: string, value: string, method: string, evidence?: Evidence): Answer => ({ value, pipeline: PIPELINE, exact: true, kind, method, evidence });
  const withArea = (room: Room) => `${room.label} · ${room.area.toFixed(2)} m²`;

  if (pick !== "all") {
    const measured = selected.filter((room) => room.area > 0);
    if (measured.length === 0) return unanswered("rooms", `none of the ${which} ${where} has an area in the model`);
    const extreme = measured.reduce((best, room) => ((pick === "largest" ? room.area > best.area : room.area < best.area) ? room : best)).area;
    // Rooms that print the same area tie; naming one of them would be arbitrary.
    const chosen = measured.filter((room) => room.area.toFixed(2) === extreme.toFixed(2));
    const named = chosen.map((room) => `'${room.label}' on ${room.storey.name}`).join(", ");
    const method = `comparison of the net floor areas of the ${measured.length} ${which} ${where}`;
    const evidence = drawn(chosen, `The ${pick} of the ${which} ${where}: ${named}`, withArea);
    if (type === "area") {
      return result(`area_${pick}_room`, round(extreme, 2), "m2", `${method}; the ${pick} is ${named}`, evidence, chosen.length > 1 ? `${chosen.length} rooms tie at ${extreme.toFixed(2)} m².` : undefined);
    }
    return text(`${pick}_room`, chosen.length > 1 ? `${named}: ${extreme.toFixed(2)} m² each (a tie)` : `${named}, ${extreme.toFixed(2)} m²`, method, evidence);
  }

  if (measure === "count") {
    return result("count_rooms_selected", selected.length, "count", `IfcSpace ${which} ${where}`, drawn(selected, `The ${selected.length} ${which} ${where}`, (room) => room.tag));
  }
  if (measure === "list") {
    const shown = selected.slice(0, 60).map((room) => `${room.label}${room.area > 0 ? `, ${room.area.toFixed(2)} m²` : ""}${storey ? "" : ` (${room.storey.name})`}`);
    if (selected.length > shown.length) shown.push(`and ${selected.length - shown.length} more`);
    return text("list_rooms", shown.join("\n") || "none", `IfcSpace ${which} ${where}, largest first`, drawn(selected, `The ${selected.length} ${which} ${where}`, (room) => room.tag));
  }

  const measured = selected.filter((room) => room.area > 0);
  if (measured.length === 0) return unanswered("rooms", `none of the ${which} ${where} has an area in the model`);
  const sum = measured.reduce((total, room) => total + room.area, 0);
  const notes = [
    measure === "area" && measured.length > 1 && measured.length <= 12 ? `The total consists of ${measured.map((room) => `${room.label} ${room.area.toFixed(2)} m²`).join(", ")}.` : "",
    measured.length < selected.length ? `${selected.length - measured.length} rooms have neither a stored area nor geometry and are left out.` : "",
  ].filter(Boolean).join(" ");
  const value = round(measure === "average" ? sum / measured.length : sum, 2);
  return result(
    measure === "average" ? "area_rooms_average" : "area_rooms_selected", value, "m2",
    `${measure === "average" ? "mean" : "sum"} of the net floor areas of the ${measured.length} ${which} ${where} (stored NetFloorArea, or the plan footprint)`,
    drawn(measured, `The ${measured.length} ${which} ${where}, ${value.toFixed(2)} m² ${measure === "average" ? "on average" : "together"}`, withArea),
    notes || undefined,
  );
}

/** What the model can be asked about, in its own words, for the interpreter. */
export async function ifcMenu(ifcPath: string): Promise<IfcMenu> {
  const model = await loadModel(ifcPath);
  const rooms = model.elements("space").map((id) => model.space(id));
  const names = new Map<string, number>();
  for (const room of rooms) {
    const name = room.name || room.number;
    if (name) names.set(name, (names.get(name) ?? 0) + 1);
  }
  return {
    model: [...new Set([model.projectName, model.buildingName, basename(ifcPath, ".ifc")].filter(Boolean))].join(" / "),
    storeys: model.storeys.filter((storey) => storey.name).map((storey) => ({ name: storey.name, elevation: storey.elevation, rooms: model.elements("space", storey).length })),
    elements: (Object.keys(NOUNS) as ElementKind[])
      .map((kind): [ElementKind, string, number] => [kind, NOUNS[kind][1], model.elements(kind).length])
      .filter(([, , n]) => n > 0),
    roomNames: [...names].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])),
    roomNumbers: rooms.filter((room) => room.name && room.number).slice(0, 4).map((room) => room.number),
  };
}

/**
 * Runs a call the interpreter chose. `type` decides between a figure and a name where a call allows both.
 * Null for a call this solver does not compute: a question about the model's facts, or one the model cannot answer.
 */
export async function solveIfcCall(ifcPath: string, call: IfcCall, type: QuestionType, question: string): Promise<Answer | null> {
  if (call.operation === "model_facts" || call.operation === "none") return null;
  const model = await loadModel(ifcPath);
  switch (call.operation) {
    case "count_elements": {
      const scope = call.storey === null ? "model" : "storey";
      return call.elements.length === 1 ? count(model, { kind: "count", element: call.elements[0], scope, name: call.storey }, question) : countSeveral(model, call.elements, call.storey);
    }
    case "rooms": return selectRooms(model, call, type, question);
    case "storey_total": return storeyTotal(model, call.quantity, call.storey, question);
  }
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
