import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { beforeAll, describe, expect, it } from "vitest";
import type { VisionModel, VisionRequest } from "../src/models/vision.js";
import { inferType, isLocate, isPlainRequest } from "../src/questions.js";
import { ask, type Deps } from "../src/router.js";
import type { Polygon } from "../src/types.js";

const rect = (x: number, y: number, w: number, h: number): Polygon => [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];
const polyline = (layer: string, points: Polygon) =>
  `0\nLWPOLYLINE\n8\n${layer}\n90\n${points.length}\n70\n1\n${points.map(([x, y]) => `10\n${x}\n20\n${y}\n`).join("")}`;
const text = (value: string, x: number, y: number) => `0\nTEXT\n8\nROOM_TEXT\n10\n${x}\n20\n${y}\n1\n${value}\n`;

// Apartment A: 'Zimmer' 1.01 (12 m²) and 1.03 (9 m²), 'Bad' 1.02 (4 m²), 'Balkon' 1.04 (3 m²), one door, two windows.
// Apartment B: 'Zimmer' 2.01 (9 m²), 'Bad' 2.02 (6 m²), one door, one window.
const DXF =
  "0\nSECTION\n2\nENTITIES\n" +
  polyline("ROOM_OUTLINE", rect(0, 0, 4, 3)) + text("Zimmer", 2, 1.8) + text("1.01", 2, 1.5) +
  polyline("ROOM_OUTLINE", rect(4, 0, 2, 2)) + text("Bad", 5, 1.3) + text("1.02", 5, 1.0) +
  polyline("ROOM_OUTLINE", rect(0, 3, 3, 3)) + text("Zimmer", 1.5, 4.8) + text("1.03", 1.5, 4.5) +
  polyline("ROOM_OUTLINE", rect(3, 3, 3, 1)) + text("Balkon", 4.5, 3.7) + text("1.04", 4.5, 3.4) +
  polyline("UNIT_OUTLINE", rect(0, 0, 6, 6)) + text("App. A", 5, 5) +
  polyline("ROOM_OUTLINE", rect(7, 0, 3, 3)) + text("Zimmer", 8.5, 1.8) + text("2.01", 8.5, 1.5) +
  polyline("ROOM_OUTLINE", rect(7, 3, 3, 2)) + text("Bad", 8.5, 4.3) + text("2.02", 8.5, 4.0) +
  polyline("UNIT_OUTLINE", rect(7, 0, 3, 6)) + text("App. B", 9.5, 5.5) +
  polyline("DOOR", rect(3.9, 1, 0.2, 0.8)) + polyline("DOOR", rect(8, 2.9, 0.8, 0.2)) +
  polyline("WINDOW", rect(1, -0.1, 1, 0.2)) + polyline("WINDOW", rect(1, 5.9, 1, 0.2)) + polyline("WINDOW", rect(9.9, 1, 0.2, 1)) +
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

const call = (fields: Record<string, unknown>) => ({
  symbols: [], labels: [], room_numbers: [], apartments: [], pick: "all", measure: "count", missing: [], broader_label: false, reason: "", locate: false, answer_type: "count", ...fields,
});
const takeoff = (fields: Record<string, unknown>) => model("fake-planner", call(fields));
const deps = (planner: VisionModel | null, vision: VisionModel = model("fake-vision", {})): Deps => ({ vision, planner, detector: null, fileUrl: () => "/plan.png" });
const numbers = (svg: string) => [...svg.matchAll(/font-weight="600" fill="#ffffff">([^<]*)</g)].map((m) => m[1]);
const svgOf = (answer: Awaited<ReturnType<typeof ask>>) => (answer.evidence?.kind === "svg" ? answer.evidence.svg : "");
const onPlan = (question: string, fields: Record<string, unknown>) => ask({ file: plan, question }, deps(takeoff(fields)));

describe("a question about a layered DXF plan, read by the interpreter", () => {
  it("goes to the interpreter even when a template matches, with the template's reading as a hint", async () => {
    const planner = takeoff({ operation: "count_symbols", symbols: ["doors"], apartments: ["B"] });
    const answer = await ask({ file: plan, question: "How many doors are drawn on this floor plan in apartment B?" }, deps(planner));
    expect(planner.requests).toHaveLength(1);
    expect(planner.requests[0].prompt).toContain("Question: How many doors are drawn on this floor plan in apartment B?");
    expect(planner.requests[0].prompt).toContain("A keyword parser reads this as: count all doors on the whole floor.");
    expect(answer).toMatchObject({ value: 1, unit: "count", exact: true, pipeline: "dxf-geometry" });
    expect(answer.method).toBe(`understood as "count doors in apartment B" by fake-planner; door symbols on layer DOOR; those lying in or reaching the outline of one of the 2 rooms in apartment B`);
  });

  it("tells the interpreter which of the plan's room numbers a question without a template reading names", async () => {
    const planner = takeoff({ operation: "rooms", room_numbers: ["1.02"], measure: "area", answer_type: "area" });
    const answer = await ask({ file: plan, question: "1.02 Bad net floor area" }, deps(planner));
    expect(planner.requests[0].prompt).toContain("A keyword parser reads this as: a question about room 1.02.");
    expect(answer).toMatchObject({ value: 4, unit: "m2" });
    expect(answer.method).toBe(`understood as "area of room 1.02" by fake-planner; outline of room 1.02`);
  });

  it("shows the interpreter a short menu in the plan's own words, not the room table", async () => {
    const planner = takeoff({ operation: "none" });
    await ask({ file: plan, question: "anything about bedrooms?" }, deps(planner));
    const { prompt, schema } = planner.requests[0];
    expect(prompt).not.toContain("A keyword parser");
    expect(prompt).toContain("Room labels on this plan (rooms carrying each): 'Zimmer' x3, 'Bad' x2, 'Balkon' x1");
    expect(prompt).toContain("Apartments: A (4 rooms), B (2 rooms)");
    expect(prompt).toContain("Room numbers (6): 1.01 1.02 1.03 1.04 2.01 2.02");
    expect(prompt).toContain("Symbols drawn on the floor: 2 doors, 3 windows, 0 toilets");
    expect(prompt).not.toContain("12.00");
    expect((schema.properties as any).labels.items.enum).toEqual(["Zimmer", "Bad", "Balkon"]);
    expect((schema.properties as any).apartments.items.enum).toEqual(["A", "B"]);
  });

  it("counts by geometry and says which label the question was matched to", async () => {
    const answer = await onPlan("show me the bedrooms", { operation: "rooms", labels: ["Zimmer"], locate: true });
    expect(answer).toMatchObject({ value: 3, unit: "count", exact: true, pipeline: "dxf-geometry" });
    expect(answer.method).toContain(`understood as "count rooms labelled 'Zimmer'" by fake-planner`);
    expect(answer.note).toBe("The question was matched to the plan's label 'Zimmer' by fake-planner. Rooms labelled 'Zimmer': 3 marked on the drawing.");
    expect(numbers(svgOf(answer))).toHaveLength(3);
  });

  it("labels an answer an estimate when the interpreter took a broader label for want of an exact one", async () => {
    const answer = await onPlan("how big is the living room of apartment B?", { operation: "rooms", labels: ["Zimmer"], apartments: ["B"], pick: "largest", measure: "area", broader_label: true, answer_type: "area" });
    expect(answer).toMatchObject({ value: 9, unit: "m2", exact: false });
    expect(answer.note).toContain("The plan has no label for exactly what was asked; fake-planner took the rooms labelled 'Zimmer' as the nearest.");
  });

  it("adds up, averages and compares in code what the interpreter selects", async () => {
    const sum = await onPlan("area of room 1.01 and 1.02", { operation: "rooms", room_numbers: ["1.01", "1.02"], measure: "area", answer_type: "area" });
    expect(sum).toMatchObject({ value: 16, unit: "m2", exact: true, note: "The total consists of 1.01 Zimmer 12.00 m² and 1.02 Bad 4.00 m²." });
    expect(numbers(svgOf(sum))).toEqual(["1 · 1.01 Zimmer", "2 · 1.02 Bad"]);

    const mean = await onPlan("average size of a 'Zimmer'?", { operation: "rooms", labels: ["zimmer"], measure: "average", answer_type: "area" });
    expect(mean).toMatchObject({ value: 10, unit: "m2", exact: true });

    const flats = await onPlan("how much bigger is apartment A than B?", { operation: "compare", apartments: ["A", "B"], measure: "area", answer_type: "text" });
    expect(flats.value).toBe("Apartment A: 25.00 m²; Apartment B: 15.00 m². Largest: apartment A, 10.00 m² more than apartment B.");
    expect(flats).toMatchObject({ exact: true, pipeline: "dxf-geometry" });
    expect(numbers(svgOf(flats))).toHaveLength(5);

    const symbols = await onPlan("more doors or windows?", { operation: "compare", symbols: ["doors", "windows"], answer_type: "text" });
    expect(symbols.value).toBe("Doors: 2; Windows: 3. Most: windows, 1 more than doors.");
  });

  it("names the largest room, and every room of a tie", async () => {
    const largest = await onPlan("which room is the largest?", { operation: "rooms", pick: "largest", measure: "list", answer_type: "text" });
    expect(largest.value).toBe("1.01 Zimmer, 12.00 m²");
    expect(numbers(svgOf(largest))).toEqual(["1 · 1.01 Zimmer"]);
    const smallest = await onPlan("smallest 'Zimmer'?", { operation: "rooms", labels: ["Zimmer"], pick: "smallest", measure: "list", answer_type: "text" });
    expect(smallest.value).toBe("1.03 Zimmer and 2.01 Zimmer: 9.00 m² each (a tie)");
    expect(numbers(svgOf(smallest))).toHaveLength(2);
  });

  it("counts several kinds in one answer, with the total, what it consists of and every item marked", async () => {
    const answer = await onPlan("how many doors and windows?", { operation: "count_symbols", symbols: ["doors", "windows"] });
    expect(answer).toMatchObject({ value: 5, unit: "count", exact: true, note: "The total of 5 consists of 2 doors and 3 windows." });
    expect(numbers(svgOf(answer))).toEqual(["1 · door", "2 · door", "3 · window", "4 · window", "5 · window"]);
  });

  it("counts the symbols of one apartment or room by containment", async () => {
    expect((await onPlan("windows in apartment A", { operation: "count_symbols", symbols: ["windows"], apartments: ["A"] })).value).toBe(2);
    expect((await onPlan("windows in apartment B", { operation: "count_symbols", symbols: ["windows"], apartments: ["B"] })).value).toBe(1);
    const bath = await onPlan("doors of room 1.02", { operation: "count_symbols", symbols: ["doors"], room_numbers: ["1.02"] });
    expect(bath).toMatchObject({ value: 1, exact: true });
    expect(bath.method).toContain("those lying in or reaching the outline of one of the 1 room 1.02");
  });

  it("says that the drawing does not have a room, label or apartment instead of narrowing the selection", async () => {
    const number = await onPlan("total area of rooms 1.01 and 9.99", { operation: "rooms", room_numbers: ["1.01", "9.99"], measure: "area", answer_type: "area" });
    expect(number).toMatchObject({ value: null, pipeline: "none" });
    expect(number.note).toBe("This drawing does not have room 9.99. It has room labels 'Zimmer', 'Bad', 'Balkon'; rooms numbered 1.01 to 2.02; apartments A and B.");
    const word = await onPlan("how many saunas?", { operation: "rooms", missing: ["sauna"] });
    expect(word.value).toBeNull();
    expect(word.note).toContain("This drawing does not have 'sauna'.");
    const flat = await onPlan("how big is apartment C?", { operation: "area_apartment", apartments: ["C"], answer_type: "area" });
    expect(flat.note).toContain("does not have apartment C");
  });

  it("answers a question the drawing cannot answer with the reason, not with 'not understood'", async () => {
    const answer = await onPlan("what is the ceiling height in the stairwell?", { operation: "none", reason: "The plan holds no ceiling heights.", answer_type: "text" });
    expect(answer).toMatchObject({ value: null, pipeline: "none", note: "The plan holds no ceiling heights." });
    expect(answer.method).toContain(`understood as "a question this drawing's CAD data cannot answer" by fake-planner`);
  });

  it("runs the dataset's operations for apartments and floor totals", async () => {
    expect((await onPlan("flats?", { operation: "count_apartments" })).value).toBe(2);
    expect((await onPlan("flat A size", { operation: "area_apartment", apartments: ["a"], answer_type: "area" })).value).toBe(25);
    const both = await onPlan("A and B together", { operation: "area_apartment", apartments: ["A", "B"], answer_type: "area" });
    expect(both).toMatchObject({ value: 40, unit: "m2", note: "The total of 40.00 m² consists of apartment A 25.00 m² and apartment B 15.00 m²." });
    expect((await onPlan("whole floor, indoor", { operation: "area_floor", answer_type: "area" })).value).toBe(40);
    expect((await onPlan("rooms of A", { operation: "rooms", apartments: ["A"] })).value).toBe(4);
  });
});

describe("a question about a layered DXF plan, read by the keyword parser", () => {
  const template = "How many rooms labelled 'Zimmer' are there on this floor?";

  it("answers a template question without a model, and says who read it", async () => {
    const answer = await ask({ file: plan, question: template }, deps(null));
    expect(answer).toMatchObject({ value: 3, exact: true, method: "read by the keyword parser (no interpreter model is configured); room labels equal to 'Zimmer'" });
    const free = await ask({ file: plan, question: "window count" }, deps(null));
    expect(free.value).toBeNull();
    expect(free.method).toContain("read by the keyword parser (no interpreter model is configured)");
  });

  it("does not ask the interpreter in bulk mode", async () => {
    const planner = takeoff({ operation: "count_symbols", symbols: ["windows"] });
    const answer = await ask({ file: plan, question: template }, { ...deps(planner), interpreter: "templates" });
    expect(answer).toMatchObject({ value: 3, method: "read by the keyword parser (bulk mode, INTERPRETER=templates); room labels equal to 'Zimmer'" });
    expect(planner.requests).toHaveLength(0);
  });

  it("takes over when the interpreter's call fails or cannot be run, and says so", async () => {
    const failing: VisionModel = {
      id: "broken-planner",
      ask: async () => {
        throw new Error("spawn claude ENOENT");
      },
    };
    const failed = await ask({ file: plan, question: template }, deps(failing));
    expect(failed.value).toBe(3);
    expect(failed.method).toContain("read by the keyword parser (the interpreter broken-planner gave no usable call: spawn claude ENOENT)");
    const unusable = await ask({ file: plan, question: template }, deps(takeoff({ operation: "count_symbols" })));
    expect(unusable.value).toBe(3);
    expect(unusable.method).toContain("gave no usable call: count_symbols without a symbol kind");
  });

  it("marks what a plain show-request names, and leaves a qualified one unanswered", async () => {
    expect(await ask({ file: plan, question: "Show me the doors" }, deps(null))).toMatchObject({ value: 2, note: "Doors: 2 marked on the drawing." });
    expect((await ask({ file: plan, question: "Show me the doors of apartment A" }, deps(null))).value).toBeNull();
  });
});

describe("the source of an answer about a layered DXF plan", () => {
  it("names the interpreter with its reading, the script that measured, and the shapes it measured", async () => {
    const planner = model("claude-cli:claude-haiku-5-5", call({ operation: "area_apartment", apartments: ["A"], answer_type: "area" }));
    const answer = await ask({ file: plan, question: "how big is flat A?" }, deps(planner));
    expect(answer).toMatchObject({ value: 25, pipeline: "dxf-geometry" });
    expect(answer.source).toEqual({
      understoodBy: { by: "model", name: "claude-cli:claude-haiku-5-5", label: "Claude Haiku 5.5 (Anthropic)", tier: "external-model", reading: "net area of apartment A" },
      calculatedBy: [{ name: "CAD geometry script", tier: "script" }],
      from: { file: "floor.dxf", used: "indoor room outlines inside unit A: 3 room outlines on layer ROOM_OUTLINE" },
    });
    // A client that does not know `source` shows this sentence.
    expect(answer.method).toBe(`understood as "net area of apartment A" by claude-cli:claude-haiku-5-5; indoor room outlines inside unit A`);
  });

  it("counts the shapes the value was worked out from, not only the ones it marks", async () => {
    const largest = await onPlan("which room is the largest?", { operation: "rooms", pick: "largest", answer_type: "text" });
    expect(numbers(svgOf(largest))).toEqual(["1 · 1.01 Zimmer"]);
    expect(largest.source.from.used).toBe("outlines of the 6 rooms, compared by area: 6 room outlines on layer ROOM_OUTLINE");
    const symbols = await onPlan("how many doors and windows?", { operation: "count_symbols", symbols: ["doors", "windows"] });
    expect(symbols.source.from.used).toBe("2 door symbols on layer DOOR, 3 window symbols on layer WINDOW");
  });

  it("names the keyword parser and why no model read the question", async () => {
    const doors = "How many doors are drawn on this floor plan?";
    const bulk = await ask({ file: plan, question: doors }, { ...deps(takeoff({ operation: "none" })), interpreter: "templates" });
    expect(bulk.source).toEqual({
      understoodBy: { by: "keyword-parser", name: "Keyword parser", tier: "script", why: "bulk mode, INTERPRETER=templates" },
      calculatedBy: [{ name: "CAD geometry script", tier: "script" }],
      from: { file: "floor.dxf", used: "2 door symbols on layer DOOR" },
    });
    expect((await ask({ file: plan, question: doors }, deps(null))).source.understoodBy.why).toBe("no interpreter model is configured");
    const failing: VisionModel = { id: "broken-planner", ask: async () => { throw new Error("spawn claude ENOENT"); } };
    expect((await ask({ file: plan, question: doors }, deps(failing))).source.understoodBy).toMatchObject({
      by: "keyword-parser", why: "the interpreter broken-planner gave no usable call: spawn claude ENOENT",
    });
  });

  it("says why nothing was calculated when the drawing does not have what was asked", async () => {
    const answer = await onPlan("area of apartment C", { operation: "area_apartment", apartments: ["C"], answer_type: "area" });
    expect(answer).toMatchObject({ value: null, pipeline: "none" });
    expect(answer.source).toMatchObject({ understoodBy: { by: "model", name: "fake-planner" }, calculatedBy: [], from: { file: "floor.dxf", used: "nothing" } });
    expect(answer.source.needed).toContain("This drawing does not have apartment C");
    // A wording the keyword parser does not know, with no interpreter to read it.
    const unread = await ask({ file: plan, question: "window count" }, deps(null));
    expect(unread.source).toMatchObject({ understoodBy: { by: "keyword-parser" }, calculatedBy: [], from: { file: "floor.dxf" } });
    expect(unread.source.needed).toContain("an interpreter model is needed");
    // A file no pipeline takes: nothing read the question either.
    const unknown = await ask({ file: plan.replace(/floor\.dxf$/, "notes.xyz"), question: "how many doors?" }, deps(takeoff({ operation: "none" })));
    expect(unknown).toMatchObject({ value: null, pipeline: "none", method: "no pipeline for .xyz files" });
    expect(unknown.source).toMatchObject({ understoodBy: { by: "nobody" }, calculatedBy: [], from: { file: "notes.xyz", used: "nothing" } });
  });

  it("does not blame the wording when a DXF has none of the layers the CAD script reads", async () => {
    const sketch = plan.replace(/floor\.dxf$/, "sketch.dxf");
    writeFileSync(sketch, "0\nSECTION\n2\nENTITIES\n0\nLINE\n8\n0\n10\n0\n20\n0\n11\n5\n21\n5\n0\nENDSEC\n0\nEOF\n");
    const planner = takeoff({ operation: "count_symbols", symbols: ["doors"] });
    const answer = await ask({ file: sketch, question: "how many doors?" }, deps(planner));
    expect(planner.requests).toHaveLength(0);
    expect(answer).toMatchObject({ value: null, pipeline: "none" });
    expect(answer.source).toMatchObject({ understoodBy: { by: "nobody" }, calculatedBy: [], from: { file: "sketch.dxf", used: "nothing" } });
    expect(answer.source.needed).toBe("the DXF file has no labelled room outlines on the layers ROOM_OUTLINE and ROOM_TEXT, which the CAD geometry script reads");
  });
});

describe("a question about a raster drawing", () => {
  const inventory = { floors: 1, bedrooms: [{ x: 100, y: 200 }, { x: 600, y: 200 }], toilet_bowls: [{ x: 500, y: 500 }], showers: [{ x: 300, y: 300 }], bathtubs: [] };
  const vision = () =>
    model("fake-vision", (request) => {
      const properties = request.schema.properties as object;
      if ("answer" in properties) return { answer: "Scale 1:100", value: null, unit: null, explanation: "title block" };
      return "items" in properties ? { items: [{ x: 250, y: 250 }], count: 1 } : inventory;
    });
  const reading = (fields: Record<string, unknown>) => model("fake-planner", { operation: "count_known", targets: [], whole_drawing: true, items: "", locate: false, answer_type: "count", ...fields });

  it("goes to the interpreter even when a keyword matches, with the keyword's reading as a hint", async () => {
    const planner = reading({ targets: ["sink"], whole_drawing: false, locate: true });
    const eyes = vision();
    const answer = await ask({ file: image, question: "show me the kitchen sink" }, deps(planner, eyes));
    expect(planner.requests[0].prompt).toContain("A keyword parser reads this as: count the kitchens on the whole drawing.");
    expect(planner.requests[0].prompt).toContain("- toilet: toilet bowls (the fixture");
    expect(planner.requests[0].prompt).not.toContain("shower_bathtub");
    // A count limited to part of the drawing is made by the vision model from the full question.
    expect(eyes.requests[0].prompt).toBe("show me the kitchen sink");
    expect(answer).toMatchObject({ value: 1, pipeline: "vision-model" });
    expect(answer.method).toContain(`understood as "count sinks and wash basins in the part of the drawing the question names" by fake-planner`);
    expect(answer.evidence?.kind === "image" && answer.evidence.marks).toHaveLength(1);
  });

  it("maps loose wording onto a known kind and marks it", async () => {
    const answer = await ask({ file: image, question: "where's the loo?" }, deps(reading({ targets: ["toilet"], locate: true }), vision()));
    expect(answer).toMatchObject({ value: 1, kind: "toilet", note: "Toilet bowls: 1 marked on the drawing." });
    expect(answer.method).toContain(`understood as "count toilet bowls" by fake-planner`);
  });

  it("returns several kinds with the total and what it consists of", async () => {
    const answer = await ask({ file: image, question: "bedrooms and toilets, how many?" }, deps(reading({ targets: ["bedroom", "toilet"] }), vision()));
    expect(answer).toMatchObject({ value: 3, kind: "toilet+bedroom", note: "The total of 3 consists of 1 toilet bowls and 2 bedrooms." });
    expect(answer.evidence?.kind === "image" && answer.evidence.marks.map((m) => [m.n, m.label])).toEqual([[1, "toilet bowls"], [2, "bedrooms"], [3, "bedrooms"]]);
  });

  it("counts showers and bathtubs named together as the dataset's combined kind", async () => {
    const answer = await ask({ file: image, question: "showers plus tubs" }, deps(reading({ targets: ["shower", "bathtub"] }), vision()));
    expect(answer).toMatchObject({ value: 1, kind: "shower_bathtub" });
  });

  it("reads the drawing freely when there is nothing to count, and says why nothing is marked", async () => {
    const planner = reading({ operation: "read", locate: true, answer_type: "text" });
    const answer = await ask({ file: image, question: "show me the scale" }, deps(planner, vision()));
    expect(answer).toMatchObject({ value: "Scale 1:100", pipeline: "vision-model" });
    expect(answer.note).toContain("Nothing is marked");
    expect(answer.evidence?.kind === "image" && answer.evidence.marks).toEqual([]);
  });

  it("does not ask the interpreter when the caller states that the answer is not a count", async () => {
    const planner = reading({ targets: ["toilet"] });
    const answer = await ask({ file: image, question: "what scale is this drawn at?", type: "text" }, deps(planner, vision()));
    expect(answer.value).toBe("Scale 1:100");
    expect(planner.requests).toHaveLength(0);
  });

  it("tags the model that counted as an outside one in the source, next to who understood the question", async () => {
    const eyes = { ...vision(), id: "gemini-api:gemini-4-hydrogen" };
    const answer = await ask({ file: image, question: "how many staircases?" }, deps(reading({ operation: "count_other", items: "staircases" }), eyes));
    expect(answer.source).toEqual({
      understoodBy: { by: "model", name: "fake-planner", tier: "external-model", reading: "count staircases" },
      calculatedBy: [{ name: "gemini-api:gemini-4-hydrogen", label: "Gemini 4 Hydrogen (Google)", tier: "external-model", did: "counted the staircases, because our detectors do not know this kind of item" }],
      from: { file: "plan.png", used: "the drawing image; 1 position the model pointed at" },
    });
    // A stated answer type leaves nothing to interpret: the source says so instead of naming a reader.
    const stated = await ask({ file: image, question: "what scale is this drawn at?", type: "text" }, deps(reading({}), eyes));
    expect(stated.source.understoodBy).toMatchObject({ by: "stated-type", tier: "script" });
    expect(stated.source.calculatedBy).toMatchObject([{ name: "gemini-api:gemini-4-hydrogen", tier: "external-model" }]);
  });

  it("falls back to the keyword patterns without an interpreter model", async () => {
    const answer = await ask({ file: image, question: "näytä makuuhuoneet" }, deps(null, vision()));
    expect(answer).toMatchObject({ value: 2, kind: "bedroom", note: "Bedrooms: 2 marked on the drawing." });
    expect(answer.method).toContain("read by the keyword parser (no interpreter model is configured)");
    expect(answer.evidence?.kind === "image" && answer.evidence.marks.map((m) => [m.n, m.x, m.y])).toEqual([[1, 20, 20], [2, 120, 20]]);
    // A qualified request is not turned into the count of the first keyword.
    const qualified = await ask({ file: image, question: "show me the bedroom door" }, deps(null, vision()));
    expect(qualified.value).toBe("Scale 1:100");
  });
});

describe("keyword readings, for when no interpreter model is there", () => {
  it("take a show-request only from the head of the question", () => {
    for (const question of ["show me the bedrooms", "Where is the sauna?", "näytä makuuhuoneet", "Markiere alle Fenster", "Où sont les toilettes ?", "Please mark the windows"]) {
      expect(isLocate(question), question).toBe(true);
    }
    for (const question of [
      "How many floors (storeys) does this floor plan show?", "rooms marked WC", "What is the net floor area of room 1.04 in m²?",
      "Which rooms show a window?", "What is the size of the room where the bathtub is?", "What does the mark 'KPH' mean?",
    ]) {
      expect(isLocate(question), question).toBe(false);
    }
  });

  it("tell a plain show-request from one with a qualifier", () => {
    expect(isPlainRequest("show me all the doors on this floor", /\bdoors\b/)).toBe(true);
    expect(isPlainRequest("Zeig mir die Fenster im Dachgeschoss", /fenster/, ["Dachgeschoss"])).toBe(true);
    expect(isPlainRequest("show me the doors of apartment A", /\bdoors\b/)).toBe(false);
    expect(isPlainRequest("where is the living room?", /\brooms?\b/)).toBe(false);
  });

  it("read loose unit wording as the measure it names", () => {
    expect(inferType("All walls in EG, total length is how many metre?")).toBe("length");
    expect(inferType("How much room space is there on Level 1 in square metres?")).toBe("area");
  });
});
