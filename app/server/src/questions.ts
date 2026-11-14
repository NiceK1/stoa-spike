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

const TYPE_WORDS: [QuestionType, RegExp][] = [
  ["count", /\b(how many|wie viele|combien|quant[ie]|kuinka monta|hvor mange|mitu|number of)\b/],
  ["volume", /\b(volume|volumen|nettovolumen|maht|tilavuus)\b|m³/],
  ["length", /\b(length|länge|longueur|lunghezza|pituus|længde|pikkus|metres|meter)\b/],
  ["area", /\b(area|fläche|nettofläche|surface|superficie|pinta-ala|areal|nettoareal|pindala)\b|m²|ft²/],
];

const HOW_MANY = "(?:how many|wie viele|combien de|quant[ie]|kuinka monta)\\s+";
// "How many square metres ..." asks for a measure, not a count.
const UNIT_AFTER_HOW_MANY: [QuestionType, RegExp][] = [
  ["volume", new RegExp(`${HOW_MANY}(?:cubic\\s|m³|m3\\b|kubikmeter|mètres cubes|metri cubi|kuutiometri)`)],
  ["area", new RegExp(`${HOW_MANY}(?:square\\s|m²|m2\\b|sq\\.?\\s?(?:m|ft)\\b|quadratmeter|mètres carrés|metri quadr|neliömetri)`)],
  ["length", new RegExp(`${HOW_MANY}(?:linear\\s+|running\\s+)?(?:metres|meters|meter|feet|foot|millimetres|millimeters|centimetres|centimeters|mètres|metri|metriä)\\b`)],
];

/** Guess the answer type of a free-form question, for questions that do not come from the dataset. */
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

// Verbs and question words that ask to be shown something, in the languages the dataset uses and a few neighbours.
const LOCATE_WORDS = [
  "show", "mark", "highlight", "locate", "find", "point out", "pinpoint", "circle", "indicate", "where", "where's",
  "näytä", "merkitse", "merkkaa", "korosta", "etsi", "paikanna", "osoita", "missä",
  "zeig", "zeige", "zeigen", "markiere", "markieren", "finde", "kennzeichne", "wo",
  "montre", "montrez", "montre-moi", "marque", "marquez", "trouve", "trouvez", "surligne", "indique", "indiquez", "repère", "où",
  "mostra", "mostrami", "segna", "evidenzia", "trova", "individua", "dove", "dov'è",
  "visa", "markera", "hitta", "muestra", "muéstrame", "señala", "resalta", "localiza", "dónde",
];
const LOCATE = new RegExp(String.raw`(?<![\p{L}'])(?:${LOCATE_WORDS.join("|")})(?![\p{L}'-])`, "u");

/**
 * True for a request to be shown something ("show me the bedrooms", "where is the sauna") rather than told a
 * quantity. Such a request is answered like the count of that thing, which comes with the marks on the drawing.
 */
export function isLocate(question: string): boolean {
  const lowered = question.toLowerCase();
  return inferType(lowered) === "text" && LOCATE.test(lowered);
}
