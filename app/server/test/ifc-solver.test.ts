import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
 * Upper floor: one bedroom 5 x 3 m.
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
#150=IFCSPACE('${guid(14)}',#5,'201',$,$,#22,#145,'Bedroom',.ELEMENT.,.INTERNAL.,$);
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
    expect(svg.match(/fill="#ff7a00"/g)).toHaveLength(1);
    expect(svg.match(/stroke="#c9c9c4"/g)!.length).toBeGreaterThanOrEqual(1);
    expect(svg.match(/fill="#4b4b48"/g)).toHaveLength(2);
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
    expect(largest?.value).toContain("Bedroom (201)");
    const software = await solveIfc(house, "What software and ifc standards were used to create this model?", "text");
    expect(software?.value).toContain("IFC2X3");
    expect(software?.value).toContain("Test CAD 1.0");
  });
});
