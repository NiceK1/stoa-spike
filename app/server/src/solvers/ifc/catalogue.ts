/**
 * What an IFC model states about itself, as text sections a language model can answer from: the file header and
 * project records, a complete inventory of element classes, spaces, systems, and per class the types with their
 * storeys, materials, flags, quantity totals and property values. One catalogue per file; a class is read in
 * detail the first time a question needs it.
 */
import { stat } from "node:fs/promises";
import * as WebIFC from "web-ifc";
import { loadModel, roomLabel, type IfcModel } from "./model.js";

type Ref = { value: number };

const MAX_TYPES = 60;
const MAX_TYPES_BY_STOREY = 30;
const MAX_INVENTORY_TYPES = 8;
const MAX_NAMES = 120;
const MAX_ELEMENTS_LISTED = 30;
const MAX_PROPERTIES = 70;
const MAX_VALUES = 4;
const MAX_SPACES = 400;
const MAX_GROUPS = 60;
const MAX_FIELDS = 8;
const MAX_SPATIAL_PROPERTIES = 25;
/** Length attributes of the element records themselves. */
const ATTRIBUTES = ["OverallWidth", "OverallHeight", "ElevationOfRefHeight", "ElevationOfTerrain"];
const MAX_LOOKUPS = 6;

const text = (attribute: { value?: unknown } | null | undefined): string => (attribute?.value == null ? "" : String(attribute.value).trim());
const refs = (value: unknown): number[] =>
  (Array.isArray(value) ? value : value ? [value] : []).map((ref: Ref) => ref?.value).filter((id): id is number => typeof id === "number");
const bump = <K>(counts: Map<K, number>, key: K, by = 1) => counts.set(key, (counts.get(key) ?? 0) + by);
const ranked = <K>(counts: Map<K, number>): [K, number][] => [...counts].sort((a, b) => b[1] - a[1]);

function num(value: number): string {
  const size = Math.abs(value);
  return String(Number(value.toFixed(size >= 100 ? 1 : size >= 1 ? 2 : 3)));
}

const clip = (value: string, length: number) => (value.length > length ? `${value.slice(0, length - 1)}…` : value);

/** Records that are not things one would count as parts of the building. */
const AUXILIARY = /^Ifc(OpeningElement|OpeningStandardCase|DistributionPort|Annotation|Grid|VirtualElement|Site|Building|BuildingStorey)$/;
const SPATIAL = /^Ifc(Site|Building|BuildingStorey)$/;
const DIMENSION = /width|height|depth|thick|diameter|radius|cross|breite|höhe|hoehe|dicke|tiefe|durchmesser/i;
const TOTALLED = /length|area|volume|perimeter|weight|länge|laenge|fläche|flaeche|volumen|umfang/i;
const LENGTH_MEASURES = new Set(["IFCLENGTHMEASURE", "IFCPOSITIVELENGTHMEASURE"]);

interface Item {
  id: number;
  group: string;
  guid: string;
  name: string;
  type: string;
  predefined: string;
  /** Index into the model's storeys, or -1 when the element stands on none. */
  storey: number;
}

interface Field {
  unit: string;
  /** True for a quantity or attribute of the element, false for a property that happens to be a measure. */
  quantity: boolean;
  values: Map<number, number>;
}

interface PropertyStats {
  filled: number;
  values: Map<string, number>;
  numbers: number;
  sum: number;
  low: number;
  high: number;
}

interface Detail {
  fields: Map<string, Field>;
  external: Map<number, boolean>;
  bearing: Map<number, boolean>;
  materials: Map<number, string>;
  properties: Map<string, PropertyStats>;
}

export interface Selection {
  sections: string[];
  classes: string[];
}

export class Catalogue {
  private readonly groups = new Map<string, Item[]>();
  private readonly byId = new Map<number, Item>();
  /** Elements that are parts of another element of their own class (a railing post in a railing), by class and type name. */
  private readonly partTypes = new Map<string, Map<string, number>>();
  private readonly details = new Map<string, Detail>();
  private readonly texts = new Map<string, string>();
  private materialOf: Map<number, number> | null = null;
  private readonly materialTexts = new Map<number, string>();
  private boundaries: Map<number, number[]> | null = null;

  constructor(private model: IfcModel) {
    this.readItems();
  }

  /** The same file opened again: record ids are stable, so everything already read stays valid. */
  rebind(model: IfcModel): void {
    this.model = model;
  }

  get elementCount(): number {
    return this.byId.size;
  }

  private readItems(): void {
    const model = this.model;
    const storeyIndex = new Map(model.storeys.map((storey, i) => [storey.id, i]));
    const typeInfo = new Map<number, { cls: string; name: string; predefined: string }>();
    const classes = new Map<number, string>();
    const classOf = (id: number) => {
      if (!classes.has(id)) classes.set(id, model.className(id));
      return classes.get(id)!;
    };
    const untagged = (name: string, tag: string) => (tag && name.endsWith(`:${tag}`) ? name.slice(0, -tag.length - 1) : name);
    const groupOf = (id: number): string => {
      const base = classOf(id).replace(/(StandardCase|ElementedCase)$/, "");
      const type = model.typeObject(id);
      if (type === undefined) return base;
      const kind = classOf(type).replace(/(Type|Style)$/, "");
      return kind === base ? base : `${kind} (${base})`;
    };

    for (const id of model.instances(WebIFC.IFCPRODUCT)) {
      const group = groupOf(id);
      const whole = model.wholeOfPart(id);
      const line = model.record(id);
      const typeId = model.typeObject(id);
      if (typeId !== undefined && !typeInfo.has(typeId)) {
        const type = model.record(typeId);
        typeInfo.set(typeId, { cls: classOf(typeId), name: untagged(text(type.Name), text(type.Tag)), predefined: text(type.PredefinedType) });
      }
      const type = typeId === undefined ? undefined : typeInfo.get(typeId);
      const name = untagged(text(line.Name), text(line.Tag));
      const objectType = untagged(text(line.ObjectType), text(line.Tag));
      // Revit writes the type as 'Family:Type:<type id>' and the element's ObjectType as 'Family:Type'.
      const typeName = type && objectType && type.name.startsWith(`${objectType}:`) && /^\d+$/.test(type.name.slice(objectType.length + 1)) ? objectType : type?.name;
      const predefined = [text(line.PredefinedType), type?.predefined ?? ""].find((value) => value && value !== "NOTDEFINED" && value !== "USERDEFINED") ?? "";
      const item: Item = {
        id, group, guid: text(line.GlobalId), name,
        // Where the type object carries only the last part of a 'Family:Type' element name, the full name says more.
        type: (typeName && name.endsWith(`:${typeName}`) ? name : typeName) || objectType || (group === "IfcSpace" ? "" : name),
        predefined, storey: storeyIndex.get(model.storeyOf(id)?.id ?? -1) ?? -1,
      };
      if (whole !== undefined && groupOf(whole) === group) {
        if (!this.partTypes.has(group)) this.partTypes.set(group, new Map());
        bump(this.partTypes.get(group)!, item.type || "(no type name)");
        continue;
      }
      if (!this.groups.has(group)) this.groups.set(group, []);
      this.groups.get(group)!.push(item);
      this.byId.set(id, item);
    }
  }

  /** Says how many parts of the same class were left out of a class's count. */
  private partsNote(group: string): string {
    const types = this.partTypes.get(group);
    if (!types) return "";
    const total = [...types.values()].reduce((sum, n) => sum + n, 0);
    return ` (not counted: ${total} parts of these elements that are ${group} records themselves — ${ranked(types).slice(0, 4).map(([name, n]) => `${clip(name, 50)} ×${n}`).join("; ")})`;
  }

  private memo(key: string, build: () => string): string {
    if (!this.texts.has(key)) this.texts.set(key, build());
    return this.texts.get(key)!;
  }

  private storeyCounts(items: Item[]): string {
    const counts = new Map<number, number>();
    for (const item of items) bump(counts, item.storey);
    return [...counts]
      .sort((a, b) => (a[0] < 0 ? 1e9 : a[0]) - (b[0] < 0 ? 1e9 : b[0]))
      .map(([storey, n]) => `${storey < 0 ? "(no storey)" : this.model.storeys[storey].name} ${n}`)
      .join(", ");
  }

  /** File header, project, site, building and storeys. */
  project(): string {
    return this.memo("project", () => {
      const model = this.model;
      const flat = (value: unknown): string => (Array.isArray(value) ? value.map(flat).filter(Boolean).join("; ") : text(value as { value?: unknown }));
      const fileName = model.headerLine(WebIFC.FILE_NAME);
      const description = model.headerLine(WebIFC.FILE_DESCRIPTION);
      const schema = flat(model.headerLine(WebIFC.FILE_SCHEMA)[0]);
      const lines = ["File header:"];
      const put = (label: string, value: string) => {
        if (value) lines.push(`- ${label}: ${value}`);
      };
      put("FILE_SCHEMA (IFC standard, as written in the file)", schema);
      if (model.schema && model.schema !== schema) put("schema family the file is read as", model.schema);
      put("FILE_DESCRIPTION", flat(description[0]));
      put("file name", flat(fileName[0]));
      put("time stamp", flat(fileName[1]));
      put("author", flat(fileName[2]));
      put("organisation", flat(fileName[3]));
      put("preprocessor", flat(fileName[4]));
      put("originating system", flat(fileName[5]));
      put("authorisation", flat(fileName[6]));
      for (const id of model.instances(WebIFC.IFCAPPLICATION).slice(0, 5)) {
        const app = model.record(id);
        const developer = app.ApplicationDeveloper ? text(model.record(app.ApplicationDeveloper.value).Name) : "";
        put("IfcApplication (modelling program)", `${text(app.ApplicationFullName)}, version ${text(app.Version)}, identifier ${text(app.ApplicationIdentifier)}${developer ? `, developer ${developer}` : ""}`);
      }
      const { length } = model.units;
      put("length unit of the model", length === 1 ? "metre" : length === 0.001 ? "millimetre" : `${length} m`);

      for (const [label, type] of [["IfcProject", WebIFC.IFCPROJECT], ["IfcSite", WebIFC.IFCSITE], ["IfcBuilding", WebIFC.IFCBUILDING]] as const) {
        const ids = model.instances(type);
        for (const id of ids.slice(0, 3)) lines.push("", `${label}:`, ...this.spatialRecord(id));
        if (ids.length > 3) lines.push("", `(${ids.length} ${label} records in all; they are listed under the class ${label})`);
      }
      for (const id of model.instances(WebIFC.IFCGEOMETRICREPRESENTATIONCONTEXT)) {
        const north = model.record(id).TrueNorth;
        if (!north) continue;
        const ratios = ((model.record(north.value).DirectionRatios ?? []) as { value?: number }[]).map((ratio) => Number(ratio.value ?? ratio));
        if (ratios.length >= 2) {
          lines.push("", `True north: direction (${ratios.map(num).join(", ")}) in model coordinates, ${num((Math.atan2(ratios[0], ratios[1]) * 180) / Math.PI)}° clockwise from the model's +Y axis`);
          break;
        }
      }

      lines.push("", `Storeys (IfcBuildingStorey), lowest first: ${model.storeys.length}`);
      model.storeys.forEach((storey, i) => {
        const next = model.storeys[i + 1];
        const stored = this.quantities(storey.id).map(([name, value, unit]) => `${name} ${num(value)}${unit ? ` ${unit}` : ""}`);
        lines.push(`- ${storey.name}: elevation ${num(storey.elevation)} m${next ? `, ${num(next.elevation - storey.elevation)} m up to ${next.name}` : ""}${stored.length ? `; ${stored.join(", ")}` : ""}`);
      });
      return lines.join("\n");
    });
  }

  private spatialRecord(id: number): string[] {
    const model = this.model;
    const line = model.record(id);
    const lines: string[] = [];
    const put = (label: string, value: string) => {
      if (value) lines.push(`- ${label}: ${value}`);
    };
    put("Name", text(line.Name));
    put("LongName", text(line.LongName));
    put("Description", text(line.Description));
    put("ObjectType", text(line.ObjectType));
    put("Phase", text(line.Phase));
    const angle = (value: unknown): string => {
      const list = (value as { value?: unknown } | null)?.value ?? value;
      const parts = (Array.isArray(list) ? list : []).map((part) => Number(part?.value ?? part));
      if (parts.length < 3 || parts.some((part) => !Number.isFinite(part))) return "";
      const degrees = parts[0] + parts[1] / 60 + parts[2] / 3600 + (parts[3] ?? 0) / 3.6e9;
      return `${degrees.toFixed(6)}° (${parts[0]}° ${Math.abs(parts[1])}′ ${num(Math.abs(parts[2]) + Math.abs(parts[3] ?? 0) / 1e6)}″)`;
    };
    put("RefLatitude", angle(line.RefLatitude));
    put("RefLongitude", angle(line.RefLongitude));
    if (line.RefElevation?.value != null) put("RefElevation", `${num(Number(line.RefElevation.value) * model.units.length)} m`);
    if (line.ElevationOfRefHeight?.value != null) put("ElevationOfRefHeight", `${num(Number(line.ElevationOfRefHeight.value) * model.units.length)} m`);
    if (line.ElevationOfTerrain?.value != null) put("ElevationOfTerrain", `${num(Number(line.ElevationOfTerrain.value) * model.units.length)} m`);
    put("LandTitleNumber", text(line.LandTitleNumber));
    const addressRef = line.BuildingAddress ?? line.SiteAddress;
    if (addressRef?.value != null) {
      const address = model.record(addressRef.value);
      const parts = [...((address.AddressLines ?? []) as { value?: unknown }[]).map(text), text(address.PostalBox), text(address.Town), text(address.Region), text(address.PostalCode), text(address.Country)];
      put("Postal address", parts.filter(Boolean).join(", "));
    }
    for (const [name, value, unit] of this.quantities(id)) put(`Quantity ${name}`, `${num(value)}${unit ? ` ${unit}` : ""}`);
    for (const [set, name, value] of this.properties(id).slice(0, MAX_SPATIAL_PROPERTIES)) put(`${set}.${name}`, clip(String(value), 120));
    return lines.length > 0 ? lines : ["- (no attributes set)"];
  }

  /** Every quantity stored on an object, in metres, m², m³. */
  private quantities(id: number): [name: string, value: number, unit: string][] {
    const model = this.model;
    const { length, area, volume } = model.units;
    const found: [string, number, string][] = [];
    const seen = new Set<string>();
    for (const setId of model.definitions(id).quantities) {
      for (const ref of refs(model.record(setId).Quantities)) {
        const quantity = model.record(ref);
        const name = text(quantity.Name);
        const entry: [number, string] | null =
          quantity.LengthValue ? [Number(quantity.LengthValue.value) * length, "m"]
          : quantity.AreaValue ? [Number(quantity.AreaValue.value) * area, "m²"]
          : quantity.VolumeValue ? [Number(quantity.VolumeValue.value) * volume, "m³"]
          : quantity.WeightValue ? [Number(quantity.WeightValue.value), "kg"]
          : quantity.CountValue ? [Number(quantity.CountValue.value), ""]
          : null;
        if (!entry || !name || seen.has(name) || !Number.isFinite(entry[0])) continue;
        seen.add(name);
        found.push([name, entry[0], entry[1]]);
      }
    }
    return found;
  }

  /** Single-valued properties of an object and of its type: set name, property name, value, and its unit when it is a length, area or volume. */
  private properties(id: number): [set: string, name: string, value: string | number | boolean, unit: string][] {
    const model = this.model;
    const { length, area, volume } = model.units;
    const found: [string, string, string | number | boolean, string][] = [];
    for (const setId of model.definitions(id).properties) {
      const set = model.record(setId);
      const setName = text(set?.Name);
      for (const ref of refs(set?.HasProperties)) {
        const property = model.record(ref);
        const nominal = property.NominalValue;
        const raw = nominal?.value;
        if (raw == null || raw === "") continue;
        const measure = String(nominal.name ?? "");
        if (typeof raw === "number" && Number.isFinite(raw)) {
          if (LENGTH_MEASURES.has(measure)) found.push([setName, text(property.Name), raw * length, "m"]);
          else if (measure === "IFCAREAMEASURE") found.push([setName, text(property.Name), raw * area, "m²"]);
          else if (measure === "IFCVOLUMEMEASURE") found.push([setName, text(property.Name), raw * volume, "m³"]);
          else found.push([setName, text(property.Name), raw, ""]);
        } else if (measure === "IFCBOOLEAN" || measure === "IFCLOGICAL") {
          found.push([setName, text(property.Name), raw === "T" || raw === true, ""]);
        } else {
          found.push([setName, text(property.Name), String(raw).trim(), ""]);
        }
      }
    }
    return found;
  }

  private material(id: number): string {
    if (!this.materialOf) {
      this.materialOf = new Map();
      for (const rel of this.model.instances(WebIFC.IFCRELASSOCIATESMATERIAL)) {
        const line = this.model.record(rel);
        if (line.RelatingMaterial?.value == null) continue;
        for (const object of refs(line.RelatedObjects)) this.materialOf.set(object, line.RelatingMaterial.value);
      }
    }
    const type = this.model.typeObject(id);
    const material = this.materialOf.get(id) ?? (type === undefined ? undefined : this.materialOf.get(type));
    if (material === undefined) return "";
    if (!this.materialTexts.has(material)) this.materialTexts.set(material, this.describeMaterial(material));
    return this.materialTexts.get(material)!;
  }

  private describeMaterial(id: number, depth = 0): string {
    const model = this.model;
    const line = model.record(id);
    const nameOf = (ref: Ref | null | undefined) => (ref?.value == null ? "" : text(model.record(ref.value).Name));
    const millimetres = (value: unknown) => `${num(Number((value as { value?: unknown })?.value ?? 0) * model.units.length * 1000)} mm`;
    if (depth > 3 || !line) return "";
    switch (model.className(id)) {
      case "IfcMaterial":
        return text(line.Name);
      case "IfcMaterialLayerSetUsage":
        return this.describeMaterial(line.ForLayerSet.value, depth + 1);
      case "IfcMaterialLayerSet": {
        const layers = refs(line.MaterialLayers).map((ref) => model.record(ref));
        const total = layers.reduce((sum, layer) => sum + Number(layer.LayerThickness?.value ?? 0), 0);
        const described = layers.map((layer) => `${nameOf(layer.Material) || text(layer.Name) || "(unnamed)"} ${millimetres(layer.LayerThickness)}`);
        return `${text(line.LayerSetName) ? `layer set '${text(line.LayerSetName)}': ` : ""}layers in order ${described.join(" | ")}; total ${millimetres({ value: total })}`;
      }
      case "IfcMaterialLayer":
        return `${nameOf(line.Material)} ${millimetres(line.LayerThickness)}`;
      case "IfcMaterialList":
        return refs(line.Materials).map((ref) => text(model.record(ref).Name)).filter(Boolean).join(" + ");
      case "IfcMaterialConstituentSet":
        return refs(line.MaterialConstituents).map((ref) => model.record(ref)).map((part) => [text(part.Name), nameOf(part.Material)].filter(Boolean).join(": ")).join(" + ");
      case "IfcMaterialProfileSetUsage":
        return this.describeMaterial(line.ForProfileSet.value, depth + 1);
      case "IfcMaterialProfileSet":
        return refs(line.MaterialProfiles).map((ref) => model.record(ref)).map((part) => [nameOf(part.Material), nameOf(part.Profile) || text(part.Name)].filter(Boolean).join(", profile ")).join(" + ");
      default:
        return text(line.Name);
    }
  }

  private detail(group: string): Detail {
    let detail = this.details.get(group);
    if (detail) return detail;
    detail = { fields: new Map(), external: new Map(), bearing: new Map(), materials: new Map(), properties: new Map() };
    const field = (name: string, unit: string, id: number, value: number, quantity = true) => {
      if (!detail!.fields.has(name)) detail!.fields.set(name, { unit, quantity, values: new Map() });
      const values = detail!.fields.get(name)!.values;
      if (!values.has(id)) values.set(id, value);
    };
    for (const { id } of this.groups.get(group) ?? []) {
      const material = this.material(id);
      if (material) detail.materials.set(id, material);
      for (const [name, value, unit] of this.quantities(id)) field(name, unit, id, value);
      const line = this.model.record(id);
      for (const attribute of ATTRIBUTES) {
        if (line[attribute]?.value != null) field(attribute, "m", id, Number(line[attribute].value) * this.model.units.length);
      }
      const seen = new Set<string>();
      for (const [set, name, value, unit] of this.properties(id)) {
        const key = `${set}.${name}`;
        if (seen.has(key)) continue;
        seen.add(key);
        if (name === "IsExternal" && typeof value === "boolean" && !detail.external.has(id)) detail.external.set(id, value);
        if (name === "LoadBearing" && typeof value === "boolean" && !detail.bearing.has(id)) detail.bearing.set(id, value);
        if (unit && typeof value === "number") field(name, unit, id, value, false);
        let stats = detail.properties.get(key);
        if (!stats) detail.properties.set(key, (stats = { filled: 0, values: new Map(), numbers: 0, sum: 0, low: Infinity, high: -Infinity }));
        stats.filled++;
        if (typeof value === "number") {
          stats.numbers++;
          stats.sum += value;
          stats.low = Math.min(stats.low, value);
          stats.high = Math.max(stats.high, value);
        }
        const shown = typeof value === "number" ? `${num(value)}${unit ? ` ${unit}` : ""}` : typeof value === "boolean" ? (value ? "yes" : "no") : clip(value, 60);
        if (stats.values.size < 200 || stats.values.has(shown)) bump(stats.values, shown);
      }
    }
    this.details.set(group, detail);
    return detail;
  }

  /** The fields most elements of a class carry, quantities first. */
  private mainFields(detail: Detail, size: number): [string, Field][] {
    const rank = ([name, field]: [string, Field]) => (field.quantity ? 2 : 0) + (TOTALLED.test(name) || DIMENSION.test(name) ? 1 : 0);
    return [...detail.fields]
      .filter(([name, field]) => field.values.size >= Math.min(size, Math.max(1, size * 0.2)) && rank([name, field]) > 0)
      .sort((a, b) => rank(b) - rank(a) || b[1].values.size - a[1].values.size)
      .slice(0, MAX_FIELDS);
  }

  private fieldSummary(name: string, field: Field, ids: number[]): string {
    const values = ids.map((id) => field.values.get(id)).filter((value): value is number => value !== undefined);
    if (values.length === 0) return "";
    const low = Math.min(...values), high = Math.max(...values);
    const partial = values.length < ids.length ? ` (${values.length} of ${ids.length} carry it)` : "";
    if (TOTALLED.test(name) && !DIMENSION.test(name)) {
      const total = values.reduce((sum, value) => sum + value, 0);
      return `${name} total ${num(total)} ${field.unit}${values.length > 1 ? ` (each ${high - low < 1e-6 ? num(low) : `${num(low)}–${num(high)}`})` : ""}${partial}`;
    }
    return `${name} ${high - low < 1e-6 ? num(low) : `${num(low)}–${num(high)}`} ${field.unit}${partial}`;
  }

  /** Complete list of the element classes of the model with counts per storey and the commonest type names. */
  inventory(): string {
    return this.memo("inventory", () => {
      const lines = ["Element classes in the model, with counts (complete: a class that is not listed does not occur in the model):"];
      const auxiliary: string[] = [];
      for (const [group, items] of [...this.groups].sort((a, b) => a[0].localeCompare(b[0]))) {
        if (AUXILIARY.test(group) && !(SPATIAL.test(group) && items.length > 3)) {
          auxiliary.push(`${group} ${items.length}`);
          continue;
        }
        const types = new Map<string, number>();
        for (const item of items) if (item.type) bump(types, item.type);
        const top = ranked(types).slice(0, MAX_INVENTORY_TYPES).map(([name, n]) => `${clip(name, 70)} ×${n}`);
        const storeys = this.model.storeys.length > 1 || items.some((item) => item.storey < 0) ? ` | by storey: ${this.storeyCounts(items)}` : "";
        lines.push(
          `- ${group}: ${items.length}${this.partsNote(group)}${storeys}` +
            (types.size > 0 ? ` | ${types.size} type name${types.size === 1 ? "" : "s"}: ${top.join("; ")}${types.size > top.length ? `; … ${types.size - top.length} more` : ""}` : ""),
        );
      }
      if (auxiliary.length > 0) lines.push(`Spatial and auxiliary records: ${auxiliary.join(", ")}`);
      return lines.join("\n");
    });
  }

  /** Class labels a detail section exists for. */
  classes(): string[] {
    return [...this.groups.keys()];
  }

  /** Resolves a label a language model wrote to a class of the inventory. */
  findClass(label: string): string | undefined {
    const wanted = label.trim().toLowerCase();
    const labels = this.classes();
    return (
      labels.find((each) => each.toLowerCase() === wanted) ??
      labels.find((each) => each.toLowerCase().split(" (")[0] === wanted.split(" (")[0]) ??
      labels.find((each) => each.toLowerCase().includes(wanted))
    );
  }

  /** One class in detail: types with counts per storey, flags, materials, quantity totals, names and property values. */
  classDetail(group: string): string {
    return this.memo(`class:${group}`, () => {
      const items = this.groups.get(group) ?? [];
      if (items.length === 0) return `${group}: none in the model.`;
      const detail = this.detail(group);
      const ids = items.map((item) => item.id);
      const fields = this.mainFields(detail, items.length);
      const lines = [`### ${group}: ${items.length} elements${this.partsNote(group)}`, `By storey: ${this.storeyCounts(items)}`];

      const predefined = new Map<string, number>();
      for (const item of items) if (item.predefined) bump(predefined, item.predefined);
      if (predefined.size > 0) lines.push(`Predefined types: ${ranked(predefined).map(([name, n]) => `${name} ${n}`).join(", ")}`);

      const flag = (label: [string, string], flags: Map<number, boolean>, subset: number[]): string => {
        const known = subset.filter((id) => flags.has(id));
        if (known.length === 0) return "";
        const yes = known.filter((id) => flags.get(id)).length;
        const unset = subset.length - known.length;
        return `${label[0]} ${yes}, ${label[1]} ${known.length - yes}${unset ? `, not stated ${unset}` : ""}`;
      };
      const EXTERNAL: [string, string] = ["external", "internal"];
      const BEARING: [string, string] = ["load-bearing", "non-load-bearing"];
      for (const [label, flags] of [[EXTERNAL, detail.external], [BEARING, detail.bearing]] as const) {
        const summary = flag(label, flags, ids);
        if (!summary) continue;
        lines.push(`${label === EXTERNAL ? "IsExternal" : "LoadBearing"}: ${summary}`);
        for (const [name, field] of fields) {
          if (!TOTALLED.test(name) || DIMENSION.test(name)) continue;
          const total = (wanted: boolean) => num(ids.filter((id) => flags.get(id) === wanted).reduce((sum, id) => sum + (field.values.get(id) ?? 0), 0));
          lines.push(`- ${name} of the ${label[0]} ones ${total(true)} ${field.unit}, of the ${label[1]} ones ${total(false)} ${field.unit}`);
        }
      }
      if (fields.length > 0) {
        lines.push("Stored quantities and dimensions over the whole class:");
        for (const [name, field] of fields) {
          let line = `- ${this.fieldSummary(name, field, ids)}`;
          const distinct = new Map<string, number>();
          for (const id of ids) if (field.values.has(id)) bump(distinct, num(field.values.get(id)!));
          if (distinct.size > 1 && distinct.size <= 12 && DIMENSION.test(name)) line += `; values: ${ranked(distinct).map(([value, n]) => `${value} ×${n}`).join(", ")}`;
          if (TOTALLED.test(name) && !DIMENSION.test(name) && this.model.storeys.length > 1) {
            const perStorey = new Map<number, number>();
            for (const item of items) if (field.values.has(item.id)) bump(perStorey, item.storey, field.values.get(item.id)!);
            line += `; by storey: ${[...perStorey].sort((a, b) => (a[0] < 0 ? 1e9 : a[0]) - (b[0] < 0 ? 1e9 : b[0])).map(([storey, total]) => `${storey < 0 ? "(no storey)" : this.model.storeys[storey].name} ${num(total)}`).join(", ")}`;
          }
          lines.push(line);
        }
      } else {
        lines.push("The model stores no quantities (length, area, volume) for this class.");
      }

      const typeNames = new Set(items.map((item) => item.type));
      // A long list of numbered names ('Haus-1' … 'Haus-173') is one line, not a hundred.
      const stem = (name: string) => name.replace(/[-_ .]?\d+$/, "");
      const series = new Map<string, number>();
      if (typeNames.size > MAX_TYPES) for (const name of typeNames) if (stem(name) !== name && stem(name)) bump(series, stem(name));
      const byType = new Map<string, Item[]>();
      for (const item of items) {
        const numbered = (series.get(stem(item.type)) ?? 0) >= 5 && stem(item.type) !== item.type;
        const key = numbered ? `${stem(item.type)}-<number> (${series.get(stem(item.type))} numbered names)` : item.type || "(no type name)";
        if (!byType.has(key)) byType.set(key, []);
        byType.get(key)!.push(item);
      }
      const types = [...byType].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
      lines.push(`Types (${types.length}), each with count, storeys, flags, material and quantities:`);
      types.slice(0, MAX_TYPES).forEach(([type, members], position) => {
        const memberIds = members.map((item) => item.id);
        const materials = new Map<string, number>();
        for (const id of memberIds) if (detail.materials.has(id)) bump(materials, detail.materials.get(id)!);
        const material = ranked(materials).slice(0, 2).map(([name, n]) => (materials.size > 1 ? `${name} (${n})` : name)).join(" / ");
        const kinds = [...new Set(members.map((item) => item.predefined).filter(Boolean))].join("/");
        const row = [
          `${type} ×${members.length}`,
          this.model.storeys.length > 1 && position < MAX_TYPES_BY_STOREY ? `storeys: ${this.storeyCounts(members)}` : "",
          kinds ? `predefined type ${kinds}` : "",
          flag(EXTERNAL, detail.external, memberIds),
          flag(BEARING, detail.bearing, memberIds),
          material ? `material: ${material}` : "",
          ...fields.map(([name, field]) => this.fieldSummary(name, field, memberIds)),
        ];
        lines.push(`- ${row.filter(Boolean).join(" | ")}`);
      });
      if (types.length > MAX_TYPES) {
        const rest = types.slice(MAX_TYPES);
        const shown = rest.slice(0, MAX_NAMES).map(([type, members]) => `${type} ×${members.length}`);
        lines.push(`- ${rest.length} more types with ${rest.reduce((sum, [, members]) => sum + members.length, 0)} elements, by name and count only: ${shown.join("; ")}${rest.length > shown.length ? `; … ${rest.length - shown.length} more` : ""}`);
      }

      if (items.length <= MAX_ELEMENTS_LISTED) {
        lines.push("Each element:");
        for (const item of items) {
          const own = fields.slice(0, 5).map(([name, field]) => (field.values.has(item.id) ? `${name} ${num(field.values.get(item.id)!)} ${field.unit}` : "")).filter(Boolean);
          lines.push(`- ${item.name || "(unnamed)"}${item.type && item.type !== item.name ? ` [${item.type}]` : ""}${item.storey >= 0 ? ` on ${this.model.storeys[item.storey].name}` : ""}${own.length ? `: ${own.join(", ")}` : ""}`);
        }
      } else {
        const names = new Map<string, number>();
        for (const item of items) if (item.name && item.name !== item.type) bump(names, item.name);
        if (names.size > 0) {
          const shown = ranked(names).slice(0, MAX_NAMES).map(([name, n]) => (n > 1 ? `${name} ×${n}` : name));
          lines.push(`Element names (${names.size} distinct): ${shown.join("; ")}${names.size > shown.length ? `; … ${names.size - shown.length} more` : ""}`);
        }
      }
      for (const [name, field] of fields.filter(([name, field]) => field.quantity && DIMENSION.test(name)).slice(0, 3)) {
        const holders = items.filter((item) => field.values.has(item.id)).sort((a, b) => field.values.get(a.id)! - field.values.get(b.id)!);
        if (holders.length < 2 || new Set(holders.map((item) => item.name || item.type)).size < 2) continue;
        const names = (group: Item[]) => {
          const counts = new Map<string, number>();
          for (const item of group) bump(counts, item.name || item.type);
          return `${ranked(counts).slice(0, 6).map(([label, n]) => (n > 1 ? `${label} ×${n}` : label)).join("; ")}${counts.size > 6 ? ` and ${counts.size - 6} more names` : ""}`;
        };
        const lowest = field.values.get(holders[0].id)!, highest = field.values.get(holders.at(-1)!.id)!;
        const low = holders.filter((item) => field.values.get(item.id)! - lowest < 1e-6);
        const high = holders.filter((item) => highest - field.values.get(item.id)! < 1e-6);
        lines.push(`Smallest ${name} ${num(lowest)} ${field.unit}: ${names(low)}. Largest ${name} ${num(highest)} ${field.unit}: ${names(high)}.`);
      }

      const properties = [...detail.properties].sort((a, b) => b[1].filled - a[1].filled);
      if (properties.length > 0) {
        lines.push(`Properties (set.property: values with the number of elements; ${items.length} elements in the class):`);
        for (const [key, stats] of properties.slice(0, MAX_PROPERTIES)) {
          const top = ranked(stats.values);
          const unset = items.length - stats.filled;
          const values =
            top.length > 8 && stats.numbers === stats.filled
              ? `${top.length}${top.length >= 200 ? "+" : ""} different numbers from ${num(stats.low)} to ${num(stats.high)}, sum ${num(stats.sum)}`
              : `${top.slice(0, top.length > 8 ? MAX_VALUES : 8).map(([value, n]) => `${value} ×${n}`).join("; ")}${top.length > 8 ? `; … ${top.length - MAX_VALUES}${top.length >= 200 ? "+" : ""} more values` : ""}`;
          lines.push(`- ${key}: ${values}${unset > 0 ? ` (not set on ${unset})` : ""}`);
        }
        if (properties.length > MAX_PROPERTIES) lines.push(`- … ${properties.length - MAX_PROPERTIES} rarer properties are not listed`);
      }
      return lines.join("\n");
    });
  }

  /** Rooms per storey with area, height and volume. */
  spaces(): string {
    return this.memo("spaces", () => {
      const model = this.model;
      const items = this.groups.get("IfcSpace") ?? [];
      if (items.length === 0) return "Spaces: the model has no IfcSpace records (no rooms are modelled).";
      const detail = this.detail("IfcSpace");
      const stored = (id: number, names: RegExp): number | undefined => {
        for (const [name, field] of detail.fields) if (names.test(name) && field.values.has(id) && field.values.get(id)! > 0) return field.values.get(id)!;
        return undefined;
      };
      const lines = [
        `Spaces (IfcSpace): ${items.length}. Area is the stored net floor area, or the plan footprint of the space body where none is stored; ` +
          "height and volume are stored quantities or properties, or measured on the space body. Label: name (number).",
      ];
      let listed = 0, sum = 0;
      const storeys = [...model.storeys.map((_, i) => i), -1];
      for (const storey of storeys) {
        const rooms = items.filter((item) => item.storey === storey);
        if (rooms.length === 0) continue;
        const rows: string[] = [];
        let total = 0;
        for (const room of rooms) {
          const area = model.floorArea(room.id)?.value;
          const gross = stored(room.id, /^GrossFloorArea$/i);
          const height = stored(room.id, /^(Height|FinishCeilingHeight|NetHeight|ClearHeight)$/i) ?? stored(room.id, /height|höhe|hoehe/i) ?? model.shape(room.id)?.height;
          const volume = stored(room.id, /^(NetVolume|GrossVolume|Volume)$/i) ?? stored(room.id, /volume|volumen/i) ?? model.shape(room.id)?.volume;
          total += area ?? 0;
          rows.push(
            `- ${roomLabel(model.space(room.id)) || room.id}: ${area === undefined ? "area unknown" : `${num(area)} m²`}` +
              `${gross ? `, gross ${num(gross)} m²` : ""}${height ? `, height ${num(height)} m` : ""}${volume ? `, volume ${num(volume)} m³` : ""}`,
          );
        }
        sum += total;
        lines.push("", `${storey < 0 ? "On no storey" : `Storey ${model.storeys[storey].name}`}: ${rooms.length} spaces, total area ${num(total)} m²`);
        const room = Math.max(0, MAX_SPACES - listed);
        lines.push(...rows.slice(0, room));
        if (rows.length > room) lines.push(`- … ${rows.length - room} more spaces on this storey are not listed`);
        listed += Math.min(rows.length, room);
      }
      lines.push("", `Sum of the space areas of the whole model: ${num(sum)} m² (net area of the rooms; a gross floor area is larger by walls and shafts)`);
      return lines.join("\n");
    });
  }

  /** Systems, zones and other groups with what they hold. */
  systems(): string {
    return this.memo("systems", () => {
      const model = this.model;
      const members = new Map<number, number[]>();
      for (const rel of model.instances(WebIFC.IFCRELASSIGNSTOGROUP)) {
        const line = model.record(rel);
        if (line.RelatingGroup?.value == null) continue;
        if (!members.has(line.RelatingGroup.value)) members.set(line.RelatingGroup.value, []);
        members.get(line.RelatingGroup.value)!.push(...refs(line.RelatedObjects));
      }
      const ids = model.instances(WebIFC.IFCGROUP);
      if (ids.length === 0) return "Systems and groups: the model has no IfcSystem, IfcDistributionSystem, IfcZone or other IfcGroup records.";
      const byClass = new Map<string, number>();
      const byKind = new Map<string, number>();
      const rows = ids.map((id) => {
        const line = model.record(id);
        const cls = model.className(id);
        bump(byClass, cls);
        const held = members.get(id) ?? [];
        const counts = new Map<string, number>();
        for (const member of held) {
          const group = this.byId.get(member)?.group ?? model.className(member);
          if (group !== "IfcDistributionPort") bump(counts, group);
        }
        const kind = text(line.ObjectType) || text(line.LongName) || text(line.PredefinedType);
        if (kind) bump(byKind, `${cls} of object type '${kind}'`);
        const spaces = held.filter((member) => this.byId.get(member)?.group === "IfcSpace");
        const named = spaces.length > 0 && spaces.length <= 40 ? `; spaces: ${spaces.map((space) => roomLabel(model.space(space))).join(", ")}` : "";
        const extra = [text(line.LongName), text(line.ObjectType), text(line.PredefinedType), text(line.Description)].filter((value) => value && value !== "NOTDEFINED");
        // Revit numbers the instances of a group: 'Model Group:Type A1:1950053'.
        const name = kind && text(line.Name).startsWith(kind) ? text(line.Name).replace(/:\d+$/, "") : text(line.Name);
        return `- ${cls} '${name}'${extra.length ? ` (${extra.join("; ")})` : ""}: ${[...counts.values()].reduce((sum, n) => sum + n, 0)} members${counts.size ? ` — ${ranked(counts).map(([group, n]) => `${group} ${n}`).join(", ")}` : ""}${named}`;
      });
      const distinct = new Map<string, number>();
      for (const row of rows) bump(distinct, row);
      const lines = [`Systems and groups: ${ids.length} (${ranked(byClass).map(([cls, n]) => `${cls} ${n}`).join(", ")})`];
      if (byKind.size > 0) lines.push(`By object type: ${ranked(byKind).slice(0, 40).map(([kind, n]) => `${kind} ×${n}`).join("; ")}`);
      lines.push(...[...distinct].slice(0, MAX_GROUPS).map(([row, n]) => (n > 1 ? `${row} (${n} groups like this)` : row)));
      if (distinct.size > MAX_GROUPS) lines.push(`- … ${distinct.size - MAX_GROUPS} more kinds of group are not listed`);
      return lines.join("\n");
    });
  }

  /** Everything recorded on one object: attributes, storey, type, material, quantities and properties. */
  private objectRecord(item: Item): string[] {
    const lines = [
      `${item.group} '${item.name}' (GlobalId ${item.guid})${item.type ? `, type ${item.type}` : ""}${item.storey >= 0 ? `, on storey ${this.model.storeys[item.storey].name}` : ""}`,
    ];
    const line = this.model.record(item.id);
    for (const attribute of ATTRIBUTES) {
      if (line[attribute]?.value != null) lines.push(`- ${attribute}: ${num(Number(line[attribute].value) * this.model.units.length)} m`);
    }
    const material = this.material(item.id);
    if (material) lines.push(`- material: ${material}`);
    for (const [name, value, unit] of this.quantities(item.id)) lines.push(`- quantity ${name}: ${num(value)} ${unit}`);
    for (const [set, name, value, unit] of this.properties(item.id).slice(0, 80)) {
      lines.push(`- ${set}.${name}: ${typeof value === "number" ? `${num(value)}${unit ? ` ${unit}` : ""}` : typeof value === "boolean" ? (value ? "yes" : "no") : clip(value, 100)}`);
    }
    return lines;
  }

  private tally(ids: number[]): string {
    const counts = new Map<string, number>();
    for (const id of ids) {
      const item = this.byId.get(id);
      if (item && !AUXILIARY.test(item.group)) bump(counts, `${item.group} ${item.type || item.name}`);
    }
    return ranked(counts).slice(0, 40).map(([label, n]) => `${label} ×${n}`).join("; ");
  }

  /** Records of the objects a question names: elements by GlobalId, rooms by number or name. */
  lookups(question: string): string {
    const sections: string[] = [];
    const guids = new Set(question.match(/[0-9A-Za-z_$]{22}/g) ?? []);
    if (guids.size > 0) {
      for (const item of this.byId.values()) {
        if (guids.has(item.guid) && sections.length < MAX_LOOKUPS) sections.push(this.objectRecord(item).join("\n"));
      }
    }
    const spaces = this.groups.get("IfcSpace") ?? [];
    const words = ` ${question.toLowerCase().replace(/[^\p{L}\p{N}.\-_]+/gu, " ")} `;
    const named = spaces.filter((item) => {
      const { number, name } = this.model.space(item.id);
      return [number, name].some((label) => label.length >= 3 && /\d/.test(label) && words.includes(` ${label.toLowerCase()} `));
    });
    if (named.length > 0 && named.length <= MAX_LOOKUPS) {
      if (!this.boundaries) {
        this.boundaries = new Map();
        for (const rel of this.model.instances(WebIFC.IFCRELSPACEBOUNDARY)) {
          const line = this.model.record(rel);
          if (line.RelatingSpace?.value == null || line.RelatedBuildingElement?.value == null) continue;
          if (!this.boundaries.has(line.RelatingSpace.value)) this.boundaries.set(line.RelatingSpace.value, []);
          this.boundaries.get(line.RelatingSpace.value)!.push(line.RelatedBuildingElement.value);
        }
      }
      for (const item of named) {
        const lines = this.objectRecord(item);
        lines[0] = `Room ${roomLabel(this.model.space(item.id))}: ${lines[0]}`;
        const inside = this.tally(this.model.contents(item.id));
        if (inside) lines.push(`- elements placed in this room: ${inside}`);
        const around = this.tally([...new Set(this.boundaries.get(item.id) ?? [])]);
        if (around) lines.push(`- elements bounding this room (walls, doors, windows, slabs, each counted once): ${around}`);
        const bounding = [...new Set(this.boundaries.get(item.id) ?? [])].map((id) => this.material(id)).filter(Boolean);
        if (bounding.length > 0) lines.push(`- materials of the bounding elements: ${[...new Set(bounding)].slice(0, 12).join(" // ")}`);
        sections.push(lines.join("\n"));
      }
    }
    return sections.join("\n\n");
  }

  /** The sections a question was matched to, most specific first, cut to a size limit. */
  assemble(selection: Selection, limit: number): string {
    const parts = [this.project(), this.inventory()];
    const wanted: string[] = [];
    for (const label of selection.classes) {
      const group = this.findClass(label);
      if (group && !wanted.includes(group)) wanted.push(group);
    }
    for (const group of wanted) parts.push(this.classDetail(group));
    if (selection.sections.includes("spaces")) parts.push(this.spaces());
    if (selection.sections.includes("systems")) parts.push(this.systems());
    let used = 0;
    const kept: string[] = [];
    for (const part of parts) {
      const room = limit - used;
      if (room < 500) {
        kept.push("(further sections were left out for length)");
        break;
      }
      const lines = part.split("\n");
      let size = 0, taken = 0;
      while (taken < lines.length && size + lines[taken].length + 1 <= room) size += lines[taken++].length + 1;
      kept.push(taken < lines.length ? `${lines.slice(0, taken).join("\n")}\n(… ${lines.length - taken} more lines of this section were left out for length)` : part);
      used += size;
    }
    return kept.join("\n\n");
  }

  /** Every section of the model, when the whole fits in the limit; null otherwise. */
  everything(limit: number): string | null {
    // Reading every class in detail is slow on a large model, and its text would not fit anyway.
    if (this.byId.size > 4000) return null;
    const classes = this.classes().filter((group) => !AUXILIARY.test(group) && group !== "IfcSpace");
    const all = [this.project(), this.inventory(), ...classes.map((group) => this.classDetail(group)), this.spaces(), this.systems()].join("\n\n");
    return all.length <= limit ? all : null;
  }
}

const MAX_CATALOGUES = 8;
const catalogues = new Map<string, { stamp: string; catalogue: Catalogue }>();

/**
 * The catalogue of a file with its model open. The model may be closed once the caller awaits anything else,
 * so call this again after every await and before reading more sections.
 */
export async function loadCatalogue(path: string): Promise<Catalogue> {
  const info = await stat(path);
  const stamp = `${info.mtimeMs}:${info.size}`;
  const model = await loadModel(path);
  const cached = catalogues.get(path);
  catalogues.delete(path);
  const entry = cached?.stamp === stamp ? cached : { stamp, catalogue: new Catalogue(model) };
  entry.catalogue.rebind(model);
  catalogues.set(path, entry);
  if (catalogues.size > MAX_CATALOGUES) catalogues.delete(catalogues.keys().next().value!);
  return entry.catalogue;
}
