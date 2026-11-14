/** Free-text questions about an IFC model, answered in plain text from what the model itself states. */
import type { Answer, Evidence } from "../../types.js";
import { planEvidence } from "./drawing.js";
import { NOUNS, roomLabel, type IfcModel, type Storey } from "./model.js";
import { mentions, type ElementKind, type LevelRef, type TextAsk } from "./question.js";

const MAX_LABELLED = 40;
const m2 = (value: number) => `${value.toFixed(1)} m²`;
const share = (part: number, whole: number) => `${((100 * part) / whole).toFixed(1)}%`;
const capital = (word: string) => word[0].toUpperCase() + word.slice(1);

function reply(topic: string, lines: string[], method: string, evidence?: Evidence): Answer {
  return { value: lines.join("\n"), pipeline: "ifc-geometry", exact: true, kind: `text_${topic}`, method, evidence };
}

export function answerText(model: IfcModel, ask: TextAsk, question: string): Answer {
  switch (ask.topic) {
    case "software": return software(model);
    case "overview": return overview(model);
    case "levels": return levels(model);
    case "floor_area": return floorArea(model);
    case "largest_room": return largestRoom(model, ask.smallest);
    case "spaces": return spaces(model, ask.level, ask.listed, question);
    case "structure": return structure(model);
    case "wall_lengths": return wallLengths(model);
    case "element_types": return elementTypes(model, ask.element, ask.side);
    case "element_widths": return elementWidths(model, ask.element);
    case "element_volume": return elementVolume(model, ask.element);
    case "element_property": return elementProperty(model, ask.element, ask.property);
  }
}

function software(model: IfcModel): Answer {
  const { application, exporter, view, written } = model.provenance();
  const lines = [`IFC schema: ${model.schema}`];
  if (application) lines.push(`Authoring application: ${application}`);
  if (exporter) lines.push(`Exported by: ${exporter}`);
  if (view) lines.push(`Model view: ${view}`);
  if (written) lines.push(`File written: ${written}`);
  return reply("software", lines, "the IFC file header and its IfcApplication record");
}

export interface Room {
  id: number;
  label: string;
  /** The room number, short enough to sit on a plan next to many others. */
  tag: string;
  area: number;
  storey: Storey;
}

/** The rooms of a storey with their areas, largest first; a room without an area has area 0. */
export function roomsOf(model: IfcModel, storey: Storey): Room[] {
  return model
    .elements("space", storey)
    .map((id) => {
      const space = model.space(id);
      return { id, label: roomLabel(space), tag: space.number || space.name, area: model.floorArea(id)?.value ?? 0, storey };
    })
    .sort((a, b) => b.area - a.area);
}

const totalArea = (rooms: Room[]) => rooms.reduce((sum, room) => sum + room.area, 0);
const AREA_SOURCE = "the net floor area of each IfcSpace (stored NetFloorArea, or the plan footprint of its geometry)";

function overview(model: IfcModel): Answer {
  const rooms = model.storeys.flatMap((storey) => roomsOf(model, storey));
  const lines = [
    `Project: ${model.projectName || "unnamed"}`,
    `Building: ${model.buildingName || "unnamed"}`,
    ...(model.siteName ? [`Site: ${model.siteName}`] : []),
    `Levels: ${model.storeys.length} (${model.storeys.map((storey) => storey.name).join(", ")})`,
    `Rooms (IfcSpace): ${rooms.length}`,
    ...(rooms.length > 0 ? [`Net floor area of the rooms: ${m2(totalArea(rooms))}`] : []),
  ];
  const kinds: ElementKind[] = ["wall", "door", "window", "slab", "column", "beam", "stair"];
  const counts = kinds.map((kind) => [kind, model.elements(kind).length] as const).filter(([, n]) => n > 0);
  if (counts.length > 0) lines.push(`Elements: ${counts.map(([kind, n]) => `${n} ${NOUNS[kind][n === 1 ? 0 : 1]}`).join(", ")}`);
  lines.push("The model does not state the building's use; the names above are what it records.");
  return reply("overview", lines, `IfcProject, IfcBuilding, IfcSite and IfcBuildingStorey records, element counts, and ${AREA_SOURCE}`);
}

function levels(model: IfcModel): Answer {
  const lines = [`Building levels: ${model.storeys.length}`];
  model.storeys.forEach((storey, i) => {
    const next = model.storeys[i + 1];
    const height = next ? `, ${(next.elevation - storey.elevation).toFixed(2)} m up to ${next.name}` : "";
    lines.push(`- ${storey.name}: elevation ${storey.elevation.toFixed(2)} m${height}`);
  });
  return reply("levels", lines, "the Elevation of each IfcBuildingStorey; heights are the differences between consecutive levels");
}

function floorArea(model: IfcModel): Answer {
  const perLevel = model.storeys.map((storey) => ({ storey, rooms: roomsOf(model, storey) })).filter(({ rooms }) => rooms.length > 0);
  const total = perLevel.reduce((sum, { rooms }) => sum + totalArea(rooms), 0);
  if (total === 0) return reply("floor_area", ["The model has no rooms (IfcSpace) to take a floor area from."], "IfcSpace records");
  const lines = [`Total net floor area: ${m2(total)}`, "", "Net floor area by level:"];
  for (const { storey, rooms } of perLevel) lines.push(`- ${storey.name}: ${m2(totalArea(rooms))} (${share(totalArea(rooms), total)})`);
  lines.push("", "This is the sum of the room areas; the model holds no separate gross floor area.");
  return reply("floor_area", lines, `the sum over the rooms of each level of ${AREA_SOURCE}`);
}

function largestRoom(model: IfcModel, smallest: boolean): Answer {
  const rooms = model.storeys.flatMap((storey) => roomsOf(model, storey)).filter((room) => room.area > 0);
  if (rooms.length === 0) return reply("largest_room", ["The model has no rooms (IfcSpace) with an area."], "IfcSpace records");
  const room = rooms.reduce((best, each) => ((smallest ? each.area < best.area : each.area > best.area) ? each : best));
  return reply(
    "largest_room",
    [`${smallest ? "Smallest" : "Largest"} room: ${room.label}`, `Area: ${m2(room.area)}`, `Level: ${room.storey.name}`],
    `comparison of ${AREA_SOURCE} over the ${rooms.length} rooms of the model`,
    planEvidence(model, [{ storey: room.storey, ids: [room.id] }], `Room '${room.label}' on the plan of ${room.storey.name}`, () => `${room.label} · ${m2(room.area)}`),
  );
}

/** The storey a question means: one it names, else one it places ('basement', 'second floor', 'level 3'). */
function levelOf(model: IfcModel, ref: LevelRef | null, question: string): Storey | undefined {
  const named = model.storeys.filter((storey) => mentions(question, storey.name)).sort((a, b) => b.name.length - a.name.length)[0];
  if (named || !ref) return named;
  const occupied = model.storeys.filter((storey) => model.elements("space", storey).length > 0);
  if (ref === "top") return occupied.at(-1);
  const ground = model.storeys.reduce((best, storey) => (Math.abs(storey.elevation) < Math.abs(best.elevation) ? storey : best), model.storeys[0]);
  return model.storeys[model.storeys.indexOf(ground) + ref.above];
}

function spaces(model: IfcModel, ref: LevelRef | null, listed: boolean, question: string): Answer {
  const storey = levelOf(model, ref, question);
  if (ref && !storey) {
    return reply("spaces", [`The model has no such level. Its levels are: ${model.storeys.map((each) => each.name).join(", ")}.`], "IfcBuildingStorey records");
  }
  const perLevel = (storey ? [storey] : model.storeys).map((each) => ({ storey: each, rooms: roomsOf(model, each) })).filter(({ rooms }) => rooms.length > 0);
  const all = perLevel.flatMap(({ rooms }) => rooms);
  if (all.length === 0) {
    return reply("spaces", [`No rooms (IfcSpace) ${storey ? `on ${storey.name}` : "in the model"}.`], "IfcSpace records");
  }

  const lines: string[] = [];
  if (!storey) lines.push(`Total: ${all.length} spaces on ${perLevel.length} levels, ${m2(totalArea(all))}`, "");
  for (const { storey: each, rooms } of perLevel) {
    lines.push(`${each.name}: ${rooms.length} spaces, ${m2(totalArea(rooms))}${storey ? "" : ` (${share(totalArea(rooms), totalArea(all))})`}`);
    if (listed || storey) lines.push(...rooms.map((room) => `- ${room.label}: ${m2(room.area)}`), "");
  }
  while (lines.at(-1) === "") lines.pop();
  const byId = new Map(all.map((room) => [room.id, room]));
  return reply(
    "spaces", lines,
    `the IfcSpace rooms of ${storey ? storey.name : "every level"} with ${AREA_SOURCE}`,
    planEvidence(
      model, perLevel.map(({ storey: each, rooms }) => ({ storey: each, ids: rooms.map((room) => room.id) })),
      storey ? `The ${all.length} rooms on ${storey.name}` : `The ${all.length} rooms of the model; levels left to right, top to bottom: ${perLevel.map(({ storey: each }) => each.name).join(", ")}`,
      all.length <= MAX_LABELLED ? (id) => byId.get(id)!.tag : undefined,
    ),
  );
}

function structure(model: IfcModel): Answer {
  const kinds: ElementKind[] = ["beam", "column", "slab", "wall", "footing", "roof", "stair"];
  const lines = ["Structural elements in the model:", ...kinds.map((kind) => `- ${capital(NOUNS[kind][1])} (${NOUNS[kind][2]}): ${model.elements(kind).length}`)];
  const walls = model.elements("wall");
  const bearing = walls.filter((id) => model.property(id, "LoadBearing") === true).length;
  if (walls.some((id) => model.property(id, "LoadBearing") !== null)) lines.push(`Walls marked load-bearing: ${bearing} of ${walls.length}`);
  return reply("structure", lines, "counts of the IFC element classes, and the LoadBearing property of the walls");
}

/** Elements of a kind grouped by the name of their type, most common first. */
function byType(model: IfcModel, ids: number[]): [string, number[]][] {
  const groups = new Map<string, number[]>();
  for (const id of ids) {
    const type = model.typeName(id) || "no type name";
    if (!groups.has(type)) groups.set(type, []);
    groups.get(type)!.push(id);
  }
  return [...groups].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
}

function modelEvidence(model: IfcModel, ids: number[], caption: string, label?: (id: number) => string): Evidence | undefined {
  const groups = model.storeys.map((storey) => ({ storey, ids: ids.filter((id) => model.storeyOf(id)?.id === storey.id) })).filter((group) => group.ids.length > 0);
  if (groups.length === 0) return undefined;
  const order = groups.map((group) => `${group.storey.name} ${group.ids.length}`).join(", ");
  return planEvidence(model, groups, `${caption}; levels left to right, top to bottom: ${order}`, label);
}

function elementTypes(model: IfcModel, element: ElementKind, side: "exterior" | "interior" | null): Answer {
  const [, plural, ifcClass] = NOUNS[element];
  let ids = model.elements(element);
  let what = plural;
  if (side && ids.length > 0) {
    if (!ids.some((id) => model.property(id, "IsExternal") !== null)) {
      return reply(`${element}_types`, [`The model does not mark its ${plural} as exterior or interior (no IsExternal property).`, `Total ${plural}: ${ids.length}`], `the IsExternal property of the ${ifcClass} elements`);
    }
    ids = ids.filter((id) => model.property(id, "IsExternal") === (side === "exterior"));
    what = `${side} ${plural}`;
  }
  if (ids.length === 0) return reply(`${element}_types`, [`No ${what} (${ifcClass}) found in this model.`], `a search for ${ifcClass} elements`);

  const lines = [`Total ${what}: ${ids.length}`, "", `${capital(NOUNS[element][0])} types and quantities:`];
  for (const [type, members] of byType(model, ids)) lines.push(`- ${type}: ${members.length} (${share(members.length, ids.length)})`);
  return reply(
    `${element}_types`, lines,
    `${ifcClass} elements grouped by the name of their type object${side ? ", filtered by their IsExternal property" : ""}`,
    modelEvidence(model, ids, `The ${ids.length} ${what} of the model`),
  );
}

function elementWidths(model: IfcModel, element: ElementKind): Answer {
  const [singular, plural, ifcClass] = NOUNS[element];
  const widths = model
    .elements(element)
    .map((id) => ({ id, width: model.overallWidth(id) }))
    .filter((each): each is { id: number; width: number } => each.width !== null && each.width > 0)
    .sort((a, b) => b.width - a.width);
  if (widths.length === 0) return reply(`${element}_widths`, [`The model gives no widths for its ${plural} (no OverallWidth on ${ifcClass}).`], `the OverallWidth attribute of ${ifcClass}`);
  const describe = ({ id, width }: { id: number; width: number }) => `${width.toFixed(2)} m - ${[model.name(id), model.typeName(id)].filter(Boolean).join(", ")}`;
  const mean = widths.reduce((sum, each) => sum + each.width, 0) / widths.length;
  const lines = [
    `Widest ${singular}: ${describe(widths[0])}`,
    ...(widths.length > 1 ? [`Second widest: ${describe(widths[1])}`] : []),
    `Narrowest ${singular}: ${describe(widths.at(-1)!)}`,
    `Average width: ${mean.toFixed(2)} m over ${widths.length} ${plural}`,
  ];
  // Marks are numbered in storey order, so each one says which it is.
  const widest = widths[0];
  const narrowest = widths.at(-1)!;
  const evidence =
    widest.id === narrowest.id
      ? modelEvidence(model, [widest.id], `The only ${singular} with a width`)
      : modelEvidence(model, [widest.id, narrowest.id], `The widest and the narrowest ${singular}`, (id) => (id === widest.id ? "widest" : "narrowest"));
  return reply(`${element}_widths`, lines, `the OverallWidth attribute of the ${widths.length} ${ifcClass} elements`, evidence);
}

function elementVolume(model: IfcModel, element: ElementKind): Answer {
  const [, plural, ifcClass] = NOUNS[element];
  const ids = model.elements(element);
  if (ids.length === 0) return reply(`${element}_volume`, [`No ${plural} (${ifcClass}) found in this model.`], `a search for ${ifcClass} elements`);
  const stored = ids.some((id) => model.quantity(id, "NetVolume") !== null);
  const volume = (id: number) => (stored ? model.quantity(id, "NetVolume") : model.shape(id)?.volume) ?? 0;
  const total = ids.reduce((sum, id) => sum + volume(id), 0);
  const lines = [`Total ${plural}: ${ids.length}`, `Total volume: ${total.toFixed(2)} m³`, "", "By type:"];
  for (const [type, members] of byType(model, ids)) lines.push(`- ${type}: ${members.length} ${plural}, ${members.reduce((sum, id) => sum + volume(id), 0).toFixed(2)} m³`);
  return reply(`${element}_volume`, lines, stored ? `the NetVolume quantity stored on each ${ifcClass}, grouped by type name` : `the volume of each ${ifcClass} body, grouped by type name`);
}

function elementProperty(model: IfcModel, element: ElementKind, property: "LoadBearing" | "FireRating"): Answer {
  const [, plural, ifcClass] = NOUNS[element];
  const ids = model.elements(element);
  const values = ids.map((id) => model.property(id, property));
  const topic = `${element}_${property.toLowerCase()}`;
  const method = `the ${property} property of the ${ids.length} ${ifcClass} elements`;
  if (values.every((value) => value === null || value === "")) {
    return reply(topic, [`${property === "LoadBearing" ? "Load-bearing classification" : "Fire rating information"} is not available for the ${plural} in this model.`], method);
  }
  if (property === "LoadBearing") {
    const bearing = values.filter((value) => value === true).length;
    const not = values.filter((value) => value === false).length;
    return reply(topic, [`Load-bearing ${plural}: ${bearing} (${share(bearing, ids.length)})`, `Non-load-bearing ${plural}: ${not} (${share(not, ids.length)})`, ...(bearing + not < ids.length ? [`Not classified: ${ids.length - bearing - not}`] : [])], method);
  }
  const ratings = new Map<string, number>();
  for (const value of values) if (value !== null && value !== "") ratings.set(String(value), (ratings.get(String(value)) ?? 0) + 1);
  return reply(topic, [`${capital(plural)} with a fire rating: ${[...ratings.values()].reduce((a, b) => a + b, 0)} of ${ids.length}`, ...[...ratings].sort((a, b) => b[1] - a[1]).map(([rating, n]) => `- ${rating}: ${n}`)], method);
}

function wallLengths(model: IfcModel): Answer {
  const walls = model.elements("wall");
  const measured = walls.map((id) => ({ id, length: model.quantity(id, "Length") })).filter((each): each is { id: number; length: number } => each.length !== null);
  if (measured.length === 0) {
    return reply("wall_lengths", [walls.length === 0 ? "No walls (IfcWall) found in this model." : `The ${walls.length} walls of the model carry no stored Length quantity.`], "the Length base quantity of the IfcWall elements");
  }
  const sum = (side: boolean | null) => measured.filter(({ id }) => model.property(id, "IsExternal") === side).reduce((total, each) => total + each.length, 0);
  const lines = [`Total wall length: ${measured.reduce((total, each) => total + each.length, 0).toFixed(1)} m over ${measured.length} walls`];
  if (measured.some(({ id }) => model.property(id, "IsExternal") !== null)) {
    lines.push(`- Exterior walls: ${sum(true).toFixed(1)} m`, `- Interior walls: ${sum(false).toFixed(1)} m`);
    if (sum(null) > 0) lines.push(`- Not classified: ${sum(null).toFixed(1)} m`);
  }
  return reply("wall_lengths", lines, "the Length base quantity stored on each IfcWall, split by its IsExternal property");
}
