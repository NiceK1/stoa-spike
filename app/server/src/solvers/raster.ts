/**
 * Raster drawings. A drawn symbol (window, door, sanitary fixture) is counted by the trained detector that the routing
 * prefers for its class. Room types and storeys come from one inventory of the drawing by a vision model, which also
 * answers everything on drawings the detectors do not recognise.
 * Either way the answer comes with numbered marks on the image, so a person can check each counted item.
 */
import sharp from "sharp";
import type { Detector } from "../models/detector.js";
import type { VisionModel } from "../models/vision.js";
import { markedSentence, type RasterKind, type RasterReading } from "../planner.js";
import type { Answer, Mark, QuestionType } from "../types.js";

export interface RasterDeps {
  vision: VisionModel;
  detector: Detector | null;
  /** URL the browser can load the image from. */
  imageUrl: string;
  /** Use the detector for the classes it offers. Off to measure the vision model alone. */
  useDetector?: boolean;
}

export interface Target {
  id: string;
  /** The items as a plural noun phrase, for sentences and for the interpreter's menu. */
  plural: string;
  /** What tells this kind from its neighbours, for the interpreter. */
  hint?: string;
  pattern: RegExp;
  /** Inventory categories that add up to this target. */
  categories: string[];
  /** Detector classes that add up to this target. */
  detectorClasses: string[];
  /** A drawn symbol, which a detector counts best, as opposed to a room type or a storey, which is read from labels. */
  symbol?: boolean;
}

// The target is the one whose words appear first in the question: later mentions are usually exclusions.
export const TARGETS: Target[] = [
  { id: "window", plural: "windows", pattern: /\bwindows?\b|ikkuna/, categories: ["windows"], detectorClasses: ["window"], symbol: true },
  { id: "door", plural: "doors", hint: "doorways fitted with a door leaf", pattern: /\bdoors?\b|\bove[at]\b|\bovia\b/, categories: ["doors"], detectorClasses: ["door"], symbol: true },
  { id: "toilet", plural: "toilet bowls", hint: "the fixture: toilets, WCs, WC seats, loos", pattern: /toilet bowls?|wc seats?|wc-istuin/, categories: ["toilet_bowls"], detectorClasses: ["toilet"], symbol: true },
  { id: "sink", plural: "sinks and wash basins", hint: "in kitchens and bathrooms together", pattern: /\bsinks?\b|wash ?basins?|tiskiallas|pesuallas|allasta/, categories: ["sinks"], detectorClasses: ["sink"], symbol: true },
  // The combined target stays first: on an equal match position the earlier entry wins.
  {
    id: "shower_bathtub", plural: "showers and bathtubs", hint: "both together in one total", categories: ["showers", "bathtubs"], detectorClasses: ["shower", "bathtub"], symbol: true,
    pattern: /\bshowers?\s*(?:and|or|&|\/|,)\s*bathtubs?\b|\bbathtubs?\s*(?:and|or|&|\/|,)\s*showers?\b|suihku\S*\s+(?:ja|tai|sekä)\s+kylpyamme|kylpyamme\S*\s+(?:ja|tai|sekä)\s+suihku/,
  },
  { id: "shower", plural: "showers", pattern: /\bshowers?\b|suihku/, categories: ["showers"], detectorClasses: ["shower"], symbol: true },
  { id: "bathtub", plural: "bathtubs", pattern: /\bbathtubs?\b|kylpyamme/, categories: ["bathtubs"], detectorClasses: ["bathtub"], symbol: true },
  { id: "sauna", plural: "saunas", hint: "sauna rooms", pattern: /\bsauna/, categories: ["saunas"], detectorClasses: ["sauna"] },
  { id: "kitchen", plural: "kitchens", hint: "including kitchenettes", pattern: /\bkitchens?\b|keittiö/, categories: ["kitchens"], detectorClasses: ["kitchen"] },
  { id: "bedroom", plural: "bedrooms", pattern: /\bbedrooms?\b|makuuhuone/, categories: ["bedrooms"], detectorClasses: ["bedroom"] },
  { id: "wc_room", plural: "separate WC rooms", hint: "toilet rooms as rooms, not the fixture in them", pattern: /wc rooms?|toilet rooms?|wc-tila/, categories: ["wc_rooms"], detectorClasses: ["wc_room"] },
  { id: "bathroom", plural: "bathrooms", hint: "bathrooms and washrooms; a separate WC room is not one", pattern: /\bbathrooms?\b|washrooms?|kylpy- tai pesuhuone/, categories: ["bathrooms"], detectorClasses: ["bathroom"] },
  { id: "balcony", plural: "balconies", pattern: /\bbalcon(y|ies)\b|parveke/, categories: ["balconies"], detectorClasses: ["balcony"] },
  { id: "floor", plural: "storeys", hint: "how many floors or storeys the image shows", pattern: /\bfloors\b|\bstoreys?\b|kerrosta/, categories: [], detectorClasses: ["floor"] },
];

export function rasterTarget(question: string): Target | null {
  const lowered = question.toLowerCase();
  let best: { target: Target; index: number } | null = null;
  for (const target of TARGETS) {
    const match = target.pattern.exec(lowered);
    if (match && (best === null || match.index < best.index)) best = { target, index: match.index };
  }
  return best?.target ?? null;
}

const COMBINED = TARGETS.filter((t) => t.detectorClasses.length > 1);

/** The kinds the interpreter chooses from. A combined target is left out: it is its parts, named together. */
export const RASTER_KINDS: RasterKind[] = TARGETS.filter((t) => !COMBINED.includes(t)).map((t) => ({ id: t.id, description: t.hint ? `${t.plural} (${t.hint})` : t.plural }));

/** The targets behind the kinds a question names; parts that make up a combined target are counted as that target. */
function targetsOf(ids: string[]): Target[] {
  let rest = TARGETS.filter((t) => ids.includes(t.id));
  const merged: Target[] = [];
  for (const whole of COMBINED) {
    const parts = rest.filter((t) => t.detectorClasses.length === 1 && whole.detectorClasses.includes(t.detectorClasses[0]));
    if (parts.length !== whole.detectorClasses.length) continue;
    merged.push(whole);
    rest = rest.filter((t) => !parts.includes(t));
  }
  return [...merged, ...rest];
}

/** The reading the keyword patterns give, for when no interpreter model reads the question. */
export function readByKeywords(question: string, qtype: QuestionType, locate = false): RasterReading {
  const target = qtype === "count" ? rasterTarget(question) : null;
  if (target) return { call: { operation: "count_known", targets: [target.id], whole: true }, locate, type: qtype };
  return { call: qtype === "count" ? { operation: "count_other", items: "items" } : { operation: "read" }, locate, type: qtype };
}

const CATEGORIES = [...new Set(TARGETS.flatMap((t) => t.categories))];

const INVENTORY_PROMPT = "Take the inventory of this floor plan.";
const IN_DOMAIN_SCORE = 0.6;
const IN_DOMAIN_DETECTIONS = 3;

const INVENTORY_BASE = [
  "You take an inventory of an architectural floor plan. Open the image with the Read tool before answering.",
  "Go through the plan room by room and record every item of each category exactly once, with the position of its centre:",
  "x and y in thousandths of the image width and height (0 to 1000, origin at the top-left corner).",
  "",
  "Categories and their rules:",
  "- floors: how many separate storeys the image shows (each storey is its own plan drawing); an integer, not a list.",
  "- windows: every window drawn in an outer or inner wall.",
  "- doors: every doorway fitted with a door leaf (usually drawn with a swing arc or a leaf line). Open doorways without a leaf do not count.",
  "- toilet_bowls: every toilet seat symbol.",
  "- sinks: every sink or wash basin, in kitchens and bathrooms alike. A double-bowl sink is one item.",
  "- showers: every shower. bathtubs: every bathtub.",
  "- saunas: every sauna room (often marked S or SAUNA).",
  "- kitchens: every kitchen, including kitchenettes, open kitchens and utility kitchens (marked K, KT, KK, KEITTIÖ, TUPAKEITTIÖ, APUKEITTIÖ).",
  "- bedrooms: every bedroom (marked MH or makuuhuone).",
  "- wc_rooms: every separate toilet room marked WC.",
  "- bathrooms: every bathroom or washroom (marked KH, KPH, PH, PESUH or SH). A separate WC room is not a bathroom.",
  "- balconies: every balcony, including glazed balconies (parveke, lasitettu parveke). Terraces are not balconies.",
  "",
  "Use an empty list for a category with no items.",
].join("\n");

const SCOPE_RULE =
  "Scope: many images show one apartment inside a larger building plan, with parts of neighbouring apartments or shared " +
  "spaces visible around it. When a hand-drawn outline, the labels (for example an apartment name with its area) or the " +
  "framing single out one apartment, record only that apartment's items. Ignore everything in neighbouring apartments, " +
  "above all rooms and fixtures that are cut off at the edge of the image.";

const FIXTURE_RULES =
  "Fixtures: a shower is often drawn only as a small shower-head symbol (a small circle with a short curved hose or " +
  "spray lines) in a corner of a bathroom, with no tray; record each one as a shower. " +
  "A sink is a basin with a bowl outline; a stove (four circles), a washing machine, a floor drain or a water heater is not a sink.";

/** Prompt versions, kept so that measured results stay reproducible. Selected with INVENTORY_PROMPT. */
export const INVENTORY_PROMPTS: Record<string, string> = {
  v1: INVENTORY_BASE,
  v2: `${INVENTORY_BASE}\n\n${SCOPE_RULE}`,
  v3: `${INVENTORY_BASE}\n\n${SCOPE_RULE}\n\n${FIXTURE_RULES}`,
};
const DEFAULT_PROMPT = "v3";

function inventorySystem(): string {
  return INVENTORY_PROMPTS[process.env.INVENTORY_PROMPT ?? DEFAULT_PROMPT] ?? INVENTORY_PROMPTS[DEFAULT_PROMPT];
}

const POINTS = {
  type: "array",
  items: { type: "object", properties: { x: { type: "integer" }, y: { type: "integer" } }, required: ["x", "y"], additionalProperties: false },
};

export const INVENTORY_SCHEMA = {
  type: "object",
  properties: { floors: { type: "integer" }, ...Object.fromEntries(CATEGORIES.map((c) => [c, POINTS])) },
  required: ["floors", ...CATEGORIES],
  additionalProperties: false,
};

const COUNT_SYSTEM =
  "You read architectural floor plans and count what is drawn on them. Open the image with the Read tool before answering. " +
  "Work through the plan room by room and list every item the question asks about, exactly once. " +
  "For each item give the position of its centre as x and y in thousandths of the image width and height " +
  "(0 to 1000, origin at the top-left corner). The answer is the number of items you list.";

const COUNT_SCHEMA = {
  type: "object",
  properties: { items: POINTS, count: { type: "integer" } },
  required: ["items", "count"],
  additionalProperties: false,
};

const FREE_SYSTEM =
  "You read architectural drawings. Open the image with the Read tool before answering. " +
  "Answer from what is drawn or written on the drawing; if it cannot be determined, say so in the explanation and leave value empty.";

const FREE_SCHEMA = {
  type: "object",
  properties: {
    answer: { type: "string" },
    value: { type: ["number", "null"] },
    unit: { type: ["string", "null"] },
    explanation: { type: "string" },
  },
  required: ["answer", "value", "unit", "explanation"],
  additionalProperties: false,
};

type Located = { x: number; y: number };

/**
 * Rows top to bottom, left to right within a row, so the numbers on the drawing read like text.
 * Items whose centres differ in height by less than `tolerance` share a row.
 */
export function readingOrder<T>(items: T[], centre: (item: T) => Located, tolerance: number): T[] {
  const byHeight = [...items].sort((a, b) => centre(a).y - centre(b).y);
  const rows: T[][] = [];
  for (const item of byHeight) {
    const row = rows.at(-1);
    if (row && centre(item).y - centre(row[0]).y < tolerance) row.push(item);
    else rows.push([item]);
  }
  return rows.flatMap((row) => row.sort((a, b) => centre(a).x - centre(b).x));
}
/** Share of the image height within which two items count as one row. */
const ROW = 0.03;

/**
 * Answers a question as it was read: a count of known kinds on the whole drawing, a located count by the vision model
 * (other items, or known kinds limited to a part of the drawing), or a free reading.
 */
export async function solveRaster(imagePath: string, question: string, reading: RasterReading, deps: RasterDeps): Promise<Answer> {
  const { call, locate, type } = reading;
  const { width = 0, height = 0 } = await sharp(imagePath).metadata();
  const image = (marks: Mark[], caption: string) => ({ kind: "image" as const, imageUrl: deps.imageUrl, width, height, marks, caption });
  const toMarks = (items: Located[]): Mark[] =>
    readingOrder(items, (item) => item, 1000 * ROW).map((item, i) => ({ n: i + 1, x: (item.x / 1000) * width, y: (item.y / 1000) * height }));

  if (call.operation === "read") {
    const { output } = await deps.vision.ask({ imagePath, system: FREE_SYSTEM, prompt: question, schema: FREE_SCHEMA });
    const unmarked = locate ? "Nothing is marked: the answer was read from the drawing as a whole, not from items that can be pointed at." : "";
    return {
      value: type === "text" ? output.answer : (output.value ?? output.answer), unit: output.unit ?? undefined, pipeline: "vision-model", exact: false,
      method: `read from the drawing by ${deps.vision.id}`, note: [output.explanation, unmarked].filter(Boolean).join(" ") || undefined, evidence: image([], "Source drawing"),
    };
  }

  const targets = call.operation === "count_known" ? targetsOf(call.targets) : [];
  if (call.operation === "count_other" || !call.whole) {
    const { output } = await deps.vision.ask({ imagePath, system: COUNT_SYSTEM, prompt: question, schema: COUNT_SCHEMA });
    const items: Located[] = output.items ?? [];
    const subject = call.operation === "count_other" ? call.items : `${targets.map((t) => t.plural).join(" and ")} in the part of the drawing the question names`;
    return {
      value: items.length > 0 ? items.length : output.count, unit: "count", pipeline: "vision-model", exact: false, kind: "other",
      method: `${subject} listed by ${deps.vision.id}`,
      note: locate ? markedSentence(items.length, subject) : undefined,
      evidence: image(toMarks(items), "Each number is one counted item; positions are the model's estimate"),
    };
  }

  const parts: { target: Target; answer: Answer; marks: Mark[] }[] = [];
  for (const target of targets) {
    const answer = await countTarget(imagePath, target, deps, image, toMarks);
    parts.push({ target, answer, marks: answer.evidence?.kind === "image" ? answer.evidence.marks : [] });
  }
  const marked = (count: number, subject: string) =>
    // A storey is a whole plan on the image, not an item with a position.
    parts.every((part) => part.target.id === "floor") ? "Storeys are counted from the whole image; there is no single item to mark." : markedSentence(count, subject);
  if (parts.length === 1) {
    const [{ target, answer, marks }] = parts;
    return { ...answer, note: locate ? marked(marks.length, target.plural) : undefined };
  }

  const total = parts.reduce((sum, part) => sum + (part.answer.value as number), 0);
  const subject = parts.map((part) => part.target.plural).join(" and ");
  const consists = `The total of ${total} consists of ${parts.map((part) => `${part.answer.value} ${part.target.plural}`).join(" and ")}.`;
  const marks = parts.flatMap((part) => part.marks.map((mark) => ({ ...mark, label: mark.label ?? part.target.plural })));
  const pipelines = new Set(parts.map((part) => part.answer.pipeline));
  return {
    value: total, unit: "count", pipeline: pipelines.size === 1 ? parts[0].answer.pipeline : "vision-model", exact: false, kind: parts.map((part) => part.target.id).join("+"),
    method: parts.map((part) => part.answer.method).join("; "),
    note: locate ? `${consists} ${marked(marks.length, subject)}` : consists,
    evidence: image(marks.map((mark, i) => ({ ...mark, n: i + 1 })), "Each mark is one counted item, labelled with its kind"),
  };
}

/**
 * Counts one target on the whole drawing with a single source. A target the detectors are given is counted by the
 * detector routed to its classes, when the drawing is in the detectors' style; everything else comes from the vision
 * model's inventory of the drawing, which is one request shared by every such question about it.
 *
 * RASTER_DETECTOR_TARGETS: "symbols" (default) gives the detectors the drawn symbols and leaves room types and
 * storeys to the vision model; "all" gives them every class they know, and is what runs without a vision model;
 * "none" switches them off.
 */
async function countTarget(
  imagePath: string, target: Target, deps: RasterDeps,
  image: (marks: Mark[], caption: string) => Answer["evidence"], toMarks: (items: Located[]) => Mark[],
): Promise<Answer> {
  const { height = 0 } = await sharp(imagePath).metadata();
  const local = deps.vision.id === "none";
  const scope = deps.useDetector === false ? "none" : local ? "all" : (process.env.RASTER_DETECTOR_TARGETS ?? "symbols");
  const detector = scope === "none" ? null : deps.detector;
  const names = target.detectorClasses.map((cls) => cls.replace("_", " ")).join(" and ");

  if (detector && target.detectorClasses.every((cls) => cls in detector.thresholds) && (scope === "all" || target.symbol === true)) {
    const scanned = await detector.detect(imagePath);
    // The detectors know one drawing style. On a drawing where they recognise almost nothing with confidence
    // (an elevation, a historic scan), their count would be a confident zero, so the vision model answers instead.
    if (scanned.filter((d) => d.score >= IN_DOMAIN_SCORE).length >= IN_DOMAIN_DETECTIONS) {
      const boxes = readingOrder(
        scanned.filter((d) => target.detectorClasses.includes(d.cls) && d.score >= detector.thresholds[d.cls]),
        (d) => ({ x: d.x + d.w / 2, y: d.y + d.h / 2 }), height * ROW,
      );
      const by = [...new Set(target.detectorClasses.map((cls) => detector.nameFor?.(cls) ?? detector.id.split(":")[1]))].join(" and ");
      return {
        value: boxes.length, unit: "count", pipeline: "detector", exact: false, kind: target.id,
        method: `${names} ${target.symbol ? "symbols" : "rooms"} found by the detector ${by}`,
        evidence: image(
          boxes.map((d, i) => ({ n: i + 1, x: d.x, y: d.y, w: d.w, h: d.h, label: `${d.cls.replace("_", " ")}, ${Math.round(d.score * 100)}% confidence` })),
          `Each box is one counted ${names}`,
        ),
      };
    }
  }

  const { output } = await deps.vision.ask({ imagePath, system: inventorySystem(), schema: INVENTORY_SCHEMA, prompt: INVENTORY_PROMPT });
  if (target.id === "floor") {
    return {
      value: output.floors, unit: "count", pipeline: "vision-model", exact: false, kind: target.id,
      method: `storeys counted by ${deps.vision.id}`, evidence: image([], "Source drawing"),
    };
  }
  const points: Located[] = target.categories.flatMap((category) => output[category] ?? []);
  return {
    value: points.length, unit: "count", pipeline: "vision-model", exact: false, kind: target.id,
    method: `${target.categories.join(" and ").replaceAll("_", " ")} located by ${deps.vision.id}`,
    evidence: image(toMarks(points), "Each number is one counted item; positions are the model's estimate"),
  };
}
