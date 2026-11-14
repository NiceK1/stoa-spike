/**
 * Raster drawings. A vision model reads each drawing once into an inventory of located items
 * (windows, doors, fixtures, room types); every count question is then answered from that inventory.
 * Detectors, when configured, count the symbol classes they know, and the sources vote.
 * Either way the answer comes with numbered marks on the image, so a person can check each counted item.
 */
import sharp from "sharp";
import type { Detection, Detector } from "../models/detector.js";
import type { VisionModel } from "../models/vision.js";
import { markedSentence, planRaster, type RasterCall } from "../planner.js";
import type { Answer, Mark, QuestionType } from "../types.js";

export interface RasterDeps {
  vision: VisionModel;
  detector: Detector | null;
  /** URL the browser can load the image from. */
  imageUrl: string;
  /** Use the detector for the classes it offers. Off to measure the vision model alone. */
  useDetector?: boolean;
  /** Maps wording the target patterns do not know onto a target. Without it such a question goes the way its type says. */
  planner?: VisionModel | null;
}

export interface Target {
  id: string;
  /** The items as a plural noun phrase, for sentences and for the planner's menu. */
  plural: string;
  /** What tells this kind from its neighbours, for the planner. */
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

/** One source's count of a target, with the items it counted. */
export interface Tally {
  name: string;
  count: number;
  boxes?: Detection[];
  points?: Located[];
}

/** A way to count a target on one drawing. `tally` does the work, so a source that is not asked costs nothing. */
export interface Source {
  name: string;
  kind: "detector" | "vision";
  tally(): Promise<Tally>;
}

/**
 * Who answers a target where the default did not measure best: detectors by name, "vision" for the vision model.
 * With an even number of voters `upper` takes the higher middle count. Chosen on one set of held-out drawings and
 * kept only where a second set agreed (scripts/voters.ts). The default is a vote of every detector and the vision
 * model on symbols, and the vision model alone on room types and storeys.
 */
const ELECTORATE: Record<string, { voters: string[]; upper?: boolean }> = {
  // The vision model misses door leaves, which drags a three-way vote down.
  door: { voters: ["floorplan-yolo11m-1280"] },
  // Both sources overlook saunas more often than they invent one.
  sauna: { voters: ["floorplan-yolo11m-1280", "vision"], upper: true },
};

const CATEGORY_OF: Record<string, string> = Object.fromEntries(
  TARGETS.filter((t) => t.categories.length === 1 && t.detectorClasses.length === 1).map((t) => [t.detectorClasses[0], t.categories[0]]),
);
const SYMBOL_CLASSES = new Set(TARGETS.filter((t) => t.symbol).flatMap((t) => t.detectorClasses));
/** Detections down to this share of a class's threshold are passed to the vision model as unsure candidates. */
const UNSURE = 0.5;

const HINT_RULE =
  "Detector candidates: the request lists positions that a symbol detector found for some categories, in the same " +
  "coordinates. The detector finds most items, but it misses some and sometimes reports things that are not there; " +
  "a position followed by a question mark is one it was unsure about. Check every candidate against the drawing, " +
  "keep the real ones, drop the wrong ones and add every item it missed. Categories that are not listed were not scanned.";

/** INVENTORY_HINTS: "symbols" or "all" passes the detector's findings for those classes to the vision model. */
function hintedClasses(detector: Detector): string[] {
  const mode = process.env.INVENTORY_HINTS ?? "off";
  if (mode !== "symbols" && mode !== "all") return [];
  return Object.keys(detector.thresholds).filter((cls) => cls in CATEGORY_OF && (mode === "all" || SYMBOL_CLASSES.has(cls)));
}

function candidateList(detector: Detector, scanned: Detection[], width: number, height: number): string | null {
  const classes = hintedClasses(detector);
  if (classes.length === 0) return null;
  const lines = classes.map((cls) => {
    const sure = detector.thresholds[cls];
    const points = scanned
      .filter((d) => d.cls === cls && d.score >= sure * UNSURE)
      .sort((a, b) => a.y - b.y || a.x - b.x)
      .map((d) => `${Math.round(((d.x + d.w / 2) / width) * 1000)},${Math.round(((d.y + d.h / 2) / height) * 1000)}${d.score < sure ? "?" : ""}`);
    return `${CATEGORY_OF[cls]}: ${points.length > 0 ? points.join(" ") : "none"}`;
  });
  return `Detector candidates (x,y of each centre):\n${lines.join("\n")}`;
}

/**
 * Every independent way to count `target` on this drawing: each detector that knows its classes, when the drawing
 * is in the detectors' style, and the vision model's inventory (the middle of INVENTORY_VOTES readings).
 * `routed` is the count of the detector preferred for the target, for answering without a vote.
 *
 * RASTER_DETECTOR_TARGETS: "symbols" (default) lets the detectors count drawn symbols and leaves room types and
 * storeys to the vision model; "all" gives the detectors everything they know; "none" switches them off.
 */
export async function countSources(imagePath: string, target: Target, deps: RasterDeps): Promise<{ sources: Source[]; routed: Tally | null }> {
  const { width = 0, height = 0 } = await sharp(imagePath).metadata();
  const scope = deps.useDetector === false ? "none" : (process.env.RASTER_DETECTOR_TARGETS ?? "symbols");
  const detector = scope === "none" ? null : deps.detector;
  const known = (model: Detector) => target.detectorClasses.every((cls) => cls in model.thresholds);
  const answers = detector !== null && known(detector) && (scope === "all" || target.symbol === true);
  const counts = answers || (detector !== null && known(detector) && target.id in ELECTORATE);
  const scanned = detector && (counts || hintedClasses(detector).length > 0) ? await detector.detect(imagePath) : null;
  // The detectors know one drawing style. On a drawing where they recognise almost nothing with confidence
  // (an elevation, a historic scan), their count would be a confident zero, so they are left out.
  const trusted = scanned !== null && scanned.filter((d) => d.score >= IN_DOMAIN_SCORE).length >= IN_DOMAIN_DETECTIONS;
  const counted = (model: Detector, all: Detection[]) =>
    readingOrder(
      all.filter((d) => target.detectorClasses.includes(d.cls) && d.score >= model.thresholds[d.cls]),
      (d) => ({ x: d.x + d.w / 2, y: d.y + d.h / 2 }), height * ROW,
    );

  const sources: Source[] = [];
  if (detector && trusted && counts) {
    for (const model of (detector.members ?? [detector]).filter(known)) {
      const name = model.id.split(":")[1];
      sources.push({
        name, kind: "detector",
        tally: async () => {
          const boxes = counted(model, await model.detect(imagePath));
          return { name, count: boxes.length, boxes };
        },
      });
    }
  }

  const hints = detector && trusted ? candidateList(detector, scanned!, width, height) : null;
  const system = hints ? `${inventorySystem()}\n\n${HINT_RULE}` : inventorySystem();
  const votes = Math.max(1, Number(process.env.INVENTORY_VOTES ?? 1));
  sources.push({
    name: deps.vision.id, kind: "vision",
    tally: async () => {
      // Several independent readings, answered by the middle one: a single reading is off by one too often.
      const readings = await Promise.all(
        Array.from({ length: votes }, (_, pass) => {
          const request = pass === 0 ? INVENTORY_PROMPT : `${INVENTORY_PROMPT} (Independent reading ${pass + 1}.)`;
          return deps.vision.ask({ imagePath, system, schema: INVENTORY_SCHEMA, prompt: hints ? `${request}\n\n${hints}` : request });
        }),
      );
      const itemsOf = (output: Record<string, any>): Located[] => target.categories.flatMap((c) => output[c] ?? []);
      const countOf = (output: Record<string, any>): number => (target.id === "floor" ? output.floors : itemsOf(output).length);
      const middle = readings.map((r) => countOf(r.output)).sort((a, b) => a - b)[Math.floor(votes / 2)];
      const chosen = readings.find((r) => countOf(r.output) === middle)!.output;
      return {
        name: votes > 1 ? `${deps.vision.id}, middle of ${votes} readings` : deps.vision.id, count: middle,
        points: target.id === "floor" ? undefined : itemsOf(chosen),
      };
    },
  });

  if (!detector || !trusted || !answers) return { sources, routed: null };
  const boxes = counted(detector, scanned!);
  return { sources, routed: { name: detector.nameFor?.(target.detectorClasses[0]) ?? detector.id.split(":")[1], count: boxes.length, boxes } };
}

/** `locate` marks a request to be shown the items: the answer then carries a sentence saying what was marked. */
export async function solveRaster(imagePath: string, question: string, qtype: QuestionType, deps: RasterDeps, locate = false): Promise<Answer> {
  const { width = 0, height = 0 } = await sharp(imagePath).metadata();
  const image = (marks: Mark[], caption: string) => ({ kind: "image" as const, imageUrl: deps.imageUrl, width, height, marks, caption });
  const toMarks = (items: Located[]): Mark[] =>
    readingOrder(items, (item) => item, 1000 * ROW).map((item, i) => ({ n: i + 1, x: (item.x / 1000) * width, y: (item.y / 1000) * height }));

  let target = qtype === "count" ? rasterTarget(question) : null;
  let call: RasterCall | null = null;
  if (!target && deps.planner && (qtype === "count" || qtype === "text")) {
    call = await planRaster(question, TARGETS.map((t) => ({ id: t.id, description: t.hint ? `${t.plural} (${t.hint})` : t.plural })), deps.planner);
    if (call?.operation === "count_known") target = TARGETS.find((t) => t.id === (call as { target: string }).target) ?? null;
  }
  const show = locate || (call !== null && call.operation !== "free" && call.locate);
  const understood = (reading: string) => (call ? `understood as "${reading}" by ${deps.planner!.id}; ` : "");
  const counting = target !== null || call?.operation === "count_other" || (qtype === "count" && call?.operation !== "free");

  if (!counting) {
    const { output } = await deps.vision.ask({ imagePath, system: FREE_SYSTEM, prompt: question, schema: FREE_SCHEMA });
    return {
      value: qtype === "text" ? output.answer : (output.value ?? output.answer), unit: output.unit ?? undefined, pipeline: "vision-model", exact: false,
      method: `read from the drawing by ${deps.vision.id}`, note: output.explanation, evidence: image([], "Source drawing"),
    };
  }

  if (!target) {
    const { output } = await deps.vision.ask({ imagePath, system: COUNT_SYSTEM, prompt: question, schema: COUNT_SCHEMA });
    const items: Located[] = output.items ?? [];
    const subject = call?.operation === "count_other" ? call.items : "items";
    return {
      value: items.length > 0 ? items.length : output.count, unit: "count", pipeline: "vision-model", exact: false, kind: "other",
      method: `${understood(`count ${subject}`)}items listed by ${deps.vision.id}`,
      note: show ? markedSentence(items.length, subject) : undefined,
      evidence: image(toMarks(items), "Each number is one counted item; positions are the model's estimate"),
    };
  }

  const answer = await countTarget(imagePath, target, deps, image, toMarks);
  const marked = answer.evidence?.kind === "image" ? answer.evidence.marks.length : 0;
  return {
    ...answer, method: understood(`count ${target.plural}`) + answer.method,
    note: show && target.id !== "floor" ? markedSentence(marked, target.plural) : undefined,
  };
}

async function countTarget(
  imagePath: string, target: Target, deps: RasterDeps,
  image: (marks: Mark[], caption: string) => Answer["evidence"], toMarks: (items: Located[]) => Mark[],
): Promise<Answer> {
  const names = target.detectorClasses.map((cls) => cls.replace("_", " ")).join(" and ");
  const boxMarks = (found: Detection[]): Mark[] =>
    found.map((d, i) => ({ n: i + 1, x: d.x, y: d.y, w: d.w, h: d.h, label: `${d.cls.replace("_", " ")}, ${Math.round(d.score * 100)}% confidence` }));
  const { sources, routed } = await countSources(imagePath, target, deps);
  const what = `${names} ${target.symbol ? "symbols" : "rooms"}`;

  const single = (tally: Tally): Answer => {
    if (tally.boxes) {
      return {
        value: tally.count, unit: "count", pipeline: "detector", exact: false, kind: target.id,
        method: `${what} found by the detector ${tally.name}`, evidence: image(boxMarks(tally.boxes), `Each box is one counted ${names}`),
      };
    }
    if (target.id === "floor") {
      return {
        value: tally.count, unit: "count", pipeline: "vision-model", exact: false, kind: target.id,
        method: `storeys counted by ${tally.name}`, evidence: image([], "Source drawing"),
      };
    }
    return {
      value: tally.count, unit: "count", pipeline: "vision-model", exact: false, kind: target.id,
      method: `${target.categories.join(" and ").replaceAll("_", " ")} located by ${tally.name}`,
      evidence: image(toMarks(tally.points ?? []), "Each number is one counted item; positions are the model's estimate"),
    };
  };

  // With two or more detectors, a symbol is counted by each of them and by the vision model, and the middle
  // count wins: on held-out drawings that beats every single source. RASTER_SYMBOL_VOTE=off disables voting.
  const voting = process.env.RASTER_SYMBOL_VOTE !== "off";
  const rule = voting ? ELECTORATE[target.id] : undefined;
  const named = rule ? sources.filter((s) => rule.voters.includes(s.kind === "vision" ? "vision" : s.name)) : [];
  const everyone = voting && routed && target.symbol && sources.filter((s) => s.kind === "detector").length >= 2 ? sources : [];
  const voters = named.length > 0 ? named : everyone;

  if (voters.length === 1) return single(await voters[0].tally());
  if (voters.length > 1) {
    const tallies = await Promise.all(voters.map((s) => s.tally()));
    const counts = tallies.map((t) => t.count).sort((a, b) => a - b);
    const chosen = counts[rule?.upper ? Math.floor(counts.length / 2) : Math.floor((counts.length - 1) / 2)];
    const which = counts.length === 2 ? (rule?.upper ? "higher" : "lower") : "middle";
    const boxes = tallies.find((t) => t.boxes && t.count === chosen);
    const located = tallies.find((t) => t.points && t.count === chosen) ?? tallies.find((t) => t.points);
    return {
      value: chosen, unit: "count", pipeline: "symbol-vote", exact: false, kind: target.id,
      method: `${which} of ${counts.length} independent counts of ${what} (${tallies.map((t) => `${t.name}: ${t.count}`).join("; ")})`,
      evidence: boxes
        ? image(boxMarks(boxes.boxes!), `Each box is one counted ${names}, as found by ${boxes.name}`)
        : image(toMarks(located?.points ?? []), "Each number is one counted item; positions are the vision model's estimate"),
    };
  }

  return single(routed ?? (await sources.find((s) => s.kind === "vision")!.tally()));
}
