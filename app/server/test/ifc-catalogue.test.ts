import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { VisionModel, VisionRequest } from "../src/models/vision.js";
import { loadCatalogue } from "../src/solvers/ifc/catalogue.js";
import { answerFromDigest, factsFor } from "../src/solvers/ifc/digest.js";

const guid = (n: number) => String(n).padStart(22, "0");

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

/**
 * A plant room in millimetres. Ground floor: two cavity walls of one type with a three-layer set, marked external,
 * a pipe, a stair holding two treads, and a kitchen with a stored area and height. Upper floor: an internal partition,
 * a second pipe, and a store room measured from its body. Both pipes belong to one heating system.
 */
const PLANT = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('ViewDefinition [CoordinationView]'),'2;1');
FILE_NAME('plant.ifc','2026-01-01T00:00:00',('A. Author'),('Org Ltd'),'by hand','Test exporter 1.0','');
FILE_SCHEMA(('IFC2X3'));
ENDSEC;
DATA;
#1=IFCPERSON($,$,'t',$,$,$,$,$);
#2=IFCORGANIZATION($,'Test vendor',$,$,$);
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
#15=IFCPROJECT('${guid(1)}',#5,'P-1',$,$,'Test plant',$,(#14),#9);
#16=IFCLOCALPLACEMENT($,#13);
#17=IFCBUILDING('${guid(2)}',#5,'House','A test house',$,#16,$,'Office block',.ELEMENT.,$,$,#30);
#18=IFCLOCALPLACEMENT(#16,#13);
#19=IFCBUILDINGSTOREY('${guid(3)}',#5,'Ground floor',$,$,#18,$,$,.ELEMENT.,0.);
#20=IFCCARTESIANPOINT((0.,0.,3000.));
#21=IFCAXIS2PLACEMENT3D(#20,#11,#12);
#22=IFCLOCALPLACEMENT(#16,#21);
#23=IFCBUILDINGSTOREY('${guid(4)}',#5,'Upper floor',$,$,#22,$,$,.ELEMENT.,3000.);
#24=IFCRELAGGREGATES('${guid(5)}',#5,$,$,#15,(#31));
#25=IFCRELAGGREGATES('${guid(6)}',#5,$,$,#17,(#19,#23));
#26=IFCRELAGGREGATES('${guid(7)}',#5,$,$,#31,(#17));
#30=IFCPOSTALADDRESS($,$,$,$,('1 Main Street'),$,'Espoo',$,'02150','Finland');
#31=IFCSITE('${guid(8)}',#5,'Plot',$,$,#16,$,$,.ELEMENT.,(60,10,30,0),(24,56,15,0),12000.,$,$);
#40=IFCMATERIAL('Brick');
#41=IFCMATERIAL('Rigid insulation');
#42=IFCMATERIAL('Concrete block');
#43=IFCMATERIALLAYER(#40,90.,$);
#44=IFCMATERIALLAYER(#41,50.,$);
#45=IFCMATERIALLAYER(#42,190.,$);
#46=IFCMATERIALLAYERSET((#43,#44,#45),'Cavity wall');
#47=IFCMATERIALLAYERSETUSAGE(#46,.AXIS2.,.POSITIVE.,0.);
#48=IFCRELASSOCIATESMATERIAL('${guid(9)}',#5,$,$,(#60,#61),#47);
#50=IFCWALLTYPE('${guid(10)}',#5,'Cavity wall 330',$,$,$,$,$,$,.STANDARD.);
#60=IFCWALLSTANDARDCASE('${guid(11)}',#5,'W1',$,$,#18,$,'1');
#61=IFCWALLSTANDARDCASE('${guid(12)}',#5,'W2',$,$,#18,$,'2');
#62=IFCWALL('${guid(13)}',#5,'W3',$,'Partition',#22,$,'3');
#63=IFCRELDEFINESBYTYPE('${guid(14)}',#5,$,$,(#60,#61),#50);
#64=IFCPROPERTYSINGLEVALUE('IsExternal',$,IFCBOOLEAN(.T.),$);
#65=IFCPROPERTYSET('${guid(15)}',#5,'Pset_WallCommon',$,(#64));
#66=IFCRELDEFINESBYPROPERTIES('${guid(16)}',#5,$,$,(#60,#61),#65);
#67=IFCPROPERTYSINGLEVALUE('IsExternal',$,IFCBOOLEAN(.F.),$);
#68=IFCPROPERTYSET('${guid(17)}',#5,'Pset_WallCommon',$,(#67));
#69=IFCRELDEFINESBYPROPERTIES('${guid(18)}',#5,$,$,(#62),#68);
#70=IFCQUANTITYLENGTH('Length',$,$,6000.);
#71=IFCELEMENTQUANTITY('${guid(19)}',#5,'BaseQuantities',$,$,(#70));
#72=IFCRELDEFINESBYPROPERTIES('${guid(20)}',#5,$,$,(#60),#71);
#73=IFCQUANTITYLENGTH('Length',$,$,4000.);
#74=IFCELEMENTQUANTITY('${guid(21)}',#5,'BaseQuantities',$,$,(#73));
#75=IFCRELDEFINESBYPROPERTIES('${guid(22)}',#5,$,$,(#61),#74);
#76=IFCQUANTITYLENGTH('Length',$,$,2500.);
#77=IFCELEMENTQUANTITY('${guid(23)}',#5,'BaseQuantities',$,$,(#76));
#78=IFCRELDEFINESBYPROPERTIES('${guid(24)}',#5,$,$,(#62),#77);
#80=IFCPIPESEGMENTTYPE('${guid(25)}',#5,'Copper pipe',$,$,$,$,$,$,.RIGIDSEGMENT.);
#81=IFCFLOWSEGMENT('${guid(26)}',#5,'Copper pipe:101',$,'Copper pipe',#18,$,'101');
#82=IFCFLOWSEGMENT('${guid(27)}',#5,'Copper pipe:102',$,'Copper pipe',#22,$,'102');
#83=IFCRELDEFINESBYTYPE('${guid(28)}',#5,$,$,(#81,#82),#80);
#84=IFCPROPERTYSINGLEVALUE('Length',$,IFCLENGTHMEASURE(1500.),$);
#85=IFCPROPERTYSET('${guid(29)}',#5,'Dimensions',$,(#84));
#86=IFCRELDEFINESBYPROPERTIES('${guid(30)}',#5,$,$,(#81),#85);
#87=IFCPROPERTYSINGLEVALUE('Length',$,IFCLENGTHMEASURE(2500.),$);
#88=IFCPROPERTYSET('${guid(31)}',#5,'Dimensions',$,(#87));
#89=IFCRELDEFINESBYPROPERTIES('${guid(32)}',#5,$,$,(#82),#88);
#90=IFCSYSTEM('${guid(33)}',#5,'Heating supply',$,'Hydronic supply');
#91=IFCRELASSIGNSTOGROUP('${guid(34)}',#5,$,$,(#81,#82),$,#90);
${box(100, 0, 0, 4000, 3000, 2500)}
#110=IFCSPACE('${guid(40)}',#5,'101',$,$,#18,#105,'Kitchen',.ELEMENT.,.INTERNAL.,$);
#111=IFCQUANTITYAREA('NetFloorArea',$,$,11.5);
#112=IFCQUANTITYLENGTH('Height',$,$,2400.);
#113=IFCELEMENTQUANTITY('${guid(41)}',#5,'BaseQuantities',$,$,(#111,#112));
#114=IFCRELDEFINESBYPROPERTIES('${guid(42)}',#5,$,$,(#110),#113);
${box(120, 0, 0, 5000, 3000, 2700)}
#130=IFCSPACE('${guid(43)}',#5,'201',$,$,#22,#125,'Store',.ELEMENT.,.INTERNAL.,$);
#131=IFCRELAGGREGATES('${guid(44)}',#5,$,$,#19,(#110));
#132=IFCRELAGGREGATES('${guid(45)}',#5,$,$,#23,(#130));
#140=IFCSTAIR('${guid(46)}',#5,'Stair',$,$,#18,$,$,.STRAIGHT_RUN_STAIR.);
#141=IFCSTAIR('${guid(47)}',#5,'Tread 1',$,$,#18,$,$,.NOTDEFINED.);
#142=IFCSTAIR('${guid(48)}',#5,'Tread 2',$,$,#18,$,$,.NOTDEFINED.);
#143=IFCRELAGGREGATES('${guid(49)}',#5,$,$,#140,(#141,#142));
#150=IFCRELCONTAINEDINSPATIALSTRUCTURE('${guid(50)}',#5,$,$,(#60,#61,#81,#140),#19);
#151=IFCRELCONTAINEDINSPATIALSTRUCTURE('${guid(51)}',#5,$,$,(#62,#82),#23);
ENDSEC;
END-ISO-10303-21;
`;

/** A language model that replies from a script and keeps what it was asked. */
function scripted(replies: Record<string, unknown>[]): VisionModel & { asked: VisionRequest[] } {
  const asked: VisionRequest[] = [];
  return {
    id: "scripted",
    asked,
    async ask(request) {
      asked.push(request);
      return { output: replies[asked.length - 1] as Record<string, any>, seconds: 0, costUsd: 0, cached: false };
    },
  };
}

let folder: string;
let plant: string;

beforeAll(() => {
  folder = mkdtempSync(join(tmpdir(), "ifc-catalogue-"));
  plant = join(folder, "plant.ifc");
  writeFileSync(plant, PLANT);
});

afterAll(() => rmSync(folder, { recursive: true, force: true }));

describe("the catalogue of a hand-written model", () => {
  it("reads the header, the project records and the location", async () => {
    const project = (await loadCatalogue(plant)).project();
    expect(project).toContain("FILE_SCHEMA (IFC standard, as written in the file): IFC2X3");
    expect(project).toContain("originating system: Test exporter 1.0");
    expect(project).toContain("author: A. Author");
    expect(project).toContain("IfcApplication (modelling program): Test CAD, version 1.0, identifier TC, developer Test vendor");
    expect(project).toContain("- LongName: Test plant");
    expect(project).toContain("- Description: A test house");
    expect(project).toContain("- RefLatitude: 60.175000°");
    expect(project).toContain("- RefLongitude: 24.937500°");
    expect(project).toContain("- RefElevation: 12 m");
    expect(project).toContain("- Postal address: 1 Main Street, Espoo, 02150, Finland");
    expect(project).toContain("- Ground floor: elevation 0 m, 3 m up to Upper floor");
  });

  it("lists every element class with counts per storey and type names", async () => {
    const inventory = (await loadCatalogue(plant)).inventory();
    expect(inventory).toContain("- IfcWall: 3 | by storey: Ground floor 2, Upper floor 1 | 2 type names: Cavity wall 330 ×2; Partition ×1");
    // An IFC2x3 flow segment is named by the class of its type object.
    expect(inventory).toContain("- IfcPipeSegment (IfcFlowSegment): 2 | by storey: Ground floor 1, Upper floor 1 | 1 type name: Copper pipe ×2");
    expect(inventory).toContain("- IfcStair: 1 (not counted: 2 parts of these elements that are IfcStair records themselves");
    expect(inventory).toContain("- IfcSpace: 2");
  });

  it("gives a class its types with material layers, flags and quantity totals", async () => {
    const walls = (await loadCatalogue(plant)).classDetail("IfcWall");
    expect(walls).toContain("IsExternal: external 2, internal 1");
    expect(walls).toContain("- Length of the external ones 10 m, of the internal ones 2.5 m");
    expect(walls).toContain("- Length total 12.5 m (each 2.5–6); by storey: Ground floor 10, Upper floor 2.5");
    expect(walls).toContain("layer set 'Cavity wall': layers in order Brick 90 mm | Rigid insulation 50 mm | Concrete block 190 mm; total 330 mm");
    expect(walls).toContain("- Cavity wall 330 ×2 | storeys: Ground floor 2 | predefined type STANDARD | external 2, internal 0");
    expect(walls).toContain("- Pset_WallCommon.IsExternal: yes ×2; no ×1");
  });

  it("totals a length that is stored as a property", async () => {
    const pipes = (await loadCatalogue(plant)).classDetail("IfcPipeSegment (IfcFlowSegment)");
    expect(pipes).toContain("- Length total 4 m (each 1.5–2.5); by storey: Ground floor 1.5, Upper floor 2.5");
    expect(pipes).toContain("Predefined types: RIGIDSEGMENT 2");
  });

  it("lists rooms with stored or measured area, height and volume", async () => {
    const spaces = (await loadCatalogue(plant)).spaces();
    expect(spaces).toContain("- Kitchen (101): 11.5 m², height 2.4 m, volume 30 m³");
    expect(spaces).toContain("- Store (201): 15 m², height 2.7 m, volume 40.5 m³");
    expect(spaces).toContain("Sum of the space areas of the whole model: 26.5 m²");
  });

  it("lists systems with their members by class", async () => {
    const systems = (await loadCatalogue(plant)).systems();
    expect(systems).toContain("Systems and groups: 1 (IfcSystem 1)");
    expect(systems).toContain("- IfcSystem 'Heating supply' (Hydronic supply): 2 members — IfcPipeSegment (IfcFlowSegment) 2");
  });

  it("looks up the objects a question names by GlobalId or room number", async () => {
    const catalogue = await loadCatalogue(plant);
    const wall = catalogue.lookups(`What is the length of the wall ${guid(11)}?`);
    expect(wall).toContain(`IfcWall 'W1' (GlobalId ${guid(11)}), type Cavity wall 330, on storey Ground floor`);
    expect(wall).toContain("- quantity Length: 6 m");
    expect(catalogue.lookups("How high is the ceiling in room 101?")).toContain("- quantity Height: 2.4 m");
    expect(catalogue.lookups("How many doors are there?")).toBe("");
  });

  it("assembles the sections asked for and says what it cut", async () => {
    const catalogue = await loadCatalogue(plant);
    expect(catalogue.findClass("ifcpipesegment")).toBe("IfcPipeSegment (IfcFlowSegment)");
    const facts = catalogue.assemble({ sections: ["systems"], classes: ["IfcWall", "IfcNoSuchThing"] }, 50_000);
    expect(facts).toContain("### IfcWall: 3 elements");
    expect(facts).toContain("IfcSystem 'Heating supply'");
    expect(facts).not.toContain("### IfcPipeSegment");
    expect(facts).not.toContain("Kitchen (101)");
    const cut = catalogue.assemble({ sections: [], classes: ["IfcWall"] }, 1500);
    expect(cut.length).toBeLessThan(1700);
    expect(cut).toMatch(/more lines of this section were left out for length|further sections were left out for length/);
  });
});

describe("answering from the catalogue", () => {
  it("answers in one call when the whole catalogue fits", async () => {
    const model = scripted([{ answer: "The external walls carry 50 mm of rigid insulation.", value: 50, unit: "mm" }]);
    const answer = await answerFromDigest(plant, "How thick is the insulation of the external walls?", "text", model);
    expect(answer).toMatchObject({ value: "The external walls carry 50 mm of rigid insulation.", pipeline: "ifc-facts", exact: false, kind: "ifc_facts_text" });
    expect(model.asked).toHaveLength(1);
    expect(model.asked[0].prompt).toContain("Rigid insulation 50 mm");
    expect(model.asked[0].prompt).toContain("Kitchen (101)");
  });

  it("asks which sections are needed when the catalogue is too long, and answers from those", async () => {
    const model = scripted([{ sections: [], classes: ["IfcPipeSegment (IfcFlowSegment)"] }]);
    const facts = await factsFor(plant, "What is the total length of pipe?", model, 4000);
    expect(model.asked).toHaveLength(1);
    expect(model.asked[0].prompt).toContain("- IfcPipeSegment (IfcFlowSegment): 2");
    expect(model.asked[0].prompt).not.toContain("### IfcPipeSegment");
    expect(facts).toContain("### IfcPipeSegment (IfcFlowSegment): 2 elements");
    expect(facts).not.toContain("### IfcWall");
  });
});
