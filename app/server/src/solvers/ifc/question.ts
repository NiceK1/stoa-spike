/** Take-off questions about an IFC model (English, Estonian, Danish, German) to a structured intent. */
import type { QuestionType } from "../../types.js";

export type ElementKind =
  | "space" | "door" | "window" | "wall" | "column" | "stair" | "beam" | "slab"
  | "sanitary" | "railing" | "roof" | "ramp" | "furniture" | "covering" | "footing" | "pipe";

export type IfcIntent =
  /** Net floor area of one room; `storey` is null when the question names only the room. */
  | { kind: "area_room"; room: string; storey: string | null }
  | { kind: "area_storey_rooms"; storey: string | null }
  | { kind: "wall_length" | "wall_side_area" | "wall_volume" | "slab_volume"; storey: string | null }
  /** `scope` is null when the wording does not say whether `name` is a storey or the model. */
  | { kind: "count"; element: ElementKind; scope: "storey" | "model" | null; name: string | null }
  | { kind: "text"; ask: TextAsk };

/** A storey named by its position rather than its name: 0 is the ground floor, 1 the floor above it, -1 the basement. */
export type LevelRef = { above: number } | "top";

/** What a free-text question wants to know about the model. */
export type TextAsk =
  | { topic: "software" | "overview" | "levels" | "floor_area" | "structure" | "wall_lengths" }
  | { topic: "largest_room"; smallest: boolean }
  | { topic: "spaces"; level: LevelRef | null; listed: boolean }
  | { topic: "element_types"; element: ElementKind; side: "exterior" | "interior" | null }
  | { topic: "element_widths"; element: ElementKind }
  | { topic: "element_volume"; element: ElementKind }
  | { topic: "element_property"; element: ElementKind; property: "LoadBearing" | "FireRating" };

/** A word or phrase that is not part of a longer word; \b does not know letters such as ø or ä. */
function words(pattern: string): RegExp {
  return new RegExp(`(?<![\\p{L}\\p{N}])(?:${pattern})(?![\\p{L}\\p{N}])`, "u");
}

/** English, then Estonian, Danish and German where the take-off questions use them. */
const ELEMENT_WORDS: [ElementKind, RegExp][] = [
  ["sanitary", words("sanitary (?:fixtures?|terminals?|appliances?|ware)")],
  ["space", words("rooms?|spaces?|ruumi|ruume|ruumid|ruum|rum|räume|raum")],
  ["door", words("doors?|ust|uks|ukse|uksi|uksed|døre|dør|türen|tür")],
  ["window", words("windows?|akent|aken|akna|aknaid|aknad|vinduer|vindue|fenster")],
  ["wall", words("walls?|seina|sein|seinu|seinad|vægge|væg|wände|wand")],
  ["column", words("columns?|posti|post|poste|postid|søjler|søjle|stützen|stütze|säulen|säule")],
  ["stair", words("stairs?|staircases?|treppi|trepp|treppe|trepid|trapper|trappe|treppen")],
  ["beam", words("beams?|tala|talasid|talad|bjælker|bjælke|träger|balken")],
  ["slab", words("slabs?|dæk|plader|decken|bodenplatten")],
  ["railing", words("railings?|handrails?|gelændere?|rækværk|geländer")],
  ["roof", words("roofs?|katust|katused|tage|dächer|dach")],
  ["ramp", words("ramps?|ramper|rampen")],
  ["furniture", words("furniture|furnishings?|møbler|möbel")],
  ["covering", words("coverings?")],
  ["footing", words("footings?|foundations?|fundamenter|fundamente")],
  ["pipe", words("pipes?|pipe segments?|ducts?|rør|rohre")],
];

const WHOLE_MODEL = words("(?:in|of) (?:the |this )?(?:whole |entire )?(?:model|building|project)|mudelis|i modellen|i bygningen|das modell|im modell|im gebäude");
const ONE_STOREY = words("floor plan|floor|storey|story|level|plaanil|korruse|korrusel|plantegningen|etagen|etage|grundriss|geschoss|stockwerk");
const ALL_ROOMS = words("all (?:the )?(?:rooms|spaces)|alle rum|kõigi ruumide|aller räume");
const SIDE_AREA = words("side area|sideareal|nettosideareal|seitenfläche|netto-seitenfläche");
const WALLS = words("walls?|vægge|wände|seinte|seinad|seina");
const SLABS = words("slabs?|dæk|plader|decken|bodenplatten");

// 'x', „x“, «x», »x«, “x”, "x". A single quote only opens after a space and closes before one, so that
// apostrophes inside a name stay part of it.
const QUOTED = /(?<=^|[\s(])'(.+?)'(?=$|[\s,.;:?!)])|„([^“”]+)[“”]|«([^»]+)»|»([^«]+)«|“([^”]+)”|"([^"]+)"/g;

/** True when the text names this storey, room or model as whole words, ignoring case and spacing. */
export function mentions(text: string, name: string): boolean {
  const loose = (value: string) => value.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
  const wanted = loose(name);
  return wanted !== "" && words(wanted.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).test(loose(text));
}

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

const ORDINALS = ["ground", "first", "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth", "ninth"];

/** 'basement', 'ground floor', 'second level', 'level 3', 'attic'. A numbered or named floor counts up from the ground floor. */
function levelRef(lowered: string): LevelRef | null {
  if (words("basement|cellar|underground (?:floor|level|storey)").test(lowered)) return { above: -1 };
  if (words("attic|top (?:floor|level|storey)|roof level").test(lowered)) return "top";
  const named = ORDINALS.findIndex((ordinal) => words(`${ordinal} (?:floor|level|storey|story)`).test(lowered));
  if (named >= 0) return { above: named };
  const numbered = /(?:level|floor|storey|story) (\d{1,2})(?![\d.])/.exec(lowered);
  return numbered ? { above: Number(numbered[1]) } : null;
}

/** Things a question can narrow down to that the solver does not extract: one room or dwelling, materials, build-ups, ratings. */
const OUT_OF_REACH = words(
  "materials?|thick\\w*|insulation|glazing|glazed|coefficient|warranty|fa[cç]ades?|steps|spans?|depth|compliant|lifespan|specification|layers|painting|" +
    "fire-rated|vapou?r|curtain|carbon|efficiency|grid|load path|restrooms?|bathrooms?|bedrooms?|toilets?|house [a-z]|duplex [a-z]|in room|room [a-z]?\\d[\\w.]*|" +
    "skirting|tiles?|tiling|doorknobs?|[0-9a-z_$]{22}",
);

/** Words that ask which kinds of an element there are and how many. */
const LISTING = "types?|kinds?|quantit(?:y|ies)|how many|distribution|counts?|breakdown|installed|present|used|applied|available|located|found|in (?:this|the) building";

/** Maps an English free-text question about a model to the facts it asks for, or null. */
export function parseTextQuestion(question: string): TextAsk | null {
  const lowered = withoutQuoted(question);
  const has = (pattern: string) => words(pattern).test(lowered);

  if (has("software|ifc (?:standards?|schema|version)|modell?ing standards?")) return { topic: "software" };
  if (has("(?:largest|biggest|smallest) (?:room|space)") || /(?:room|space).*(?:largest|biggest|smallest)/.test(lowered)) {
    return { topic: "largest_room", smallest: has("smallest") };
  }
  if (has("building(?:'s)? type|(?:type|kind) of building|project information|building details") || (has("number of levels") && has("rooms|spaces|area"))) {
    return { topic: "overview" };
  }
  if (has("(?:heights?|elevations?) of (?:each |the |all )?(?:building )?(?:levels?|storeys?|stories|floors?)|floor-to-floor|(?:how many|number of) (?:levels|storeys|stories|floors)")) {
    return { topic: "levels" };
  }
  if (has("(?:total |net |gross |usable )+floor area")) return { topic: "floor_area" };
  // From here on the nearest known fact would be a wrong answer to a narrower question.
  if (OUT_OF_REACH.test(lowered)) return null;
  if (has("space (?:breakdown|distribution)|(?:spaces|rooms) (?:are )?(?:on|in|of)|names of (?:all )?(?:the )?(?:rooms|spaces)|list of (?:each |all |the )?(?:rooms?|spaces?)")) {
    return { topic: "spaces", level: levelRef(lowered), listed: !has("by level|per level|distribution") || has("room names|individual|listing|complete") };
  }
  if (has("structural (?:components|elements|members)|structural system[^?]*counts")) return { topic: "structure" };

  const element = elementKind(lowered);
  if (!element || element === "space" || levelRef(lowered)) return null;
  if (element === "wall" && has("length")) return { topic: "wall_lengths" };
  if (has("load[- ]bearing")) return { topic: "element_property", element, property: "LoadBearing" };
  if (has("fire rating")) return { topic: "element_property", element, property: "FireRating" };
  if ((element === "door" || element === "window") && has("widths?|widest|narrowest|wide")) return { topic: "element_widths", element };
  if (has("volume")) return { topic: "element_volume", element };
  if (!has(LISTING) || has("lengths?|heights?|areas?|sizes? of|dimensions of")) return null;
  const side = has("exterior|external|outer|outside") ? "exterior" : has("interior|internal|inner|inside") ? "interior" : null;
  return { topic: "element_types", element, side };
}

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
    const ask = parseTextQuestion(question);
    return ask ? { kind: "text", ask } : null;
  }
  return null;
}
