/**
 * Questions the fixed parsers do not recognise go to a language model that picks one operation and its parameters
 * from a menu of what the drawing supports. The model only chooses the call; code computes the answer and the marks.
 */
import type { VisionModel } from "./models/vision.js";
import { isIndoor, type Plan, type Room, type TakeoffResult } from "./solvers/dxf.js";
import type { Polygon } from "./types.js";

const SYMBOLS = ["doors", "windows", "toilets", "washbasins", "bathtubs", "showers"] as const;

const TAKEOFF_SYSTEM = [
  "You translate a question about one floor plan into a single call of a take-off program.",
  "The program computes the answer from the plan's CAD geometry and marks it on the drawing; you only choose the call.",
  "",
  "Operations:",
  "- count_symbols: count and mark one kind of drawn symbol. Set symbol.",
  "- count_apartments: count and mark the apartments (residential units, flats) on the floor.",
  "- rooms: select rooms, then count them, add up their areas, or list them. The selection combines labels (rooms carrying one of",
  "  these labels), room_numbers (these rooms) and apartment (rooms of this apartment); a filter left empty does not narrow, so",
  "  all three empty selects every room. pick narrows the selection to its largest or smallest room. measure is count, area",
  "  (the sum over the selection) or list (name the selected rooms, for 'which room ...' questions).",
  "- area_apartment: the net floor area of one apartment, without its balconies, loggias and terraces. Set apartment.",
  "- area_floor: the total net floor area of all numbered indoor rooms on the floor.",
  "- answer: a question about this plan's rooms, areas, apartments or symbols that no operation above expresses (a comparison,",
  "  a yes/no question). Write the answer in the language of the question from the plan data, and give in room_numbers the rooms",
  "  it rests on. Never add up areas yourself: a question that needs a sum is a rooms call.",
  "- none: the question asks for something the plan data does not hold.",
  "",
  "Rules:",
  "- The room labels are in the plan's own language. Map the words of the question onto the labels this plan uses, whatever",
  "  the language of the question, and copy them exactly as listed. A label quoted in the question is used as it is.",
  "  When several of the plan's labels are the kind of room asked for, give them all.",
  "- A request to show, mark, find, highlight or locate things is the count of those things with locate set to true.",
  "- Spelling mistakes and missing words are normal; choose the reading a person on site would mean.",
  "- Fields that the operation does not use: symbol 'none', empty lists, apartment '', pick 'all', measure 'count', answer ''.",
].join("\n");

const TAKEOFF_SCHEMA = {
  type: "object",
  properties: {
    operation: { type: "string", enum: ["count_symbols", "count_apartments", "rooms", "area_apartment", "area_floor", "answer", "none"] },
    symbol: { type: "string", enum: [...SYMBOLS, "none"] },
    labels: { type: "array", items: { type: "string" } },
    room_numbers: { type: "array", items: { type: "string" } },
    apartment: { type: "string" },
    pick: { type: "string", enum: ["all", "largest", "smallest"] },
    measure: { type: "string", enum: ["count", "area", "list"] },
    answer: { type: "string" },
    locate: { type: "boolean" },
  },
  required: ["operation", "symbol", "labels", "room_numbers", "apartment", "pick", "measure", "answer", "locate"],
  additionalProperties: false,
};

const m2 = (area: number) => area.toFixed(2);

/** What the plan holds, in the plan's own words: the vocabulary the question is mapped onto, and the facts behind free answers. */
export function takeoffMenu(plan: Plan): string {
  const { labels, units } = plan.vocabulary();
  const unitOf = plan.unitOf();
  const sum = (rooms: Room[]) => rooms.reduce((total, r) => total + (r.area ?? 0), 0);
  const lines = [
    `Room labels on this plan (rooms carrying each, their summed area): ${labels.map(([name, n]) => `${name} x${n} (${m2(sum(plan.labelled(name)))} m²)`).join(", ") || "none"}`,
    `Apartments: ${units.map((u) => `${u} (${plan.unitRooms(u).length} rooms, ${m2(sum(plan.unitRooms(u).filter(isIndoor)))} m² net without outdoor rooms)`).join(", ") || "none"}`,
    `Symbols drawn: ${plan.doors.length} doors, ${plan.windows.length} windows, ${plan.toilets.length} toilets, ${plan.washbasins.length} washbasins, ${plan.bathtubs.length} bathtubs, ${plan.showers.length} showers`,
    "Rooms (number; label; apartment; area in m²):",
    ...plan.rooms.map((r) => `${r.number ?? "-"}; ${r.name ?? "-"}; ${unitOf.get(r) ?? "-"}; ${r.area === null ? "-" : m2(r.area)}`),
  ];
  return lines.join("\n");
}

export interface PlannedTakeoff {
  value: number | string;
  unit?: string;
  /** False when the model wrote the answer itself from the plan's facts. */
  exact: boolean;
  /** The call that was run, in words. */
  understood: string;
  method: string;
  subject?: string;
  locate: boolean;
  highlights: Polygon[];
  cutouts?: Polygon[][];
  labels?: string[];
}

const quoted = (names: string[]) => names.map((n) => `'${n}'`).join(" or ");
const roomName = (r: Room) => [r.number, r.name].filter(Boolean).join(" ");

/**
 * Asks the planner for a call on this plan and runs it. Null when the planner finds no call, or names things the plan
 * does not have.
 */
export async function planTakeoff(question: string, plan: Plan, planner: VisionModel): Promise<PlannedTakeoff | null> {
  const { output: call } = await planner.ask({ system: TAKEOFF_SYSTEM, schema: TAKEOFF_SCHEMA, prompt: `Question: ${question}\n\n${takeoffMenu(plan)}` });
  const vocabulary = plan.vocabulary();
  const locate = call.locate === true;
  const done = (understood: string, result: TakeoffResult | null, unit: string): PlannedTakeoff | null =>
    result && { ...result, unit, exact: true, understood, locate };

  if (call.operation === "count_symbols" && SYMBOLS.includes(call.symbol)) return done(`count ${call.symbol}`, plan.answer({ kind: `count_${call.symbol}` }), "count");
  if (call.operation === "count_apartments") return done("count apartments", plan.answer({ kind: "count_apartments" }), "count");
  if (call.operation === "area_floor") return done("total area of the numbered indoor rooms", plan.answer({ kind: "area_all_indoor" }), "m2");

  const apartment = vocabulary.units.find((u) => u === String(call.apartment ?? "").trim().toUpperCase());
  if (call.operation === "area_apartment") {
    return apartment ? done(`net area of apartment ${apartment}`, plan.answer({ kind: "area_apartment", unit: apartment }), "m2") : null;
  }

  const asked = { labels: (call.labels ?? []) as string[], numbers: (call.room_numbers ?? []) as string[] };
  const labels = asked.labels.flatMap((l) => vocabulary.labels.filter(([name]) => name.toLowerCase() === l.trim().toLowerCase()).map(([name]) => name));
  const numbers = asked.numbers.map((n) => n.trim()).filter((n) => vocabulary.numbers.includes(n));

  if (call.operation === "answer" && String(call.answer ?? "").trim()) {
    const rooms = plan.select({ numbers }).filter((r) => r.polygon !== null);
    return {
      value: String(call.answer).trim(), exact: false, locate, understood: "a question about the plan's rooms",
      method: `written by ${planner.id} from the rooms, labels, apartments and areas measured on the CAD geometry`,
      highlights: rooms.map((r) => r.polygon as Polygon), cutouts: rooms.map((r) => r.holes), labels: rooms.map(roomName),
    };
  }
  if (call.operation !== "rooms") return null;
  // A filter that names nothing on this plan would silently widen the selection to every room.
  if ((asked.labels.length > 0 && labels.length === 0) || (asked.numbers.length > 0 && numbers.length === 0)) return null;
  if (String(call.apartment ?? "").trim() && !apartment) return null;

  const scope = [
    labels.length > 0 ? `rooms labelled ${quoted(labels)}` : numbers.length > 0 ? `room${numbers.length > 1 ? "s" : ""} ${numbers.join(", ")}` : "rooms",
    labels.length > 0 && numbers.length > 0 ? `numbered ${numbers.join(", ")}` : "",
    apartment ? `in apartment ${apartment}` : "",
  ].filter(Boolean).join(" ");
  const measure: "count" | "area" | "list" = call.measure;

  // The dataset's own operations, so that a reworded dataset question is computed exactly like the original.
  if (call.pick === "all" && !apartment && numbers.length === 0 && labels.length === 1 && measure !== "list") {
    const kind = measure === "count" ? "count_rooms_labelled" : "area_rooms_labelled";
    return done(`${measure === "count" ? "count" : "total area of"} ${scope}`, plan.answer({ kind, name: labels[0] }), measure === "count" ? "count" : "m2");
  }

  let rooms = plan.select({ labels: labels.length ? labels : undefined, numbers: numbers.length ? numbers : undefined, unit: apartment });
  if (call.pick !== "all") {
    const measured = rooms.filter((r) => r.area !== null).sort((a, b) => (a.area as number) - (b.area as number));
    const chosen = call.pick === "largest" ? measured.at(-1) : measured[0];
    if (!chosen) return null;
    rooms = [chosen];
    const understood = `${call.pick} of the ${scope}`;
    if (measure === "area") return done(`area of the ${understood}`, plan.measure(rooms, "area", `outline of the ${understood}, room ${roomName(chosen)}`), "m2");
    const drawn = plan.measure(rooms, "count", `room outlines compared by area`)!;
    return { ...drawn, value: `${roomName(chosen)}, ${m2(chosen.area as number)} m²`, exact: true, understood, locate, labels: [roomName(chosen)] };
  }
  if (measure === "list") {
    const drawn = plan.measure(rooms, "count", `room labels, numbers and apartment outlines`)!;
    const named = rooms.filter((r) => r.polygon !== null).map(roomName);
    return { ...drawn, value: rooms.length ? rooms.map(roomName).join(", ") : "none", exact: true, understood: `list the ${scope}`, locate, labels: named };
  }
  const result = plan.measure(rooms, measure, measure === "count" ? `labels, numbers and apartment outlines of the ${scope}` : `outlines of the ${scope}`);
  return done(`${measure === "count" ? "count" : "total area of"} ${scope}`, result && { ...result, subject: scope }, measure === "count" ? "count" : "m2");
}

export interface RasterKind {
  id: string;
  /** What the kind covers, for the planner. */
  description: string;
}

export type RasterCall = { operation: "count_known"; target: string; locate: boolean } | { operation: "count_other"; items: string; locate: boolean } | { operation: "free" };

const RASTER_SYSTEM = [
  "You decide how a question about a floor plan image is answered. The program has three ways:",
  "- count_known: count and mark one of the kinds listed in the request, which it has detectors and an inventory for. Set target to the kind's id.",
  "- count_other: count and mark any other kind of item that can be pointed at on the drawing (stairs, wardrobes, fireplaces). Set items to a short English plural for them.",
  "- free: every other question (a text, a dimension, an area, a comparison).",
  "Rules:",
  "- The question may be in any language, casual, terse or misspelt; choose the reading a person on site would mean.",
  "- Prefer count_known whenever a listed kind is what the question asks about, however it names it.",
  "- A request to show, mark, find, highlight or locate things is the count of those things with locate set to true.",
  "- Fields the operation does not use: target 'none', items ''.",
].join("\n");

/** Maps a question about a raster drawing onto a known countable kind, a generic located count, or a free-form reading. */
export async function planRaster(question: string, kinds: RasterKind[], planner: VisionModel): Promise<RasterCall | null> {
  const schema = {
    type: "object",
    properties: {
      operation: { type: "string", enum: ["count_known", "count_other", "free"] },
      target: { type: "string", enum: [...kinds.map((k) => k.id), "none"] },
      items: { type: "string" },
      locate: { type: "boolean" },
    },
    required: ["operation", "target", "items", "locate"],
    additionalProperties: false,
  };
  const prompt = `Question: ${question}\n\nKinds for count_known:\n${kinds.map((k) => `- ${k.id}: ${k.description}`).join("\n")}`;
  const { output } = await planner.ask({ system: RASTER_SYSTEM, schema, prompt });
  const locate = output.locate === true;
  if (output.operation === "count_known" && kinds.some((k) => k.id === output.target)) return { operation: "count_known", target: output.target, locate };
  if (output.operation === "count_other" && String(output.items ?? "").trim()) return { operation: "count_other", items: String(output.items).trim(), locate };
  return output.operation === "free" ? { operation: "free" } : null;
}

/** The sentence that answers a request to show something; `subject` is a plural noun phrase. */
export function markedSentence(count: number, subject: string): string {
  const named = subject.charAt(0).toUpperCase() + subject.slice(1);
  return count === 0 ? `${named}: none found on this drawing.` : `${named}: ${count} marked on the drawing.`;
}
