/** Take-off questions about an IFC model (English, Estonian, Danish, German) to a structured intent. */
import type { QuestionType } from "../../types.js";

export type ElementKind =
  | "space" | "door" | "window" | "wall" | "column" | "stair" | "beam" | "slab"
  | "sanitary" | "railing" | "roof" | "ramp" | "furniture" | "covering" | "footing";

export type IfcIntent =
  /** Net floor area of one room; `storey` is null when the question names only the room. */
  | { kind: "area_room"; room: string; storey: string | null }
  | { kind: "area_storey_rooms"; storey: string | null }
  | { kind: "wall_length" | "wall_side_area" | "wall_volume" | "slab_volume"; storey: string | null }
  /** `scope` is null when the wording does not say whether `name` is a storey or the model. */
  | { kind: "count"; element: ElementKind; scope: "storey" | "model" | null; name: string | null }
  | { kind: "text"; topic: TextTopic };

export type TextTopic = "software" | "storeys" | "spaces" | "largest_room" | "elements" | "summary";

/** A word or phrase that is not part of a longer word; \b does not know letters such as ø or ä. */
function words(pattern: string): RegExp {
  return new RegExp(`(?<![\\p{L}\\p{N}])(?:${pattern})(?![\\p{L}\\p{N}])`, "u");
}

const ELEMENT_WORDS: [ElementKind, RegExp][] = [
  ["sanitary", words("sanitary (?:fixtures?|terminals?|appliances?|ware)|sanitetsgenstande|sanitet|sanitärobjekte|sanitärgegenstände|sanitaarseadet|sanitaarseadmeid|sanitaartehnikat")],
  ["space", words("rooms?|spaces?|ruumi|ruume|ruumid|ruum|rum|räume|raum")],
  ["door", words("doors?|ust|uks|ukse|uksi|uksed|døre|dør|türen|tür")],
  ["window", words("windows?|akent|aken|akna|aknaid|aknad|vinduer|vindue|fenster")],
  ["wall", words("walls?|seina|sein|seinu|seinad|vægge|væg|wände|wand")],
  ["column", words("columns?|posti|post|poste|postid|søjler|søjle|stützen|stütze|säulen|säule")],
  ["stair", words("stairs?|staircases?|treppi|trepp|treppe|trepid|trapper|trappe|treppen")],
  ["beam", words("beams?|tala|talasid|talad|bjælker|bjælke|träger|balken")],
  ["slab", words("slabs?|dæk|plader|decken|bodenplatten|vahelage|vahelagesid|plaati|plaate")],
  ["railing", words("railings?|handrails?|piiret|piirded|gelændere?|rækværk|geländer")],
  ["roof", words("roofs?|katust|katused|tage|dächer|dach")],
  ["ramp", words("ramps?|kaldteed|kaldteid|ramper|rampen")],
  ["furniture", words("furniture|furnishings?|furniture items|mööblieset|møbler|möbel")],
  ["covering", words("coverings?")],
  ["footing", words("footings?|foundations?|vundamenti|fundamenter|fundamente")],
];

const WHOLE_MODEL = words("(?:in|of) (?:the |this )?(?:whole |entire )?(?:model|building|project)|mudelis|i modellen|i bygningen|das modell|im modell|im gebäude|hoones");
const ONE_STOREY = words("floor plan|floor|storey|story|level|plaanil|korruse|korrusel|plantegningen|etagen|etage|grundriss|geschoss|stockwerk");
const ALL_ROOMS = words("all (?:the )?(?:rooms|spaces)|alle rum|kõigi ruumide|aller räume|total");
const SIDE_AREA = words("side area|sideareal|nettosideareal|seitenfläche|netto-seitenfläche|külgpind|küljepind|külgpindala");
const WALLS = words("walls?|vægge|wände|seinte|seinad|seina");
const SLABS = words("slabs?|dæk|plader|decken|bodenplatten|vahelagede|plaatide");

// 'x', „x“, «x», »x«, “x”, "x". A single quote only opens after a space and closes before one, so that
// apostrophes inside a name stay part of it.
const QUOTED = /(?<=^|[\s(])'(.+?)'(?=$|[\s,.;:?!)])|„([^“”]+)[“”]|«([^»]+)»|»([^«]+)«|“([^”]+)”|"([^"]+)"/g;

/** The quoted names in a question, in order. */
export function quotedNames(question: string): string[] {
  return [...question.matchAll(QUOTED)].map((match) => match.slice(1).find((group) => group !== undefined)!.trim());
}

function withoutQuoted(question: string): string {
  return question.replace(QUOTED, " ").toLowerCase();
}

/** The element kind named first in the text, if any. */
function elementKind(lowered: string): ElementKind | null {
  let best: { kind: ElementKind; at: number } | null = null;
  for (const [kind, pattern] of ELEMENT_WORDS) {
    const at = lowered.search(pattern);
    if (at >= 0 && (!best || at < best.at)) best = { kind, at };
  }
  return best?.kind ?? null;
}

const TEXT_TOPICS: [TextTopic, RegExp][] = [
  ["software", words("software|ifc (?:standards?|schema|version)|authoring|created with|modell?ing standards?|exported")],
  ["largest_room", words("(?:largest|biggest|smallest) (?:room|space)|(?:room|space)[^?]* (?:largest|biggest)")],
  ["storeys", words("heights? of each level|storeys|stories|levels|floors|elevations?")],
  ["spaces", words("space (?:breakdown|distribution)|rooms?|spaces?|floor area|net (?:usable )?floor area")],
  ["elements", words("types?|quantit(?:y|ies)|how many|components|elements|doors?|windows?|walls?|slabs?|columns?|beams?|stairs?|railings?|furniture|coverings?|pipes?|fixtures?|systems?")],
  ["summary", words("what (?:type|kind) of building|building(?:'s)? type|overview|describe|summary|about (?:this|the) (?:building|model)")],
];

/** Maps a question to what it asks of the model, or null when it is not one of the understood forms. */
export function parseIfcQuestion(question: string, qtype: QuestionType): IfcIntent | null {
  const names = quotedNames(question);
  const lowered = withoutQuoted(question);
  const last = names.at(-1) ?? null;

  if (qtype === "area") {
    if (SIDE_AREA.test(lowered)) return { kind: "wall_side_area", storey: last };
    if (names.length >= 2) return { kind: "area_room", room: names[0], storey: names[1] };
    if (ALL_ROOMS.test(lowered)) return { kind: "area_storey_rooms", storey: last };
    if (names.length === 1) return { kind: "area_room", room: names[0], storey: null };
    return null;
  }
  if (qtype === "length") return WALLS.test(lowered) ? { kind: "wall_length", storey: last } : null;
  if (qtype === "volume") {
    if (SLABS.test(lowered)) return { kind: "slab_volume", storey: last };
    return WALLS.test(lowered) ? { kind: "wall_volume", storey: last } : null;
  }
  if (qtype === "count") {
    const element = elementKind(lowered);
    if (!element) return null;
    const scope = WHOLE_MODEL.test(lowered) ? "model" : ONE_STOREY.test(lowered) ? "storey" : null;
    return { kind: "count", element, scope, name: last };
  }
  if (qtype === "text") {
    const topic = TEXT_TOPICS.find(([, pattern]) => pattern.test(lowered))?.[0];
    return topic ? { kind: "text", topic } : null;
  }
  return null;
}
