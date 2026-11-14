import type { QuestionType } from "./types.js";

export interface Intent {
  kind: string;
  name?: string;
  number?: string;
  unit?: string;
}

const APARTMENT = /\b(?:apartment|appartement|appartamento|wohnung)\s+([A-Z])\b/i;
const ROOM_NUMBER = /\b(?:room|pièce|locale|raum)\s+([A-Z]?\d+(?:\.\d+)?)/i;

const ALL_INDOOR = ["numbered indoor rooms", "intérieures numérotées", "nummerierten innenräume", "interni numerati"];
const AREA_BY_LABEL = ["all rooms labelled", "toutes les pièces désignées", "aller räume mit der bezeichnung", "tutti i locali denominati"];
const COUNT_BY_LABEL = ["rooms labelled", "pièces portant la désignation", "räume mit der bezeichnung", "locali con la denominazione"];

// Checked in order; room-label templates are matched before these, so French "portant" never reaches "porte".
const COUNT_KINDS: [string, RegExp][] = [
  ["count_apartments", /\b(apartments|appartements|wohnungen|appartamenti)\b/],
  ["count_doors", /\b(doors|portes|türen|porte)\b/],
  ["count_windows", /\b(windows|fenêtres|fenster|finestre)\b/],
  ["count_toilets", /\b(toilets|wcs?)\b/],
  ["count_washbasins", /\b(washbasins|lavabos|lavabi)\b/],
  ["count_bathtubs", /\b(bathtubs|baignoires|badewannen|vasche da bagno)\b/],
  ["count_showers", /\b(showers|douches|duschen|docce)\b/],
];

const QUOTE_PAIRS: [string, string][] = [["«", "»"], ["„", "“"], ["„", "”"], ["“", "”"], ["‘", "’"], ["'", "'"], ['"', '"']];

/** Text between the first opening and the last closing quote; names may contain apostrophes. */
export function quotedName(question: string): string | undefined {
  for (const [open, close] of QUOTE_PAIRS) {
    const start = question.indexOf(open);
    const end = question.lastIndexOf(close);
    if (start >= 0 && start < end) return question.slice(start + 1, end).trim();
  }
  return undefined;
}

// Area is checked before length: "square metres" holds a length word.
const TYPE_WORDS: [QuestionType, RegExp][] = [
  ["count", /\b(how many|wie viele|combien|quant[ie]|kuinka monta|hvor mange|mitu|number of)\b/],
  ["volume", /\b(volume|volumen|nettovolumen|maht|tilavuus)\b|m³/],
  ["area", /\b(area|fläche|nettofläche|surface|superficie|pinta-ala|areal|nettoareal|pindala|square (?:metres?|meters?|feet)|sq\.? ?(?:m|ft)|m2)\b|m²|ft²/],
  ["length", /\b(length|länge|longueur|lunghezza|pituus|længde|pikkus|metres?|meters?)\b/],
];

const HOW_MANY = "(?:how many|wie viele|combien de|quant[ie]|kuinka monta)\\s+";
// "How many square metres ..." asks for a measure, not a count.
const UNIT_AFTER_HOW_MANY: [QuestionType, RegExp][] = [
  ["volume", new RegExp(`${HOW_MANY}(?:cubic\\s|m³|m3\\b|kubikmeter|mètres cubes|metri cubi|kuutiometri)`)],
  ["area", new RegExp(`${HOW_MANY}(?:square\\s|m²|m2\\b|sq\\.?\\s?(?:m|ft)\\b|quadratmeter|mètres carrés|metri quadr|neliömetri)`)],
  ["length", new RegExp(`${HOW_MANY}(?:linear\\s+|running\\s+)?(?:metres?|meters?|feet|foot|millimetres?|millimeters?|centimetres?|centimeters?|mètres?|metri|metriä)\\b`)],
];

/** Guess the answer type from keywords. Used only when no interpreter model reads the question. */
export function inferType(question: string): QuestionType {
  const lowered = question.toLowerCase();
  for (const [type, pattern] of UNIT_AFTER_HOW_MANY) if (pattern.test(lowered)) return type;
  for (const [type, pattern] of TYPE_WORDS) if (pattern.test(lowered)) return type;
  return "text";
}

/** Map a take-off question about a layered floor plan (EN/DE/FR/IT) to a structured intent. */
export function parseTakeoff(question: string, qtype: QuestionType): Intent | null {
  const lowered = question.toLowerCase();
  if (qtype === "area") {
    const apartment = APARTMENT.exec(question);
    if (apartment && apartment[1] === apartment[1].toUpperCase()) return { kind: "area_apartment", unit: apartment[1] };
    if (ALL_INDOOR.some((k) => lowered.includes(k))) return { kind: "area_all_indoor" };
    if (AREA_BY_LABEL.some((k) => lowered.includes(k))) return { kind: "area_rooms_labelled", name: quotedName(question) };
    const room = ROOM_NUMBER.exec(question);
    if (room) return { kind: "area_room", number: room[1] };
  } else if (qtype === "count") {
    if (COUNT_BY_LABEL.some((k) => lowered.includes(k))) return { kind: "count_rooms_labelled", name: quotedName(question) };
    for (const [kind, pattern] of COUNT_KINDS) if (pattern.test(lowered)) return { kind };
  }
  return null;
}

/** The keyword parser's reading in words, shown to the interpreter model to confirm or correct. */
export function describeIntent(intent: Intent): string {
  switch (intent.kind) {
    case "count_rooms_labelled": return `count the rooms labelled '${intent.name}' on the whole floor`;
    case "count_apartments": return "count the apartments on the floor";
    case "area_room": return `the net floor area of room ${intent.number}`;
    case "area_rooms_labelled": return `the total area of all rooms labelled '${intent.name}' on the floor`;
    case "area_all_indoor": return "the total net floor area of all numbered indoor rooms on the floor";
    case "area_apartment": return `the net floor area of apartment ${intent.unit}`;
    default: return `count all ${intent.kind.replace("count_", "")} on the whole floor`;
  }
}

// Verbs and question words that ask to be shown something, in the languages the dataset uses and a few neighbours.
const LOCATE_WORDS = [
  "show", "mark", "highlight", "locate", "find", "point out", "pinpoint", "circle", "indicate", "where", "where's",
  "näytä", "merkitse", "merkkaa", "korosta", "etsi", "paikanna", "osoita", "missä",
  "zeig", "zeige", "zeigen", "markiere", "markieren", "finde", "kennzeichne", "wo",
  "montre", "montrez", "montre-moi", "marque", "marquez", "trouve", "trouvez", "surligne", "indique", "indiquez", "repère", "où",
  "mostra", "mostrami", "segna", "evidenzia", "trova", "individua", "dove", "dov'è",
  "visa", "markera", "hitta", "muestra", "muéstrame", "señala", "resalta", "localiza", "dónde",
];
const POLITE = ["please", "pls", "can you", "could you", "would you", "bitte", "kannst du", "können sie", "s'il vous plaît", "per favore", "voisitko"];
// Only at the head of the question: "which rooms show a window" and "the room where the bathtub is" are not requests.
const LOCATE = new RegExp(String.raw`^\P{L}*(?:(?:${POLITE.join("|")})[\s,]+)*(?:${LOCATE_WORDS.join("|")})(?![\p{L}'-])`, "u");

/**
 * True for a request to be shown something ("show me the bedrooms", "where is the sauna") rather than told a
 * quantity, judged by keywords. Used only when no interpreter model reads the question.
 */
export function isLocate(question: string): boolean {
  const lowered = question.toLowerCase();
  return inferType(lowered) === "text" && LOCATE.test(lowered);
}

const FILLER = new Set([
  "me", "us", "the", "a", "an", "all", "every", "each", "any", "of", "on", "in", "at", "this", "that", "these", "those", "there", "here", "is", "are",
  "drawing", "plan", "floor", "floorplan", "model", "building", "storey", "level", "it", "them", "its", "s",
  "mir", "uns", "die", "der", "das", "den", "dem", "alle", "allen", "im", "auf", "diesem", "dieser", "sind", "ist", "grundriss", "geschoss", "gebäude", "modell",
  "moi", "nous", "les", "le", "la", "l", "tous", "toutes", "sur", "ce", "cet", "cette", "sont", "est", "étage", "du", "de", "des",
  "mi", "tutti", "tutte", "i", "gli", "il", "lo", "su", "questo", "questa", "pianta", "piano", "sono", "è",
  "kaikki", "tässä", "pohjapiirustuksessa", "ovat", "alla", "på", "här", "todos", "todas", "los", "las", "el", "en", "este", "esta",
]);

/**
 * True when a show-request names nothing but the thing to show: once the request words, filler words, quoted names
 * and the text matched by `target` are taken out, no word is left. A leftover word ("largest", "apartment") is a
 * qualifier the keyword parsers would drop, so such a request is not theirs to answer as a plain count.
 */
export function isPlainRequest(question: string, target: RegExp, alsoAllowed: string[] = []): boolean {
  const allowed = new Set(alsoAllowed.flatMap((name) => name.toLowerCase().split(/[^\p{L}\p{N}]+/u)));
  let rest = question.toLowerCase().replace(/'[^']*'|"[^"]*"|«[^»]*»|„[^“”]*[“”]/g, " ");
  // The whole word around the match: target patterns are often stems ("makuuhuone" in "makuuhuoneet").
  rest = rest.replace(new RegExp(String.raw`[\p{L}-]*(?:${target.source})[\p{L}-]*`, "gu"), " ");
  for (const phrase of [...POLITE, ...LOCATE_WORDS].sort((a, b) => b.length - a.length)) {
    rest = rest.replace(new RegExp(String.raw`(?<![\p{L}'])${phrase}(?![\p{L}'-])`, "gu"), " ");
  }
  return rest.split(/[^\p{L}\p{N}]+/u).every((word) => word === "" || FILLER.has(word) || allowed.has(word));
}

/** The pattern of the symbol or apartment kind a count intent names, for `isPlainRequest`. */
export function countKindPattern(kind: string): RegExp | undefined {
  return COUNT_KINDS.find(([name]) => name === kind)?.[1];
}
