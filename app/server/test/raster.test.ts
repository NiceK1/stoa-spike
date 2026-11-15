import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Detection, Detector } from "../src/models/detector.js";
import type { VisionModel, VisionRequest } from "../src/models/vision.js";
import type { RasterReading } from "../src/planner.js";
import { readByKeywords, solveRaster, type RasterDeps } from "../src/solvers/raster.js";

let drawing = "";
beforeAll(async () => {
  drawing = join(mkdtempSync(join(tmpdir(), "raster-test-")), "plan.png");
  await sharp({ create: { width: 200, height: 100, channels: 3, background: "#ffffff" } }).png().toFile(drawing);
});
afterEach(() => {
  delete process.env.RASTER_DETECTOR_TARGETS;
});

const box = (cls: string, score: number, x = 10, y = 10): Detection => ({ cls, score, x, y, w: 20, h: 10 });
const THRESHOLDS = { window: 0.5, door: 0.5, sauna: 0.5, bedroom: 0.5, floor: 0.5 };
/** Two models behind one detector: `symbols` is routed the windows, `rooms` everything else. */
function routed(detections: Detection[], thresholds: Record<string, number> = THRESHOLDS): Detector & { scans: number } {
  const detector = {
    id: "onnx:symbols+rooms", thresholds, scans: 0,
    nameFor: (cls: string) => (cls === "window" ? "symbols" : "rooms"),
    detect: async () => {
      detector.scans++;
      return detections;
    },
  };
  return detector;
}

type Recording = VisionModel & { requests: VisionRequest[] };
/**
 * A vision model that records what it was asked. Its inventory has `windows` windows, two bedrooms and one storey;
 * a located count lists one item, and a free reading says "Scale 1:100".
 */
function vision(windows: number): Recording {
  const requests: VisionRequest[] = [];
  return {
    id: "fake-vision", requests,
    ask: async (request) => {
      requests.push(request);
      const properties = request.schema.properties as object;
      const inventory = { floors: 1, windows: Array.from({ length: windows }, (_, i) => ({ x: 100 * i, y: 500 })), bedrooms: [{ x: 100, y: 200 }, { x: 600, y: 200 }] };
      const output =
        "answer" in properties ? { answer: "Scale 1:100", value: null, unit: null, explanation: "" }
        : "items" in properties ? { items: [{ x: 250, y: 250 }], count: 1 }
        : inventory;
      return { output, seconds: 0, costUsd: 0, cached: false };
    },
  };
}
/** The app without an outside model. Asking it is the error the solver must not run into. */
const noVision: VisionModel = {
  id: "none",
  ask: async () => {
    throw new Error("This question needs a vision model");
  },
};

const windows = (n: number, score = 0.9) => Array.from({ length: n }, (_, i) => box("window", score, 10 + 30 * i));
const WINDOWS = "How many windows are shown on this floor plan?";
const BEDROOMS = "How many bedrooms (makuuhuone, usually marked MH) are on this floor plan?";
const STOREYS = "How many floors (storeys) does this floor plan show?";
const NO_OUTSIDE = "and none is configured (VISION_PROVIDER=none).";
const count = (question: string, deps: Omit<RasterDeps, "imageUrl">) => solveRaster(drawing, question, readByKeywords(question, "count"), { ...deps, imageUrl: "/plan.png" });

describe("counting symbols on a raster drawing", () => {
  it("counts a symbol with the detector routed to its class, and does not ask the vision model", async () => {
    const model = vision(9);
    const answer = await count(WINDOWS, { vision: model, detector: routed(windows(4)) });
    expect(answer).toMatchObject({ value: 4, pipeline: "detector", kind: "window" });
    expect(answer.method).toBe("window symbols counted by our detectors (symbols), no outside model");
    expect(answer.evidence?.kind === "image" && answer.evidence.marks.map((m) => m.n)).toEqual([1, 2, 3, 4]);
    expect(model.requests).toHaveLength(0);
  });

  it("leaves detections below the class threshold out of the count", async () => {
    const found = [...windows(3), box("window", 0.3, 150), box("door", 0.9, 150)];
    expect((await count(WINDOWS, { vision: vision(9), detector: routed(found) })).value).toBe(3);
  });

  it("falls back to the outside vision model when the detectors do not recognise the drawing, and says so", async () => {
    const answer = await count(WINDOWS, { vision: vision(7), detector: routed(windows(6, 0.55)) });
    expect(answer).toMatchObject({ value: 7, pipeline: "vision-model" });
    expect(answer.method).toBe("windows read by the outside vision model fake-vision because our detectors do not recognise this drawing, so their count would not be reliable");
  });

  it("numbers the counted items in reading order", async () => {
    const found = [box("window", 0.9, 150, 10), box("window", 0.9, 10, 12), box("window", 0.9, 80, 11), box("window", 0.9, 120, 60)];
    const answer = await count(WINDOWS, { vision: vision(4), detector: routed(found) });
    expect(answer.evidence?.kind === "image" && answer.evidence.marks.map((m) => [m.n, m.x])).toEqual([[1, 10], [2, 80], [3, 150], [4, 120]]);
  });

  it("adds up several kinds, each from its own detector, and marks them all", async () => {
    const found = [...windows(3), box("door", 0.9, 10, 60), box("door", 0.9, 60, 60)];
    const reading = { call: { operation: "count_known" as const, targets: ["window", "door"], whole: true }, locate: true, type: "count" as const };
    const answer = await solveRaster(drawing, "show me the doors and windows", reading, { vision: vision(0), detector: routed(found), imageUrl: "/plan.png" });
    expect(answer).toMatchObject({ value: 5, kind: "window+door", pipeline: "detector" });
    expect(answer.note).toBe("The total of 5 consists of 3 windows and 2 doors. Windows and doors: 5 marked on the drawing.");
    expect(answer.method).toBe("window symbols counted by our detectors (symbols), no outside model; door symbols counted by our detectors (rooms), no outside model");
    expect(answer.evidence?.kind === "image" && answer.evidence.marks.map((m) => m.n)).toEqual([1, 2, 3, 4, 5]);
  });
});

describe("room types and storeys on a raster drawing", () => {
  const rooms = () => routed([...windows(4), box("bedroom", 0.9), box("bedroom", 0.9, 60), box("bedroom", 0.9, 110), box("floor", 0.9, 0, 0)]);

  it("are counted by the detectors by default, without asking the vision model", async () => {
    const model = vision(0);
    const bedrooms = await count(BEDROOMS, { vision: model, detector: rooms() });
    const storeys = await count(STOREYS, { vision: model, detector: rooms() });
    expect(bedrooms).toMatchObject({ value: 3, pipeline: "detector", kind: "bedroom" });
    expect(bedrooms.method).toBe("bedroom rooms counted by our detectors (rooms), no outside model");
    expect(bedrooms.evidence?.kind === "image" && bedrooms.evidence.marks).toHaveLength(3);
    expect(storeys).toMatchObject({ value: 1, pipeline: "detector", kind: "floor" });
    expect(storeys.method).toBe("storey plans counted by our detectors (rooms), no outside model");
    expect(model.requests).toHaveLength(0);
  });

  it("come from one inventory by the vision model with RASTER_DETECTOR_TARGETS=symbols, which the method names", async () => {
    process.env.RASTER_DETECTOR_TARGETS = "symbols";
    const model = vision(0);
    const detector = rooms();
    const bedrooms = await count(BEDROOMS, { vision: model, detector });
    const storeys = await count(STOREYS, { vision: model, detector });
    expect(bedrooms).toMatchObject({ value: 2, pipeline: "vision-model", kind: "bedroom" });
    expect(bedrooms.method).toBe("bedrooms read by the outside vision model fake-vision because RASTER_DETECTOR_TARGETS=symbols leaves room types and storeys to it");
    expect(storeys).toMatchObject({ value: 1, pipeline: "vision-model", kind: "floor" });
    // The same request, so the two questions share one cached reading of the drawing.
    expect(model.requests).toHaveLength(2);
    expect(model.requests[1]).toEqual(model.requests[0]);
    expect((await count(WINDOWS, { vision: model, detector })).pipeline).toBe("detector");
  });

  it("outlines an item the reader counted with our detector's box around it, and leaves a dot where there is none", async () => {
    process.env.RASTER_DETECTOR_TARGETS = "symbols";
    // The reader's two bedrooms sit at 20 and 120 px; the detector has a bedroom box around the first only.
    const detector = routed([box("bedroom", 0.3), box("bedroom", 0.9, 60)]);
    const bedrooms = await count(BEDROOMS, { vision: vision(0), detector });
    expect(bedrooms.value).toBe(2);
    expect(bedrooms.evidence).toMatchObject({
      marks: [{ n: 1, x: 10, y: 10, w: 20, h: 10, label: "bedroom, outlined by our detector" }, { n: 2, x: 120, y: 20 }],
      caption: "Each number is one item the reader counted; a box is our detector's outline of it, a dot the reader's estimate",
    });
    expect(bedrooms.evidence?.kind === "image" && bedrooms.evidence.marks[1].w).toBeUndefined();
    expect(bedrooms.source.from.used).toBe("the drawing image; 2 positions in the model's inventory of the drawing, 1 of them outlined by our detector");
  });

  it("go to the vision model for a kind the installed detectors do not offer", async () => {
    const answer = await count(STOREYS, { vision: vision(0), detector: routed(windows(4), { window: 0.5, door: 0.5 }) });
    expect(answer).toMatchObject({ value: 1, pipeline: "vision-model" });
    expect(answer.method).toBe("storeys read by the outside vision model fake-vision because our detectors do not offer storeys");
  });

  it("answers a request to show the storeys with the detector's box around each storey plan", async () => {
    const question = "show me the floors";
    const detector = routed([...windows(4), box("floor", 0.9, 0, 0), box("floor", 0.9, 100, 0)]);
    const answer = await solveRaster(drawing, question, readByKeywords(question, "count", true), { vision: vision(0), detector, imageUrl: "/plan.png" });
    expect(answer).toMatchObject({ value: 2, pipeline: "detector", note: "Storeys: 2 marked on the drawing." });
    expect(answer.evidence?.kind === "image" && answer.evidence.marks).toHaveLength(2);
  });

  it("says why a request to show the storeys has no marks when the outside model counted them", async () => {
    const question = "show me the floors";
    const answer = await solveRaster(drawing, question, readByKeywords(question, "count", true), { vision: vision(0), detector: null, imageUrl: "/plan.png" });
    expect(answer).toMatchObject({ value: 1, note: "Storeys are counted from the whole image; there is no single item to mark." });
    expect(answer.method).toBe("storeys read by the outside vision model fake-vision because no detector weights are installed");
  });
});

describe("the source of a raster answer", () => {
  const STAIRS = { call: { operation: "count_other" as const, items: "staircases" }, locate: false, type: "count" as const };

  it("names the detector that counted as our own model, and its boxes as the data", async () => {
    const answer = await count(WINDOWS, { vision: vision(9), detector: routed(windows(4)) });
    expect(answer.source).toEqual({
      calculatedBy: [{ name: "symbols", label: "Blueline detector", tier: "own-model", did: "counted the windows" }],
      from: { file: "plan.png", used: "4 detection boxes of class window on the drawing image" },
    });
  });

  it("lists every detector with the kind it counted when several kinds are asked", async () => {
    const found = [...windows(3), box("door", 0.9, 10, 60)];
    const reading = { call: { operation: "count_known" as const, targets: ["window", "door"], whole: true }, locate: false, type: "count" as const };
    const answer = await solveRaster(drawing, "doors and windows", reading, { vision: vision(0), detector: routed(found), imageUrl: "/plan.png" });
    expect(answer.source.calculatedBy).toEqual([
      { name: "symbols", label: "Blueline detector", tier: "own-model", did: "counted the windows" },
      { name: "rooms", label: "Blueline detector", tier: "own-model", did: "counted the doors" },
    ]);
    expect(answer.source.from.used).toBe("3 detection boxes of class window on the drawing image; 1 detection box of class door on the drawing image");
  });

  it("names the model a fallback went to, its tier and the reason", async () => {
    const external = { ...vision(7), id: "claude-cli:claude-sonnet-5-5" };
    const answer = await count(WINDOWS, { vision: external, detector: routed(windows(6, 0.55)) });
    expect(answer.source).toEqual({
      calculatedBy: [{ name: "claude-cli:claude-sonnet-5-5", label: "Claude Sonnet 5.5 (Anthropic)", tier: "external-model", did: "counted the windows, because our detectors do not recognise this drawing, so their count would not be reliable" }],
      from: { file: "plan.png", used: "the drawing image; 7 positions in the model's inventory of the drawing" },
    });
    const hosted = { ...vision(7), id: "openai-compatible:gemma-4-31b" };
    const ours = await solveRaster(drawing, "how many staircases?", STAIRS, { vision: hosted, detector: null, imageUrl: "/plan.png" });
    expect(ours.source.calculatedBy).toMatchObject([{ name: "openai-compatible:gemma-4-31b", tier: "self-hosted-model" }]);
    expect(ours.method).toBe("staircases read by the self-hosted vision model openai-compatible:gemma-4-31b because our detectors do not know this kind of item");
  });

  it("does not call a detector hosted elsewhere ours", async () => {
    const hosted: Detector = { id: "roboflow:floor-plans/3", thresholds: THRESHOLDS, detect: async () => windows(4) };
    const answer = await count(WINDOWS, { vision: vision(9), detector: hosted });
    expect(answer).toMatchObject({ value: 4, pipeline: "detector" });
    expect(answer.source.calculatedBy).toEqual([{ name: "roboflow:floor-plans/3", label: "floor-plans/3 (Roboflow)", tier: "external-model", did: "counted the windows" }]);
    expect(answer.method).toBe("window symbols counted by the outside detector roboflow:floor-plans/3");
  });

  it("says what it would have taken when no outside model is configured", async () => {
    const none = await solveRaster(drawing, "how many staircases?", STAIRS, { vision: noVision, detector: routed(windows(4)), imageUrl: "/plan.png" });
    expect(none.source).toEqual({
      calculatedBy: [], from: { file: "plan.png", used: "nothing" },
      needed: "an outside vision model is needed, because our detectors do not know this kind of item; none is configured (VISION_PROVIDER=none)",
    });
    // One kind counted, the other not: the source keeps the detector and says what is missing.
    const reading = { call: { operation: "count_known" as const, targets: ["window", "floor"], whole: true }, locate: false, type: "count" as const };
    const partly = await solveRaster(drawing, "windows and storeys", reading, { vision: noVision, detector: routed(windows(4), { window: 0.5 }), imageUrl: "/plan.png" });
    expect(partly.source.calculatedBy).toMatchObject([{ name: "symbols", tier: "own-model" }]);
    expect(partly.source.needed).toContain("because our detectors do not offer storeys");
  });
});

describe("what the detectors cannot do", () => {
  const solve = (question: string, call: RasterReading["call"], vision: VisionModel, detector: Detector | null = routed(windows(4))) =>
    solveRaster(drawing, question, { call, locate: false, type: call.operation === "read" ? "text" : "count" }, { vision, detector, imageUrl: "/plan.png" });
  const OTHER = { operation: "count_other" as const, items: "staircases" };
  const PART = { operation: "count_known" as const, targets: ["sink"], whole: false };
  const READ = { operation: "read" as const };

  it("goes to the outside vision model, and the method says which model and why", async () => {
    const other = await solve("how many staircases?", OTHER, vision(0));
    expect(other).toMatchObject({ value: 1, pipeline: "vision-model" });
    expect(other.method).toBe("staircases read by the outside vision model fake-vision because our detectors do not know this kind of item");

    const part = await solve("the kitchen sink", PART, vision(0));
    expect(part).toMatchObject({ value: 1, pipeline: "vision-model" });
    expect(part.method).toBe(
      "sinks and wash basins in the part of the drawing the question names read by the outside vision model fake-vision because our detectors count on the whole drawing only, not in a part of it",
    );

    const read = await solve("what scale is this drawn at?", READ, vision(0));
    expect(read).toMatchObject({ value: "Scale 1:100", pipeline: "vision-model" });
    expect(read.method).toBe("the drawing read by the outside vision model fake-vision because our detectors count items and cannot read text, dimensions or tables");
  });

  it("gets an answer with no value and the reason when no outside model is configured", async () => {
    const other = await solve("how many staircases?", OTHER, noVision);
    expect(other).toMatchObject({ value: null, pipeline: "none" });
    expect(other.note).toBe(`No answer: this question needs an outside vision model, because our detectors do not know this kind of item, ${NO_OUTSIDE}`);
    expect(other.method).toContain("staircases were not counted or read");
    expect(other.evidence?.kind === "image" && other.evidence.marks).toEqual([]);

    expect((await solve("the kitchen sink", PART, noVision)).note).toContain("because our detectors count on the whole drawing only, not in a part of it");
    expect(await solve("what scale is this drawn at?", READ, noVision)).toMatchObject({
      value: null, pipeline: "none", note: `No answer: this question needs an outside vision model, because our detectors count items and cannot read text, dimensions or tables, ${NO_OUTSIDE}`,
    });
  });

  it("still counts every kind the detectors know when no outside model is configured, whatever the setting", async () => {
    process.env.RASTER_DETECTOR_TARGETS = "symbols";
    const detector = routed([...windows(4), box("bedroom", 0.9), box("sauna", 0.9, 60)]);
    expect(await count(BEDROOMS, { vision: noVision, detector })).toMatchObject({ value: 1, pipeline: "detector" });
    expect(await count("How many saunas are on this floor plan?", { vision: noVision, detector })).toMatchObject({ value: 1, pipeline: "detector" });
  });

  it("has no value for a known kind without an outside model when the detectors do not offer it or do not recognise the drawing", async () => {
    const storeys = await count(STOREYS, { vision: noVision, detector: routed(windows(4), { window: 0.5 }) });
    expect(storeys).toMatchObject({ value: null, pipeline: "none", kind: "floor" });
    expect(storeys.note).toBe(`No answer: this question needs an outside vision model, because our detectors do not offer storeys, ${NO_OUTSIDE}`);

    const unrecognised = await count(WINDOWS, { vision: noVision, detector: routed(windows(6, 0.55)) });
    expect(unrecognised).toMatchObject({ value: null, pipeline: "none", kind: "window" });
    expect(unrecognised.note).toContain("because our detectors do not recognise this drawing, so their count would not be reliable");
  });

  it("marks what was counted and says what was not, when one of several kinds needs the missing outside model", async () => {
    const call = { operation: "count_known" as const, targets: ["window", "floor"], whole: true };
    const answer = await solve("windows and storeys", call, noVision, routed(windows(4), { window: 0.5 }));
    expect(answer).toMatchObject({ value: null, pipeline: "none", kind: "window+floor" });
    expect(answer.note).toBe(`Counted: 4 windows. Not counted: storeys. No answer: this question needs an outside vision model, because our detectors do not offer storeys, ${NO_OUTSIDE}`);
    expect(answer.evidence?.kind === "image" && answer.evidence.marks).toHaveLength(4);
  });

  it("says which mode would answer and offers it, when the line-up states that it has no outside model", async () => {
    const advice = { none: "Blueline only calls none", remedy: "Best accuracy, or a reader chosen in Custom, would answer it", retry: "best" as const };
    const answer = await solveRaster(drawing, "the kitchen sink", { call: PART, locate: false, type: "count" }, { vision: noVision, detector: routed(windows(4)), imageUrl: "/plan.png", advice });
    expect(answer).toMatchObject({ value: null, retry: { mode: "best" } });
    expect(answer.source.needed).toBe(
      "an outside vision model is needed, because our detectors count on the whole drawing only, not in a part of it; Blueline only calls none. Best accuracy, or a reader chosen in Custom, would answer it",
    );
    // One of several kinds is open: the offer is on the whole answer.
    const call = { operation: "count_known" as const, targets: ["window", "floor"], whole: true };
    const partly = await solveRaster(drawing, "windows and storeys", { call, locate: false, type: "count" }, { vision: noVision, detector: routed(windows(4), { window: 0.5 }), imageUrl: "/plan.png", advice });
    expect(partly).toMatchObject({ value: null, retry: { mode: "best" } });
    expect((await solve("the kitchen sink", PART, noVision)).retry).toBeUndefined();
  });
});

describe("a line-up that states what the detectors count", () => {
  const rooms = () => routed([...windows(4), box("bedroom", 0.9), box("bedroom", 0.9, 60), box("bedroom", 0.9, 110)]);

  it("leaves room types to the reader with the scope 'symbols', whatever the environment says", async () => {
    process.env.RASTER_DETECTOR_TARGETS = "all";
    const model = vision(0);
    const bedrooms = await count(BEDROOMS, { vision: model, detector: rooms(), scope: "symbols" });
    expect(bedrooms).toMatchObject({ value: 2, pipeline: "vision-model" });
    expect(bedrooms.method).toBe("bedrooms read by the outside vision model fake-vision because the line-up leaves room types and storeys to the reader");
    expect(await count(WINDOWS, { vision: model, detector: rooms(), scope: "symbols" })).toMatchObject({ value: 4, pipeline: "detector" });
  });

  it("gives the detectors every kind with the scope 'all', whatever the environment says", async () => {
    process.env.RASTER_DETECTOR_TARGETS = "symbols";
    expect(await count(BEDROOMS, { vision: vision(0), detector: rooms(), scope: "all" })).toMatchObject({ value: 3, pipeline: "detector" });
  });
});

describe("the vote on a drawn symbol", () => {
  /** Two detectors behind one, as in the app: `symbols` is routed the windows, and `rooms` knows them as well. */
  function pair(symbols: number, others: number): Detector {
    const member = (name: string, found: number): Detector => ({ id: `onnx:${name}`, thresholds: THRESHOLDS, detect: async () => [...windows(found), box("bedroom", 0.9, 10, 60)] });
    const routedTo = member("symbols", symbols);
    return { id: "onnx:symbols+rooms", thresholds: THRESHOLDS, nameFor: (cls) => (cls === "window" ? "symbols" : "rooms"), detect: routedTo.detect, members: [member("rooms", others), routedTo] };
  }
  const voted = (detector: Detector, model: VisionModel) => count(WINDOWS, { vision: model, detector, scope: "symbols", vote: true });

  it("takes the middle of the counts of every detector and of the reader's inventory, and says so", async () => {
    const answer = await voted(pair(4, 6), vision(5));
    expect(answer).toMatchObject({ value: 5, pipeline: "symbol-vote", kind: "window" });
    expect(answer.method).toBe("middle of 3 independent counts of window symbols (symbols: 4; rooms: 6; fake-vision: 5)");
    expect(answer.source).toEqual({
      calculatedBy: [
        { name: "symbols", label: "Blueline detector", tier: "own-model", did: "counted the windows: 4" },
        { name: "rooms", label: "Blueline detector", tier: "own-model", did: "counted the windows: 6" },
        { name: "fake-vision", tier: "external-model", did: "counted the windows in its inventory of the drawing: 5" },
        { name: "Middle count script", tier: "script", did: "took the middle of the 3 counts: 5" },
      ],
      from: { file: "plan.png", used: "the drawing image; 5 positions in the reader's inventory of the drawing" },
    });
  });

  it("marks the items of a count that equals the middle: the routed detector's boxes first, then the other detector's, then the reader's positions", async () => {
    const caption = (answer: Awaited<ReturnType<typeof voted>>) => (answer.evidence?.kind === "image" ? [answer.evidence.caption, answer.evidence.marks.length, answer.evidence.marks[0]?.w] : null);
    const both = await voted(pair(5, 5), vision(9));
    expect(both.value).toBe(5);
    expect(caption(both)).toEqual(["Each box is one counted window, as found by symbols", 5, 20]);
    const other = await voted(pair(4, 5), vision(5));
    expect(caption(other)).toEqual(["Each box is one counted window, as found by rooms", 5, 20]);
    expect(other.source.from.used).toBe("5 detection boxes of class window by rooms on the drawing image");
    const reader = await voted(pair(4, 6), vision(5));
    expect(caption(reader)).toEqual(["Each number is one counted item; positions are the reader's estimate", 5, undefined]);
  });

  it("is not held on room types, which that line-up gives to the reader", async () => {
    const answer = await count(BEDROOMS, { vision: vision(0), detector: pair(4, 4), scope: "symbols", vote: true });
    expect(answer).toMatchObject({ value: 2, pipeline: "vision-model" });
  });

  it("leaves a drawing the detectors do not recognise to the reader alone", async () => {
    const unsure = pair(0, 6);
    unsure.detect = async () => windows(6, 0.55);
    const answer = await voted(unsure, vision(7));
    expect(answer).toMatchObject({ value: 7, pipeline: "vision-model" });
    expect(answer.method).toContain("because our detectors do not recognise this drawing");
  });

  it("is answered by the routed detector alone when the reader fails, and the method says why", async () => {
    const broken: VisionModel = { id: "broken-reader", ask: async () => { throw new Error("503 from the provider"); } };
    const answer = await voted(pair(4, 6), broken);
    expect(answer).toMatchObject({ value: 4, pipeline: "detector" });
    expect(answer.method).toBe("window symbols counted by our detectors (symbols), no outside model; the reader broken-reader gave no count for the vote (503 from the provider)");
  });

  it("is not held with fewer than three counts: one detector answers without asking the reader", async () => {
    const model = vision(9);
    const answer = await voted(routed(windows(4)), model);
    expect(answer).toMatchObject({ value: 4, pipeline: "detector" });
    expect(model.requests).toHaveLength(0);
  });
});
