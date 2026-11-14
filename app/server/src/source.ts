/** Names and tiers for the source of an answer: which script or model understood the question and computed the value. */
import type { Contributor, SourceTier } from "./types.js";

export const SCRIPTS = {
  keywords: "Keyword parser",
  dxf: "CAD geometry script",
  ifcRecords: "IFC model script (web-ifc)",
  ifcStored: "IFC stored quantities",
  ifcGeometry: "IFC geometry script (web-ifc)",
  ifcFacts: "IFC facts script (web-ifc)",
  sheetText: "Sheet text script (mupdf)",
} as const;

/** The tier of a model or detector, from the provider its id starts with. An unknown provider counts as external. */
export function tierOf(id: string): SourceTier {
  const provider = id.split(":")[0];
  if (provider === "onnx" || provider === "gemma-local") return "own-model";
  if (provider === "openai-compatible") return "self-hosted-model";
  return "external-model";
}

export const script = (name: string, did?: string): Contributor => ({ name, tier: "script", ...(did && { did }) });
export const model = (id: string, did?: string, name = id): Contributor => ({ name, tier: tierOf(id), ...(did && { did }) });
