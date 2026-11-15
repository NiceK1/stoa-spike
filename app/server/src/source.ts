/** Names, display labels and tiers for the source of an answer: which script or model understood the question and computed the value. */
import type { Contributor, OutsideAdvice, SourceTier } from "./types.js";

export const SCRIPTS = {
  keywords: "Keyword parser",
  dxf: "CAD geometry script",
  ifcRecords: "IFC model script (web-ifc)",
  ifcStored: "IFC stored quantities",
  ifcGeometry: "IFC geometry script (web-ifc)",
  ifcFacts: "IFC facts script (web-ifc)",
  sheetText: "Sheet text script (mupdf)",
  vote: "Middle count script",
} as const;

/** The tier of a model or detector, from the provider its id starts with. An unknown provider counts as external. */
export function tierOf(id: string): SourceTier {
  const provider = id.split(":")[0];
  if (provider === "onnx" || provider === "gemma-local") return "own-model";
  if (provider === "openai-compatible") return "self-hosted-model";
  return "external-model";
}

export const INTERPRETER_LABEL = "Blueline interpreter (tuned Gemma)";
export const DETECTOR_LABEL = "Blueline detector (trained YOLO11)";

const PRODUCTS: Record<string, string> = {
  "claude-haiku-5-5": "Claude Haiku 5.5",
  "claude-sonnet-5-5": "Claude Sonnet 5.5",
  "claude-opus-5-5": "Claude Opus 5.5",
  "gemini-4-hydrogen": "Gemini 4 Hydrogen",
};
const VENDORS: Record<string, string> = { "claude-cli": "Anthropic", "anthropic-api": "Anthropic", "gemini-api": "Google", roboflow: "Roboflow" };

/**
 * A model id as a person reads it: our own models by what they are, a model outside by product and vendor.
 * Undefined for a provider the app does not know, whose id is then shown as it is.
 */
export function labelOf(id: string): string | undefined {
  const [provider, name = ""] = id.split(":");
  if (provider === "onnx") return /yolo11/i.test(name) ? DETECTOR_LABEL : "Blueline detector";
  if (provider === "gemma-local") return INTERPRETER_LABEL;
  if (provider === "openai-compatible") return `${name} (self-hosted)`;
  const vendor = VENDORS[provider];
  return vendor ? `${PRODUCTS[name] ?? name} (${vendor})` : undefined;
}

/** The advice of a line-up built from the environment alone, where no mode is there to point to. */
export const UNCONFIGURED: OutsideAdvice = { none: "none is configured (VISION_PROVIDER=none)" };

export const script = (name: string, did?: string): Contributor => ({ name, tier: "script", ...(did && { did }) });
export function model(id: string, did?: string, name = id): Contributor {
  const label = labelOf(id);
  return { name, ...(label && { label }), tier: tierOf(id), ...(did && { did }) };
}
