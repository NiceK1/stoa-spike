import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { beforeAll, describe, expect, it } from "vitest";
import type { VisionModel, VisionRequest } from "../src/models/vision.js";
import { isLocate } from "../src/questions.js";
import { ask, type Deps } from "../src/router.js";
import type { Polygon } from "../src/types.js";

const rect = (x: number, y: number, w: number, h: number): Polygon => [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];
const polyline = (layer: string, points: Polygon) =>
  `0\nLWPOLYLINE\n8\n${layer}\n90\n${points.length}\n70\n1\n${points.map(([x, y]) => `10\n${x}\n20\n${y}\n`).join("")}`;
const text = (value: string, x: number, y: number) => `0\nTEXT\n8\nROOM_TEXT\n10\n${x}\n20\n${y}\n1\n${value}\n`;

// Two rooms 'Zimmer' (12 and 9 m²), a 'Bad' (4 m²) and a 'Balkon' (3 m²) in apartment A; one door, two windows.
const DXF =
  "0\nSECTION\n2\nENTITIES\n" +
  polyline("ROOM_OUTLINE", rect(0, 0, 4, 3)) + text("Zimmer", 2, 1.8) + text("1.01", 2, 1.5) +
  polyline("ROOM_OUTLINE", rect(4, 0, 2, 2)) + text("Bad", 5, 1.3) + text("1.02", 5, 1.0) +
  polyline("ROOM_OUTLINE", rect(0, 3, 3, 3)) + text("Zimmer", 1.5, 4.8) + text("1.03", 1.5, 4.5) +
  polyline("ROOM_OUTLINE", rect(3, 3, 3, 1)) + text("Balkon", 4.5, 3.7) + text("1.04", 4.5, 3.4) +
  polyline("UNIT_OUTLINE", rect(0, 0, 6, 6)) + text("App. A", 5, 5) +
  polyline("DOOR", rect(3.9, 1, 0.2, 0.8)) + polyline("WINDOW", rect(1, -0.1, 1, 0.2)) + polyline("WINDOW", rect(1, 5.9, 1, 0.2)) +
  "0\nENDSEC\n0\nEOF\n";

let plan = "", image = "";
beforeAll(async () => {
  const folder = mkdtempSync(join(tmpdir(), "planner-test-"));
  plan = join(folder, "floor.dxf");
  writeFileSync(plan, DXF);
  image = join(mkdtempSync(join(tmpdir(), "planner-test-")), "plan.png");
  await sharp({ create: { width: 200, height: 100, channels: 3, background: "#ffffff" } }).png().toFile(image);
});

type Recording = VisionModel & { requests: VisionRequest[] };

/** A model that answers every request with `output` and records what it was asked. */
function model(id: string, output: Record<string, unknown> | ((request: VisionRequest) => Record<string, unknown>)): Recording {
  const requests: VisionRequest[] = [];
  return {
    id, requests,
    ask: async (request) => {
      requests.push(request);
      return { output: typeof output === "function" ? output(request) : output, seconds: 0, costUsd: 0, cached: false };
    },
  };
}

const call = (fields: Record<string, unknown>) =>
  ({ symbol: "none", labels: [], room_numbers: [], apartment: "", pick: "all", measure: "count", answer: "", locate: false, ...fields });
const takeoff = (fields: Record<string, unknown>) => model("fake-planner", call(fields));
const deps = (planner: VisionModel | null, vision: VisionModel = model("fake-vision", {})): Deps => ({ vision, planner, detector: null, fileUrl: () => "/plan.png" });
const numbers = (svg: string) => [...svg.matchAll(/font-weight="600" fill="#ffffff">([^<]*)</g)].map((m) => m[1]);
const svgOf = (answer: Awaited<ReturnType<typeof ask>>) => (answer.evidence?.kind === "svg" ? answer.evidence.svg : "");

describe("a free-form question about a layered DXF plan", () => {
  it("maps the question's word onto the plan's own label and counts by geometry", async () => {
    const planner = takeoff({ operation: "rooms", labels: ["Zimmer"], locate: true });
    const answer = await ask({ file: plan, question: "show me the bedrooms" }, deps(planner));
    expect(answer).toMatchObject({ value: 2, unit: "count", exact: true, pipeline: "dxf-geometry", note: "Rooms labelled 'Zimmer': 2 marked on the drawing." });
    expect(answer.method).toContain(`understood as "count rooms labelled 'Zimmer'" by fake-planner`);
    expect(numbers(svgOf(answer))).toEqual(["1", "2"]);
  });

  it("tells the planner the plan's labels, room numbers, apartments and symbol counts", async () => {
    const planner = takeoff({ operation: "none" });
    await ask({ file: plan, question: "anything about bedrooms?" }, deps(planner));
    const { prompt } = planner.requests[0];
    expect(prompt).toContain("Question: anything about bedrooms?");
    expect(prompt).toContain("Zimmer x2 (21.00 m²)");
    expect(prompt).toContain("Bad x1");
    expect(prompt).toContain("Apartments: A (4 rooms, 25.00 m² net without outdoor rooms)");
    expect(prompt).toContain("1 doors, 2 windows");
    expect(prompt).toContain("1.03; Zimmer; A; 9.00");
  });

  it("adds up the rooms the planner selects, in code", async () => {
    const planner = takeoff({ operation: "rooms", labels: ["Bad", "zimmer"], measure: "area" });
    const answer = await ask({ file: plan, question: "combined area of the bedrooms and the bathroom?" }, deps(planner));
    expect(answer).toMatchObject({ value: 25, unit: "m2", exact: true });
    expect(numbers(svgOf(answer))).toHaveLength(3);
  });

  it("finds the largest room and names it", async () => {
    const answer = await ask({ file: plan, question: "which room is the largest?" }, deps(takeoff({ operation: "rooms", pick: "largest", measure: "list" })));
    expect(answer.value).toBe("1.01 Zimmer, 12.00 m²");
    expect(numbers(svgOf(answer))).toEqual(["1 · 1.01 Zimmer"]);
  });

  it("runs the dataset's operations for symbols, apartments and floor totals", async () => {
    expect((await ask({ file: plan, question: "fenster?" }, deps(takeoff({ operation: "count_symbols", symbol: "windows" })))).value).toBe(2);
    expect((await ask({ file: plan, question: "flat A size" }, deps(takeoff({ operation: "area_apartment", apartment: "a" })))).value).toBe(25);
    expect((await ask({ file: plan, question: "whole floor, indoor" }, deps(takeoff({ operation: "area_floor" })))).value).toBe(25);
    expect((await ask({ file: plan, question: "rooms of A" }, deps(takeoff({ operation: "rooms", apartment: "A" })))).value).toBe(4);
  });

  it("highlights the rooms a free answer rests on and labels it an estimate", async () => {
    const planner = takeoff({ operation: "answer", answer: "Yes, 1.01 is larger than 1.03.", room_numbers: ["1.01", "1.03", "9.99"] });
    const answer = await ask({ file: plan, question: "is 1.01 bigger than 1.03?" }, deps(planner));
    expect(answer).toMatchObject({ value: "Yes, 1.01 is larger than 1.03.", exact: false, pipeline: "dxf-facts" });
    expect(numbers(svgOf(answer))).toEqual(["1 · 1.01 Zimmer", "2 · 1.03 Zimmer"]);
  });

  it("answers a template question without asking the planner", async () => {
    const planner = takeoff({ operation: "count_symbols", symbol: "windows" });
    const counted = await ask({ file: plan, question: "How many rooms labelled 'Zimmer' are there on this floor?" }, deps(planner));
    expect(counted).toMatchObject({ value: 2, method: "room labels equal to 'Zimmer'" });
    expect(counted.note).toBeUndefined();
    const shown = await ask({ file: plan, question: "Show me the doors" }, deps(planner));
    expect(shown).toMatchObject({ value: 1, note: "Doors: 1 marked on the drawing." });
    expect(planner.requests).toHaveLength(0);
  });

  it("leaves the question unanswered when the planner finds no call", async () => {
    const answer = await ask({ file: plan, question: "who drew this?" }, deps(takeoff({ operation: "none" })));
    expect(answer).toMatchObject({ value: null, pipeline: "none" });
  });

  it("does not widen a selection to every room when the planner names a label the plan lacks", async () => {
    const answer = await ask({ file: plan, question: "how many saunas?" }, deps(takeoff({ operation: "rooms", labels: ["Sauna"] })));
    expect(answer.value).toBeNull();
  });

  it("stays with the fixed parser when the planner is switched off", async () => {
    const answer = await ask({ file: plan, question: "window count" }, deps(null));
    expect(answer.value).toBeNull();
  });
});

describe("a free-form question about a raster drawing", () => {
  const inventory = { floors: 1, bedrooms: [{ x: 100, y: 200 }, { x: 600, y: 200 }], toilet_bowls: [{ x: 500, y: 500 }] };
  const vision = () => model("fake-vision", (request) => ("answer" in (request.schema.properties as object) ? { answer: "Scale 1:100", value: null, unit: null, explanation: "title block" } : inventory));

  it("marks what a show-me question in a known wording asks for, without the planner", async () => {
    const planner = model("fake-planner", { operation: "free", target: "none", items: "", locate: false });
    const answer = await ask({ file: image, question: "näytä makuuhuoneet" }, deps(planner, vision()));
    expect(answer).toMatchObject({ value: 2, kind: "bedroom", note: "Bedrooms: 2 marked on the drawing." });
    expect(answer.evidence?.kind === "image" && answer.evidence.marks.map((m) => [m.n, m.x, m.y])).toEqual([[1, 20, 20], [2, 120, 20]]);
    expect(planner.requests).toHaveLength(0);
  });

  it("lets the planner map loose wording onto a known kind", async () => {
    const planner = model("fake-planner", { operation: "count_known", target: "toilet", items: "", locate: true });
    const answer = await ask({ file: image, question: "where's the loo?" }, deps(planner, vision()));
    expect(answer).toMatchObject({ value: 1, kind: "toilet", note: "Toilet bowls: 1 marked on the drawing." });
    expect(answer.method).toContain(`understood as "count toilet bowls" by fake-planner`);
    expect(answer.evidence?.kind === "image" && answer.evidence.marks).toHaveLength(1);
    expect(planner.requests[0].prompt).toContain("- toilet: toilet bowls (the fixture");
    expect(planner.requests[0].prompt).toContain("- wc_room: separate WC rooms");
  });

  it("reads the drawing freely when the planner finds nothing to count", async () => {
    const planner = model("fake-planner", { operation: "free", target: "none", items: "", locate: false });
    const answer = await ask({ file: image, question: "what scale is this drawn at?" }, deps(planner, vision()));
    expect(answer).toMatchObject({ value: "Scale 1:100", pipeline: "vision-model" });
    expect(answer.evidence?.kind === "image" && answer.evidence.marks).toEqual([]);
  });

  it("does not ask the planner when the caller states that the question is not a count", async () => {
    const planner = model("fake-planner", { operation: "count_known", target: "toilet", items: "", locate: false });
    const answer = await ask({ file: image, question: "what scale is this drawn at?", type: "text" }, deps(planner, vision()));
    expect(answer.value).toBe("Scale 1:100");
    expect(planner.requests).toHaveLength(0);
  });
});

describe("requests to be shown something", () => {
  it("are told from quantity questions", () => {
    for (const question of ["show me the bedrooms", "Where is the sauna?", "näytä makuuhuoneet", "Markiere alle Fenster", "Où sont les toilettes ?"]) {
      expect(isLocate(question), question).toBe(true);
    }
    for (const question of ["How many floors (storeys) does this floor plan show?", "rooms marked WC", "What is the net floor area of room 1.04 in m²?"]) {
      expect(isLocate(question), question).toBe(false);
    }
  });
});
