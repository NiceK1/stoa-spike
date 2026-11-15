import { describe, expect, it } from "vitest";
import { renderPlanSvg } from "../src/evidence.js";
import { contains, polygonArea } from "../src/geometry.js";
import { inferType, parseTakeoff } from "../src/questions.js";
import { isCorrect } from "../src/scoring.js";
import { labelOf, model, tierOf } from "../src/source.js";
import { Plan, parseDxf } from "../src/solvers/dxf.js";
import { rasterTarget, rasterTargets, readByKeywords } from "../src/solvers/raster.js";
import type { Polygon } from "../src/types.js";

const rect = (x: number, y: number, w: number, h: number): Polygon => [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];
const polyline = (layer: string, points: Polygon, closed = true) =>
  `0\nLWPOLYLINE\n8\n${layer}\n90\n${points.length}\n70\n${closed ? 1 : 0}\n${points.map(([x, y]) => `10\n${x}\n20\n${y}\n`).join("")}`;
const text = (value: string, x: number, y: number) => `0\nTEXT\n8\nROOM_TEXT\n10\n${x}\n20\n${y}\n1\n${value}\n`;

describe("geometry", () => {
  it("measures area and containment", () => {
    expect(polygonArea(rect(0, 0, 2, 3))).toBeCloseTo(6);
    expect(contains(rect(0, 0, 2, 3), [1, 1])).toBe(true);
    expect(contains(rect(0, 0, 2, 3), [3, 1])).toBe(false);
  });
});

describe("scoring", () => {
  it("requires exact counts and allows two percent on measures", () => {
    expect(isCorrect("count", 13, 13)).toBe(true);
    expect(isCorrect("count", 13, 12)).toBe(false);
    expect(isCorrect("area", 100, 101.9)).toBe(true);
    expect(isCorrect("area", 100, 102.1)).toBe(false);
    expect(isCorrect("volume", 100, null)).toBe(false);
    expect(isCorrect("text", "office", "anything")).toBeNull();
  });
});

describe("the tier of a model in an answer's source", () => {
  it("follows the provider: our own weights, a model we host, or a model outside", () => {
    expect(tierOf("onnx:floorplan-symbols-yolo11l-1280+floorplan-yolo11m-1280")).toBe("own-model");
    expect(tierOf("gemma-local:interpreter-q8_0")).toBe("own-model");
    expect(tierOf("openai-compatible:gemma-4-31b:min1024")).toBe("self-hosted-model");
    for (const id of ["claude-cli:claude-sonnet-5-5", "anthropic-api:claude-haiku-5-5", "gemini-api:gemini-4-hydrogen", "roboflow:floor-plans/3"]) {
      expect(tierOf(id), id).toBe("external-model");
    }
  });

  it("takes a provider it does not know for an external one, never for ours", () => {
    expect(tierOf("some-new-provider:model")).toBe("external-model");
  });
});

describe("the label of a model in an answer's source", () => {
  it("names our own models by what they are and a model outside by product and vendor", () => {
    expect(labelOf("onnx:floorplan-symbols-yolo11l-1280+floorplan-yolo11m-1280")).toBe("Blueline detector (trained YOLO11)");
    expect(labelOf("gemma-local:interpreter-q8_0")).toBe("Blueline interpreter (tuned Gemma)");
    expect(labelOf("anthropic-api:claude-haiku-5-5")).toBe("Claude Haiku 5.5 (Anthropic)");
    expect(labelOf("claude-cli:claude-sonnet-5-5:high")).toBe("Claude Sonnet 5.5 (Anthropic)");
    expect(labelOf("gemini-api:gemini-4-hydrogen")).toBe("Gemini 4 Hydrogen (Google)");
    expect(labelOf("openai-compatible:gemma-4-31b:min1024")).toBe("gemma-4-31b (self-hosted)");
  });

  it("keeps the id of a model it has no product name for, and has no label for an unknown provider", () => {
    expect(labelOf("gemini-api:gemini-1.5-pro")).toBe("gemini-1.5-pro (Google)");
    expect(labelOf("onnx:floorplan-rfdetr-960")).toBe("Blueline detector");
    expect(labelOf("some-new-provider:model")).toBeUndefined();
    expect(model("some-new-provider:model", "counted")).toEqual({ name: "some-new-provider:model", tier: "external-model", did: "counted" });
  });
});

describe("take-off questions", () => {
  it("reads room labels in four languages", () => {
    expect(parseTakeoff("How many rooms labelled 'Cage d'escalier' are there on this floor?", "count")).toEqual({ kind: "count_rooms_labelled", name: "Cage d'escalier" });
    expect(parseTakeoff("Wie viele Räume mit der Bezeichnung «Korridor» gibt es in diesem Geschoss?", "count")?.name).toBe("Korridor");
    expect(parseTakeoff("Combien de pièces portant la désignation « Pièce » y a-t-il à cet étage ?", "count")?.name).toBe("Pièce");
    expect(parseTakeoff("Quanti locali con la denominazione «Stanza» ci sono in questo piano?", "count")?.name).toBe("Stanza");
  });

  it("separates symbols, rooms and apartments", () => {
    expect(parseTakeoff("Quante porte (porte interne e porte d'ingresso insieme) sono disegnate?", "count")?.kind).toBe("count_doors");
    expect(parseTakeoff("Wie viele WCs sind auf diesem Grundriss eingezeichnet?", "count")?.kind).toBe("count_toilets");
    expect(parseTakeoff("Combien d'appartements (logements) figurent sur ce plan d'étage ?", "count")?.kind).toBe("count_apartments");
    expect(parseTakeoff("Wie gross ist die Nettofläche von Raum U1.02 («Reduit») in m²?", "area")).toEqual({ kind: "area_room", number: "U1.02" });
    expect(parseTakeoff("Quelle est la surface nette de l'appartement B en m² ?", "area")).toEqual({ kind: "area_apartment", unit: "B" });
    expect(parseTakeoff("What is the fire rating of the stair core?", "text")).toBeNull();
  });

  it("guesses the answer type of a free question", () => {
    expect(inferType("How many windows are there?")).toBe("count");
    expect(inferType("What is the net floor area of room 1.04 in m²?")).toBe("area");
    expect(inferType("Who is the architect?")).toBe("text");
    expect(inferType("How many square metres is the living room?")).toBe("area");
    expect(inferType("How many metres of wall are on this level?")).toBe("length");
    expect(inferType("How many cubic metres of concrete are in the slabs?")).toBe("volume");
  });
});

describe("raster targets", () => {
  it("takes the first-mentioned item, not a later exclusion", () => {
    expect(rasterTarget("How many bathrooms or washrooms (e.g. KH, KPH) are on this floor plan, not counting separate WC rooms?")?.id).toBe("bathroom");
    expect(rasterTarget("How many separate WC rooms (toilet rooms marked WC) are on this floor plan?")?.id).toBe("wc_room");
    expect(rasterTarget("How many toilet bowls (WC seats) are drawn on this floor plan?")?.id).toBe("toilet");
    expect(rasterTarget("How many sinks and wash basins (kitchen and bathroom combined) are drawn on this floor plan?")?.id).toBe("sink");
    expect(rasterTarget("How many floors (storeys) does this floor plan show?")?.id).toBe("floor");
    expect(rasterTarget("How many windows are shown on this floor plan?")?.id).toBe("window");
  });

  it("separates showers, bathtubs and the two together", () => {
    expect(rasterTarget("How many showers are drawn on this floor plan?")?.id).toBe("shower");
    expect(rasterTarget("How many bathtubs are drawn on this floor plan?")?.id).toBe("bathtub");
    expect(rasterTarget("Kuinka monta suihkua pohjapiirustuksessa on?")?.id).toBe("shower");
    expect(rasterTarget("How many showers are there, not counting bathtubs?")?.id).toBe("shower");
    expect(rasterTarget("How many showers and bathtubs are drawn on this floor plan in total?")?.id).toBe("shower_bathtub");
  });

  it("takes every kind of a question that only lists kinds", () => {
    const ids = (question: string) => rasterTargets(question).map((t) => t.id);
    expect(ids("where sauna and where bathroom")).toEqual(["sauna", "bathroom"]);
    expect(ids("How many saunas and bathrooms are there?")).toEqual(["sauna", "bathroom"]);
    expect(ids("show me the showers and the bathtubs")).toEqual(["shower_bathtub"]);
    expect(ids("How many sinks and wash basins (kitchen and bathroom combined) are drawn on this floor plan?")).toEqual(["sink"]);
    expect(ids("How many bathrooms or washrooms (e.g. KH, KPH) are on this floor plan, not counting separate WC rooms?")).toEqual(["bathroom"]);
  });

  it("reads a list of kinds as a request to count and mark each, without an interpreter", () => {
    expect(readByKeywords("where sauna and where bathroom", "text")).toEqual({
      call: { operation: "count_known", targets: ["sauna", "bathroom"], whole: true }, locate: true, type: "count",
    });
    expect(readByKeywords("How many windows are shown on this floor plan?", "count").call).toEqual({ operation: "count_known", targets: ["window"], whole: true });
  });

  it("reads the Finnish questions", () => {
    expect(rasterTarget("Kuinka monta ovea pohjapiirustuksessa on? Laske oviaukot, joissa on ovi.")?.id).toBe("door");
    expect(rasterTarget("Kuinka monta kerrosta pohjapiirustuksessa on esitetty?")?.id).toBe("floor");
    expect(rasterTarget("Kuinka monta suihkua ja kylpyammetta pohjapiirustukseen on piirretty yhteensä?")?.id).toBe("shower_bathtub");
    expect(rasterTarget("Kuinka monta erillistä WC-tilaa pohjapiirustuksessa on?")?.id).toBe("wc_room");
  });
});

describe("layered DXF plan with a hole", () => {
  const plan = new Plan(parseDxf(
    "0\nSECTION\n2\nENTITIES\n" +
      polyline("ROOM_OUTLINE", rect(0, 0, 6, 4)) + polyline("ROOM_OUTLINE", rect(2, 1, 2, 2)) + text("App. A", 1, 3.5) + text("Zimmer", 1, 1.8) + text("1.01", 1, 1.5) +
      polyline("ROOM_OUTLINE", rect(2.5, 1.5, 1, 1)) + text("Lift", 3, 2.3) + text("1.02", 3, 2.0) +
      polyline("UNIT_OUTLINE", rect(0, 0, 6, 4)) + polyline("UNIT_OUTLINE", rect(2, 1, 2, 2)) +
      "0\nENDSEC\n0\nEOF\n",
  ));

  it("subtracts a nested ring from the room around it", () => {
    expect(plan.answer({ kind: "area_room", number: "1.01" })?.value).toBe(20);
    expect(plan.answer({ kind: "area_room", number: "1.02" })?.value).toBe(1);
    expect(plan.answer({ kind: "area_all_indoor" })?.value).toBe(21);
  });

  it("leaves rooms in a hole of the unit outline out of the apartment", () => {
    expect(plan.answer({ kind: "area_apartment", unit: "A" })?.value).toBe(20);
  });

  it("cuts the hole out of the highlight", () => {
    const room = plan.answer({ kind: "area_room", number: "1.01" })!;
    const svg = renderPlanSvg({ outlines: plan.roomOutlines, highlights: room.highlights }, room.cutouts);
    expect(svg).toMatch(/<path d="M[^"]* Z M[^"]* Z" fill="#2f6bff"[^>]*fill-rule="evenodd"/);
  });
});

describe("layered DXF plan", () => {
  const plan = new Plan(parseDxf(
    "0\nSECTION\n2\nENTITIES\n" +
      polyline("ROOM_OUTLINE", rect(0, 0, 4, 3)) + text("App. A", 2, 2.2) + text("Zimmer", 2, 1.8) + text("1.01", 2, 1.5) + text("12.00 m²", 2, 1.2) +
      polyline("ROOM_OUTLINE", rect(4, 0, 1, 2)) + text("1.02", 4.5, 1.0) +
      polyline("ROOM_OUTLINE", rect(0, 3, 4, 1)) + text("Balkon", 2, 3.8) + text("1.03", 2, 3.5) + text("4.00 m²", 2, 3.2) +
      polyline("UNIT_OUTLINE", rect(0, 0, 5, 4)) + polyline("DOOR", rect(3.9, 1, 0.2, 0.8)) +
      "0\nENDSEC\n0\nEOF\n",
  ));

  it("measures a room from its outline", () => {
    expect(plan.answer({ kind: "area_room", number: "1.01" })?.value).toBe(12);
    expect(plan.answer({ kind: "area_room", number: "9.99" })).toBeNull();
  });

  it("counts a number-only room in totals but not in label counts", () => {
    expect(plan.answer({ kind: "area_all_indoor" })?.value).toBe(14);
    expect(plan.answer({ kind: "count_rooms_labelled", name: "zimmer" })?.value).toBe(1);
  });

  it("leaves outdoor rooms out of an apartment's area", () => {
    expect(plan.answer({ kind: "area_apartment", unit: "A" })?.value).toBe(14);
    expect(plan.answer({ kind: "count_apartments" })?.value).toBe(1);
    expect(plan.answer({ kind: "count_doors" })?.value).toBe(1);
  });

  it("numbers every highlighted shape in the evidence drawing", () => {
    const svg = renderPlanSvg({ outlines: plan.roomOutlines, highlights: plan.answer({ kind: "count_rooms_labelled", name: "Zimmer" })!.highlights });
    expect(svg).toContain(">1</text>");
    expect(svg).not.toContain(">2</text>");
  });
});
