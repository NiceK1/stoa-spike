/** An IFC model read through web-ifc: storeys and what stands on them, stored quantities, and plan geometry. */
import { readFile, stat } from "node:fs/promises";
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
};

const SI_PREFIX: Record<string, number> = {
  EXA: 1e18, PETA: 1e15, TERA: 1e12, GIGA: 1e9, MEGA: 1e6, KILO: 1e3, HECTO: 1e2, DECA: 10,
  DECI: 0.1, CENTI: 0.01, MILLI: 1e-3, MICRO: 1e-6, NANO: 1e-9, PICO: 1e-12, FEMTO: 1e-15, ATTO: 1e-18,
};

// Quantity sets that hold the standard base quantities: 'BaseQuantities' (IFC2x3 exporters), 'Qto_WallBaseQuantities' (IFC4).
const BASE_QUANTITIES = /basequantities$/i;

type Ref = { value: number };
const text = (attribute: { value?: unknown } | null | undefined): string => (attribute?.value == null ? "" : String(attribute.value));

export class IfcModel {
  readonly schema: string;
  readonly projectName: string;
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
  private quantitySets: Map<number, number[]> | null = null;
  private typeOf: Map<number, number> | null = null;

  constructor(private readonly api: WebIFC.IfcAPI, private readonly modelId: number) {
    this.schema = api.GetModelSchema(modelId);
    [this.lengthScale, this.areaScale, this.volumeScale] = this.readUnits();

    const project = this.ids(WebIFC.IFCPROJECT).map((id) => this.line(id))[0];
    this.projectName = text(project?.LongName) || text(project?.Name);
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

  private ids(type: number): number[] {
    const vector = this.api.GetLineIDsWithType(this.modelId, type, true);
    const ids: number[] = [];
    for (let i = 0; i < vector.size(); i++) ids.push(vector.get(i));
    return ids;
  }

  line(id: number): any {
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

  private loadQuantitySets(): Map<number, number[]> {
    if (!this.quantitySets) {
      this.quantitySets = new Map();
      for (const id of this.ids(WebIFC.IFCRELDEFINESBYPROPERTIES)) {
        // Raw access: models carry tens of thousands of these and most point at property sets.
        const [, , , , related, definition] = this.api.GetRawLineData(this.modelId, id).arguments;
        if (!definition || this.api.GetLineType(this.modelId, definition.value) !== WebIFC.IFCELEMENTQUANTITY) continue;
        for (const object of related as Ref[]) {
          if (!this.quantitySets.has(object.value)) this.quantitySets.set(object.value, []);
          this.quantitySets.get(object.value)!.push(definition.value);
        }
      }
    }
    return this.quantitySets;
  }

  /** A stored base quantity of an element in metres, m² or m³, or null when the model does not carry it. */
  quantity(id: number, name: string): number | null {
    let values = this.quantityValues.get(id);
    if (!values) {
      values = new Map();
      for (const setId of this.loadQuantitySets().get(id) ?? []) {
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

  /** The element's own body, or the bodies of its parts when it has none. */
  private mesh(id: number, depth = 0): Mesh | null {
    const pieces: { positions: Float64Array; indices: Uint32Array }[] = [];
    const flat = this.api.GetFlatMesh(this.modelId, id);
    for (let i = 0; i < flat.geometries.size(); i++) {
      const placed = flat.geometries.get(i);
      const geometry = this.api.GetGeometry(this.modelId, placed.geometryExpressID);
      const vertices = this.api.GetVertexArray(geometry.GetVertexData(), geometry.GetVertexDataSize());
      const indices = this.api.GetIndexArray(geometry.GetIndexData(), geometry.GetIndexDataSize());
      geometry.delete();
      if (indices.length > 0) pieces.push(toPlan(vertices, indices, placed.flatTransformation));
    }
    flat.delete();
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
        shape = { area, volume: meshVolume(mesh), shapes, outline: single ? shapes[0] : planHull(mesh) };
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
function toPlan(vertices: Float32Array, indices: Uint32Array, m: number[]): Mesh {
  const count = vertices.length / 6; // position and normal per vertex
  const positions = new Float64Array(count * 3);
  for (let i = 0; i < count; i++) {
    const x = vertices[6 * i], y = vertices[6 * i + 1], z = vertices[6 * i + 2];
    positions[3 * i] = m[0] * x + m[4] * y + m[8] * z + m[12];
    positions[3 * i + 1] = -(m[2] * x + m[6] * y + m[10] * z + m[14]);
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
const open = new Map<string, { stamp: string; model: Promise<IfcModel> }>();

/** Opens a model once and keeps it, with its derived geometry, for later questions; the least recently used is closed. */
export async function loadModel(path: string): Promise<IfcModel> {
  const info = await stat(path);
  const stamp = `${info.mtimeMs}:${info.size}`;
  const cached = open.get(path);
  open.delete(path);
  if (cached && cached.stamp !== stamp) cached.model.then((model) => model.close(), () => {});
  const entry =
    cached?.stamp === stamp
      ? cached
      : { stamp, model: Promise.all([ifcApi(), readFile(path)]).then(([api, data]) => new IfcModel(api, api.OpenModel(data, { COORDINATE_TO_ORIGIN: false }))) };
  open.set(path, entry);
  if (open.size > MAX_OPEN_MODELS) {
    const [oldest, evicted] = open.entries().next().value!;
    open.delete(oldest);
    evicted.model.then((model) => model.close(), () => {});
  }
  entry.model.catch(() => open.delete(path));
  return entry.model;
}
