import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { VisionModel, VisionRequest } from "../src/models/vision.js";
import { ask } from "../src/router.js";
import { solveIfc } from "../src/solvers/ifc.js";

/** A rectangle of w x d millimetres with its corner at (x, y), extruded to a height, as a product shape. */
function box(id: number, x: number, y: number, w: number, d: number, height: number): string {
  return [
    `#${id}=IFCCARTESIANPOINT((${x + w / 2}.,${y + d / 2}.));`,
    `#${id + 1}=IFCAXIS2PLACEMENT2D(#${id},$);`,
    `#${id + 2}=IFCRECTANGLEPROFILEDEF(.AREA.,$,#${id + 1},${w}.,${d}.);`,
    `#${id + 3}=IFCEXTRUDEDAREASOLID(#${id + 2},#13,#11,${height}.);`,
    `#${id + 4}=IFCSHAPEREPRESENTATION(#14,'Body','SweptSolid',(#${id + 3}));`,
    `#${id + 5}=IFCPRODUCTDEFINITIONSHAPE($,$,(#${id + 4}));`,
  ].join("\n");
}

const guid = (n: number) => String(n).padStart(22, "0");

/**
 * A house in millimetres. Ground floor: kitchen 4 x 3 m, hall 2 x 3 m with a stored net floor area of 5.5 m²,
 * a wall with base quantities, a second wall without, and a stair exported as an IfcStair holding two IfcStair treads.
 * Upper floor: one bedroom 5 x 3 m, numbered 'Room no. 201'.
 */
const HOUSE = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('ViewDefinition [CoordinationView]'),'2;1');
FILE_NAME('house.ifc','2026-01-01T00:00:00',(''),(''),'by hand','Test exporter 1.0','');
FILE_SCHEMA(('IFC2X3'));
ENDSEC;
DATA;
#1=IFCPERSON($,$,'t',$,$,$,$,$);
#2=IFCORGANIZATION($,'t',$,$,$);
#3=IFCPERSONANDORGANIZATION(#1,#2,$);
#4=IFCAPPLICATION(#2,'1.0','Test CAD','TC');
#5=IFCOWNERHISTORY(#3,#4,$,.ADDED.,$,$,$,0);
#6=IFCSIUNIT(*,.LENGTHUNIT.,.MILLI.,.METRE.);
#7=IFCSIUNIT(*,.AREAUNIT.,$,.SQUARE_METRE.);
#8=IFCSIUNIT(*,.VOLUMEUNIT.,$,.CUBIC_METRE.);
#9=IFCUNITASSIGNMENT((#6,#7,#8));
#10=IFCCARTESIANPOINT((0.,0.,0.));
#11=IFCDIRECTION((0.,0.,1.));
#12=IFCDIRECTION((1.,0.,0.));
#13=IFCAXIS2PLACEMENT3D(#10,#11,#12);
#14=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-5,#13,$);
#15=IFCPROJECT('${guid(1)}',#5,'Test house',$,$,$,$,(#14),#9);
#16=IFCLOCALPLACEMENT($,#13);
#17=IFCBUILDING('${guid(2)}',#5,'House',$,$,#16,$,$,.ELEMENT.,$,$,$);
#18=IFCLOCALPLACEMENT(#16,#13);
#19=IFCBUILDINGSTOREY('${guid(3)}',#5,'Ground floor',$,$,#18,$,$,.ELEMENT.,0.);
#20=IFCCARTESIANPOINT((0.,0.,3000.));
#21=IFCAXIS2PLACEMENT3D(#20,#11,#12);
#22=IFCLOCALPLACEMENT(#16,#21);
#23=IFCBUILDINGSTOREY('${guid(4)}',#5,'Upper floor',$,$,#22,$,$,.ELEMENT.,3000.);
#24=IFCRELAGGREGATES('${guid(5)}',#5,$,$,#15,(#17));
#25=IFCRELAGGREGATES('${guid(6)}',#5,$,$,#17,(#19,#23));
${box(100, 0, 0, 4000, 3000, 2500)}
#110=IFCSPACE('${guid(10)}',#5,'101',$,$,#18,#105,'Kitchen',.ELEMENT.,.INTERNAL.,$);
${box(120, 4000, 0, 2000, 3000, 2500)}
#130=IFCSPACE('${guid(11)}',#5,'102',$,$,#18,#125,'Hall',.ELEMENT.,.INTERNAL.,$);
#131=IFCQUANTITYAREA('NetFloorArea',$,$,5.5);
#132=IFCELEMENTQUANTITY('${guid(12)}',#5,'BaseQuantities',$,$,(#131));
#133=IFCRELDEFINESBYPROPERTIES('${guid(13)}',#5,$,$,(#130),#132);
${box(140, 0, 0, 5000, 3000, 2500)}
#150=IFCSPACE('${guid(14)}',#5,'Room no. 201',$,$,#22,#145,'Bedroom',.ELEMENT.,.INTERNAL.,$);
#151=IFCRELAGGREGATES('${guid(15)}',#5,$,$,#19,(#110,#130));
#152=IFCRELAGGREGATES('${guid(16)}',#5,$,$,#23,(#150));
${box(200, 0, -200, 6000, 200, 2500)}
#210=IFCWALLSTANDARDCASE('${guid(20)}',#5,'W1',$,$,#18,#205,$);
#211=IFCQUANTITYLENGTH('Length',$,$,6000.);
#212=IFCQUANTITYAREA('NetSideArea',$,$,13.2);
#213=IFCQUANTITYVOLUME('NetVolume',$,$,2.9);
#214=IFCELEMENTQUANTITY('${guid(21)}',#5,'BaseQuantities',$,$,(#211,#212,#213));
#215=IFCRELDEFINESBYPROPERTIES('${guid(22)}',#5,$,$,(#210),#214);
${box(220, 0, 3000, 6000, 200, 2500)}
#230=IFCWALL('${guid(23)}',#5,'W2',$,$,#18,#225,$);
#240=IFCSTAIR('${guid(24)}',#5,'Stair',$,$,#18,$,$,.STRAIGHT_RUN_STAIR.);
${box(250, 4200, 200, 300, 1000, 150)}
#260=IFCSTAIR('${guid(25)}',#5,'Tread 1',$,$,#18,#255,$,.NOTDEFINED.);
${box(270, 4500, 200, 300, 1000, 300)}
#280=IFCSTAIR('${guid(26)}',#5,'Tread 2',$,$,#18,#275,$,.NOTDEFINED.);
#281=IFCRELAGGREGATES('${guid(27)}',#5,$,$,#240,(#260,#280));
#282=IFCRELCONTAINEDINSPATIALSTRUCTURE('${guid(28)}',#5,$,$,(#210,#230,#240),#19);
ENDSEC;
END-ISO-10303-21;
`;

let folder: string;
let house: string;

beforeAll(() => {
  folder = mkdtempSync(join(tmpdir(), "ifc-solver-"));
  house = join(folder, "house.ifc");
  writeFileSync(house, HOUSE);
});

afterAll(() => rmSync(folder, { recursive: true, force: true }));

describe("solveIfc on a hand-written model", () => {
  it("measures a room from its geometry, in metres", async () => {
    const answer = await solveIfc(house, "What is the net floor area of the room 'Kitchen (101)' on 'Ground floor', in m²?", "area");
    expect(answer).toMatchObject({ value: 12, unit: "m2", kind: "area_room", pipeline: "ifc-geometry", exact: true });
    expect(answer?.method).toContain("footprint");
  });

  it("prefers the stored net floor area over geometry", async () => {
    const answer = await solveIfc(house, "Kui suur on ruumi „Hall (102)“ netopõrandapind korrusel „Ground floor“ (m²)?", "area");
    expect(answer).toMatchObject({ value: 5.5, kind: "area_room" });
    expect(answer?.method).toContain("NetFloorArea");
  });

  it("says in the source whether a value was stored in the model or measured from its geometry", async () => {
    const stored = await solveIfc(house, "What is the net floor area of the room 'Hall (102)' on 'Ground floor', in m²?", "area");
    expect(stored?.source).toEqual({
      calculatedBy: [{ name: "IFC stored quantities", tier: "script", did: "the NetFloorArea of the room" }],
      from: { file: "house.ifc", used: "1 IfcSpace, room 'Hall (102)' on storey Ground floor" },
    });
    const measured = await solveIfc(house, "What is the net floor area of the room 'Kitchen (101)' on 'Ground floor', in m²?", "area");
    expect(measured?.source.calculatedBy).toEqual([{ name: "IFC geometry script (web-ifc)", tier: "script", did: "measured the room's plan footprint" }]);
    const both = await solveIfc(house, "What is the total net floor area of all rooms on 'Ground floor' in m²?", "area");
    expect(both?.source.calculatedBy).toEqual([
      { name: "IFC stored quantities", tier: "script", did: "the NetFloorArea of 1 of the 2 rooms" },
      { name: "IFC geometry script (web-ifc)", tier: "script", did: "measured the plan footprint of the other 1" },
    ]);
    expect(both?.source.from.used).toBe("2 IfcSpace rooms on storey Ground floor");
    const missing = await solveIfc(house, "What is the net floor area of the room 'Sauna' on 'Ground floor', in m²?", "area");
    expect(missing?.source).toMatchObject({ calculatedBy: [], needed: "no room named 'Sauna' on Ground floor", from: { file: "house.ifc", used: "nothing" } });
  });

  it("totals the rooms of one storey only", async () => {
    const answer = await solveIfc(house, "Hvad er det samlede nettoareal af alle rum på 'Ground floor' i m²?", "area");
    expect(answer).toMatchObject({ value: 17.5, kind: "area_storey_rooms" });
  });

  it("counts elements per storey and in the model", async () => {
    expect(await solveIfc(house, "How many rooms (spaces) are shown on the floor plan of 'Ground floor'?", "count")).toMatchObject({ value: 2, kind: "count_space_storey" });
    expect(await solveIfc(house, "How many rooms (spaces) are there in the model 'Test house'?", "count")).toMatchObject({ value: 3, kind: "count_space_model" });
    expect(await solveIfc(house, "Hvor mange vægge er vist på plantegningen for 'Ground floor'?", "count")).toMatchObject({ value: 2 });
    expect(await solveIfc(house, "Mitu ust on mudelis „Test house“?", "count")).toMatchObject({ value: 0, kind: "count_door_model" });
  });

  it("counts a stair once, not its treads", async () => {
    expect(await solveIfc(house, "How many stairs are shown on the floor plan of 'Ground floor'?", "count")).toMatchObject({ value: 1 });
    expect(await solveIfc(house, "How many stairs are there in the model 'Test house'?", "count")).toMatchObject({ value: 1 });
  });

  it("sums stored wall quantities, converting millimetres", async () => {
    expect(await solveIfc(house, "What is the total length of all walls on 'Ground floor', in metres?", "length")).toMatchObject({ value: 6, unit: "m", kind: "length_walls_storey" });
    expect(await solveIfc(house, "What is the total net side area of all walls on 'Ground floor', in m²?", "area")).toMatchObject({ value: 13.2, unit: "m2" });
    const volume = await solveIfc(house, "What is the total net volume of all walls on 'Ground floor', in m³?", "volume");
    expect(volume).toMatchObject({ value: 2.9, unit: "m3" });
    expect(volume?.note).toContain("1 walls have no NetVolume");
  });

  it("draws the storey with the answer highlighted", async () => {
    const answer = await solveIfc(house, "What is the net floor area of the room 'Kitchen (101)' on 'Ground floor', in m²?", "area");
    expect(answer?.evidence?.kind).toBe("svg");
    const svg = answer?.evidence?.kind === "svg" ? answer.evidence.svg : "";
    // One highlighted room, the other room as an outline, two walls solid.
    expect(svg.match(/fill="#2f6bff"/g)).toHaveLength(1);
    expect(svg.match(/stroke="#c3cbdb"/g)!.length).toBeGreaterThanOrEqual(1);
    expect(svg.match(/fill="#3b4459"/g)).toHaveLength(2);
    expect(svg).toContain("Kitchen (101)");
  });

  it("says what is missing instead of guessing", async () => {
    const answer = await solveIfc(house, "How many doors are shown on the floor plan of 'Attic'?", "count");
    expect(answer?.value).toBeNull();
    expect(answer?.method).toContain("no storey named 'Attic'");
  });

  it("returns null for a question it does not understand", async () => {
    expect(await solveIfc(house, "How many toilets are shown on this floor plan?", "count")).toBeNull();
    // An area asked of a storey in unknown wording could be rooms or wall sides.
    expect(await solveIfc(house, "Kui suur on pind korrusel „Ground floor“?", "area")).toBeNull();
  });

  it("rejects a file that is not an IFC model, and keeps working afterwards", async () => {
    const broken = join(folder, "broken.ifc");
    writeFileSync(broken, "not an IFC file");
    await expect(solveIfc(broken, "How many doors are there in the model 'x'?", "count")).rejects.toThrow("broken.ifc could not be read as an IFC model");
    expect(await solveIfc(house, "How many walls are there in the model 'Test house'?", "count")).toMatchObject({ value: 2 });
  });

  it("answers free-text questions from the model's own records", async () => {
    const levels = await solveIfc(house, "What are the heights of each level?", "text");
    expect(levels?.value).toContain("Ground floor: elevation 0.00 m, 3.00 m up to Upper floor");
    const largest = await solveIfc(house, "Which room in the building is the largest?", "text");
    expect(largest?.value).toContain("Bedroom (Room no. 201)");
    const software = await solveIfc(house, "What software and ifc standards were used to create this model?", "text");
    expect(software?.value).toContain("IFC2X3");
    expect(software?.value).toContain("Test CAD 1.0");
  });
});

describe("a question about a building model, read by the interpreter", () => {
  type Recording = VisionModel & { requests: VisionRequest[] };
  /** An interpreter that returns `fields` as its call and records what it was asked. */
  function interpreter(fields: Record<string, unknown>): Recording {
    const requests: VisionRequest[] = [];
    const output = { elements: [], storey: "", rooms: [], pick: "all", measure: "count", quantity: "none", missing: [], reason: "", locate: false, answer_type: "count", ...fields };
    return {
      id: "fake-planner", requests,
      ask: async (request) => {
        requests.push(request);
        return { output, seconds: 0, costUsd: 0, cached: false };
      },
    };
  }
  const writer: VisionModel = { id: "fake-writer", ask: async () => ({ output: { answer: "On the ground floor.", value: null, unit: null, sections: [], classes: [] }, seconds: 0, costUsd: 0, cached: false }) };
  const about = (question: string, fields: Record<string, unknown>, planner = interpreter(fields)) =>
    ask({ file: house, question }, { vision: writer, planner, detector: null, fileUrl: () => "" });
  const highlights = (answer: Awaited<ReturnType<typeof ask>>) => (answer.evidence?.kind === "svg" ? (answer.evidence.svg.match(/fill="#2f6bff"/g) ?? []).length : 0);

  it("sees the model's storeys, element classes and room names, and the rule parser's reading", async () => {
    const planner = interpreter({ operation: "count_elements", elements: ["wall"], storey: "Ground floor" });
    const answer = await about("How many walls are shown on the floor plan of 'Ground floor'?", {}, planner);
    const { prompt, schema } = planner.requests[0];
    expect(prompt).toContain("A keyword parser reads this as: count every wall on the storey or in the model named 'Ground floor'.");
    expect(prompt).toContain("Storeys, lowest first: 'Ground floor' (elevation 0.00 m, 2 rooms), 'Upper floor' (elevation 3.00 m, 1 rooms)");
    expect(prompt).toContain("space (rooms) 3, wall (walls) 2, stair (stairs) 1");
    expect(prompt).toContain("Room names (rooms carrying each): 'Bedroom', 'Hall', 'Kitchen'");
    expect((schema.properties as any).storey.enum).toEqual(["Ground floor", "Upper floor", ""]);
    expect(answer).toMatchObject({ value: 2, kind: "count_wall_storey", exact: true });
    expect(answer.method).toBe(`understood as "count walls on 'Ground floor'" by fake-planner; IfcWall elements on storey Ground floor`);
  });

  it("highlights the one room a where-question names, not every room of the model", async () => {
    const answer = await about("where is the kitchen?", { operation: "rooms", rooms: ["Kitchen"], locate: true });
    expect(answer).toMatchObject({ value: 1, unit: "count", note: "The 1 counted item is highlighted on the drawing." });
    expect(highlights(answer)).toBe(1);
  });

  it("maps an everyday storey word through the interpreter's choice of storey name", async () => {
    const answer = await about("how big is the bedroom upstairs?", { operation: "rooms", rooms: ["Bedroom"], storey: "Upper floor", measure: "area", answer_type: "area" });
    expect(answer).toMatchObject({ value: 15, unit: "m2", kind: "area_room" });
  });

  it("finds a room by its name and the number inside a longer room number", async () => {
    const answer = await about("area of Bedroom 201?", { operation: "rooms", rooms: ["Bedroom (201)"], measure: "area", answer_type: "area" });
    expect(answer).toMatchObject({ value: 15, unit: "m2", kind: "area_room" });
    expect(answer.method).toContain("room 'Bedroom (Room no. 201)' on Upper floor");
  });

  it("adds up several rooms and several element classes, and says what the total consists of", async () => {
    const rooms = await about("area of the kitchen and the hall", { operation: "rooms", rooms: ["Kitchen (101)", "Hall"], measure: "area", answer_type: "area" });
    expect(rooms).toMatchObject({ value: 17.5, unit: "m2", note: "The total consists of Kitchen (101) 12.00 m², Hall (102) 5.50 m²." });
    expect(highlights(rooms)).toBe(2);
    const elements = await about("walls and stairs downstairs", { operation: "count_elements", elements: ["wall", "stair"], storey: "Ground floor" });
    expect(elements).toMatchObject({ value: 3, note: "The total of 3 consists of 2 walls and 1 stair." });
  });

  it("names the largest room and highlights it alone", async () => {
    const answer = await about("Show me the largest room", { operation: "rooms", pick: "largest", locate: true });
    expect(answer.value).toBe("'Bedroom (Room no. 201)' on Upper floor, 15.00 m²");
    expect(answer.note).toBe("The items behind the answer are highlighted on the drawing.");
    expect(highlights(answer)).toBe(1);
  });

  it("says that the model does not have a storey or a room instead of answering for another", async () => {
    const storey = await about("doors in the attic?", { operation: "count_elements", elements: ["wall"], missing: ["attic"] });
    expect(storey).toMatchObject({ value: null, pipeline: "none", note: "The building model does not have 'attic'. Its storeys are 'Ground floor', 'Upper floor'." });
    expect(storey.source).toMatchObject({ calculatedBy: [], needed: "The building model does not have 'attic'.", from: { file: "house.ifc", used: "nothing" } });
    const room = await about("area of the sauna and the kitchen", { operation: "rooms", rooms: ["Sauna", "Kitchen"], measure: "area", answer_type: "area" });
    expect(room.value).toBeNull();
    expect(room.method).toContain("the model has no room named 'Sauna' in the model");
  });

  it("gives the source of a count: the interpreter's reading, our script, and the elements counted", async () => {
    const answer = await about("how many walls downstairs?", { operation: "count_elements", elements: ["wall"], storey: "Ground floor" });
    expect(answer.value).toBe(2);
    expect(answer.source).toEqual({
      understoodBy: { by: "model", name: "fake-planner", tier: "external-model", reading: expect.stringContaining("count walls") },
      calculatedBy: [{ name: "IFC model script (web-ifc)", tier: "script" }],
      from: { file: "house.ifc", used: "2 IfcWall elements on storey Ground floor" },
    });
  });

  it("names only the scripts the areas of the selected rooms came from", async () => {
    const largest = await about("which room is the largest?", { operation: "rooms", pick: "largest", answer_type: "text" });
    expect(largest.source).toMatchObject({
      calculatedBy: [
        { name: "IFC stored quantities", tier: "script", did: "the NetFloorArea of 1 of the 3 rooms" },
        { name: "IFC geometry script (web-ifc)", tier: "script", did: "measured the plan footprint of the other 2" },
      ],
      from: { file: "house.ifc", used: "3 IfcSpace rooms in the model" },
    });
    // Neither of these two rooms stores an area, so the stored quantities are not named.
    const measured = await about("kitchen and bedroom together", { operation: "rooms", rooms: ["Kitchen", "Bedroom"], measure: "area", answer_type: "area" });
    expect(measured.value).toBe(27);
    expect(measured.source.calculatedBy).toEqual([{ name: "IFC geometry script (web-ifc)", tier: "script", did: "measured each room's plan footprint" }]);
  });

  it("names both the script that extracted the facts and the model that worded the answer", async () => {
    const answer = await about("what are the walls made of?", { operation: "model_facts", answer_type: "text" });
    expect(answer.source.calculatedBy).toEqual([
      { name: "IFC facts script (web-ifc)", tier: "script", did: "extracted the model's facts as text" },
      { name: "fake-writer", tier: "external-model", did: "wrote the answer from those facts" },
    ]);
    expect(answer.source.from.file).toBe("house.ifc");
    const none: VisionModel = { id: "none", ask: async () => { throw new Error("This question needs a vision model"); } };
    const unanswered = await ask({ file: house, question: "what are the walls made of?" }, { vision: none, planner: null, detector: null, fileUrl: () => "" });
    expect(unanswered.source).toMatchObject({ understoodBy: { by: "keyword-parser" }, calculatedBy: [], from: { file: "house.ifc", used: "nothing" } });
    expect(unanswered.source.needed).toContain("an outside language model is needed");
  });

  it("names the model that reworded a question for the keyword parser", async () => {
    const english = "How many walls are shown on the floor plan of 'Ground floor'?";
    const translator: VisionModel = { id: "anthropic-api:claude-haiku-5-5", ask: async () => ({ output: { question: english }, seconds: 0, costUsd: 0, cached: false }) };
    const answer = await ask({ file: house, question: "Zenbat horma daude 'Ground floor' solairuan?", type: "count" }, { vision: translator, planner: null, detector: null, fileUrl: () => "" });
    expect(answer.value).toBe(2);
    expect(answer.source.understoodBy).toEqual({
      by: "keyword-parser", name: "Keyword parser", tier: "script", why: "no interpreter model is configured",
      helper: { name: "anthropic-api:claude-haiku-5-5", label: "Claude Haiku 5.5 (Anthropic)", tier: "external-model", did: `rewrote the question in English as "${english}" for the keyword parser` },
    });
  });

  it("hands a question about the model's facts to the fact-sheet writer", async () => {
    const answer = await about("what are the walls made of?", { operation: "model_facts", answer_type: "text" });
    expect(answer).toMatchObject({ value: "On the ground floor.", pipeline: "ifc-facts", exact: false });
    expect(answer.method).toContain(`understood as "a question about facts in the building model" by fake-planner; answered by fake-writer`);
  });

  it("answers a question about the model's facts with no value and the reason when no outside model is configured", async () => {
    const none: VisionModel = { id: "none", ask: async () => { throw new Error("This question needs a vision model"); } };
    const planner = interpreter({ operation: "model_facts", answer_type: "text" });
    for (const reader of [{ planner }, { planner: null }]) {
      const answer = await ask({ file: house, question: "what are the walls made of?" }, { vision: none, detector: null, fileUrl: () => "", ...reader });
      expect(answer).toMatchObject({ value: null, pipeline: "none" });
      expect(answer.note).toContain("it needs an outside language model, and none is configured (VISION_PROVIDER=none)");
    }
    // What the code computes needs no model.
    expect(await ask({ file: house, question: "Show me the walls" }, { vision: none, planner: null, detector: null, fileUrl: () => "" })).toMatchObject({ value: 2 });
  });

  it("has a model of its own word the facts when the line-up names one, and says which mode would when it has none", async () => {
    const none: VisionModel = { id: "none", ask: async () => { throw new Error("This question needs a vision model"); } };
    const wording: VisionModel = { ...writer, id: "anthropic-api:claude-sonnet-5-5" };
    const worded = await ask({ file: house, question: "what are the walls made of?" }, { vision: none, text: wording, planner: null, detector: null, fileUrl: () => "" });
    expect(worded.source.calculatedBy[1]).toEqual({ name: "anthropic-api:claude-sonnet-5-5", label: "Claude Sonnet 5.5 (Anthropic)", tier: "external-model", did: "wrote the answer from those facts" });

    const advice = { none: "Blueline only calls none", remedy: "Best accuracy, or a reader chosen in Custom, would answer it", retry: "best" as const };
    const unanswered = await ask({ file: house, question: "what are the walls made of?" }, { vision: none, text: none, planner: null, detector: null, fileUrl: () => "", advice });
    expect(unanswered).toMatchObject({ value: null, retry: { mode: "best" } });
    expect(unanswered.source.needed).toBe(
      "an outside language model is needed to write the answer from the model's facts; Blueline only calls none. Best accuracy, or a reader chosen in Custom, would answer it",
    );
  });

  it("without an interpreter, does not turn a question about one room into a count of all rooms", async () => {
    const answer = await ask({ file: house, question: "Where is the kitchen?" }, { vision: writer, planner: null, detector: null, fileUrl: () => "" });
    expect(answer.value).toBe("On the ground floor.");
    expect(answer.method).toContain("read by the keyword parser (no interpreter model is configured)");
    const plain = await ask({ file: house, question: "Show me the walls" }, { vision: writer, planner: null, detector: null, fileUrl: () => "" });
    expect(plain).toMatchObject({ value: 2, note: "The 2 counted items are highlighted on the drawing." });
  });
});
