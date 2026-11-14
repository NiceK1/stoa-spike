/**
 * The interpreter: a language model reads every question. It gets the question, the keyword parser's reading as a
 * hint, and a menu of what this drawing supports, and returns one structured call: the operation, its classes and
 * parameters, whether the user asked to be shown things, and the answer type. Code then computes the answer and the
 * marks. The model is asked through the text side of VisionModel with a JSON schema, so any model can take its place.
 */
import type { VisionModel } from "./models/vision.js";
import { SYMBOL_KINDS, isIndoor, type Plan, type Room, type SymbolKind } from "./solvers/dxf.js";
import type { ElementKind } from "./solvers/ifc/question.js";
import type { Polygon, QuestionType } from "./types.js";

/** The interpreter's output names no call the program can run; the keyword parsers then read the question. */
export class UnusableCall extends Error {}

const HINT_RULE =
  "The request may give the reading of a keyword parser. That parser matches single keywords and ignores every qualifier " +
  "(an apartment, a room, a storey, 'largest', a second kind of item, a condition). Keep its reading when it covers the whole question; otherwise correct it.";
const LOCATE_RULE =
  "locate is true only for a request to be shown things or told where they are (show, mark, find, highlight, locate, where is). " +
  "Such a request is the count of those things with locate true. A question that asks how many or how much has locate false.";
const WORDING_RULE = "The question may be in any language, casual, terse or misspelt; choose the reading a person on site would mean.";

function request(question: string, hint: string | null, menu: string): string {
  return [`Question: ${question}`, ...(hint ? [`A keyword parser reads this as: ${hint}.`] : []), "", menu].join("\n");
}

const list = (value: unknown): string[] => (Array.isArray(value) ? value.map((each) => String(each).trim()).filter(Boolean) : []);
const sentence = (value: unknown): string => String(value ?? "").trim();
const typeOf = (value: unknown, allowed: QuestionType[]): QuestionType => (allowed.includes(value as QuestionType) ? (value as QuestionType) : "text");
const and = (names: string[]) => (names.length <= 1 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`);
const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/** The sentence that answers a request to show something; `subject` is a plural noun phrase. */
export function markedSentence(count: number, subject: string): string {
  return count === 0 ? `${capital(subject)}: none found on this drawing.` : `${capital(subject)}: ${count} marked on the drawing.`;
}

// ---------------------------------------------------------------------------------------------------------------
// Layered DXF plans
// ---------------------------------------------------------------------------------------------------------------

const TAKEOFF_SYSTEM = [
  "You translate a question about one floor plan into a single call of a take-off program.",
  "The program computes the answer from the plan's CAD geometry and marks it on the drawing; you only choose the call and never calculate.",
  "",
  "Operations:",
  "- count_symbols: count and mark drawn symbols. symbols lists the kinds asked for, one or several. labels, room_numbers and",
  "  apartments narrow the count to the symbols in those rooms; leave all three empty for the whole floor.",
  "- count_apartments: count and mark the apartments (residential units, flats) on the floor.",
  "- rooms: select rooms, then count them, add up their areas, average their areas or list them. The selection combines labels",
  "  (rooms carrying one of these labels), room_numbers (these rooms) and apartments (rooms of these apartments); a filter left",
  "  empty does not narrow, so all three empty selects every room. pick narrows the selection to its largest or smallest room.",
  "  measure is count, area (the sum over the selection), average (the mean room area) or list (name the selected rooms, for",
  "  'which room ...' questions).",
  "- area_apartment: the net floor area of each apartment in apartments, without its balconies, loggias and terraces; several",
  "  apartments are added up.",
  "- area_floor: the total net floor area of all numbered indoor rooms on the floor.",
  "- compare: work out measure (count or area) separately for each of several things and report the figures side by side, with",
  "  the largest and the difference. Put the things to compare into one field, two or more of them: apartments, symbols,",
  "  room_numbers or labels. The other fields narrow every side. Use it for 'which is bigger', 'how much more', 'more X or Y'.",
  "- none: the plan data (room outlines, labels, numbers and areas, apartments, door, window and sanitary symbols) cannot answer",
  "  the question. Say in reason, in one sentence, what the plan does not hold.",
  "",
  "Rules:",
  "- The room labels are in the plan's own language. Map the words of the question onto the labels this plan uses, whatever",
  "  the language of the question, and copy them exactly as listed. When several of the plan's labels are the kind of room",
  "  asked for, give them all.",
  "- When the question names a room number, a label or an apartment that the request does not list, do not swap in another:",
  "  put that word into missing, and the program will say that the drawing does not have it.",
  "- broader_label is true only when the plan has no label for exactly what is asked and you used a broader one in its place",
  "  (every habitable room is labelled 'Zimmer' and the question asks for the living room). Otherwise it is false.",
  `- ${LOCATE_RULE}`,
  "- answer_type: count for a number of items, area for square metres, text for names, comparisons and yes/no answers.",
  `- ${WORDING_RULE}`,
  `- ${HINT_RULE}`,
  "- Fields that the operation does not use: empty lists, pick 'all', measure 'count'. reason is '' unless the operation is none.",
].join("\n");

const TAKEOFF_OPERATIONS = ["count_symbols", "count_apartments", "rooms", "area_apartment", "area_floor", "compare", "none"];
// Above these sizes the menu names the most common entries and says how many it left out.
const MENU_LABELS = 60;
const MENU_NUMBERS = 120;

function takeoffSchema(plan: Plan): Record<string, unknown> {
  const { labels, units } = plan.vocabulary();
  // A closed vocabulary keeps a small model from inventing a label; a plan with too many labels to list gets none.
  const oneOf = (values: string[]) => (values.length > 0 ? { type: "string", enum: values } : { type: "string" });
  return {
    type: "object",
    properties: {
      operation: { type: "string", enum: TAKEOFF_OPERATIONS },
      symbols: { type: "array", items: { type: "string", enum: [...SYMBOL_KINDS] } },
      labels: { type: "array", items: oneOf(labels.length <= MENU_LABELS ? labels.map(([name]) => name) : []) },
      room_numbers: { type: "array", items: { type: "string" } },
      apartments: { type: "array", items: oneOf(units) },
      pick: { type: "string", enum: ["all", "largest", "smallest"] },
      measure: { type: "string", enum: ["count", "area", "average", "list"] },
      missing: { type: "array", items: { type: "string" } },
      broader_label: { type: "boolean" },
      reason: { type: "string" },
      locate: { type: "boolean" },
      answer_type: { type: "string", enum: ["count", "area", "text"] },
    },
    required: ["operation", "symbols", "labels", "room_numbers", "apartments", "pick", "measure", "missing", "broader_label", "reason", "locate", "answer_type"],
    additionalProperties: false,
  };
}

/** What the plan holds, in the plan's own words: the vocabulary a question is mapped onto. Bounded, whatever the size of the plan. */
export function takeoffMenu(plan: Plan): string {
  const { labels, numbers, units } = plan.vocabulary();
  const shown = labels.slice(0, MENU_LABELS).map(([name, n]) => `'${name}' x${n}`);
  if (labels.length > MENU_LABELS) shown.push(`and ${labels.length - MENU_LABELS} rarer labels; a label quoted in the question is checked by the program`);
  const listed = numbers.slice(0, MENU_NUMBERS).join(" ");
  return [
    `Room labels on this plan (rooms carrying each): ${shown.join(", ") || "none"}`,
    `Apartments: ${units.map((u) => `${u} (${plan.unitRooms(u).length} rooms)`).join(", ") || "none"}`,
    `Room numbers (${numbers.length}): ${listed || "none"}${numbers.length > MENU_NUMBERS ? ` and ${numbers.length - MENU_NUMBERS} more; a number from the question is checked by the program` : ""}`,
    `Symbols drawn on the floor: ${SYMBOL_KINDS.map((kind) => `${plan.symbols(kind).shapes.length} ${kind}`).join(", ")}`,
  ].join("\n");
}

/** How the interpreter read a question. */
export interface Reading {
  /** The call that was run, in words. */
  understood: string;
  /** The answer type the interpreter stated. */
  type: QuestionType;
  /** The user asked to be shown the items. */
  locate: boolean;
}

export interface PlannedTakeoff extends Reading {
  /** Null when the drawing cannot answer; `note` then says why. */
  value: number | string | null;
  unit?: string;
  /** False when the interpreter took a broader label in place of one the plan does not have. */
  exact: boolean;
  method: string;
  note?: string;
  /** What was counted or measured, as a plural noun phrase. */
  subject?: string;
  highlights: Polygon[];
  cutouts?: Polygon[][];
  labels?: string[];
}

const m2 = (area: number) => area.toFixed(2);
const quoted = (names: string[]) => names.map((n) => `'${n}'`).join(" or ");
const roomName = (r: Room) => [r.number, r.name].filter(Boolean).join(" ");
const shapesOf = (rooms: Room[]) => {
  const drawn = rooms.filter((r) => r.polygon !== null);
  return { highlights: drawn.map((r) => r.polygon as Polygon), cutouts: drawn.map((r) => r.holes), labels: drawn.map(roomName) };
};
const SINGULAR: Record<SymbolKind, string> = { doors: "door", windows: "window", toilets: "toilet", washbasins: "washbasin", bathtubs: "bathtub", showers: "shower" };
const APARTMENT_WORD = /^(?:apartment|flat|unit|wohnung|whg\.?|app\.?|appartement|appartamento)\s*/i;

/** Asks the interpreter for a call on this plan and runs it. Throws UnusableCall when the output names no runnable call. */
export async function planTakeoff(question: string, plan: Plan, planner: VisionModel, hint: string | null = null): Promise<PlannedTakeoff> {
  const { output } = await planner.ask({ system: TAKEOFF_SYSTEM, schema: takeoffSchema(plan), prompt: request(question, hint, takeoffMenu(plan)) });
  const planned = runTakeoff(output, plan);
  const chosen = list(output.labels).filter((label) => !question.toLowerCase().includes(label.toLowerCase()));
  if (planned.value === null || chosen.length === 0) return planned;
  // Geometry is exact, the choice of label is not: the answer says which label the question was matched to, and
  // a label taken for want of an exact one makes it an estimate.
  const matched = output.broader_label === true
    ? `The plan has no label for exactly what was asked; ${planner.id} took the rooms labelled ${quoted(chosen)} as the nearest.`
    : `The question was matched to the plan's label${chosen.length > 1 ? "s" : ""} ${chosen.map((label) => `'${label}'`).join(", ")} by ${planner.id}.`;
  return { ...planned, exact: planned.exact && output.broader_label !== true, note: [planned.note, matched].filter(Boolean).join(" ") };
}

function runTakeoff(call: Record<string, any>, plan: Plan): PlannedTakeoff {
  const vocabulary = plan.vocabulary();
  const reading = { locate: call.locate === true, type: typeOf(call.answer_type, ["count", "area", "text"]) };
  const missing = list(call.missing).map((word) => `'${word}'`);

  const labels: string[] = [];
  for (const asked of list(call.labels)) {
    const known = vocabulary.labels.find(([name]) => name.toLowerCase() === asked.toLowerCase());
    if (known) labels.push(known[0]);
    else missing.push(`a room labelled '${asked}'`);
  }
  const numbers: string[] = [];
  for (const asked of list(call.room_numbers)) {
    const known = vocabulary.numbers.find((number) => number.toLowerCase() === asked.toLowerCase());
    if (known) numbers.push(known);
    else missing.push(`room ${asked}`);
  }
  const apartments: string[] = [];
  for (const asked of list(call.apartments)) {
    const known = vocabulary.units.find((unit) => unit === asked.replace(APARTMENT_WORD, "").toUpperCase());
    if (known) apartments.push(known);
    else missing.push(`apartment ${asked}`);
  }
  const symbols = list(call.symbols).filter((kind): kind is SymbolKind => (SYMBOL_KINDS as readonly string[]).includes(kind));

  const inApartments = apartments.length > 0 ? `in apartment${apartments.length > 1 ? "s" : ""} ${and(apartments)}` : "";
  const scope = [
    labels.length > 0 ? `rooms labelled ${quoted(labels)}` : numbers.length > 0 ? `room${numbers.length > 1 ? "s" : ""} ${and(numbers)}` : "rooms",
    labels.length > 0 && numbers.length > 0 ? `numbered ${and(numbers)}` : "",
    inApartments,
  ].filter(Boolean).join(" ");
  const narrowed = labels.length + numbers.length + apartments.length > 0;
  const select = (filter: { labels?: string[]; numbers?: string[]; units?: string[] } = {}) =>
    plan.select({
      labels: filter.labels ?? (labels.length ? labels : undefined),
      numbers: filter.numbers ?? (numbers.length ? numbers : undefined),
      units: filter.units ?? (apartments.length ? apartments : undefined),
    });

  const unanswered = (understood: string, why: string): PlannedTakeoff => ({ ...reading, value: null, exact: false, understood, method: "nothing was measured", note: why, highlights: [] });
  const exact = (understood: string, result: Omit<PlannedTakeoff, keyof Reading | "exact">): PlannedTakeoff => ({ ...reading, exact: true, understood, ...result });

  const operation = String(call.operation);
  if (operation === "none") {
    return unanswered("a question this drawing's CAD data cannot answer", sentence(call.reason) || "The drawing holds room outlines, labels, numbers and areas, apartments, and door, window and sanitary symbols; the question asks for something else.");
  }
  if (missing.length > 0) {
    const has = [
      vocabulary.labels.length > 0 ? `room labels ${vocabulary.labels.slice(0, 20).map(([name]) => `'${name}'`).join(", ")}` : "",
      vocabulary.numbers.length > 0 ? `rooms numbered ${vocabulary.numbers[0]} to ${vocabulary.numbers.at(-1)}` : "",
      vocabulary.units.length > 0 ? `apartments ${and(vocabulary.units)}` : "no apartments",
    ].filter(Boolean).join("; ");
    return unanswered(`a question about ${and(missing)}`, `This drawing does not have ${and(missing)}. It has ${has}.`);
  }

  if (operation === "count_symbols") {
    if (symbols.length === 0) throw new UnusableCall("count_symbols without a symbol kind");
    const rooms = narrowed ? select() : null;
    const where = !rooms ? "" : labels.length + numbers.length > 0 ? ` in the ${scope}` : ` ${inApartments}`;
    const understood = `count ${and(symbols)}${where}`;
    // The dataset's own operation, so that a reworded dataset question is computed exactly like the original.
    const whole = !rooms && symbols.length === 1 ? plan.answer({ kind: `count_${symbols[0]}` }) : null;
    if (whole) return exact(understood, { ...whole, unit: "count" });
    const parts = symbols.map((kind) => ({ kind, ...plan.symbols(kind), found: rooms ? plan.symbolsIn(kind, rooms) : plan.symbols(kind).shapes }));
    const total = parts.reduce((sum, part) => sum + part.found.length, 0);
    const several = parts.length > 1;
    return exact(understood, {
      value: total, unit: "count", subject: `${and(symbols)}${where}`,
      method: parts.map((part) => part.method).join(", ") + (rooms ? `; those lying in or reaching the outline of one of the ${rooms.length} ${scope}` : ""),
      note: several ? `The total of ${total} consists of ${and(parts.map((part) => `${part.found.length} ${part.kind}`))}.` : undefined,
      highlights: parts.flatMap((part) => part.found),
      labels: several ? parts.flatMap((part) => part.found.map(() => SINGULAR[part.kind])) : undefined,
    });
  }

  if (operation === "count_apartments") return exact("count apartments", { ...plan.answer({ kind: "count_apartments" })!, unit: "count" });

  if (operation === "area_floor") {
    const floor = plan.answer({ kind: "area_all_indoor" });
    return floor ? exact("total area of the numbered indoor rooms", { ...floor, unit: "m2" }) : unanswered("total area of the numbered indoor rooms", "The plan has no numbered indoor room with an area.");
  }

  if (operation === "area_apartment") {
    if (apartments.length === 0) throw new UnusableCall("area_apartment without an apartment");
    const understood = `net area of apartment${apartments.length > 1 ? "s" : ""} ${and(apartments)}`;
    const parts = apartments.map((unit) => ({ unit, result: plan.answer({ kind: "area_apartment", unit }) }));
    const unmeasured = parts.filter((part) => part.result === null).map((part) => part.unit);
    if (unmeasured.length > 0) return unanswered(understood, `Apartment ${and(unmeasured)} has no indoor room with an area on this plan.`);
    if (parts.length === 1) return exact(understood, { ...parts[0].result!, unit: "m2" });
    const total = Math.round(parts.reduce((sum, part) => sum + part.result!.value, 0) * 100) / 100;
    return exact(understood, {
      value: total, unit: "m2", method: `indoor room outlines inside units ${and(apartments)}`,
      note: `The total of ${m2(total)} m² consists of ${and(parts.map((part) => `apartment ${part.unit} ${m2(part.result!.value)} m²`))}.`,
      highlights: parts.flatMap((part) => part.result!.highlights), cutouts: parts.flatMap((part) => part.result!.cutouts ?? part.result!.highlights.map(() => [])),
    });
  }

  if (operation === "compare") {
    type Side = { name: string; value: number; shapes: ReturnType<typeof shapesOf> };
    const areaOf = (rooms: Room[]) => rooms.reduce((sum, r) => sum + (r.area ?? 0), 0);
    const ofRooms = (name: string, rooms: Room[], areas: boolean): Side => ({ name, value: areas ? areaOf(rooms) : rooms.length, shapes: shapesOf(rooms) });
    const ofSymbols = (name: string, kinds: SymbolKind[], rooms: Room[] | null): Side => {
      const found = kinds.flatMap((kind) => (rooms ? plan.symbolsIn(kind, rooms) : plan.symbols(kind).shapes));
      return { name, value: found.length, shapes: { highlights: found, cutouts: found.map(() => []), labels: found.map(() => "") } };
    };
    const wantsArea = call.measure === "area";
    const within = [labels.length > 0 ? `rooms labelled ${quoted(labels)}` : "", numbers.length > 0 ? `room${numbers.length > 1 ? "s" : ""} ${and(numbers)}` : ""].filter(Boolean).join(" numbered ");
    let sides: Side[];
    let areas = false;
    let what: string;
    if (apartments.length >= 2) {
      if (symbols.length > 0) {
        sides = apartments.map((unit) => ofSymbols(`apartment ${unit}`, symbols, select({ units: [unit] })));
        what = `number of ${and(symbols)}${within ? ` in the ${within}` : ""}`;
      } else {
        areas = wantsArea;
        // An apartment's area is its net area, as in area_apartment: outdoor rooms stay out unless rooms were named.
        const net = areas && !within;
        sides = apartments.map((unit) => ofRooms(`apartment ${unit}`, select({ units: [unit] }).filter((r) => !net || isIndoor(r)), areas));
        what = areas ? (within ? `area of the ${within}` : "net area without outdoor rooms") : `number of ${within || "rooms"}`;
      }
      what += ` of apartments ${and(apartments)}`;
    } else if (symbols.length >= 2) {
      sides = symbols.map((kind) => ofSymbols(kind, [kind], narrowed ? select() : null));
      what = `numbers of ${and(symbols)}${narrowed ? ` in the ${scope}` : ""}`;
    } else if (numbers.length >= 2) {
      areas = true;
      sides = numbers.map((number) => ofRooms(`room ${number}`, select({ numbers: [number] }), true));
      what = `areas of rooms ${and(numbers)}`;
    } else if (labels.length >= 2) {
      areas = wantsArea;
      sides = labels.map((label) => ofRooms(`rooms labelled '${label}'`, select({ labels: [label] }), areas));
      what = `${areas ? "total areas" : "numbers"} of the rooms labelled ${and(labels.map((l) => `'${l}'`))}${inApartments ? ` ${inApartments}` : ""}`;
    } else throw new UnusableCall("compare needs two or more apartments, symbols, room numbers or labels");

    const show = (value: number) => (areas ? `${m2(value)} m²` : String(value));
    const ranked = [...sides].sort((a, b) => b.value - a.value);
    const top = ranked.filter((side) => show(side.value) === show(ranked[0].value));
    const verdict =
      top.length === sides.length ? "They are equal."
      : `${areas ? "Largest" : "Most"}: ${and(top.map((side) => side.name))}, ${show(ranked[0].value - ranked.at(-1)!.value)} more than ${ranked.at(-1)!.name}.`;
    return exact(`compare the ${what}`, {
      value: `${sides.map((side) => `${capital(side.name)}: ${show(side.value)}`).join("; ")}. ${verdict}`,
      method: areas ? "room outlines, added up for each side and compared" : "items counted for each side and compared",
      subject: and(sides.map((side) => side.name)),
      highlights: sides.flatMap((side) => side.shapes.highlights), cutouts: sides.flatMap((side) => side.shapes.cutouts),
      labels: sides.some((side) => side.shapes.labels.some(Boolean)) ? sides.flatMap((side) => side.shapes.labels) : undefined,
    });
  }

  if (operation !== "rooms") throw new UnusableCall(`unknown operation '${operation}'`);
  const measure: "count" | "area" | "average" | "list" = ["area", "average", "list"].includes(call.measure) ? call.measure : "count";
  const pick: "all" | "largest" | "smallest" = call.pick === "largest" || call.pick === "smallest" ? call.pick : "all";

  if (pick === "all" && apartments.length === 0 && numbers.length === 0 && labels.length === 1 && (measure === "count" || measure === "area")) {
    const understood = `${measure === "count" ? "count" : "total area of"} ${scope}`;
    const result = plan.answer({ kind: measure === "count" ? "count_rooms_labelled" : "area_rooms_labelled", name: labels[0] });
    return result ? exact(understood, { ...result, unit: measure === "count" ? "count" : "m2", subject: scope }) : unanswered(understood, `A room labelled '${labels[0]}' has no area on this plan.`);
  }

  const rooms = select();
  if (pick !== "all") {
    const understood = `${pick} of the ${scope}`;
    const measured = rooms.filter((r) => r.area !== null);
    if (measured.length === 0) return unanswered(understood, `None of the ${scope} has an area on this plan.`);
    const extreme = measured.reduce((best, r) => ((pick === "largest" ? r.area! > best.area! : r.area! < best.area!) ? r : best)).area as number;
    // Rooms that print the same area tie; naming one of them as the largest would be arbitrary.
    const chosen = measured.filter((r) => m2(r.area as number) === m2(extreme));
    const names = and(chosen.map(roomName));
    const shown = { ...shapesOf(chosen), subject: `the ${understood}` };
    if (reading.type === "area" || (measure === "area" && reading.type !== "text")) {
      return exact(`area of the ${understood}`, {
        value: Math.round(extreme * 100) / 100, unit: "m2", method: `outline of the ${understood}, room ${names}`, ...shown,
        note: chosen.length > 1 ? `${chosen.length} rooms tie at ${m2(extreme)} m²: ${names}.` : undefined,
      });
    }
    return exact(understood, {
      value: chosen.length > 1 ? `${names}: ${m2(extreme)} m² each (a tie)` : `${names}, ${m2(extreme)} m²`,
      method: `outlines of the ${measured.length} ${scope}, compared by area`, ...shown,
    });
  }
  if (measure === "list") {
    return exact(`list the ${scope}`, {
      value: rooms.length ? rooms.map(roomName).join(", ") : "none", method: "room labels, numbers and apartment outlines", subject: scope, ...shapesOf(rooms),
    });
  }
  if (measure === "average") {
    const understood = `average area of the ${scope}`;
    const measured = rooms.filter((r) => r.area !== null);
    if (measured.length === 0) return unanswered(understood, `None of the ${scope} has an area on this plan.`);
    const mean = measured.reduce((sum, r) => sum + (r.area as number), 0) / measured.length;
    return exact(understood, {
      value: Math.round(mean * 100) / 100, unit: "m2", subject: scope, ...shapesOf(measured),
      method: `mean of the outline areas of the ${measured.length} ${scope}`,
    });
  }
  const single = rooms.length === 1 && labels.length === 0 && numbers.length === 1;
  const understood = `${measure === "count" ? "count" : single ? "area of" : "total area of"} ${scope}`;
  const result = plan.measure(rooms, measure, measure === "count" ? `labels, numbers and apartment outlines of the ${scope}` : single ? `outline of ${scope}` : `outlines of the ${scope}`);
  if (!result) return unanswered(understood, rooms.length === 0 ? `The plan has no ${scope}.` : `One of the ${scope} has no area on this plan.`);
  const consists = measure === "area" && rooms.length > 1 && rooms.length <= 12 ? `The total consists of ${and(rooms.map((r) => `${roomName(r)} ${m2(r.area as number)} m²`))}.` : undefined;
  return exact(understood, { ...result, unit: measure === "count" ? "count" : "m2", subject: scope, labels: shapesOf(rooms).labels, note: consists });
}

// ---------------------------------------------------------------------------------------------------------------
// Raster drawings
// ---------------------------------------------------------------------------------------------------------------

export interface RasterKind {
  id: string;
  /** What the kind covers, for the interpreter. */
  description: string;
}

export type RasterCall =
  /** `whole` is false when the question limits the items to a part of the drawing or by a condition. */
  | { operation: "count_known"; targets: string[]; whole: boolean }
  | { operation: "count_other"; items: string }
  | { operation: "read" };

export interface RasterReading {
  call: RasterCall;
  locate: boolean;
  type: QuestionType;
}

const RASTER_SYSTEM = [
  "You decide how a question about a drawing image (a floor plan, or a sheet of a drawing set) is answered. The program has three ways:",
  "- count_known: count and mark the items of one or more of the kinds listed in the request, which the program has detectors and",
  "  an inventory for. Set targets to the ids of every kind asked for; several kinds are counted separately and added up.",
  "  Set whole_drawing to false when the question limits the items to a part of the drawing or by a condition (one room, one",
  "  storey, an apartment, an enlarged plan or detail, 'the front door', 'in the kitchen'); a vision model then counts just",
  "  those from the full question. Otherwise whole_drawing is true: an explanation of what counts as one item ('doorways",
  "  fitted with a door leaf', 'a double-bowl sink counts as one', 'including kitchenettes', 'not counting separate WC rooms')",
  "  is not a limit.",
  "- count_other: count and mark any other kind of item that can be pointed at on the drawing (stairs, wardrobes, fireplaces).",
  "  Set items to a short English plural for them.",
  "- read: every other question (a text, a dimension, an area, an entry of a schedule or table, a comparison).",
  "Rules:",
  `- ${WORDING_RULE}`,
  "- Use count_known whenever listed kinds are what the question asks about, however it names them.",
  `- ${LOCATE_RULE}`,
  "- answer_type: count for a number of items, area or length for a measure, text for words, names and several figures.",
  `- ${HINT_RULE}`,
  "- Fields the operation does not use: targets [], whole_drawing true, items ''.",
].join("\n");

/** Maps a question about a raster drawing onto known countable kinds, a generic located count, or a free reading. */
export async function planRaster(question: string, kinds: RasterKind[], planner: VisionModel, hint: string | null = null): Promise<RasterReading> {
  const schema = {
    type: "object",
    properties: {
      operation: { type: "string", enum: ["count_known", "count_other", "read"] },
      targets: { type: "array", items: { type: "string", enum: kinds.map((k) => k.id) } },
      whole_drawing: { type: "boolean" },
      items: { type: "string" },
      locate: { type: "boolean" },
      answer_type: { type: "string", enum: ["count", "area", "length", "text"] },
    },
    required: ["operation", "targets", "whole_drawing", "items", "locate", "answer_type"],
    additionalProperties: false,
  };
  const menu = `Kinds for count_known:\n${kinds.map((k) => `- ${k.id}: ${k.description}`).join("\n")}`;
  const { output } = await planner.ask({ system: RASTER_SYSTEM, schema, prompt: request(question, hint, menu) });
  const reading = { locate: output.locate === true, type: typeOf(output.answer_type, ["count", "area", "length", "text"]) };
  const targets = [...new Set(list(output.targets).filter((id) => kinds.some((k) => k.id === id)))];
  if (output.operation === "count_known" && targets.length > 0) return { ...reading, call: { operation: "count_known", targets, whole: output.whole_drawing !== false } };
  if (output.operation === "count_other" && sentence(output.items)) return { ...reading, call: { operation: "count_other", items: sentence(output.items) } };
  if (output.operation === "read") return { ...reading, call: { operation: "read" } };
  throw new UnusableCall(`${output.operation} without what to count`);
}

// ---------------------------------------------------------------------------------------------------------------
// IFC models
// ---------------------------------------------------------------------------------------------------------------

/** What an IFC model can be asked about, in its own words. */
export interface IfcMenu {
  /** File name of the model, which questions use as the model's name. */
  model: string;
  /** Lowest first. */
  storeys: { name: string; elevation: number; rooms: number }[];
  /** Element classes with at least one element, with their counts in the whole model. */
  elements: [ElementKind, string, number][];
  /** Distinct room names with the number of rooms carrying each, most common first. */
  roomNames: [string, number][];
  /** A few room numbers, to show how rooms are numbered. */
  roomNumbers: string[];
}

export const IFC_QUANTITIES = ["wall_length", "wall_side_area", "wall_volume", "slab_volume"] as const;

export type IfcCall =
  /** `storey` is null for the whole model. */
  | { operation: "count_elements"; elements: ElementKind[]; storey: string | null }
  | { operation: "rooms"; rooms: string[]; storey: string | null; pick: "all" | "largest" | "smallest"; measure: "count" | "area" | "average" | "list" }
  | { operation: "storey_total"; quantity: (typeof IFC_QUANTITIES)[number]; storey: string | null }
  | { operation: "model_facts" }
  | { operation: "none"; reason: string };

export interface IfcReading extends Reading {
  call: IfcCall;
  /** Storeys, rooms or other things the question names that the model does not have. */
  missing: string[];
}

const IFC_SYSTEM = [
  "You translate a question about a building model (IFC) into a single call of a take-off program.",
  "The program computes the answer from the model and marks it on the storey plans; you only choose the call and never calculate.",
  "",
  "Operations:",
  "- count_elements: count and mark building elements. elements lists the classes asked for, one or several. storey narrows",
  "  the count to one storey; leave it '' for the whole model.",
  "- rooms: select rooms (spaces), then count them, add up their net floor areas, average them or list them. rooms names the",
  "  rooms asked for; leave it empty for every room. storey narrows to one storey, '' takes the whole model. pick narrows the",
  "  selection to its largest or smallest room. measure is count, area (the sum), average or list.",
  "- storey_total: a total over all walls or all slabs of one storey. quantity is wall_length, wall_side_area (the net side",
  "  area of the walls), wall_volume or slab_volume (the net volume of the floor slabs). Set storey.",
  "- model_facts: any other question about the building: element types, materials, properties, dimensions, level heights, the",
  "  authoring software, a description or a breakdown. A language model then answers it from facts extracted from the model.",
  "- none: the question is not about this building model. Say in reason, in one sentence, why.",
  "",
  "Rules:",
  "- storey is one of the storey names in the request, copied exactly, or ''. Map everyday words onto them (ground floor,",
  "  upstairs, basement, top floor, second level) using their order, lowest first, and their elevations. The name of the model",
  "  itself is not a storey. A storey the question names that the model does not have goes into missing.",
  "- A room is named by a room name from the request, or by the name or number the question gives, copied exactly, character",
  "  for character, in its own language, with its number in brackets when the question writes one: 'KORIDOR (119)'. Map everyday",
  "  words onto the model's room names (the kitchen is 'Küche'). A kind of room the model does not list goes into missing.",
  `- ${LOCATE_RULE} That count is count_elements for elements and rooms with measure count for rooms.`,
  "- answer_type is what the question asks for, whatever the operation: count for 'how many', area (m²), length (m), volume",
  "  (m³), or text for names, descriptions and several figures. 'How many light fixtures' is model_facts with answer_type count.",
  `- ${WORDING_RULE}`,
  `- ${HINT_RULE}`,
  "- Fields that the operation does not use: empty lists, storey '', pick 'all', measure 'count', quantity 'none'. reason is '' unless the operation is none.",
].join("\n");

const MENU_STOREYS = 40;
const MENU_ROOM_NAMES = 60;

function ifcSchema(menu: IfcMenu): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      operation: { type: "string", enum: ["count_elements", "rooms", "storey_total", "model_facts", "none"] },
      elements: { type: "array", items: { type: "string", enum: menu.elements.map(([kind]) => kind) } },
      storey: { type: "string", enum: [...menu.storeys.slice(0, MENU_STOREYS).map((storey) => storey.name), ""] },
      rooms: { type: "array", items: { type: "string" } },
      pick: { type: "string", enum: ["all", "largest", "smallest"] },
      measure: { type: "string", enum: ["count", "area", "average", "list"] },
      quantity: { type: "string", enum: [...IFC_QUANTITIES, "none"] },
      missing: { type: "array", items: { type: "string" } },
      reason: { type: "string" },
      locate: { type: "boolean" },
      answer_type: { type: "string", enum: ["count", "area", "length", "volume", "text"] },
    },
    required: ["operation", "elements", "storey", "rooms", "pick", "measure", "quantity", "missing", "reason", "locate", "answer_type"],
    additionalProperties: false,
  };
}

/** The menu as text. Room names that share a word with the question come first, so a long list is cut where it matters least. */
export function ifcMenuText(menu: IfcMenu, question: string): string {
  const words = new Set(question.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((word) => word.length >= 4));
  const named = (name: string) => name.toLowerCase().split(/[^\p{L}\p{N}]+/u).some((word) => words.has(word));
  const names = [...menu.roomNames].sort((a, b) => Number(named(b[0])) - Number(named(a[0])));
  const shown = names.slice(0, MENU_ROOM_NAMES).map(([name, n]) => `'${name}'${n > 1 ? ` x${n}` : ""}`);
  if (names.length > MENU_ROOM_NAMES) shown.push(`and ${names.length - MENU_ROOM_NAMES} more names; a room named in the question is looked up by the program`);
  const storeys = menu.storeys.slice(0, MENU_STOREYS).map((storey) => `'${storey.name}' (elevation ${storey.elevation.toFixed(2)} m, ${storey.rooms} rooms)`);
  return [
    `Model: '${menu.model}'`,
    `Storeys, lowest first: ${storeys.join(", ") || "none"}`,
    `Element classes for count_elements (number in the whole model): ${menu.elements.map(([kind, plural, n]) => `${kind} (${plural}) ${n}`).join(", ")}`,
    `Room names (rooms carrying each): ${shown.join(", ") || "none"}`,
    ...(menu.roomNumbers.length > 0 ? [`Rooms also carry numbers, for example ${menu.roomNumbers.join(", ")}.`] : []),
  ].join("\n");
}

/** Asks the interpreter for a call on this model. Throws UnusableCall when the output names no runnable call. */
export async function planIfc(question: string, menu: IfcMenu, planner: VisionModel, hint: string | null = null): Promise<IfcReading> {
  const { output } = await planner.ask({ system: IFC_SYSTEM, schema: ifcSchema(menu), prompt: request(question, hint, ifcMenuText(menu, question)) });
  const reading = { locate: output.locate === true, type: typeOf(output.answer_type, ["count", "area", "length", "volume", "text"]), missing: list(output.missing) };
  const storey = sentence(output.storey) || null;
  const on = storey ? `on '${storey}'` : "in the whole model";
  const operation = String(output.operation);

  if (operation === "count_elements") {
    const elements = [...new Set(list(output.elements).filter((kind): kind is ElementKind => menu.elements.some(([known]) => known === kind)))];
    if (elements.length === 0) throw new UnusableCall("count_elements without an element class");
    const plurals = elements.map((kind) => menu.elements.find(([known]) => known === kind)![1]);
    return { ...reading, understood: `count ${and(plurals)} ${on}`, call: { operation, elements, storey } };
  }
  if (operation === "rooms") {
    const rooms = list(output.rooms);
    const measure: "count" | "area" | "average" | "list" = ["area", "average", "list"].includes(output.measure) ? output.measure : "count";
    const pick: "all" | "largest" | "smallest" = output.pick === "largest" || output.pick === "smallest" ? output.pick : "all";
    const which = rooms.length > 0 ? `room${rooms.length > 1 ? "s" : ""} ${and(rooms.map((room) => `'${room}'`))}` : "all rooms";
    const selection = pick === "all" ? which : `the ${pick} of ${which}`;
    const verb = { count: "count", area: "net floor area of", average: "average net floor area of", list: "list" }[measure];
    return { ...reading, understood: `${pick !== "all" && measure === "count" ? "" : `${verb} `}${selection} ${on}`, call: { operation, rooms, storey, pick, measure } };
  }
  if (operation === "storey_total") {
    const quantity = IFC_QUANTITIES.find((each) => each === output.quantity);
    if (!quantity) throw new UnusableCall("storey_total without a quantity");
    return { ...reading, understood: `total ${quantity.replaceAll("_", " ")} ${storey ? `on '${storey}'` : "of a storey the question does not name"}`, call: { operation, quantity, storey } };
  }
  if (operation === "model_facts") return { ...reading, understood: "a question about facts in the building model", call: { operation } };
  if (operation === "none") {
    return { ...reading, understood: "a question this building model cannot answer", call: { operation, reason: sentence(output.reason) || "The question is not about this building model." } };
  }
  throw new UnusableCall(`unknown operation '${operation}'`);
}
