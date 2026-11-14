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
/** The app without an external model. Asking it is the error the solver must not run into. */
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
const NO_EXTERNAL = "and the app is running with our local models only (VISION_PROVIDER=none).";
const count = (question: string, deps: Omit<RasterDeps, "imageUrl">) => solveRaster(drawing, question, readByKeywords(question, "count"), { ...deps, imageUrl: "/plan.png" });

describe("counting symbols on a raster drawing", () => {
  it("counts a symbol with the detector routed to its class, and does not ask the vision model", async () => {
    const model = vision(9);
    const answer = await count(WINDOWS, { vision: model, detector: routed(windows(4)) });
    expect(answer).toMatchObject({ value: 4, pipeline: "detector", kind: "window" });
    expect(answer.method).toBe("window symbols counted by our detectors (symbols), no external model");
    expect(answer.evidence?.kind === "image" && answer.evidence.marks.map((m) => m.n)).toEqual([1, 2, 3, 4]);
    expect(model.requests).toHaveLength(0);
  });

  it("leaves detections below the class threshold out of the count", async () => {
    const found = [...windows(3), box("window", 0.3, 150), box("door", 0.9, 150)];
    expect((await count(WINDOWS, { vision: vision(9), detector: routed(found) })).value).toBe(3);
  });

  it("falls back to the external vision model when the detectors do not recognise the drawing, and says so", async () => {
    const answer = await count(WINDOWS, { vision: vision(7), detector: routed(windows(6, 0.55)) });
    expect(answer).toMatchObject({ value: 7, pipeline: "vision-model" });
    expect(answer.method).toBe("windows read by the external vision model fake-vision because our detectors do not recognise this drawing, so their count would not be reliable");
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
    expect(answer.method).toBe("window symbols counted by our detectors (symbols), no external model; door symbols counted by our detectors (rooms), no external model");
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
    expect(bedrooms.method).toBe("bedroom rooms counted by our detectors (rooms), no external model");
    expect(bedrooms.evidence?.kind === "image" && bedrooms.evidence.marks).toHaveLength(3);
    expect(storeys).toMatchObject({ value: 1, pipeline: "detector", kind: "floor" });
    expect(storeys.method).toBe("storey plans counted by our detectors (rooms), no external model");
    expect(model.requests).toHaveLength(0);
  });

  it("come from one inventory by the vision model with RASTER_DETECTOR_TARGETS=symbols, which the method names", async () => {
    process.env.RASTER_DETECTOR_TARGETS = "symbols";
    const model = vision(0);
    const detector = rooms();
    const bedrooms = await count(BEDROOMS, { vision: model, detector });
    const storeys = await count(STOREYS, { vision: model, detector });
    expect(bedrooms).toMatchObject({ value: 2, pipeline: "vision-model", kind: "bedroom" });
    expect(bedrooms.method).toBe("bedrooms read by the external vision model fake-vision because RASTER_DETECTOR_TARGETS=symbols leaves room types and storeys to it");
    expect(storeys).toMatchObject({ value: 1, pipeline: "vision-model", kind: "floor" });
    // The same request, so the two questions share one cached reading of the drawing.
    expect(model.requests).toHaveLength(2);
    expect(model.requests[1]).toEqual(model.requests[0]);
    expect(detector.scans).toBe(0);
    expect((await count(WINDOWS, { vision: model, detector })).pipeline).toBe("detector");
  });

  it("go to the vision model for a kind the installed detectors do not offer", async () => {
    const answer = await count(STOREYS, { vision: vision(0), detector: routed(windows(4), { window: 0.5, door: 0.5 }) });
    expect(answer).toMatchObject({ value: 1, pipeline: "vision-model" });
    expect(answer.method).toBe("storeys read by the external vision model fake-vision because our detectors do not offer storeys");
  });

  it("answers a request to show the storeys with the detector's box around each storey plan", async () => {
    const question = "show me the floors";
    const detector = routed([...windows(4), box("floor", 0.9, 0, 0), box("floor", 0.9, 100, 0)]);
    const answer = await solveRaster(drawing, question, readByKeywords(question, "count", true), { vision: vision(0), detector, imageUrl: "/plan.png" });
    expect(answer).toMatchObject({ value: 2, pipeline: "detector", note: "Storeys: 2 marked on the drawing." });
    expect(answer.evidence?.kind === "image" && answer.evidence.marks).toHaveLength(2);
  });

  it("says why a request to show the storeys has no marks when the external model counted them", async () => {
    const question = "show me the floors";
    const answer = await solveRaster(drawing, question, readByKeywords(question, "count", true), { vision: vision(0), detector: null, imageUrl: "/plan.png" });
    expect(answer).toMatchObject({ value: 1, note: "Storeys are counted from the whole image; there is no single item to mark." });
    expect(answer.method).toBe("storeys read by the external vision model fake-vision because no detector weights are installed");
  });
});

describe("what the detectors cannot do", () => {
  const solve = (question: string, call: RasterReading["call"], vision: VisionModel, detector: Detector | null = routed(windows(4))) =>
    solveRaster(drawing, question, { call, locate: false, type: call.operation === "read" ? "text" : "count" }, { vision, detector, imageUrl: "/plan.png" });
  const OTHER = { operation: "count_other" as const, items: "staircases" };
  const PART = { operation: "count_known" as const, targets: ["sink"], whole: false };
  const READ = { operation: "read" as const };

  it("goes to the external vision model, and the method says which model and why", async () => {
    const other = await solve("how many staircases?", OTHER, vision(0));
    expect(other).toMatchObject({ value: 1, pipeline: "vision-model" });
    expect(other.method).toBe("staircases read by the external vision model fake-vision because our detectors do not know this kind of item");

    const part = await solve("the kitchen sink", PART, vision(0));
    expect(part).toMatchObject({ value: 1, pipeline: "vision-model" });
    expect(part.method).toBe(
      "sinks and wash basins in the part of the drawing the question names read by the external vision model fake-vision because our detectors count on the whole drawing only, not in a part of it",
    );

    const read = await solve("what scale is this drawn at?", READ, vision(0));
    expect(read).toMatchObject({ value: "Scale 1:100", pipeline: "vision-model" });
    expect(read.method).toBe("the drawing read by the external vision model fake-vision because our detectors count items and cannot read text, dimensions or tables");
  });

  it("gets an answer with no value and the reason when no external model is configured", async () => {
    const other = await solve("how many staircases?", OTHER, noVision);
    expect(other).toMatchObject({ value: null, pipeline: "none" });
    expect(other.note).toBe(`No answer: this question needs an external vision model, because our detectors do not know this kind of item, ${NO_EXTERNAL}`);
    expect(other.method).toContain("staircases were not counted or read");
    expect(other.evidence?.kind === "image" && other.evidence.marks).toEqual([]);

    expect((await solve("the kitchen sink", PART, noVision)).note).toContain("because our detectors count on the whole drawing only, not in a part of it");
    expect(await solve("what scale is this drawn at?", READ, noVision)).toMatchObject({
      value: null, pipeline: "none", note: `No answer: this question needs an external vision model, because our detectors count items and cannot read text, dimensions or tables, ${NO_EXTERNAL}`,
    });
  });

  it("still counts every kind the detectors know when no external model is configured, whatever the setting", async () => {
    process.env.RASTER_DETECTOR_TARGETS = "symbols";
    const detector = routed([...windows(4), box("bedroom", 0.9), box("sauna", 0.9, 60)]);
    expect(await count(BEDROOMS, { vision: noVision, detector })).toMatchObject({ value: 1, pipeline: "detector" });
    expect(await count("How many saunas are on this floor plan?", { vision: noVision, detector })).toMatchObject({ value: 1, pipeline: "detector" });
  });

  it("has no value for a known kind without an external model when the detectors do not offer it or do not recognise the drawing", async () => {
    const storeys = await count(STOREYS, { vision: noVision, detector: routed(windows(4), { window: 0.5 }) });
    expect(storeys).toMatchObject({ value: null, pipeline: "none", kind: "floor" });
    expect(storeys.note).toBe(`No answer: this question needs an external vision model, because our detectors do not offer storeys, ${NO_EXTERNAL}`);

    const unrecognised = await count(WINDOWS, { vision: noVision, detector: routed(windows(6, 0.55)) });
    expect(unrecognised).toMatchObject({ value: null, pipeline: "none", kind: "window" });
    expect(unrecognised.note).toContain("because our detectors do not recognise this drawing, so their count would not be reliable");
  });

  it("marks what was counted and says what was not, when one of several kinds needs the missing external model", async () => {
    const call = { operation: "count_known" as const, targets: ["window", "floor"], whole: true };
    const answer = await solve("windows and storeys", call, noVision, routed(windows(4), { window: 0.5 }));
    expect(answer).toMatchObject({ value: null, pipeline: "none", kind: "window+floor" });
    expect(answer.note).toBe(`Counted: 4 windows. Not counted: storeys. No answer: this question needs an external vision model, because our detectors do not offer storeys, ${NO_EXTERNAL}`);
    expect(answer.evidence?.kind === "image" && answer.evidence.marks).toHaveLength(4);
  });
});
