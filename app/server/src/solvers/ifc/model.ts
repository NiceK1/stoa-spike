/** An IFC model read through web-ifc: storeys and what stands on them, stored quantities, and plan geometry. */
import { readFile, stat } from "node:fs/promises";
import { basename } from "node:path";
import * as WebIFC from "web-ifc";
import type { Polygon } from "../../types.js";
import { footprintArea, footprintShapes, meshVolume, planHull, signedArea, type Mesh } from "./footprint.js";
import type { ElementKind } from "./question.js";

export interface Storey {
  id: number;
  name: string;
  /** Metres above the project zero. */
  elevation: number;
}

export interface Space {
  id: number;
  /** IfcSpace.Name, the room number in most authoring tools. */
  number: string;
  /** IfcSpace.LongName, the room name. */
  name: string;
}

export interface ElementShape {
  /** Plan area covered, m². */
  area: number;
  /** Enclosed volume, m³. */
  volume: number;
  /** Vertical extent, m. */
  height: number;
  /** Footprint pieces with holes cut out, largest first. */
  shapes: Polygon[];
  /** One polygon standing for the whole element: its footprint when that is a single piece, otherwise its convex hull. */
  outline: Polygon;
}

const IFC_CLASSES: Record<Exclude<ElementKind, "sanitary">, number> = {
  space: WebIFC.IFCSPACE,
  door: WebIFC.IFCDOOR,
  window: WebIFC.IFCWINDOW,
  wall: WebIFC.IFCWALL,
  column: WebIFC.IFCCOLUMN,
  stair: WebIFC.IFCSTAIR,
  beam: WebIFC.IFCBEAM,
  slab: WebIFC.IFCSLAB,
  railing: WebIFC.IFCRAILING,
  roof: WebIFC.IFCROOF,
  ramp: WebIFC.IFCRAMP,
  furniture: WebIFC.IFCFURNISHINGELEMENT,
  covering: WebIFC.IFCCOVERING,
  footing: WebIFC.IFCFOOTING,
  pipe: WebIFC.IFCFLOWSEGMENT,
};

/** Singular, plural and IFC class of each element kind, for method texts. */
export const NOUNS: Record<ElementKind, [string, string, string]> = {
  space: ["room", "rooms", "IfcSpace"],
  door: ["door", "doors", "IfcDoor"],
  window: ["window", "windows", "IfcWindow"],
  wall: ["wall", "walls", "IfcWall"],
  column: ["column", "columns", "IfcColumn"],
  stair: ["stair", "stairs", "IfcStair"],
  beam: ["beam", "beams", "IfcBeam"],
  slab: ["slab", "slabs", "IfcSlab"],
  sanitary: ["sanitary fixture", "sanitary fixtures", "sanitary IfcFlowTerminal"],
  railing: ["railing", "railings", "IfcRailing"],
  roof: ["roof", "roofs", "IfcRoof"],
  ramp: ["ramp", "ramps", "IfcRamp"],
  furniture: ["furniture item", "furniture items", "IfcFurnishingElement"],
  covering: ["covering", "coverings", "IfcCovering"],
  footing: ["footing", "footings", "IfcFooting"],
  pipe: ["pipe or duct run", "pipe and duct runs", "IfcFlowSegment"],
};

/** A room as questions name it: 'KORIDOR (119)'. */
export const roomLabel = (space: Space) => (space.name && space.number ? `${space.name} (${space.number})` : space.name || space.number);

const SI_PREFIX: Record<string, number> = {
  EXA: 1e18, PETA: 1e15, TERA: 1e12, GIGA: 1e9, MEGA: 1e6, KILO: 1e3, HECTO: 1e2, DECA: 10,
  DECI: 0.1, CENTI: 0.01, MILLI: 1e-3, MICRO: 1e-6, NANO: 1e-9, PICO: 1e-12, FEMTO: 1e-15, ATTO: 1e-18,
};

// Quantity sets that hold the standard base quantities: 'BaseQuantities' (IFC2x3 exporters), 'Qto_WallBaseQuantities' (IFC4).
const BASE_QUANTITIES = /basequantities$/i;

type Ref = { value: number };

/** web-ifc vectors live in wasm memory; its typings do not declare their delete(). */
function free(handle: object): void {
  (handle as { delete?: () => void }).delete?.();
}

const text = (attribute: { value?: unknown } | null | undefined): string => (attribute?.value == null ? "" : String(attribute.value));

export class IfcModel {
  readonly schema: string;
  readonly projectName: string;
  readonly buildingName: string;
  readonly siteName: string;
  readonly storeys: Storey[];

  /** Metres, m² and m³ per model unit. */
  private readonly lengthScale: number;
  private readonly areaScale: number;
  private readonly volumeScale: number;

  /** Everything reached from an object: contained and aggregated objects, openings, and what fills them. */
  private readonly below = new Map<number, number[]>();
  private readonly parts = new Map<number, number[]>();
  private readonly wholeOf = new Map<number, number>();

  private readonly classSets = new Map<number, Set<number>>();
  private readonly memberSets = new Map<number, Set<number>>();
  private readonly shapes = new Map<number, ElementShape | null>();
  private readonly quantityValues = new Map<number, Map<string, number>>();
  private readonly propertyValues = new Map<number, Map<string, string | number | boolean>>();
  private quantitySets: Map<number, number[]> | null = null;
  private propertySets: Map<number, number[]> | null = null;
  /** Plan coordinates are kept relative to this point: georeferenced models sit millions of metres from zero, where polygon maths loses its digits. */
  private origin: [number, number] | null = null;
  private typeOf: Map<number, number> | null = null;

  constructor(private readonly api: WebIFC.IfcAPI, private readonly modelId: number, /** Name of the file the model was read from. */ readonly file = "") {
    this.schema = api.GetModelSchema(modelId);
    [this.lengthScale, this.areaScale, this.volumeScale] = this.readUnits();

    const named = (type: number) => {
      const lines = this.ids(type).map((id) => this.line(id));
      return [...new Set(lines.flatMap((line) => [text(line.Name), text(line.LongName)]).filter(Boolean))].join(" / ");
    };
    this.projectName = named(WebIFC.IFCPROJECT);
    this.buildingName = named(WebIFC.IFCBUILDING);
    this.siteName = named(WebIFC.IFCSITE);
    this.storeys = this.ids(WebIFC.IFCBUILDINGSTOREY)
      .map((id) => {
        const line = this.line(id);
        return { id, name: text(line.Name), elevation: Number(line.Elevation?.value ?? 0) * this.lengthScale };
      })
      .sort((a, b) => a.elevation - b.elevation);

    this.readRelations();
  }

  close(): void {
    this.api.CloseModel(this.modelId);
  }

  /** Metres, m² and m³ per model unit. */
  get units(): { length: number; area: number; volume: number } {
    return { length: this.lengthScale, area: this.areaScale, volume: this.volumeScale };
  }

  /** Ids of every record of an IFC class, subclasses included. */
  instances(type: number): number[] {
    return this.ids(type);
  }

  /** A record with its attributes by name, as web-ifc reads it. */
  record(id: number): any {
    return this.line(id);
  }

  /** IFC class of a record, as 'IfcWallStandardCase'. */
  className(id: number): string {
    return this.api.GetNameFromTypeCode(this.api.GetLineType(this.modelId, id));
  }

  /** Arguments of a header record (WebIFC.FILE_NAME, FILE_SCHEMA, FILE_DESCRIPTION), as written in the file. */
  headerLine(type: number): any[] {
    return this.api.GetHeaderLine(this.modelId, type)?.arguments ?? [];
  }

  /** The type object of an element, if it has one. */
  typeObject(id: number): number | undefined {
    return this.types().get(id);
  }

  /** The object this one is a part of. */
  wholeOfPart(id: number): number | undefined {
    return this.wholeOf.get(id);
  }

  /** What an object directly holds: contained and aggregated objects, openings, and what fills them. */
  contents(id: number): number[] {
    return this.below.get(id) ?? [];
  }

  /** Quantity sets and property sets of an object; the property sets of its type come after its own. */
  definitions(id: number): { quantities: number[]; properties: number[] } {
    const { quantities, properties } = this.loadDefinitions();
    const type = this.types().get(id);
    const typeSets = type === undefined ? [] : ((this.line(type).HasPropertySets ?? []) as Ref[]).map((ref) => ref.value);
    return { quantities: quantities.get(id) ?? [], properties: [...(properties.get(id) ?? []), ...typeSets] };
  }

  private ids(type: number): number[] {
    const vector = this.api.GetLineIDsWithType(this.modelId, type, true);
    const ids: number[] = [];
    for (let i = 0; i < vector.size(); i++) ids.push(vector.get(i));
    free(vector);
    return ids;
  }

  private line(id: number): any {
    return this.api.GetLine(this.modelId, id);
  }

  private readUnits(): [number, number, number] {
    const scales: Record<string, number> = {};
    const powers: Record<string, number> = { LENGTHUNIT: 1, AREAUNIT: 2, VOLUMEUNIT: 3 };
    const scaleOf = (unitId: number, power: number): number => {
      const type = this.api.GetLineType(this.modelId, unitId);
      const unit = this.line(unitId);
      if (type === WebIFC.IFCSIUNIT) return (SI_PREFIX[text(unit.Prefix)] ?? 1) ** power;
      if (type === WebIFC.IFCCONVERSIONBASEDUNIT && unit.ConversionFactor) {
        const factor = this.line(unit.ConversionFactor.value);
        return Number(factor.ValueComponent?.value ?? 1) * scaleOf(factor.UnitComponent.value, power);
      }
      return 1;
    };
    for (const assignment of this.ids(WebIFC.IFCUNITASSIGNMENT).slice(0, 1)) {
      for (const ref of (this.line(assignment).Units ?? []) as Ref[]) {
        const kind = text(this.line(ref.value).UnitType);
        if (kind in powers) scales[kind] = scaleOf(ref.value, powers[kind]);
      }
    }
    const length = scales.LENGTHUNIT ?? 1;
    return [length, scales.AREAUNIT ?? length ** 2, scales.VOLUMEUNIT ?? length ** 3];
  }

  private readRelations(): void {
    const link = (from: number, to: number) => {
      if (!this.below.has(from)) this.below.set(from, []);
      this.below.get(from)!.push(to);
    };
    const refs = (value: Ref[] | Ref | null | undefined): number[] => (Array.isArray(value) ? value : value ? [value] : []).map((r) => r.value);

    for (const id of this.ids(WebIFC.IFCRELCONTAINEDINSPATIALSTRUCTURE)) {
      const rel = this.line(id);
      for (const element of refs(rel.RelatedElements)) link(rel.RelatingStructure.value, element);
    }
    for (const type of [WebIFC.IFCRELAGGREGATES, WebIFC.IFCRELNESTS]) {
      for (const id of this.ids(type)) {
        const rel = this.line(id);
        const whole: number = rel.RelatingObject.value;
        for (const part of refs(rel.RelatedObjects)) {
          link(whole, part);
          this.wholeOf.set(part, whole);
          if (!this.parts.has(whole)) this.parts.set(whole, []);
          this.parts.get(whole)!.push(part);
        }
      }
    }
    for (const id of this.ids(WebIFC.IFCRELVOIDSELEMENT)) {
      const rel = this.line(id);
      link(rel.RelatingBuildingElement.value, rel.RelatedOpeningElement.value);
    }
    for (const id of this.ids(WebIFC.IFCRELFILLSELEMENT)) {
      const rel = this.line(id);
      link(rel.RelatingOpeningElement.value, rel.RelatedBuildingElement.value);
    }
  }

  private classSet(type: number): Set<number> {
    if (!this.classSets.has(type)) this.classSets.set(type, new Set(this.ids(type)));
    return this.classSets.get(type)!;
  }

  /** Every object on a storey, however deep: contained elements, their parts, openings and the doors and windows in them. */
  private members(storey: Storey): Set<number> {
    let members = this.memberSets.get(storey.id);
    if (!members) {
      members = new Set();
      const queue = [storey.id];
      while (queue.length > 0) {
        for (const next of this.below.get(queue.pop()!) ?? []) {
          if (!members.has(next)) {
            members.add(next);
            queue.push(next);
          }
        }
      }
      this.memberSets.set(storey.id, members);
    }
    return members;
  }

  private kindSet(kind: ElementKind): Set<number> {
    if (kind !== "sanitary") return this.classSet(IFC_CLASSES[kind]);
    // IFC4 has IfcSanitaryTerminal; IFC2x3 marks a flow terminal as sanitary through its type object.
    const key = -1;
    if (!this.classSets.has(key)) {
      const sanitary = new Set(this.ids(WebIFC.IFCSANITARYTERMINAL));
      const types = this.types();
      for (const id of this.ids(WebIFC.IFCFLOWTERMINAL)) {
        const type = types.get(id);
        if (type !== undefined && this.api.GetLineType(this.modelId, type) === WebIFC.IFCSANITARYTERMINALTYPE) sanitary.add(id);
      }
      this.classSets.set(key, sanitary);
    }
    return this.classSets.get(key)!;
  }

  private types(): Map<number, number> {
    if (!this.typeOf) {
      this.typeOf = new Map();
      for (const id of this.ids(WebIFC.IFCRELDEFINESBYTYPE)) {
        const rel = this.line(id);
        for (const object of (rel.RelatedObjects ?? []) as Ref[]) this.typeOf.set(object.value, rel.RelatingType.value);
      }
    }
    return this.typeOf;
  }

  /**
   * Elements of a kind on one storey, or in the whole model. An element that is a part of another element of the
   * same kind (a tread exported as IfcStair inside its stair) is not counted on its own.
   */
  elements(kind: ElementKind, storey?: Storey): number[] {
    const all = this.kindSet(kind);
    const candidates = storey ? [...this.members(storey)].filter((id) => all.has(id)) : [...all];
    return candidates.filter((id) => !all.has(this.wholeOf.get(id) ?? -1)).sort((a, b) => a - b);
  }

  /** The storey an object stands on, if any. */
  storeyOf(id: number): Storey | undefined {
    return this.storeys.find((storey) => this.members(storey).has(id));
  }

  space(id: number): Space {
    const line = this.line(id);
    return { id, number: text(line.Name), name: text(line.LongName) };
  }

  name(id: number): string {
    return text(this.line(id).Name);
  }

  /** Name of the element's type object, falling back to the element's ObjectType. */
  typeName(id: number): string {
    const type = this.types().get(id);
    return (type !== undefined ? text(this.line(type).Name) : "") || text(this.line(id).ObjectType);
  }

  /** Quantity sets and property sets per object, read in one pass over the relations. */
  private loadDefinitions(): { quantities: Map<number, number[]>; properties: Map<number, number[]> } {
    if (!this.quantitySets || !this.propertySets) {
      this.quantitySets = new Map();
      this.propertySets = new Map();
      for (const id of this.ids(WebIFC.IFCRELDEFINESBYPROPERTIES)) {
        // Raw access: models carry tens of thousands of these.
        const [, , , , related, definition] = this.api.GetRawLineData(this.modelId, id).arguments;
        if (!definition || Array.isArray(definition)) continue;
        const type = this.api.GetLineType(this.modelId, definition.value);
        const sets = type === WebIFC.IFCELEMENTQUANTITY ? this.quantitySets : type === WebIFC.IFCPROPERTYSET ? this.propertySets : null;
        if (!sets) continue;
        for (const object of related as Ref[]) {
          if (!sets.has(object.value)) sets.set(object.value, []);
          sets.get(object.value)!.push(definition.value);
        }
      }
    }
    return { quantities: this.quantitySets, properties: this.propertySets };
  }

  /** A single-valued property of an element, from its own property sets or those of its type; null when absent. */
  property(id: number, name: string): string | number | boolean | null {
    let values = this.propertyValues.get(id);
    if (!values) {
      values = new Map();
      const type = this.types().get(id);
      const typeSets = type === undefined ? [] : ((this.line(type).HasPropertySets ?? []) as Ref[]).map((ref) => ref.value);
      for (const setId of [...(this.loadDefinitions().properties.get(id) ?? []), ...typeSets]) {
        const set = this.line(setId);
        for (const ref of (set?.HasProperties ?? []) as Ref[]) {
          const property = this.line(ref.value);
          const raw = property.NominalValue?.value;
          if (raw == null || values.has(text(property.Name))) continue;
          // web-ifc hands STEP booleans over as the letters T and F.
          values.set(text(property.Name), raw === "T" ? true : raw === "F" ? false : raw);
        }
      }
      this.propertyValues.set(id, values);
    }
    return values.get(name) ?? null;
  }

  /** OverallWidth of a door or window in metres, or null when the model does not give it. */
  overallWidth(id: number): number | null {
    const width = this.line(id).OverallWidth?.value;
    return width == null ? null : Number(width) * this.lengthScale;
  }

  /** What wrote the file: authoring application, exporter, model view definition. */
  provenance(): { application: string; exporter: string; view: string; written: string } {
    const header = (type: number): any[] => this.api.GetHeaderLine(this.modelId, type)?.arguments ?? [];
    const flat = (value: unknown): string => (Array.isArray(value) ? value.map(flat).filter(Boolean).join("; ") : text(value as { value?: unknown }));
    const fileName = header(WebIFC.FILE_NAME);
    const application = this.ids(WebIFC.IFCAPPLICATION).map((id) => this.line(id))[0];
    return {
      application: application ? [text(application.ApplicationFullName), text(application.Version)].filter(Boolean).join(" ") : "",
      exporter: [flat(fileName[5]), flat(fileName[4])].filter(Boolean).join("; "),
      view: flat(header(WebIFC.FILE_DESCRIPTION)[0]),
      written: flat(fileName[1]),
    };
  }

  /** A stored base quantity of an element in metres, m² or m³, or null when the model does not carry it. */
  quantity(id: number, name: string): number | null {
    let values = this.quantityValues.get(id);
    if (!values) {
      values = new Map();
      for (const setId of this.loadDefinitions().quantities.get(id) ?? []) {
        const set = this.line(setId);
        if (!BASE_QUANTITIES.test(text(set.Name))) continue;
        for (const ref of (set.Quantities ?? []) as Ref[]) {
          const quantity = this.line(ref.value);
          const value =
            quantity.LengthValue ? Number(quantity.LengthValue.value) * this.lengthScale
            : quantity.AreaValue ? Number(quantity.AreaValue.value) * this.areaScale
            : quantity.VolumeValue ? Number(quantity.VolumeValue.value) * this.volumeScale
            : quantity.CountValue ? Number(quantity.CountValue.value)
            : null;
          if (value !== null && Number.isFinite(value) && !values.has(text(quantity.Name))) values.set(text(quantity.Name), value);
        }
      }
      this.quantityValues.set(id, values);
    }
    return values.get(name) ?? null;
  }

  /** Net floor area of a space: the stored quantity when the exporter wrote one, otherwise the plan footprint of its body. */
  floorArea(id: number): { value: number; stored: boolean } | null {
    const stored = this.quantity(id, "NetFloorArea");
    if (stored !== null && stored > 0) return { value: stored, stored: true };
    const shape = this.shape(id);
    return shape && shape.area > 0 ? { value: shape.area, stored: false } : null;
  }

  /** The element's own body, or the bodies of its parts when it has none. */
  private mesh(id: number, depth = 0): Mesh | null {
    const pieces: Mesh[] = [];
    const flat = this.api.GetFlatMesh(this.modelId, id);
    for (let i = 0; i < flat.geometries.size(); i++) {
      const placed = flat.geometries.get(i);
      this.origin ??= [Math.round(placed.flatTransformation[12]), Math.round(-placed.flatTransformation[14])];
      const geometry = this.api.GetGeometry(this.modelId, placed.geometryExpressID);
      const vertices = this.api.GetVertexArray(geometry.GetVertexData(), geometry.GetVertexDataSize());
      const indices = this.api.GetIndexArray(geometry.GetIndexData(), geometry.GetIndexDataSize());
      geometry.delete();
      if (indices.length > 0) pieces.push(toPlan(vertices, indices, placed.flatTransformation, this.origin));
    }
    free(flat.geometries);
    if (pieces.length === 0 && depth < 4) {
      for (const part of this.parts.get(id) ?? []) {
        const mesh = this.mesh(part, depth + 1);
        if (mesh) pieces.push(mesh);
      }
    }
    return pieces.length === 0 ? null : merge(pieces);
  }

  /** Plan geometry of an element, or null when it has no body. */
  shape(id: number): ElementShape | null {
    if (!this.shapes.has(id)) {
      const mesh = this.mesh(id);
      let shape: ElementShape | null = null;
      if (mesh) {
        const area = footprintArea(mesh);
        const shapes = footprintShapes(mesh);
        // A footprint in several pieces (a wall cut through by a door, a door leaf beside its frame) is shown as its hull.
        const single = shapes.length > 0 && Math.abs(signedArea(shapes[0])) >= 0.9 * area;
        let low = Infinity, high = -Infinity;
        for (let i = 2; i < mesh.positions.length; i += 3) {
          low = Math.min(low, mesh.positions[i]);
          high = Math.max(high, mesh.positions[i]);
        }
        shape = { area, volume: meshVolume(mesh), height: high > low ? high - low : 0, shapes, outline: single ? shapes[0] : planHull(mesh) };
      }
      this.shapes.set(id, shape);
    }
    return this.shapes.get(id)!;
  }
}

/**
 * web-ifc returns vertices in the element's own frame and model units, with a matrix that places them in a
 * right-handed, y-up world in metres: world x = IFC x, world y = IFC z, world z = -IFC y.
 */
function toPlan(vertices: Float32Array, indices: Uint32Array, m: number[], [originX, originY]: [number, number]): Mesh {
  const count = vertices.length / 6; // position and normal per vertex
  const positions = new Float64Array(count * 3);
  for (let i = 0; i < count; i++) {
    const x = vertices[6 * i], y = vertices[6 * i + 1], z = vertices[6 * i + 2];
    positions[3 * i] = m[0] * x + m[4] * y + m[8] * z + m[12] - originX;
    positions[3 * i + 1] = -(m[2] * x + m[6] * y + m[10] * z + m[14]) - originY;
    positions[3 * i + 2] = m[1] * x + m[5] * y + m[9] * z + m[13];
  }
  const determinant =
    m[0] * (m[5] * m[10] - m[9] * m[6]) - m[4] * (m[1] * m[10] - m[9] * m[2]) + m[8] * (m[1] * m[6] - m[5] * m[2]);
  if (determinant < 0) {
    // A mirrored placement turns the triangles inside out.
    indices = indices.slice();
    for (let t = 0; t < indices.length; t += 3) [indices[t + 1], indices[t + 2]] = [indices[t + 2], indices[t + 1]];
  }
  return { positions, indices };
}

function merge(pieces: Mesh[]): Mesh {
  if (pieces.length === 1) return pieces[0];
  const positions = new Float64Array(pieces.reduce((n, p) => n + p.positions.length, 0));
  const indices = new Uint32Array(pieces.reduce((n, p) => n + p.indices.length, 0));
  let vertexOffset = 0, indexOffset = 0;
  for (const piece of pieces) {
    positions.set(piece.positions, vertexOffset * 3);
    for (let i = 0; i < piece.indices.length; i++) indices[indexOffset + i] = piece.indices[i] + vertexOffset;
    vertexOffset += piece.positions.length / 3;
    indexOffset += piece.indices.length;
  }
  return { positions, indices };
}

let apiReady: Promise<WebIFC.IfcAPI> | null = null;

function ifcApi(): Promise<WebIFC.IfcAPI> {
  apiReady ??= (async () => {
    const api = new WebIFC.IfcAPI();
    await api.Init();
    api.SetLogLevel(WebIFC.LogLevel.LOG_LEVEL_OFF);
    return api;
  })();
  return apiReady;
}

const MAX_OPEN_MODELS = 4;

interface OpenModel {
  stamp: string;
  model: Promise<IfcModel>;
}
const open = new Map<string, OpenModel>();

async function openModel(path: string): Promise<IfcModel> {
  const [api, data] = await Promise.all([ifcApi(), readFile(path)]);
  let modelId = -1;
  try {
    modelId = api.OpenModel(data, { COORDINATE_TO_ORIGIN: false });
    return new IfcModel(api, modelId, basename(path));
  } catch (cause) {
    if (modelId >= 0) api.CloseModel(modelId);
    throw new Error(`${basename(path)} could not be read as an IFC model`, { cause });
  }
}

/** Closes a model once every question that is already holding it has run: answering is synchronous, so one turn of the event loop is enough. */
function retire(entry: OpenModel): void {
  entry.model.then((model) => setImmediate(() => model.close()), () => {});
}

/** Opens a model once and keeps it, with its derived geometry, for later questions; the least recently used is closed. */
export async function loadModel(path: string): Promise<IfcModel> {
  const info = await stat(path);
  const stamp = `${info.mtimeMs}:${info.size}`;
  const cached = open.get(path);
  open.delete(path);
  if (cached && cached.stamp !== stamp) retire(cached);
  const entry = cached?.stamp === stamp ? cached : { stamp, model: openModel(path) };
  open.set(path, entry);
  if (open.size > MAX_OPEN_MODELS) {
    const [oldest, evicted] = open.entries().next().value!;
    open.delete(oldest);
    retire(evicted);
  }
  entry.model.catch(() => {
    if (open.get(path) === entry) open.delete(path);
  });
  return entry.model;
}
