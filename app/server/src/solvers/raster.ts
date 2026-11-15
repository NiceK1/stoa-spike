/**
 * Raster drawings, local first. Every known kind (drawn symbols, room types, storeys) is counted by the trained
 * detector that the routing prefers for its class, with no model call. The outside vision model (the reader) is the
 * fallback for what the detectors cannot do: other kinds of items, counts limited to a part of the drawing, free
 * reading, and drawings the detectors do not recognise. The method text of every answer names the tier, and the reason
 * when it is the outside one; without a reader such a question gets an answer with no value that says so.
 * A line-up may give room types and storeys to the reader (`scope`), and may have every detector and the reader count
 * a drawn symbol and take the middle count (`vote`).
 * A counted answer comes with numbered marks on the image, so a person can check each counted item.
 */
import { basename } from "node:path";
import sharp from "sharp";
import type { Detection, Detector } from "../models/detector.js";
import type { VisionModel } from "../models/vision.js";
import { markedSentence, type RasterKind, type RasterReading } from "../planner.js";
import { isLocate, isPlainRequest } from "../questions.js";
import { SCRIPTS, UNCONFIGURED, model, script, tierOf } from "../source.js";
import type { Answer, Mark, OutsideAdvice, QuestionType, Solved } from "../types.js";

export interface RasterDeps {
  vision: VisionModel;
  detector: Detector | null;
  /** URL the browser can load the image from. */
  imageUrl: string;
  /** Use the detector for the classes it offers. Off to measure the vision model alone. */
  useDetector?: boolean;
  /** The drawing as the user knows it, when the image is a rendering or a turned copy of it. */
  file?: string;
  /**
   * What the detectors count: every kind they know, the drawn symbols only (room types and storeys then go to the
   * reader), or nothing. Left out, RASTER_DETECTOR_TARGETS decides.
   */
  scope?: RasterScope;
  /** A drawn symbol is counted by every detector that knows it and by the reader, and the middle count is the answer. */
  vote?: boolean;
  /** What to say when a question needs a reader and there is none; left out, the environment's wording. */
  advice?: OutsideAdvice;
}

export type RasterScope = "all" | "symbols" | "none";

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
  /** A drawn symbol, as opposed to a room type or a storey, which the plan tells by its labels. */
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

/** Words that join or introduce a list of kinds without narrowing it. */
const JOINING = ["and", "or", "plus", "ja", "sekä", "tai", "und", "oder", "et", "ou", "e", "o", "och", "eller", "y"];
const LISTING = [...JOINING, "also", "both", "how", "many", "count", "number", "kuinka", "monta", "montako", "wie", "viele", "combien", "quanti", "quante", "hur", "många", "cuántos", "cuántas"];
const JOINS = new RegExp(String.raw`[,&+/]|(?<![\p{L}])(?:${JOINING.join("|")})(?![\p{L}])`, "gu");

/**
 * Every kind a question names when it does nothing but list them ("where sauna and where bathroom"); otherwise the
 * first-named kind alone, because in a longer sentence a later kind is usually an exclusion or an explanation.
 * Kinds that are not joined ("the bedroom door") are one qualified thing, not a list.
 */
export function rasterTargets(question: string): Target[] {
  const lowered = question.toLowerCase();
  const named = TARGETS.filter((t) => t.pattern.test(lowered));
  const kinds = [...new Set(targetsOf(named.map((t) => t.id)))];
  const joined = (lowered.match(JOINS) ?? []).length >= named.length - 1;
  if (named.length > 1 && joined && isPlainRequest(question, new RegExp(named.map((t) => `(?:${t.pattern.source})`).join("|")), LISTING)) {
    return kinds;
  }
  const first = rasterTarget(question);
  return first ? [first] : [];
}

/** The reading the keyword patterns give, for when no interpreter model reads the question. */
export function readByKeywords(question: string, qtype: QuestionType, locate = false): RasterReading {
  // A question that only lists several kinds asks for each of them, whatever answer type its wording suggests.
  const listed = rasterTargets(question);
  if (listed.length > 1) {
    return { call: { operation: "count_known", targets: listed.map((t) => t.id), whole: true }, locate: locate || isLocate(question), type: "count" };
  }
  const target = qtype === "count" ? rasterTarget(question) : null;
  if (target) return { call: { operation: "count_known", targets: [target.id], whole: true }, locate, type: qtype };
  return { call: qtype === "count" ? { operation: "count_other", items: "items" } : { operation: "read" }, locate, type: qtype };
}

const CATEGORIES = [...new Set(TARGETS.flatMap((t) => t.categories))];

const INVENTORY_PROMPT = "Take the inventory of this floor plan.";
const IN_DOMAIN_SCORE = 0.6;
// A box that only outlines an item the reader has already found may be one the detector itself would not count.
const OUTLINE_SCORE = 0.2;
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

/** Why a question leaves the detectors, worded to follow "because". */
const WHY = {
  other: "our detectors do not know this kind of item",
  part: "our detectors count on the whole drawing only, not in a part of it",
  read: "our detectors count items and cannot read text, dimensions or tables",
  off: "the detectors are switched off",
  absent: "no detector weights are installed",
  unrecognised: "our detectors do not recognise this drawing, so their count would not be reliable",
};

/** The fallback, named by its tier: a model we host ourselves is not an outside one. */
const fallback = (vision: VisionModel, what: string, why: string) =>
  `${what} read by the ${tierOf(vision.id) === "self-hosted-model" ? "self-hosted" : "outside"} vision model ${vision.id} because ${why}`;

/** The answer to a question that only an outside vision model could answer, when the line-up has none. */
function unanswered(file: string, what: string, why: string, evidence: Answer["evidence"], advice: OutsideAdvice = UNCONFIGURED, kind?: string): Solved {
  const remedy = advice.remedy ? `. ${advice.remedy}` : "";
  return {
    value: null, pipeline: "none", exact: false, kind, evidence,
    method: `${what} not counted or read: only an outside vision model could, because ${why}, and ${advice.none}`,
    note: `No answer: this question needs an outside vision model, because ${why}, and ${advice.none}${remedy}.`,
    source: { calculatedBy: [], needed: `an outside vision model is needed, because ${why}; ${advice.none}${remedy}`, from: { file, used: "nothing" } },
    ...(advice.retry && { retry: { mode: advice.retry } }),
  };
}

const several = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : noun.endsWith("x") ? "es" : "s"}`;

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
export async function solveRaster(imagePath: string, question: string, reading: RasterReading, deps: RasterDeps): Promise<Solved> {
  const { call, locate, type } = reading;
  const file = deps.file ?? basename(imagePath);
  const { width = 0, height = 0 } = await sharp(imagePath).metadata();
  const image = (marks: Mark[], caption: string) => ({ kind: "image" as const, imageUrl: deps.imageUrl, width, height, marks, caption });
  const toMarks = (items: Located[]): Mark[] =>
    readingOrder(items, (item) => item, 1000 * ROW).map((item, i) => ({ n: i + 1, x: (item.x / 1000) * width, y: (item.y / 1000) * height }));

  const noExternal = deps.vision.id === "none";
  if (call.operation === "read") {
    if (noExternal) return unanswered(file, "the drawing was", WHY.read, image([], "Source drawing"), deps.advice);
    const { output } = await deps.vision.ask({ imagePath, system: FREE_SYSTEM, prompt: question, schema: FREE_SCHEMA });
    const unmarked = locate ? "Nothing is marked: the answer was read from the drawing as a whole, not from items that can be pointed at." : "";
    return {
      value: type === "text" ? output.answer : (output.value ?? output.answer), unit: output.unit ?? undefined, pipeline: "vision-model", exact: false,
      method: fallback(deps.vision, "the drawing", WHY.read), note: [output.explanation, unmarked].filter(Boolean).join(" ") || undefined, evidence: image([], "Source drawing"),
      source: { calculatedBy: [model(deps.vision.id, `read the answer off the drawing, because ${WHY.read}`)], from: { file, used: "the drawing image as a whole" } },
    };
  }

  const targets = call.operation === "count_known" ? targetsOf(call.targets) : [];
  if (call.operation === "count_other" || !call.whole) {
    const subject = call.operation === "count_other" ? call.items : `${targets.map((t) => t.plural).join(" and ")} in the part of the drawing the question names`;
    const why = call.operation === "count_other" ? WHY.other : WHY.part;
    if (noExternal) return unanswered(file, `${subject} were`, why, image([], "Source drawing"), deps.advice, "other");
    const { output } = await deps.vision.ask({ imagePath, system: COUNT_SYSTEM, prompt: question, schema: COUNT_SCHEMA });
    const items: Located[] = output.items ?? [];
    return {
      value: items.length > 0 ? items.length : output.count, unit: "count", pipeline: "vision-model", exact: false, kind: "other",
      method: fallback(deps.vision, subject, why),
      note: locate ? markedSentence(items.length, subject) : undefined,
      evidence: image(toMarks(items), "Each number is one counted item; positions are the model's estimate"),
      source: {
        calculatedBy: [model(deps.vision.id, `counted the ${subject}, because ${why}`)],
        from: { file, used: `the drawing image; ${several(items.length, "position")} the model pointed at` },
      },
    };
  }

  const parts: { target: Target; answer: Solved; marks: Mark[] }[] = [];
  for (const target of targets) {
    const answer = await countTarget(imagePath, file, target, deps, image, toMarks);
    parts.push({ target, answer, marks: answer.evidence?.kind === "image" ? answer.evidence.marks : [] });
  }
  const marked = (count: number, subject: string) =>
    // The detector boxes each storey's plan; the reader only gives the number of storeys.
    parts.every((part) => part.target.id === "floor" && part.answer.pipeline !== "detector")
      ? "Storeys are counted from the whole image; there is no single item to mark."
      : markedSentence(count, subject);
  if (parts.length === 1) {
    const [{ target, answer, marks }] = parts;
    return answer.value === null ? answer : { ...answer, note: locate ? marked(marks.length, target.plural) : undefined };
  }

  // Each kind keeps its own contributor and data, so the source shows which kind came from where.
  const source: Solved["source"] = {
    calculatedBy: parts.flatMap((part) => part.answer.source.calculatedBy),
    needed: [...new Set(parts.flatMap((part) => part.answer.source.needed ?? []))].join("; ") || undefined,
    from: { file, used: [...new Set(parts.filter((part) => part.answer.value !== null).map((part) => part.answer.source.from.used))].join("; ") || "nothing" },
  };
  const open = parts.filter((part) => part.answer.value === null);
  if (open.length > 0) {
    const counted = parts.filter((part) => part.answer.value !== null);
    const sofar = counted.length > 0 ? `Counted: ${counted.map((part) => `${part.answer.value} ${part.target.plural}`).join(" and ")}.` : "";
    const marks = counted.flatMap((part) => part.marks.map((mark) => ({ ...mark, label: mark.label ?? part.target.plural })));
    const retry = open.find((part) => part.answer.retry)?.answer.retry;
    return {
      value: null, unit: "count", pipeline: "none", exact: false, kind: parts.map((part) => part.target.id).join("+"),
      method: parts.map((part) => part.answer.method).join("; "),
      note: [sofar, `Not counted: ${open.map((part) => part.target.plural).join(" and ")}.`, ...new Set(open.map((part) => part.answer.note))].filter(Boolean).join(" "),
      evidence: image(marks.map((mark, i) => ({ ...mark, n: i + 1 })), "Each mark is one counted item, labelled with its kind"),
      source,
      ...(retry && { retry }),
    };
  }

  const total = parts.reduce((sum, part) => sum + (part.answer.value as number), 0);
  const subject = parts.map((part) => part.target.plural).join(" and ");
  const consists = `The total of ${total} consists of ${parts.map((part) => `${part.answer.value} ${part.target.plural}`).join(" and ")}.`;
  const marks = parts.flatMap((part) => part.marks.map((mark) => ({ ...mark, label: mark.label ?? part.target.plural })));
  const pipelines = new Set(parts.map((part) => part.answer.pipeline));
  return {
    // Kinds that came from different places: the reader's share makes the total a reading, otherwise a vote had a part in it.
    value: total, unit: "count", pipeline: pipelines.size === 1 ? parts[0].answer.pipeline : pipelines.has("vision-model") ? "vision-model" : "symbol-vote", exact: false, kind: parts.map((part) => part.target.id).join("+"),
    method: parts.map((part) => part.answer.method).join("; "),
    note: locate ? `${consists} ${marked(marks.length, subject)}` : consists,
    evidence: image(marks.map((mark, i) => ({ ...mark, n: i + 1 })), "Each mark is one counted item, labelled with its kind"),
    source,
  };
}

/** One count of a target on a drawing, with the items that were counted. */
interface Tally {
  /** The model's id with its provider, and the name sentences use for it. */
  id: string;
  name: string;
  count: number;
  boxes?: Detection[];
  points?: Located[];
}

/** The middle of several counts; the lower of the two middle ones when their number is even. */
export function middleCount(counts: number[]): number {
  const sorted = [...counts].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) / 2)];
}

/** A vote needs a middle: with fewer counts the routed detector answers alone. */
const VOTERS = 3;

/**
 * Counts one target on the whole drawing: with the detector routed to its classes, when the drawing is in the
 * detectors' style. Otherwise the reader's inventory of the drawing answers, which is one request shared by every such
 * question about it.
 *
 * The scope says what the detectors are given: "all" (default) every class they know; "symbols" the drawn symbols
 * only, room types and storeys going to the reader; "none" nothing. The line-up states it, else RASTER_DETECTOR_TARGETS.
 *
 * With `vote`, a drawn symbol is counted by every detector that knows its classes and by the reader's inventory, and
 * the middle count is the answer: on held-out drawings that beats each of them alone.
 */
async function countTarget(
  imagePath: string, file: string, target: Target, deps: RasterDeps,
  image: (marks: Mark[], caption: string) => Answer["evidence"], toMarks: (items: Located[]) => Mark[],
): Promise<Solved> {
  const { height = 0 } = await sharp(imagePath).metadata();
  const noReader = deps.vision.id === "none";
  // Without a reader there is nobody to leave room types to.
  const scope: string = deps.useDetector === false ? "none" : noReader ? "all" : (deps.scope ?? process.env.RASTER_DETECTOR_TARGETS ?? "all");
  const detector = scope === "none" ? null : deps.detector;
  const names = target.detectorClasses.map((cls) => cls.replace("_", " ")).join(" and ");
  const inventory = () => deps.vision.ask({ imagePath, system: inventorySystem(), schema: INVENTORY_SCHEMA, prompt: INVENTORY_PROMPT });
  const located = (output: Record<string, any>): Located[] => target.categories.flatMap((category) => output[category] ?? []);
  // The reader gives one position per item. Where our detector has a box of that kind around the position, the box
  // is shown, so the item is outlined like a detector's own; a position without one stays a numbered dot.
  let outlined = 0;
  const readerMarks = async (points: Located[]): Promise<Mark[]> => {
    const marks = toMarks(points);
    if (!detector || !target.detectorClasses.every((cls) => cls in detector.thresholds)) return marks;
    const boxes = (await detector.detect(imagePath)).filter((d) => target.detectorClasses.includes(d.cls) && d.score >= OUTLINE_SCORE);
    const taken = new Set<Detection>();
    return marks.map((mark) => {
      const [around] = boxes
        .filter((d) => !taken.has(d) && mark.x >= d.x && mark.x <= d.x + d.w && mark.y >= d.y && mark.y <= d.y + d.h)
        .sort((a, b) => a.w * a.h - b.w * b.h);
      if (!around) return mark;
      taken.add(around);
      outlined++;
      return { n: mark.n, x: around.x, y: around.y, w: around.w, h: around.h, label: `${around.cls.replace("_", " ")}, outlined by our detector` };
    });
  };
  const READER_CAPTION = "Each number is one item the reader counted; a box is our detector's outline of it, a dot the reader's estimate";
  const outlines = () => (outlined ? `, ${outlined} of them outlined by our detector` : "");

  let why: string;
  if (scope === "none") why = WHY.off;
  else if (!detector) why = WHY.absent;
  else if (!target.detectorClasses.every((cls) => cls in detector.thresholds)) why = `our detectors do not offer ${target.plural}`;
  else if (scope !== "all" && !target.symbol) why = deps.scope ? "the line-up leaves room types and storeys to the reader" : `RASTER_DETECTOR_TARGETS=${scope} leaves room types and storeys to it`;
  else {
    const scanned = await detector.detect(imagePath);
    // The detectors know one drawing style. On a drawing where they recognise almost nothing with confidence
    // (an elevation, a historic scan), their count would be a confident zero, so the vision model answers instead.
    if (scanned.filter((d) => d.score >= IN_DOMAIN_SCORE).length >= IN_DOMAIN_DETECTIONS) {
      const counted = (by: Detector, found: Detection[]) =>
        readingOrder(found.filter((d) => target.detectorClasses.includes(d.cls) && d.score >= by.thresholds[d.cls]), (d) => ({ x: d.x + d.w / 2, y: d.y + d.h / 2 }), height * ROW);
      const boxMarks = (found: Detection[]): Mark[] =>
        found.map((d, i) => ({ n: i + 1, x: d.x, y: d.y, w: d.w, h: d.h, label: `${d.cls.replace("_", " ")}, ${Math.round(d.score * 100)}% confidence` }));
      const what = target.id === "floor" ? "storey plans" : `${names} ${target.symbol ? "symbols" : "rooms"}`;
      const routed = detector.nameFor?.(target.detectorClasses[0]) ?? detector.id.split(":")[1];

      // Why the reader's count could not be had, when a vote was due: the routed detector then answers alone.
      let unheard = "";
      const voters = (detector.members ?? []).filter((member) => target.detectorClasses.every((cls) => cls in member.thresholds));
      if (deps.vote && target.symbol && !noReader && voters.length + 1 >= VOTERS) {
        const read = await inventory().catch((error) => {
          unheard = `; the reader ${deps.vision.id} gave no count for the vote (${error instanceof Error ? error.message : String(error)})`.slice(0, 200);
          return null;
        });
        if (read) {
          const tallies: Tally[] = await Promise.all(voters.map(async (member) => {
            const boxes = counted(member, await member.detect(imagePath));
            return { id: member.id, name: member.id.split(":")[1], count: boxes.length, boxes };
          }));
          // The marks are those of the first count that equals the middle: the routed detector's, then another detector's.
          tallies.sort((a, b) => Number(b.name === routed) - Number(a.name === routed));
          const points = located(read.output);
          tallies.push({ id: deps.vision.id, name: deps.vision.id, count: points.length, points });
          const middle = middleCount(tallies.map((tally) => tally.count));
          const shown = tallies.find((tally) => tally.count === middle)!;
          const pointed = shown.boxes ? [] : await readerMarks(shown.points ?? []);
          return {
            value: middle, unit: "count", pipeline: "symbol-vote", exact: false, kind: target.id,
            method: `middle of ${tallies.length} independent counts of ${what} (${tallies.map((tally) => `${tally.name}: ${tally.count}`).join("; ")})`,
            evidence: shown.boxes
              ? image(boxMarks(shown.boxes), `Each box is one counted ${names}, as found by ${shown.name}`)
              : image(pointed, outlined ? READER_CAPTION : "Each number is one counted item; positions are the reader's estimate"),
            source: {
              calculatedBy: [
                ...tallies.map((tally) => model(tally.id, `counted the ${target.plural}${tally.points ? " in its inventory of the drawing" : ""}: ${tally.count}`, tally.name)),
                script(SCRIPTS.vote, `took the middle of the ${tallies.length} counts: ${middle}`),
              ],
              from: {
                file,
                used: shown.boxes
                  ? `${several(middle, "detection box")} of class ${target.detectorClasses.join(" and ")} by ${shown.name} on the drawing image`
                  : `the drawing image; ${several(middle, "position")} in the reader's inventory of the drawing${outlines()}`,
              },
            },
          };
        }
      }

      const boxes = counted(detector, scanned);
      // A detector that is not our own weights (a hosted one) is named with its provider, like any outside model.
      const ours = tierOf(detector.id) === "own-model";
      const by = ours ? [...new Set(target.detectorClasses.map((cls) => detector.nameFor?.(cls) ?? detector.id.split(":")[1]))].join(" and ") : detector.id;
      return {
        value: boxes.length, unit: "count", pipeline: "detector", exact: false, kind: target.id,
        method: (ours ? `${what} counted by our detectors (${by}), no outside model` : `${what} counted by the outside detector ${by}`) + unheard,
        evidence: image(boxMarks(boxes), `Each box is one counted ${names}`),
        source: {
          calculatedBy: [model(detector.id, `counted the ${target.plural}${unheard}`, by)],
          from: { file, used: `${several(boxes.length, "detection box")} of class ${target.detectorClasses.join(" and ")} on the drawing image` },
        },
      };
    }
    why = WHY.unrecognised;
  }

  if (noReader) return unanswered(file, `${target.plural} were`, why, image([], "Source drawing"), deps.advice, target.id);
  const { output } = await inventory();
  const method = fallback(deps.vision, target.plural, why);
  const calculatedBy = [model(deps.vision.id, `counted the ${target.plural}, because ${why}`)];
  if (target.id === "floor") {
    return {
      value: output.floors, unit: "count", pipeline: "vision-model", exact: false, kind: target.id, method, evidence: image([], "Source drawing"),
      source: { calculatedBy, from: { file, used: "the drawing image as a whole" } },
    };
  }
  const points = located(output);
  const marks = await readerMarks(points);
  return {
    value: points.length, unit: "count", pipeline: "vision-model", exact: false, kind: target.id, method,
    evidence: image(marks, outlined ? READER_CAPTION : "Each number is one counted item; positions are the model's estimate"),
    source: { calculatedBy, from: { file, used: `the drawing image; ${several(points.length, "position")} in the model's inventory of the drawing${outlines()}` } },
  };
}
