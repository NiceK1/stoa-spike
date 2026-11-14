import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Detection, Detector } from "../src/models/detector.js";
import type { VisionModel, VisionRequest } from "../src/models/vision.js";
import { solveRaster } from "../src/solvers/raster.js";

let drawing = "";
beforeAll(async () => {
  drawing = join(mkdtempSync(join(tmpdir(), "raster-test-")), "plan.png");
  await sharp({ create: { width: 200, height: 100, channels: 3, background: "#ffffff" } }).png().toFile(drawing);
});
afterEach(() => {
  delete process.env.INVENTORY_HINTS;
  delete process.env.RASTER_SYMBOL_VOTE;
});

const box = (cls: string, score: number, x = 10, y = 10): Detection => ({ cls, score, x, y, w: 20, h: 10 });
const model = (name: string, detections: Detection[], thresholds: Record<string, number> = { window: 0.5, door: 0.5 }): Detector => ({
  id: `onnx:${name}`, thresholds, detect: async () => detections,
});
const pair = (first: Detection[], second: Detection[]): Detector => ({ ...model("first", first), members: [model("first", first), model("second", second)] });

/** A vision model that reports `windows` windows and records what it was asked. */
function vision(windows: number): VisionModel & { requests: VisionRequest[] } {
  const requests: VisionRequest[] = [];
  return {
    id: "fake-vision", requests,
    ask: async (request) => {
      requests.push(request);
      return { output: { floors: 1, windows: Array.from({ length: windows }, (_, i) => ({ x: 100 * i, y: 500 })) }, seconds: 0, costUsd: 0, cached: false };
    },
  } as VisionModel & { requests: VisionRequest[] };
}

const windows = (n: number, score = 0.9) => Array.from({ length: n }, (_, i) => box("window", score, 10 + 30 * i));
const question = "How many windows are shown on this floor plan?";

describe("counting symbols on a raster drawing", () => {
  it("answers with the middle of the detectors' and the vision model's counts", async () => {
    const answer = await solveRaster(drawing, question, "count", { vision: vision(2), detector: pair(windows(4), windows(5)), imageUrl: "/plan.png" });
    expect(answer.value).toBe(4);
    expect(answer.pipeline).toBe("symbol-vote");
    expect(answer.evidence?.kind === "image" && answer.evidence.marks.map((m) => m.n)).toEqual([1, 2, 3, 4]);
  });

  it("marks the vision model's positions when no detector agrees with the middle count", async () => {
    const answer = await solveRaster(drawing, question, "count", { vision: vision(4), detector: pair(windows(3), windows(5)), imageUrl: "/plan.png" });
    expect(answer.value).toBe(4);
    expect(answer.evidence?.kind === "image" && answer.evidence.marks).toHaveLength(4);
    expect(answer.evidence?.kind === "image" && answer.evidence.marks[1]).toMatchObject({ n: 2, x: 20, y: 50 });
  });

  it("leaves detections below the class threshold out of the count", async () => {
    process.env.RASTER_SYMBOL_VOTE = "off";
    const found = [...windows(3), box("window", 0.3, 150), box("door", 0.9, 150)];
    const answer = await solveRaster(drawing, question, "count", { vision: vision(9), detector: pair(found, found), imageUrl: "/plan.png" });
    expect(answer.value).toBe(3);
    expect(answer.pipeline).toBe("detector");
  });

  it("asks the vision model alone when the detectors do not recognise the drawing", async () => {
    const faint = windows(6, 0.55);
    const answer = await solveRaster(drawing, question, "count", { vision: vision(7), detector: pair(faint, faint), imageUrl: "/plan.png" });
    expect(answer.value).toBe(7);
    expect(answer.pipeline).toBe("vision-model");
  });

  it("counts doors with the all-class detector alone", async () => {
    const doors = (n: number) => Array.from({ length: n }, (_, i) => box("door", 0.9, 10 + 30 * i));
    const both: Detector = { ...model("floorplan-yolo11m-1280", doors(5)), members: [model("floorplan-yolo11m-1280", doors(5)), model("other", doors(3))] };
    const answer = await solveRaster(drawing, "How many doors are shown on this floor plan?", "count", { vision: vision(0), detector: both, imageUrl: "/plan.png" });
    expect(answer.value).toBe(5);
    expect(answer.pipeline).toBe("detector");
  });

  it("takes the higher of the detector's and the vision model's sauna counts", async () => {
    const saunas = (n: number): VisionModel => ({ id: "fake-vision", ask: async () => ({ output: { floors: 1, saunas: Array.from({ length: n }, () => ({ x: 500, y: 500 })) }, seconds: 0, costUsd: 0, cached: false }) });
    const found = (n: number) => model("floorplan-yolo11m-1280", [...windows(3), ...Array.from({ length: n }, () => box("sauna", 0.9))], { window: 0.5, sauna: 0.5 });
    const ask = (detector: Detector, vision: VisionModel) => solveRaster(drawing, "How many saunas are on this floor plan?", "count", { vision, detector, imageUrl: "/plan.png" });
    expect((await ask(found(1), saunas(0))).value).toBe(1);
    expect((await ask(found(0), saunas(1))).value).toBe(1);
    expect((await ask(found(0), saunas(0))).value).toBe(0);
  });

  it("answers room questions from the vision model's inventory", async () => {
    const model = vision(0);
    const answer = await solveRaster(drawing, "How many storeys does this floor plan show?", "count", { vision: model, detector: pair(windows(4), windows(4)), imageUrl: "/plan.png" });
    expect(answer.value).toBe(1);
    expect(answer.pipeline).toBe("vision-model");
  });
});

describe("detector hints for the vision model", () => {
  it("lists the detector's candidates, unsure ones marked, when hints are on", async () => {
    process.env.INVENTORY_HINTS = "symbols";
    const model = vision(4);
    const found = [box("window", 0.9, 90, 45), box("window", 0.9, 10, 10), box("window", 0.9, 150, 10), box("window", 0.3, 30, 70), box("window", 0.1, 60, 70)];
    await solveRaster(drawing, question, "count", { vision: model, detector: pair(found, found), imageUrl: "/plan.png" });
    expect(model.requests).toHaveLength(1);
    expect(model.requests[0].prompt).toContain("windows: 100,150 800,150 500,500 200,750?");
    expect(model.requests[0].prompt).toContain("doors: none");
    expect(model.requests[0].system).toContain("Detector candidates");
  });

  it("sends the plain request when hints are off", async () => {
    const model = vision(4);
    await solveRaster(drawing, question, "count", { vision: model, detector: pair(windows(4), windows(4)), imageUrl: "/plan.png" });
    expect(model.requests[0].prompt).not.toContain("candidates");
    expect(model.requests[0].system).not.toContain("Detector candidates");
  });
});
