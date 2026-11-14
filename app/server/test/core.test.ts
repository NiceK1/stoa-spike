import { describe, expect, it } from "vitest";
import { renderPlanSvg } from "../src/evidence.js";
import { contains, polygonArea } from "../src/geometry.js";
import { inferType, parseTakeoff } from "../src/questions.js";
import { isCorrect } from "../src/scoring.js";
import { Plan, parseDxf } from "../src/solvers/dxf.js";
import { rasterTarget } from "../src/solvers/raster.js";
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

  it("reads the Finnish questions", () => {
    expect(rasterTarget("Kuinka monta ovea pohjapiirustuksessa on? Laske oviaukot, joissa on ovi.")?.id).toBe("door");
    expect(rasterTarget("Kuinka monta kerrosta pohjapiirustuksessa on esitetty?")?.id).toBe("floor");
    expect(rasterTarget("Kuinka monta suihkua ja kylpyammetta pohjapiirustukseen on piirretty yhteensä?")?.id).toBe("shower_bathtub");
    expect(rasterTarget("Kuinka monta erillistä WC-tilaa pohjapiirustuksessa on?")?.id).toBe("wc_room");
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
