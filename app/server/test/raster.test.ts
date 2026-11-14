import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Detection, Detector } from "../src/models/detector.js";
import type { VisionModel, VisionRequest } from "../src/models/vision.js";
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
const THRESHOLDS = { window: 0.5, door: 0.5, sauna: 0.5, bedroom: 0.5 };
/** Two models behind one detector: `symbols` is routed the windows, `rooms` everything else. */
function routed(detections: Detection[]): Detector & { scans: number } {
  const detector = {
    id: "onnx:symbols+rooms", thresholds: THRESHOLDS, scans: 0,
    nameFor: (cls: string) => (cls === "window" ? "symbols" : "rooms"),
    detect: async () => {
      detector.scans++;
      return detections;
    },
  };
  return detector;
}

type Recording = VisionModel & { requests: VisionRequest[] };
/** A vision model that reports `windows` windows, two bedrooms and one storey, and records what it was asked. */
function vision(windows: number): Recording {
  const requests: VisionRequest[] = [];
  return {
    id: "fake-vision", requests,
    ask: async (request) => {
      requests.push(request);
      const output = { floors: 1, windows: Array.from({ length: windows }, (_, i) => ({ x: 100 * i, y: 500 })), bedrooms: [{ x: 100, y: 200 }, { x: 600, y: 200 }] };
      return { output, seconds: 0, costUsd: 0, cached: false };
    },
  };
}
const noVision: VisionModel = {
  id: "none",
  ask: async () => {
    throw new Error("This question needs a vision model");
  },
};

const windows = (n: number, score = 0.9) => Array.from({ length: n }, (_, i) => box("window", score, 10 + 30 * i));
const WINDOWS = "How many windows are shown on this floor plan?";
const BEDROOMS = "How many bedrooms (makuuhuone, usually marked MH) are on this floor plan?";
const count = (question: string, deps: Omit<RasterDeps, "imageUrl">) => solveRaster(drawing, question, readByKeywords(question, "count"), { ...deps, imageUrl: "/plan.png" });

describe("counting symbols on a raster drawing", () => {
  it("counts a symbol with the detector routed to its class, and does not ask the vision model", async () => {
    const model = vision(9);
    const answer = await count(WINDOWS, { vision: model, detector: routed(windows(4)) });
    expect(answer).toMatchObject({ value: 4, pipeline: "detector", kind: "window" });
    expect(answer.method).toBe("window symbols found by the detector symbols");
    expect(answer.evidence?.kind === "image" && answer.evidence.marks.map((m) => m.n)).toEqual([1, 2, 3, 4]);
    expect(model.requests).toHaveLength(0);
  });

  it("leaves detections below the class threshold out of the count", async () => {
    const found = [...windows(3), box("window", 0.3, 150), box("door", 0.9, 150)];
    expect((await count(WINDOWS, { vision: vision(9), detector: routed(found) })).value).toBe(3);
  });

  it("asks the vision model alone when the detectors do not recognise the drawing", async () => {
    const answer = await count(WINDOWS, { vision: vision(7), detector: routed(windows(6, 0.55)) });
    expect(answer).toMatchObject({ value: 7, pipeline: "vision-model" });
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
    expect(answer.method).toBe("window symbols found by the detector symbols; door symbols found by the detector rooms");
    expect(answer.evidence?.kind === "image" && answer.evidence.marks.map((m) => m.n)).toEqual([1, 2, 3, 4, 5]);
  });
});

describe("room types and storeys on a raster drawing", () => {
  it("reads them from one inventory of the drawing by the vision model", async () => {
    const model = vision(0);
    const detector = routed([...windows(4), box("bedroom", 0.9), box("bedroom", 0.9, 60), box("bedroom", 0.9, 110)]);
    const bedrooms = await count(BEDROOMS, { vision: model, detector });
    const storeys = await count("How many floors (storeys) does this floor plan show?", { vision: model, detector });
    expect(bedrooms).toMatchObject({ value: 2, pipeline: "vision-model", kind: "bedroom" });
    expect(storeys).toMatchObject({ value: 1, pipeline: "vision-model", kind: "floor" });
    // The same request, so the two questions share one cached reading of the drawing.
    expect(model.requests).toHaveLength(2);
    expect(model.requests[1]).toEqual(model.requests[0]);
    expect(detector.scans).toBe(0);
  });

  it("lets the detectors count room types with RASTER_DETECTOR_TARGETS=all", async () => {
    process.env.RASTER_DETECTOR_TARGETS = "all";
    const model = vision(0);
    const answer = await count(BEDROOMS, { vision: model, detector: routed([...windows(4), box("bedroom", 0.9), box("bedroom", 0.9, 60), box("bedroom", 0.9, 110)]) });
    expect(answer).toMatchObject({ value: 3, pipeline: "detector" });
    expect(answer.method).toBe("bedroom rooms found by the detector rooms");
    expect(model.requests).toHaveLength(0);
  });

  it("counts with the detectors alone when the app runs without a vision model", async () => {
    const detector = routed([...windows(4), box("bedroom", 0.9), box("sauna", 0.9, 60)]);
    expect(await count(BEDROOMS, { vision: noVision, detector })).toMatchObject({ value: 1, pipeline: "detector" });
    expect(await count("How many saunas are on this floor plan?", { vision: noVision, detector })).toMatchObject({ value: 1, pipeline: "detector" });
    // Storeys are a class these detectors do not offer, so only a vision model could answer.
    await expect(count("How many floors (storeys) does this floor plan show?", { vision: noVision, detector })).rejects.toThrow("needs a vision model");
  });

  it("says why a request to show the storeys has no marks", async () => {
    const question = "show me the floors";
    const answer = await solveRaster(drawing, question, readByKeywords(question, "count", true), { vision: vision(0), detector: null, imageUrl: "/plan.png" });
    expect(answer).toMatchObject({ value: 1, note: "Storeys are counted from the whole image; there is no single item to mark." });
  });
});
