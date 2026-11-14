/**
 * Writes the question-to-call pairs the local interpreter (server/src/models/gemma.ts) is trained and tested on.
 * Every pair is rendered by the functions the app uses at inference: the request builders of planner.ts, the hint
 * functions of router.ts and the prompt renderer of models/gemma.ts.
 *
 *   STOA_DATASET=../dataset-full PLANNER_MODEL=claude-haiku-5-5 npx tsx scripts/interp-pairs.ts --out <dir> [--no-reword]
 *
 * Three sources, each with a call known to be right:
 *   dataset      the dataset's own wording; the call is the keyword parser's reading, kept when running it gives the expected answer
 *   constructed  questions built from each drawing's vocabulary that the keyword parser misreads (one apartment or room,
 *                several kinds, sums, largest and smallest, comparisons, things the drawing does not have, show-requests)
 *   reworded     rewordings of both by the hosted model, in the styles of paraphrase.ts ('train' and, for the test, 'heldout')
 * The test file comes from drawings, question templates and rewording styles that the training file does not use.
 */
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { datasetRoot, loadEnv } from "../server/src/config.js";
import { isAvailable, questionsByPath } from "../server/src/dataset.js";
import { completionJson, turns } from "../server/src/models/gemma.js";
import { createPlanner, type VisionRequest } from "../server/src/models/vision.js";
import { STYLE_SETS, rewordInStyles } from "../server/src/paraphrase.js";
import { ifcRequest, rasterRequest, runTakeoff, takeoffRequest, type IfcCall, type IfcMenu } from "../server/src/planner.js";
import { inferType, parseTakeoff } from "../server/src/questions.js";
import { ifcHint, rasterHint, takeoffHint } from "../server/src/router.js";
import { isCorrect } from "../server/src/scoring.js";
import { SYMBOL_KINDS, isLayeredPlan, loadPlan, type Plan, type SymbolKind } from "../server/src/solvers/dxf.js";
import { ifcMenu, solveIfcCall } from "../server/src/solvers/ifc.js";
import { parseIfcQuestion } from "../server/src/solvers/ifc/question.js";
import { RASTER_KINDS, rasterTarget } from "../server/src/solvers/raster.js";
import type { QuestionRow, QuestionType } from "../server/src/types.js";

loadEnv();
const args = process.argv.slice(2);
const option = (name: string, fallback?: string) => (args.includes(`--${name}`) ? args[args.indexOf(`--${name}`) + 1] : fallback);
const outDir = option("out") ?? "pairs";
mkdirSync(outDir, { recursive: true });

// ---------------------------------------------------------------------------------------------------------------
// Deterministic choices, so that a repeated run asks the hosted model the same things and finds them in the cache
// ---------------------------------------------------------------------------------------------------------------

let seed = 20261114;
function random(): number {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)];
function some<T>(items: readonly T[], n: number): T[] {
  const pool = [...items];
  const chosen: T[] = [];
  while (chosen.length < n && pool.length > 0) chosen.push(...pool.splice(Math.floor(random() * pool.length), 1));
  return chosen;
}
const fill = (template: string, slots: Record<string, string>) => template.replace(/\{(\w+)\}/g, (_, key) => slots[key] ?? `{${key}}`);

type Split = "train" | "test";
type Call = Record<string, unknown>;

interface Item {
  type: "dxf" | "raster" | "ifc";
  /** Renders the request for a question about this item's drawing. */
  request(question: string): VisionRequest;
  drawing: string;
  question: string;
  call: Call;
  lang: string;
  family: "dataset" | "constructed" | "reworded";
  split: Split;
  /** The question template or rewording style. */
  template: string;
  /** The call does not depend on the wording, so the question may be reworded. */
  rewordable?: boolean;
  /** Strings a rewording has to keep (room numbers, apartments, storey names). */
  anchors?: string[];
}

/** Templates in English for training, other English templates for the test, and a few in other languages for training. */
interface Wording {
  train: string[];
  test: string[];
  other?: Record<string, string[]>;
}
function wording(w: Wording, split: Split): { template: string; lang: string } {
  if (split === "test") return { template: pick(w.test), lang: "en" };
  const languages = Object.keys(w.other ?? {});
  if (languages.length > 0 && random() < 0.3) {
    const lang = pick(languages);
    return { template: pick(w.other![lang]), lang };
  }
  return { template: pick(w.train), lang: "en" };
}

const COUNTABLE = new Set(["count_symbols", "count_apartments", "rooms", "count_known", "count_other", "count_elements"]);
const countable = (call: Call) => COUNTABLE.has(String(call.operation)) && call.answer_type === "count" && (call.operation !== "rooms" || call.measure === "count");

// ---------------------------------------------------------------------------------------------------------------
// Layered DXF plans
// ---------------------------------------------------------------------------------------------------------------

const takeoff = (over: Call): Call => ({
  operation: "rooms", symbols: [], labels: [], room_numbers: [], apartments: [], pick: "all", measure: "count", missing: [], broader_label: false, reason: "",
  locate: false, answer_type: "count", ...over,
});

const SYMBOL_WORDS: Record<SymbolKind, Record<string, string[]>> = {
  doors: { en: ["doors"], de: ["Türen"], fr: ["portes"], it: ["porte"], fi: ["ovea"], sv: ["dörrar"] },
  windows: { en: ["windows"], de: ["Fenster"], fr: ["fenêtres"], it: ["finestre"], fi: ["ikkunaa"], sv: ["fönster"] },
  toilets: { en: ["toilets", "WCs", "toilets"], de: ["WCs", "Toiletten"], fr: ["WC", "toilettes"], it: ["WC"], fi: ["WC-istuinta"], sv: ["toaletter"] },
  washbasins: { en: ["washbasins", "sinks", "wash basins"], de: ["Lavabos", "Waschbecken"], fr: ["lavabos"], it: ["lavabi"], fi: ["pesuallasta"], sv: ["tvättställ"] },
  bathtubs: { en: ["bathtubs", "bath tubs", "tubs"], de: ["Badewannen"], fr: ["baignoires"], it: ["vasche da bagno"], fi: ["kylpyammetta"], sv: ["badkar"] },
  showers: { en: ["showers"], de: ["Duschen"], fr: ["douches"], it: ["docce"], fi: ["suihkua"], sv: ["duschar"] },
};
const symbolWord = (kind: SymbolKind, lang: string) => pick(SYMBOL_WORDS[kind][lang] ?? SYMBOL_WORDS[kind].en);

/** Everyday words for kinds of room, and the labels the Swiss plans use for them. */
const CONCEPTS: { labels: RegExp; generic?: boolean; words: Record<string, string[]> }[] = [
  { labels: /^(küche|cuisine|cucina)$/i, words: { en: ["kitchens"], de: ["Küchen"], fr: ["cuisines"], it: ["cucine"], fi: ["keittiötä"], sv: ["kök"] } },
  { labels: /^(bad|bain|bagno)$/i, words: { en: ["bathrooms"], de: ["Badezimmer", "Bäder"], fr: ["salles de bain"], it: ["bagni"], fi: ["kylpyhuonetta"], sv: ["badrum"] } },
  { labels: /^(korridor|couloir|corridoio)$/i, words: { en: ["corridors", "hallways"], de: ["Korridore", "Flure"], fr: ["couloirs"], it: ["corridoi"], fi: ["käytävää"], sv: ["korridorer"] } },
  { labels: /^(schlafzimmer|chambre à coucher|camera da letto)$/i, generic: true, words: { en: ["bedrooms"], de: ["Schlafzimmer"], fr: ["chambres à coucher"], it: ["camere da letto"], fi: ["makuuhuonetta"], sv: ["sovrum"] } },
  { labels: /^(wohnen|wohnen\/essen|séjour|séjour\/repas|soggiorno|soggiorno\/pranzo)$/i, generic: true, words: { en: ["living rooms"], de: ["Wohnzimmer"], fr: ["séjours", "salons"], it: ["soggiorni"], fi: ["olohuonetta"], sv: ["vardagsrum"] } },
  { labels: /^(balkon|balcon|balcone)$/i, words: { en: ["balconies"], de: ["Balkone"], fr: ["balcons"], it: ["balconi"], fi: ["parveketta"], sv: ["balkonger"] } },
  { labels: /^(treppenhaus|cage d'escalier|vano scala)$/i, words: { en: ["stairwells", "staircases"], de: ["Treppenhäuser"], fr: ["cages d'escalier"], it: ["vani scala"], fi: ["porrashuonetta"], sv: ["trapphus"] } },
  { labels: /^(lift|ascenseur|ascensore)$/i, words: { en: ["lifts", "elevators"], de: ["Aufzüge", "Lifte"], fr: ["ascenseurs"], it: ["ascensori"], fi: ["hissiä"], sv: ["hissar"] } },
  { labels: /^(reduit|réduit|ripostiglio)$/i, words: { en: ["storage rooms"], de: ["Abstellräume"], fr: ["débarras"], it: ["ripostigli"], fi: ["varastoa"], sv: ["förråd"] } },
];
const GENERIC_ROOM = /^(zimmer|pièce|stanza)$/i;
const ABSENT_ROOMS = ["saunas", "garages", "offices", "laundry rooms", "gyms", "wine cellars", "swimming pools", "conference rooms", "classrooms", "server rooms", "garden sheds", "home cinemas"];
const ABSENT_ROOMS_TEST = ["libraries", "workshops", "boiler rooms", "playrooms"];

const HOW_MANY_ROOMS: Wording = {
  train: ["How many {C} are there on this floor?", "How many {C} does this floor have?", "Number of {C} on this plan", "how many {C} on this level", "Count the {C} on this floor."],
  test: ["What is the number of {C} on this plan?", "Tell me how many {C} this storey has."],
  other: {
    de: ["Wie viele {C} gibt es auf diesem Geschoss?"], fr: ["Combien de {C} y a-t-il à cet étage ?"], it: ["Qual è il numero di {C} in questo piano?"],
    fi: ["Kuinka monta {C} tässä kerroksessa on?"], sv: ["Hur många {C} finns det på det här planet?"],
  },
};
const AREA_OF_ROOMS: Wording = {
  train: ["What is the total area of the {C} on this floor?", "Total area of all {C} in m²", "How many square metres do the {C} have together?"],
  test: ["How much area do the {C} take up in total?"],
};

const DXF = {
  symbolApartment: {
    train: ["How many {S} are there in apartment {U}?", "How many {S} does apartment {U} have?", "Number of {S} in apartment {U}", "Count the {S} in flat {U}.", "In apartment {U}, how many {S} are drawn?", "{S} in apartment {U}?", "how many {S} in apt {U}"],
    test: ["What is the number of {S} belonging to apartment {U}?", "Apartment {U}: how many {S} does it contain?", "Tell me how many {S} unit {U} has."],
    other: {
      de: ["Wie viele {S} gibt es in Wohnung {U}?", "Wie viele {S} hat Wohnung {U}?"], fr: ["Combien de {S} y a-t-il dans l'appartement {U} ?"],
      it: ["Qual è il numero di {S} nell'appartamento {U}?"], fi: ["Kuinka monta {S} asunnossa {U} on?"], sv: ["Hur många {S} finns det i lägenhet {U}?"],
    },
  },
  symbolRoom: {
    train: ["How many {S} does room {N} have?", "How many {S} are in room {N}?", "Count the {S} of room {N}.", "{S} in room {N}", "Room {N}: how many {S}?"],
    test: ["What is the number of {S} in room {N}?", "Tell me how many {S} room {N} has."],
    other: { de: ["Wie viele {S} hat Raum {N}?"], fr: ["Combien de {S} y a-t-il dans la pièce {N} ?"], fi: ["Kuinka monta {S} huoneessa {N} on?"] },
  },
  symbolLabel: {
    train: ["How many {S} are in the rooms labelled '{L}'?", "How many {S} do the '{L}' rooms have?", "Count the {S} in rooms labelled '{L}'."],
    test: ["What is the number of {S} in the rooms marked '{L}'?"],
  },
  symbols2: {
    train: ["How many {S} and {S2} are there on this floor?", "How many {S} and {S2} are drawn on this plan in total?", "Count the {S} and the {S2}.", "{S} and {S2} on this floor, how many altogether?", "Total number of {S} plus {S2}"],
    test: ["What is the combined number of {S} and {S2} on this drawing?", "Add up the {S} and {S2} shown on the plan."],
    other: {
      de: ["Wie viele {S} und {S2} gibt es auf diesem Geschoss insgesamt?"], fr: ["Combien de {S} et de {S2} y a-t-il sur ce plan ?"],
      fi: ["Kuinka monta {S} ja {S2} tässä kerroksessa on yhteensä?"], it: ["Qual è il numero totale di {S} e {S2} in questo piano?"], sv: ["Hur många {S} och {S2} finns det på det här planet?"],
    },
  },
  symbols3: {
    train: ["Total number of {S}, {S2} and {S3} on the plan", "How many {S}, {S2} and {S3} are there?", "Count all {S}, {S2} and {S3} on this floor."],
    test: ["Give me the total of {S}, {S2} and {S3} shown."],
  },
  symbols2Apartment: {
    train: ["How many {S} and {S2} are in apartment {U}?", "Count the {S} and {S2} of apartment {U}.", "{S} and {S2} in apartment {U} together?"],
    test: ["What is the total of {S} and {S2} in apartment {U}?"],
    other: { de: ["Wie viele {S} und {S2} hat Wohnung {U} zusammen?"] },
  },
  roomsApartment: {
    train: ["How many rooms does apartment {U} have?", "How many rooms are in apartment {U}?", "Number of rooms in apartment {U}", "Count the rooms of flat {U}."],
    test: ["What is the room count of apartment {U}?", "Apartment {U} consists of how many rooms?"],
    other: {
      de: ["Wie viele Räume hat Wohnung {U}?"], fr: ["Combien de pièces compte l'appartement {U} ?"], it: ["Quanti locali ha l'appartamento {U}?"],
      fi: ["Kuinka monta huonetta asunnossa {U} on?"], sv: ["Hur många rum har lägenhet {U}?"],
    },
  },
  roomsFloor: {
    train: ["How many rooms are there on this floor?", "Number of rooms on this plan", "How many rooms in total?"],
    test: ["What is the total room count of this floor?"],
    other: { de: ["Wie viele Räume gibt es auf diesem Geschoss?"], fi: ["Kuinka monta huonetta tässä kerroksessa on?"] },
  },
  labelApartmentCount: {
    train: ["How many rooms labelled '{L}' are in apartment {U}?", "How many '{L}' rooms does apartment {U} have?"],
    test: ["What is the number of '{L}' rooms inside apartment {U}?"],
  },
  labelApartmentArea: {
    train: ["What is the area of the rooms labelled '{L}' in apartment {U}?", "Total area of the '{L}' rooms in apartment {U} in m²"],
    test: ["How large are the '{L}' rooms of apartment {U} in total, in m²?"],
  },
  labelsArea: {
    train: ["What is the total area of the rooms labelled '{L}' and '{L2}'?", "Combined area of all '{L}' and '{L2}' rooms on this floor in m²"],
    test: ["What do the '{L}' and '{L2}' rooms add up to in m²?"],
  },
  labelsCount: {
    train: ["How many rooms are labelled '{L}' or '{L2}'?", "Count the rooms labelled '{L}' and '{L2}' together."],
    test: ["What is the number of rooms labelled either '{L}' or '{L2}'?"],
  },
  rooms2Area: {
    train: ["What is the combined area of rooms {N} and {N2}?", "How big are rooms {N} and {N2} together?", "Total area of rooms {N} and {N2} in m²", "Add up the areas of rooms {N} and {N2}."],
    test: ["What do rooms {N} and {N2} measure in total, in m²?"],
    other: { de: ["Wie gross sind die Räume {N} und {N2} zusammen in m²?"], fr: ["Quelle est la surface totale des pièces {N} et {N2} en m² ?"] },
  },
  rooms3Area: {
    train: ["Total area of rooms {N}, {N2} and {N3} in m²", "Add up the areas of rooms {N}, {N2} and {N3}.", "What is the combined area of rooms {N}, {N2} and {N3}?"],
    test: ["Sum of the floor areas of rooms {N}, {N2} and {N3}?"],
  },
  apartmentsArea: {
    train: ["What is the total area of apartments {U} and {U2}?", "Combined net floor area of apartments {U} and {U2} in m²", "How many square metres do apartments {U} and {U2} have together?"],
    test: ["What do apartments {U} and {U2} add up to in m²?"],
    other: {
      de: ["Wie gross sind die Wohnungen {U} und {U2} zusammen in m²?"], fr: ["Quelle est la surface totale des appartements {U} et {U2} en m² ?"],
      fi: ["Mikä on asuntojen {U} ja {U2} yhteenlaskettu pinta-ala?"],
    },
  },
  whichFloor: {
    train: ["Which is the {P} room on this floor?", "Which room is the {P}?", "What is the {P} room on the plan?"],
    test: ["Of all rooms on this floor, which one is the {P}?"],
    other: { de: ["Welches ist der {Pde} Raum in diesem Geschoss?"], fr: ["Quelle est la {Pfr} pièce de cet étage ?"], fi: ["Mikä on tämän kerroksen {Pfi} huone?"] },
  },
  whichApartment: {
    train: ["What is the {P} room in apartment {U}?", "Which is the {P} room in apartment {U}?", "{P} room of apartment {U}?"],
    test: ["Name the {P} room of apartment {U}."],
    other: {
      de: ["Welches ist der {Pde} Raum in Wohnung {U}?"], fr: ["Quelle est la {Pfr} pièce de l'appartement {U} ?"], fi: ["Mikä on asunnon {U} {Pfi} huone?"],
      it: ["Qual è il locale {Pit} dell'appartamento {U}?"], sv: ["Vilket är det {Psv} rummet i lägenhet {U}?"],
    },
  },
  whichLabel: { train: ["Which '{L}' is the {P}?", "Which is the {P} room labelled '{L}'?"], test: ["Among the '{L}' rooms, which is the {P}?"] },
  extremeAreaFloor: {
    train: ["What is the area of the {P} room on this floor?", "How big is the {P} room on the plan, in m²?"],
    test: ["How many square metres is the {P} room on the floor?"],
    other: { de: ["Wie gross ist der {Pde} Raum in diesem Geschoss in m²?"] },
  },
  extremeAreaApartment: {
    train: ["How big is the {P} room in apartment {U}?", "Area of the {P} room in apartment {U} in m²", "What is the area of the {P} room of apartment {U}?"],
    test: ["What does the {P} room of apartment {U} measure in m²?"],
  },
  extremeAreaLabel: { train: ["How many m² does the {P} '{L}' have?", "What is the area of the {P} room labelled '{L}'?"], test: ["How large is the {P} of the '{L}' rooms in m²?"] },
  averageApartment: { train: ["What is the average room area in apartment {U}?", "Average room size of apartment {U} in m²"], test: ["How big is a room in apartment {U} on average?"] },
  averageFloor: { train: ["Average room size on this floor in m²", "What is the average area of a room on this floor?"], test: ["Mean room size of this floor?"] },
  averageLabel: { train: ["What is the mean area of the rooms labelled '{L}'?", "Average size of the '{L}' rooms?"], test: ["How large is a '{L}' on average, in m²?"] },
  listApartment: {
    train: ["Which rooms belong to apartment {U}?", "List the rooms of apartment {U}.", "What rooms does apartment {U} have?"],
    test: ["Name all rooms that are part of apartment {U}."],
    other: { de: ["Welche Räume gehören zu Wohnung {U}?"], fr: ["Quelles pièces font partie de l'appartement {U} ?"] },
  },
  listFloor: { train: ["What rooms are on this floor?", "List all rooms on this plan."], test: ["Give me a list of every room on this floor."] },
  listLabel: { train: ["Which rooms are labelled '{L}'?", "List the rooms labelled '{L}'."], test: ["Name the rooms that carry the label '{L}'."] },
  compareApartments: {
    train: ["Which apartment is bigger, {U} or {U2}?", "Is apartment {U} larger than apartment {U2}?", "How much bigger is apartment {U} than apartment {U2}?", "Compare the areas of apartments {U} and {U2}."],
    test: ["Between apartments {U} and {U2}, which has more floor area?", "What is the difference in area between apartment {U} and apartment {U2}?"],
    other: { de: ["Welche Wohnung ist grösser, {U} oder {U2}?"], fr: ["Quel appartement est le plus grand, {U} ou {U2} ?"], fi: ["Kumpi asunto on suurempi, {U} vai {U2}?"] },
  },
  compareApartmentRooms: { train: ["Which apartment has more rooms, {U} or {U2}?", "Does apartment {U} have more rooms than apartment {U2}?"], test: ["Compare the number of rooms of apartments {U} and {U2}."] },
  compareApartmentSymbols: {
    train: ["Which apartment has more {S}, {U} or {U2}?", "Does apartment {U} have more {S} than apartment {U2}?"],
    test: ["Compare the number of {S} in apartments {U} and {U2}."],
  },
  compareSymbols: {
    train: ["Are there more {S} or {S2} on this floor?", "Which are there more of, {S} or {S2}?", "How many more {S} than {S2} are there?"],
    test: ["Compare the number of {S} with the number of {S2}."],
    other: { de: ["Gibt es mehr {S} oder {S2} auf diesem Geschoss?"], fi: ["Onko tässä kerroksessa enemmän {S} vai {S2}?"] },
  },
  compareRooms: {
    train: ["Which is larger, room {N} or room {N2}?", "Is room {N} bigger than room {N2}?", "How much larger is room {N} than room {N2}?"],
    test: ["Between rooms {N} and {N2}, which one has the greater area?"],
    other: { de: ["Welcher Raum ist grösser, {N} oder {N2}?"] },
  },
  compareLabelsCount: { train: ["Are there more '{L}' or '{L2}' rooms?", "Which label is more common, '{L}' or '{L2}'?"], test: ["Compare how many rooms are labelled '{L}' and '{L2}'."] },
  compareLabelsArea: { train: ["Which take up more area, the '{L}' rooms or the '{L2}' rooms?"], test: ["Do the '{L}' rooms cover more area than the '{L2}' rooms?"] },
  missingRoomArea: {
    train: ["What is the net floor area of room {X} in m²?", "How big is room {X}?", "Area of room {X}?"],
    test: ["What does room {X} measure?"],
    other: { de: ["Wie gross ist die Nettofläche von Raum {X} in m²?"], fr: ["Quelle est la surface nette de la pièce {X} en m² ?"] },
  },
  missingRoomSymbols: { train: ["How many {S} does room {X} have?", "How many {S} are in room {X}?"], test: ["What is the number of {S} in room {X}?"] },
  missingApartmentArea: {
    train: ["What is the net floor area of apartment {Z}?", "How big is apartment {Z} in m²?", "Area of apartment {Z}?"],
    test: ["How large is apartment {Z} in m²?"],
    other: { de: ["Wie gross ist die Nettowohnfläche von Wohnung {Z} in m²?"], fr: ["Quelle est la surface nette de l'appartement {Z} en m² ?"] },
  },
  missingApartmentSymbols: { train: ["How many {S} are in apartment {Z}?", "How many {S} does apartment {Z} have?"], test: ["What is the number of {S} belonging to apartment {Z}?"] },
  missingApartmentRooms: { train: ["How many rooms does apartment {Z} have?"], test: ["What is the room count of apartment {Z}?"] },
  showSymbols: {
    train: ["Show me the {S}.", "Where are the {S}?", "Mark all {S} on the plan.", "Highlight the {S}.", "show {S}", "Find all the {S} on this floor."],
    test: ["Can you indicate where the {S} are?", "Point out every one of the {S}."],
    other: { de: ["Zeig mir die {S}.", "Wo sind die {S}?"], fr: ["Montre-moi les {S}.", "Où sont les {S} ?"], sv: ["Visa alla {S}."] },
  },
  showSymbolsApartment: {
    train: ["Find the {S} in apartment {U}.", "Where are the {S} in apartment {U}?", "Show me the {S} of apartment {U}.", "Mark the {S} in apartment {U}."],
    test: ["Locate all {S} of apartment {U} for me."],
    other: { de: ["Zeig mir die {S} in Wohnung {U}."] },
  },
  showRoom: { train: ["Where is room {N}?", "Show me room {N}.", "Highlight room {N}.", "Find room {N} on the plan."], test: ["Can you point out room {N}?"], other: { de: ["Wo ist Raum {N}?"], fr: ["Où est la pièce {N} ?"] } },
  showApartment: {
    train: ["Highlight apartment {U}.", "Show me the rooms of apartment {U}.", "Where is apartment {U}?", "Mark apartment {U} on the plan."],
    test: ["Indicate apartment {U} on the plan."],
    other: { de: ["Zeig mir Wohnung {U}."], fi: ["Näytä asunto {U}."] },
  },
  showLabel: { train: ["Mark the rooms labelled '{L}'.", "Where are the '{L}' rooms?", "Show me every '{L}'."], test: ["Locate every room labelled '{L}'."] },
  showApartments: { train: ["Show all apartments.", "Where are the apartments?", "Mark every apartment on this floor."], test: ["Point out each apartment on the plan."] },
  showMissingRoom: { train: ["Where is room {X}?", "Show me room {X}."], test: ["Can you point out room {X}?"] },
} satisfies Record<string, Wording>;

const DXF_NONE: Record<Split, [string, "count" | "text"][]> = {
  train: [
    ["What is the ceiling height in room {N}?", "text"], ["What are the walls made of?", "text"], ["How much does apartment {U} cost?", "text"], ["What is the rent for this floor?", "text"],
    ["Who is the architect of this building?", "text"], ["When was this building built?", "text"], ["How many power sockets are there on this floor?", "count"],
    ["How many light switches are in apartment {U}?", "count"], ["How thick are the exterior walls?", "text"], ["What is the scale of this drawing?", "text"],
    ["Which way does the balcony face?", "text"], ["How many radiators are there?", "count"], ["What is the fire rating of the doors?", "text"], ["How tall are the windows?", "text"],
    ["What floor covering does room {N} have?", "text"], ["How many people live in apartment {U}?", "count"], ["What colour are the walls?", "text"],
    ["Wie hoch ist die Decke in Raum {N}?", "text"], ["Aus welchem Material sind die Wände?", "text"], ["Kuka on tämän rakennuksen arkkitehti?", "text"], ["Combien coûte l'appartement {U} ?", "text"],
  ],
  test: [
    ["What is the room height on this floor?", "text"], ["How many smoke detectors are installed?", "count"], ["What material is the floor in apartment {U}?", "text"],
    ["What year was the plan drawn?", "text"], ["How wide is the door of room {N}?", "text"], ["How many parking spaces belong to this building?", "count"],
  ],
};

const EXTREMES = [
  { pick: "largest", P: ["largest", "biggest"], Pde: "grösste", Pfr: "plus grande", Pfi: "suurin", Pit: "più grande", Psv: "största" },
  { pick: "smallest", P: ["smallest"], Pde: "kleinste", Pfr: "plus petite", Pfi: "pienin", Pit: "più piccolo", Psv: "minsta" },
];

function dxfCallOfIntent(question: string, type: QuestionType, plan: Plan): Call | null {
  const intent = parseTakeoff(question, type);
  if (!intent) return null;
  const label = (name?: string) => plan.vocabulary().labels.find(([known]) => known.toLowerCase() === (name ?? "").toLowerCase())?.[0];
  switch (intent.kind) {
    case "count_rooms_labelled": return label(intent.name) ? takeoff({ labels: [label(intent.name)] }) : null;
    case "area_rooms_labelled": return label(intent.name) ? takeoff({ labels: [label(intent.name)], measure: "area", answer_type: "area" }) : null;
    case "area_room": return takeoff({ room_numbers: [intent.number], measure: "area", answer_type: "area" });
    case "area_apartment": return takeoff({ operation: "area_apartment", apartments: [intent.unit], answer_type: "area" });
    case "area_all_indoor": return takeoff({ operation: "area_floor", answer_type: "area" });
    case "count_apartments": return takeoff({ operation: "count_apartments" });
    default: return takeoff({ operation: "count_symbols", symbols: [intent.kind.replace("count_", "")] });
  }
}

const languageOf = (question: string): string =>
  /^(wie|welche|aus welchem|zeig|wo |gibt)/i.test(question) ? "de" : /^(combien|quelle?|où|montre)/i.test(question) ? "fr" : /^(quant|qual )/i.test(question) ? "it"
  : /^(kuinka|mikä|kuka|kerro|mistä|montako|missä|näytä|merkitse)/i.test(question) ? "fi" : /^(hvor|hvad)/i.test(question) ? "da" : /^(kui|mitu)/i.test(question) ? "et"
  : /^wat|^hoeveel/i.test(question) ? "nl" : /^¿/.test(question) ? "es" : "en";

async function dxfItems(path: string, split: Split, perFamily: number): Promise<Item[]> {
  const file = join(datasetRoot(), path);
  const dxf = file.slice(0, file.length - extname(file).length) + ".dxf";
  if (!existsSync(dxf)) return [];
  const plan = await loadPlan(dxf);
  if (!isLayeredPlan(plan)) return [];
  const { labels, numbers, units } = plan.vocabulary();
  const base = { type: "dxf" as const, drawing: path, split, request: (question: string) => takeoffRequest(question, plan, takeoffHint(question, plan)) };
  const items: Item[] = [];

  // The dataset's wording, one or two questions of each kind, in the languages the plan's questions come in.
  const byKind = new Map<string, QuestionRow[]>();
  for (const row of questionsByPath().get(path) ?? []) {
    const kind = parseTakeoff(row.question, row.type as QuestionType)?.kind;
    if (kind) byKind.set(kind, [...(byKind.get(kind) ?? []), row]);
  }
  for (const [kind, rows] of [...byKind].sort()) {
    for (const row of some(rows, /labelled|area_room|area_apartment/.test(kind) ? 2 : 1)) {
      const call = dxfCallOfIntent(row.question, row.type as QuestionType, plan);
      if (!call) continue;
      let value: number | string | null = null;
      try {
        value = runTakeoff(call, plan).value;
      } catch {
        continue;
      }
      if (isCorrect(row.type, row.answer, value) !== true) continue;
      const anchors = [...(call.room_numbers as string[]), ...(call.apartments as string[])];
      items.push({ ...base, question: row.question, call, lang: languageOf(row.question), family: "dataset", template: kind, rewordable: true, anchors });
    }
  }

  const add = (name: keyof typeof DXF, slots: Record<string, string | ((lang: string) => string)>, call: Call, rewordable = true) => {
    const { template, lang } = wording(DXF[name], split);
    const filled = fill(template, Object.fromEntries(Object.entries(slots).map(([key, value]) => [key, typeof value === "function" ? value(lang) : value])));
    const full = takeoff(call);
    items.push({ ...base, question: filled, call: full, lang, family: "constructed", template: name, rewordable: rewordable && lang === "en", anchors: [...(full.room_numbers as string[]), ...(full.apartments as string[])] });
  };
  const S = (kind: SymbolKind) => (lang: string) => symbolWord(kind, lang);
  const kinds = () => some(SYMBOL_KINDS, 3) as SymbolKind[];
  const symbolCount = (symbols: SymbolKind[], over: Call = {}): Call => ({ operation: "count_symbols", symbols, ...over });
  const absentNumber = () => {
    for (;;) {
      const number = `${Math.floor(random() * 90) + 10}.${String(Math.floor(random() * 99) + 1).padStart(2, "0")}`;
      if (!numbers.includes(number)) return number;
    }
  };
  const absentUnit = () => pick("KLMNPQRSTVWXYZ".split("").filter((letter) => !units.includes(letter)));

  for (let round = 0; round < perFamily; round++) {
    const [k1, k2, k3] = kinds();
    const [u1, u2] = some(units, 2);
    const [n1, n2, n3] = some(numbers, 3);
    const [l1, l2] = some(labels.slice(0, 12).map(([name]) => name), 2);
    const extreme = pick(EXTREMES);
    const P = { P: pick(extreme.P), Pde: extreme.Pde, Pfr: extreme.Pfr, Pfi: extreme.Pfi, Pit: extreme.Pit, Psv: extreme.Psv };

    add("symbols2", { S: S(k1), S2: S(k2) }, symbolCount([k1, k2]));
    if (round % 2 === 0) add("symbols3", { S: S(k1), S2: S(k2), S3: S(k3) }, symbolCount([k1, k2, k3]));
    add("showSymbols", { S: S(k3) }, symbolCount([k3], { locate: true }), false);
    add("compareSymbols", { S: S(k2), S2: S(k3) }, { operation: "compare", symbols: [k2, k3], answer_type: "text" });
    if (round % 2 === 0) add("roomsFloor", {}, {});
    if (round % 2 === 1) add("whichFloor", P, { pick: extreme.pick, measure: "list", answer_type: "text" });
    if (round % 2 === 0) add("extremeAreaFloor", P, { pick: extreme.pick, measure: "area", answer_type: "area" });
    if (round % 3 === 0) add("averageFloor", {}, { measure: "average", answer_type: "area" });
    if (round % 3 === 1) add("listFloor", {}, { measure: "list", answer_type: "text" });
    if (round % 3 === 2 && units.length > 0) add("showApartments", {}, { operation: "count_apartments", locate: true }, false);

    if (u1) {
      add("symbolApartment", { S: S(k1), U: u1 }, symbolCount([k1], { apartments: [u1] }));
      add("roomsApartment", { U: u1 }, { apartments: [u1] });
      if (round % 2 === 0) add("symbols2Apartment", { S: S(k2), S2: S(k3), U: u1 }, symbolCount([k2, k3], { apartments: [u1] }));
      add(round % 2 === 0 ? "whichApartment" : "extremeAreaApartment", { ...P, U: u1 }, round % 2 === 0 ? { apartments: [u1], pick: extreme.pick, measure: "list", answer_type: "text" } : { apartments: [u1], pick: extreme.pick, measure: "area", answer_type: "area" });
      if (round % 3 === 0) add("averageApartment", { U: u1 }, { apartments: [u1], measure: "average", answer_type: "area" });
      if (round % 3 === 1) add("listApartment", { U: u1 }, { apartments: [u1], measure: "list", answer_type: "text" });
      if (round % 3 === 2) add("showApartment", { U: u1 }, { apartments: [u1], locate: true }, false);
      if (round % 2 === 1) add("showSymbolsApartment", { S: S(k2), U: u1 }, symbolCount([k2], { apartments: [u1], locate: true }), false);
      if (l1) add(round % 2 === 0 ? "labelApartmentCount" : "labelApartmentArea", { L: l1, U: u1 }, round % 2 === 0 ? { labels: [l1], apartments: [u1] } : { labels: [l1], apartments: [u1], measure: "area", answer_type: "area" });
    }
    if (u1 && u2) {
      add("apartmentsArea", { U: u1, U2: u2 }, { operation: "area_apartment", apartments: [u1, u2], answer_type: "area" });
      add("compareApartments", { U: u1, U2: u2 }, { operation: "compare", apartments: [u1, u2], measure: "area", answer_type: "text" });
      if (round % 2 === 0) add("compareApartmentRooms", { U: u1, U2: u2 }, { operation: "compare", apartments: [u1, u2], answer_type: "text" });
      else add("compareApartmentSymbols", { S: S(k1), U: u1, U2: u2 }, { operation: "compare", symbols: [k1], apartments: [u1, u2], answer_type: "text" });
    }
    if (n1) {
      add("symbolRoom", { S: S(k2), N: n1 }, symbolCount([k2], { room_numbers: [n1] }));
      if (round % 2 === 0) add("showRoom", { N: n1 }, { room_numbers: [n1], locate: true }, false);
    }
    if (n1 && n2) {
      add("rooms2Area", { N: n1, N2: n2 }, { room_numbers: [n1, n2], measure: "area", answer_type: "area" });
      add("compareRooms", { N: n2, N2: n1 }, { operation: "compare", room_numbers: [n2, n1], measure: "area", answer_type: "text" });
      if (n3 && round % 2 === 1) add("rooms3Area", { N: n1, N2: n2, N3: n3 }, { room_numbers: [n1, n2, n3], measure: "area", answer_type: "area" });
    }
    if (l1) {
      if (round % 2 === 0) add("symbolLabel", { S: S(k3), L: l1 }, symbolCount([k3], { labels: [l1] }));
      if (round % 3 === 0) add("whichLabel", { ...P, L: l1 }, { labels: [l1], pick: extreme.pick, measure: "list", answer_type: "text" });
      if (round % 3 === 1) add("extremeAreaLabel", { ...P, L: l1 }, { labels: [l1], pick: extreme.pick, measure: "area", answer_type: "area" });
      if (round % 3 === 2) add("averageLabel", { L: l1 }, { labels: [l1], measure: "average", answer_type: "area" });
      if (round % 3 === 0) add("listLabel", { L: l1 }, { labels: [l1], measure: "list", answer_type: "text" });
      if (round % 3 === 1) add("showLabel", { L: l1 }, { labels: [l1], locate: true }, false);
    }
    if (l1 && l2) {
      add(round % 2 === 0 ? "labelsArea" : "labelsCount", { L: l1, L2: l2 }, round % 2 === 0 ? { labels: [l1, l2], measure: "area", answer_type: "area" } : { labels: [l1, l2] });
      add(round % 2 === 0 ? "compareLabelsCount" : "compareLabelsArea", { L: l1, L2: l2 }, { operation: "compare", labels: [l1, l2], measure: round % 2 === 0 ? "count" : "area", answer_type: "text" });
    }

    // Things the plan does not have: the call says so instead of taking a neighbour.
    const x = absentNumber();
    const z = absentUnit();
    if (round % 2 === 0) add("missingRoomArea", { X: x }, { measure: "area", answer_type: "area", missing: [`room ${x}`] });
    else add("missingRoomSymbols", { S: S(k1), X: x }, symbolCount([k1], { missing: [`room ${x}`] }));
    if (round % 3 === 0) add("missingApartmentArea", { Z: z }, { operation: "area_apartment", answer_type: "area", missing: [`apartment ${z}`] });
    if (round % 3 === 1) add("missingApartmentSymbols", { S: S(k2), Z: z }, symbolCount([k2], { missing: [`apartment ${z}`] }));
    if (round % 3 === 2) add("missingApartmentRooms", { Z: z }, { missing: [`apartment ${z}`] });
    if (round % 3 === 0) {
      const gone = absentNumber();
      add("showMissingRoom", { X: gone }, { locate: true, missing: [`room ${gone}`] }, false);
    }

    // Everyday words for the plan's labels; a kind of room the plan has no label for is missing, or the generic label stands in.
    for (const concept of some(CONCEPTS, 2)) {
      const { template, lang } = wording(round % 2 === 0 ? HOW_MANY_ROOMS : AREA_OF_ROOMS, split);
      const word = pick(concept.words[lang] ?? concept.words.en);
      const matching = labels.map(([name]) => name).filter((name) => concept.labels.test(name));
      const generic = concept.generic ? labels.map(([name]) => name).filter((name) => GENERIC_ROOM.test(name)) : [];
      const measured = round % 2 === 0 ? {} : { measure: "area", answer_type: "area" };
      const call = matching.length > 0 ? { labels: matching } : generic.length > 0 ? { labels: generic, broader_label: true } : { missing: [word] };
      items.push({ ...base, question: fill(template, { C: word }), call: takeoff({ ...call, ...measured }), lang, family: "constructed", template: "everyday", rewordable: false });
    }
    if (round % 2 === 0) {
      const word = pick(split === "test" ? ABSENT_ROOMS_TEST : ABSENT_ROOMS);
      items.push({ ...base, question: fill(pick(HOW_MANY_ROOMS[split]), { C: word }), call: takeoff({ missing: [word] }), lang: "en", family: "constructed", template: "absent-room", rewordable: false });
    }
    const [none, type] = pick(DXF_NONE[split].filter(([text]) => (u1 || !text.includes("{U}")) && (n1 || !text.includes("{N}"))));
    const noneLang = languageOf(none);
    items.push({ ...base, question: fill(none, { U: u1 ?? "", N: n1 ?? "" }), call: takeoff({ operation: "none", answer_type: type }), lang: noneLang, family: "constructed", template: "none", rewordable: noneLang === "en" });
  }
  return items.filter((item) => {
    try {
      runTakeoff(item.call, plan);
      return true;
    } catch {
      return false;
    }
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Raster drawings: the menu is the same for every drawing
// ---------------------------------------------------------------------------------------------------------------

const raster = (over: Call): Call => ({ operation: "count_known", targets: [], whole_drawing: true, items: "", locate: false, answer_type: "count", ...over });
const rasterBase = { type: "raster" as const, drawing: "raster", request: (question: string) => rasterRequest(question, RASTER_KINDS, rasterHint(question)) };

const KIND_WORDS: Record<string, Record<string, string[]>> = {
  window: { en: ["windows"], fi: ["ikkunaa"], de: ["Fenster"], fr: ["fenêtres"], sv: ["fönster"], one: ["window"] },
  door: { en: ["doors"], fi: ["ovea"], de: ["Türen"], fr: ["portes"], sv: ["dörrar"], one: ["door"] },
  toilet: { en: ["toilets", "toilet bowls", "WCs", "WC seats"], fi: ["WC-istuinta"], de: ["Toiletten"], fr: ["toilettes"], sv: ["toaletter"], one: ["toilet"] },
  sink: { en: ["sinks", "wash basins", "sinks and basins"], fi: ["pesuallasta"], de: ["Waschbecken"], fr: ["lavabos"], sv: ["handfat"], one: ["sink"] },
  shower: { en: ["showers"], fi: ["suihkua"], de: ["Duschen"], fr: ["douches"], sv: ["duschar"], one: ["shower"] },
  bathtub: { en: ["bathtubs", "bath tubs"], fi: ["kylpyammetta"], de: ["Badewannen"], fr: ["baignoires"], sv: ["badkar"], one: ["bathtub"] },
  sauna: { en: ["saunas"], fi: ["saunaa"], de: ["Saunen"], fr: ["saunas"], sv: ["bastur"], one: ["sauna"] },
  kitchen: { en: ["kitchens"], fi: ["keittiötä"], de: ["Küchen"], fr: ["cuisines"], sv: ["kök"], one: ["kitchen"] },
  bedroom: { en: ["bedrooms"], fi: ["makuuhuonetta"], de: ["Schlafzimmer"], fr: ["chambres"], sv: ["sovrum"], one: ["bedroom"] },
  wc_room: { en: ["separate WC rooms", "toilet rooms"], fi: ["erillistä WC-tilaa"], de: ["separate WC-Räume"], fr: ["WC séparés"], sv: ["separata toalettrum"], one: ["WC room"] },
  bathroom: { en: ["bathrooms", "washrooms"], fi: ["kylpyhuonetta"], de: ["Badezimmer"], fr: ["salles de bain"], sv: ["badrum"], one: ["bathroom"] },
  balcony: { en: ["balconies"], fi: ["parveketta"], de: ["Balkone"], fr: ["balcons"], sv: ["balkonger"], one: ["balcony"] },
  floor: { en: ["storeys", "floors", "levels"], fi: ["kerrosta"], de: ["Geschosse"], fr: ["étages"], sv: ["våningar"], one: ["storey"] },
};
const RASTER_SYMBOLS = ["window", "door", "toilet", "sink", "shower", "bathtub"];
const OTHER_ITEMS: Record<Split, [string, string][]> = {
  train: [
    ["staircase", "stairs"], ["wardrobe", "wardrobes"], ["fireplace", "fireplaces"], ["closet", "closets"], ["column", "columns"], ["radiator", "radiators"], ["bed", "beds"], ["sofa", "sofas"],
    ["table", "tables"], ["chair", "chairs"], ["stove", "stoves"], ["refrigerator", "refrigerators"], ["washing machine", "washing machines"], ["parking space", "parking spaces"],
    ["elevator", "elevators"], ["garage", "garages"], ["living room", "living rooms"], ["dining room", "dining rooms"], ["hallway", "hallways"], ["storage room", "storage rooms"],
    ["terrace", "terraces"], ["chimney", "chimneys"], ["skylight", "skylights"], ["dishwasher", "dishwashers"], ["desk", "desks"], ["bookshelf", "bookshelves"],
    ["walk-in closet", "walk-in closets"], ["utility room", "utility rooms"], ["office", "offices"], ["carport", "carports"], ["kitchen island", "kitchen islands"], ["oven", "ovens"], ["patio", "patios"],
  ],
  test: [["bunk bed", "bunk beds"], ["piano", "pianos"], ["armchair", "armchairs"], ["towel rail", "towel rails"], ["laundry room", "laundry rooms"], ["porch", "porches"], ["water heater", "water heaters"], ["dressing room", "dressing rooms"]],
};
const PLACES: Record<Split, string[]> = {
  train: ["in the kitchen", "in the living room", "in the master bedroom", "in the bathroom", "in the hallway", "on the upper floor", "on the ground floor", "in the sauna section", "in the left apartment", "in the largest bedroom", "on the north wall", "in apartment B", "in the garage", "in enlarged plan 6A", "upstairs", "in the entrance hall"],
  test: ["in the dining area", "in the smaller bedroom", "on the top storey", "in the utility room", "along the south facade"],
};
const RASTER = {
  one: {
    train: ["How many {K} are there?", "How many {K} does this plan show?", "Number of {K} on the drawing", "Count the {K}.", "How many {K} in this flat?", "{K} count", "how many {K}", "What's the number of {K} in this floor plan?"],
    test: ["Tell me the quantity of {K} on this drawing.", "What is the total of {K} shown here?", "In this plan, how many {K} can be seen?"],
    other: {
      fi: ["Kuinka monta {K} tässä pohjapiirustuksessa on?", "Montako {K} kuvassa on?"], de: ["Wie viele {K} gibt es auf diesem Grundriss?"],
      fr: ["Combien de {K} y a-t-il sur ce plan ?"], sv: ["Hur många {K} finns det på ritningen?"],
    },
  },
  two: {
    train: ["How many {K} and {K2} are there?", "How many {K} and {K2} does the plan show in total?", "Total number of {K} and {K2}", "Count the {K} and the {K2}."],
    test: ["What is the combined number of {K} and {K2} on this drawing?"],
    other: { fi: ["Kuinka monta {K} ja {K2} pohjapiirustuksessa on yhteensä?"], de: ["Wie viele {K} und {K2} gibt es insgesamt?"], fr: ["Combien de {K} et de {K2} y a-t-il en tout ?"] },
  },
  three: { train: ["Count the {K}, {K2} and {K3}.", "How many {K}, {K2} and {K3} are there altogether?"], test: ["Give me the total of {K}, {K2} and {K3}."] },
  part: {
    train: ["How many {K} are there {AT}?", "How many {K} does the plan show {AT}?", "{K} {AT}?", "Count the {K} {AT}."],
    test: ["What is the number of {K} {AT}?", "Tell me how many {K} are located {AT}."],
  },
  show: {
    train: ["Show me the {K}.", "Where are the {K}?", "Mark all {K}.", "Highlight the {K} on the plan.", "Find the {K}.", "show {K}"],
    test: ["Can you point out the {K}?", "Indicate every one of the {K}."],
  },
  showOne: { train: ["Where is the {K}?", "Show me the {K}.", "Find the {K}."], test: ["Indicate where the {K} is."] },
} satisfies Record<string, Wording>;
const RASTER_PART_OTHER: [string, string][] = [
  ["Kuinka monta {K} keittiössä on?", "fi"], ["Kuinka monta {K} yläkerrassa on?", "fi"], ["Kuinka monta {K} olohuoneessa on?", "fi"],
  ["Wie viele {K} gibt es in der Küche?", "de"], ["Wie viele {K} hat das Wohnzimmer?", "de"], ["Combien de {K} y a-t-il dans la cuisine ?", "fr"],
];
const RASTER_SHOW_OTHER: [string, string, string][] = [
  ["Missä sauna on?", "sauna", "fi"], ["Näytä ikkunat.", "window", "fi"], ["Näytä ovet.", "door", "fi"], ["Missä keittiö on?", "kitchen", "fi"], ["Merkitse WC-istuimet.", "toilet", "fi"],
  ["Näytä makuuhuoneet.", "bedroom", "fi"], ["Missä parveke on?", "balcony", "fi"], ["Näytä kylpyhuoneet.", "bathroom", "fi"], ["Zeig mir die Fenster.", "window", "de"],
  ["Wo sind die Türen?", "door", "de"], ["Wo ist die Küche?", "kitchen", "de"], ["Markiere die Schlafzimmer.", "bedroom", "de"], ["Wo ist die Sauna?", "sauna", "de"], ["Zeig mir die Badezimmer.", "bathroom", "de"],
];
const RASTER_READ: Record<Split, [string, string][]> = {
  train: [
    ["What is the area of the living room?", "area"], ["What is the total floor area of this apartment?", "area"], ["How big is the kitchen in m²?", "area"], ["What is the scale of the drawing?", "text"],
    ["How wide is the hallway?", "length"], ["What is the length of the longest wall?", "length"], ["What does the title block say?", "text"], ["Which room is the largest?", "text"],
    ["What is the name of this apartment type?", "text"], ["What is written next to the entrance?", "text"], ["What are the dimensions of the bedroom?", "text"], ["What is the ceiling height?", "length"],
    ["Which rooms have a window?", "text"], ["What is the door type of door 101A?", "text"], ["What material is specified for door 204?", "text"], ["How many doors are listed in the door schedule?", "count"],
    ["What is the area of room 105 in the finish schedule?", "area"], ["How many rooms are listed in the room schedule?", "count"], ["What is the floor finish of the lobby?", "text"],
    ["What is the width of door 12?", "length"], ["Mikä on olohuoneen pinta-ala?", "area"], ["Wie gross ist die Küche in m²?", "area"], ["Quelle est la surface du séjour ?", "area"],
    ["Mikä on piirustuksen mittakaava?", "text"], ["What is the total living area stated on the drawing?", "area"], ["Which hardware group is specified for door 7?", "text"],
  ],
  test: [
    ["What is the size of the balcony in square metres?", "area"], ["What is the drawing number of this sheet?", "text"], ["How long is the corridor?", "length"], ["Which hardware set does door 3B have?", "text"],
    ["How many windows does the window schedule list?", "count"], ["Is the sauna next to the bathroom?", "text"], ["What is the living area stated on the plan?", "area"],
  ],
};

function rasterItems(split: Split, rounds: number): Item[] {
  const items: Item[] = [];
  const ids = RASTER_KINDS.map((kind) => kind.id);
  const word = (id: string, lang: string) => pick(KIND_WORDS[id][lang] ?? KIND_WORDS[id].en);
  const add = (name: keyof typeof RASTER, kindIds: string[], call: Call, extra: Record<string, string> = {}, singular = false) => {
    const { template, lang } = wording(RASTER[name], split);
    const [K, K2, K3] = kindIds.map((id) => (singular ? KIND_WORDS[id].one[0] : word(id, lang)));
    items.push({ ...rasterBase, split, question: fill(template, { K, K2, K3, ...extra }), call: raster(call), lang, family: "constructed", template: name, rewordable: lang === "en" && call.locate !== true });
  };
  for (let round = 0; round < rounds; round++) {
    for (const id of ids) {
      if (round % 3 === 0) add("one", [id], { targets: [id] });
      if (round % 4 === 1) add("show", [id], { targets: [id], locate: true });
      if (round % 6 === 2 && id !== "floor" && id !== "wc_room") add("showOne", [id], { targets: [id], locate: true }, {}, true);
    }
    for (let i = 0; i < 4; i++) {
      const [a, b, c] = some(ids.filter((id) => id !== "floor"), 3);
      add("two", [a, b], { targets: [a, b] });
      if (i === 0) add("three", [a, b, c], { targets: [a, b, c] });
      const symbol = pick(RASTER_SYMBOLS);
      add("part", [symbol], { targets: [symbol], whole_drawing: false }, { AT: pick(PLACES[split]) });
    }
    if (split === "train") {
      const [partTemplate, partLang] = pick(RASTER_PART_OTHER);
      const symbol = pick(RASTER_SYMBOLS);
      items.push({ ...rasterBase, split, question: fill(partTemplate, { K: word(symbol, partLang) }), call: raster({ targets: [symbol], whole_drawing: false }), lang: partLang, family: "constructed", template: "part", rewordable: false });
      const [show, id, showLang] = pick(RASTER_SHOW_OTHER);
      items.push({ ...rasterBase, split, question: show, call: raster({ targets: [id], locate: true }), lang: showLang, family: "constructed", template: "show", rewordable: false });
    }
    for (const [one, many] of some(OTHER_ITEMS[split], split === "train" ? 6 : 3)) {
      const { template, lang } = wording({ ...RASTER.one, other: undefined }, split);
      items.push({ ...rasterBase, split, question: fill(template, { K: many }), call: raster({ operation: "count_other", items: many }), lang, family: "constructed", template: "other", rewordable: true });
      if (round % 2 === 0) {
        const single = random() < 0.5;
        items.push({ ...rasterBase, split, question: fill(pick((single ? RASTER.showOne : RASTER.show)[split]), { K: single ? one : many }), call: raster({ operation: "count_other", items: many, locate: true }), lang: "en", family: "constructed", template: "show-other", rewordable: false });
      }
    }
    for (const [question, type] of some(RASTER_READ[split], split === "train" ? 5 : 3)) {
      const lang = languageOf(question);
      items.push({ ...rasterBase, split, question, call: raster({ operation: "read", answer_type: type }), lang, family: "constructed", template: "read", rewordable: lang === "en" });
    }
  }
  return items;
}

/** The dataset's wording about raster plans: twelve kinds in English and Finnish, and the schedule sheets. */
function rasterDataset(split: Split): Item[] {
  const seen = new Set<string>();
  const items: Item[] = [];
  for (const [path, rows] of questionsByPath()) {
    const source = path.split("/")[1];
    if (source !== "cubicasa5k" && source !== "opening_design") continue;
    for (const row of rows) {
      if (seen.has(row.question)) continue;
      seen.add(row.question);
      let call: Call | null = null;
      if (source === "cubicasa5k") {
        const target = rasterTarget(row.question);
        if (target) call = raster({ targets: target.detectorClasses.length > 1 ? target.detectorClasses : [target.id] });
      } else if (/schedule/i.test(row.question) && row.type !== "other") {
        call = raster({ operation: "read", answer_type: row.type });
      }
      if (call && (source === "cubicasa5k" || (seen.size % 4 === 0) === (split === "test"))) {
        items.push({ ...rasterBase, split, question: row.question, call, lang: languageOf(row.question), family: "dataset", template: source, rewordable: true });
      }
    }
  }
  return items;
}

// ---------------------------------------------------------------------------------------------------------------
// IFC models
// ---------------------------------------------------------------------------------------------------------------

const ifc = (over: Call): Call => ({
  operation: "rooms", elements: [], storey: "", rooms: [], pick: "all", measure: "count", quantity: "none", missing: [], reason: "", locate: false, answer_type: "count", ...over,
});
const ELEMENT_WORDS: Record<string, Record<string, string>> = {
  door: { de: "Türen", fi: "ovea", fr: "portes", sv: "dörrar" }, window: { de: "Fenster", fi: "ikkunaa", fr: "fenêtres", sv: "fönster" },
  wall: { de: "Wände", fi: "seinää", fr: "murs", sv: "väggar" }, column: { de: "Stützen", fi: "pilaria", fr: "poteaux", sv: "pelare" },
  stair: { de: "Treppen", fi: "porrasta", fr: "escaliers", sv: "trappor" }, beam: { de: "Träger", fi: "palkkia", fr: "poutres", sv: "balkar" },
  slab: { de: "Decken", fi: "laattaa", fr: "dalles", sv: "bjälklag" },
};
const IFC = {
  countStorey: {
    train: ["How many {E} are on '{ST}'?", "Number of {E} on {ST}", "How many {E} does {ST} have?", "{E} on {ST}?", "Count the {E} on '{ST}'.", "how many {E} on {ST}"],
    test: ["Tell me how many {E} the storey {ST} contains.", "What is the quantity of {E} located on '{ST}'?"],
    other: {
      de: ["Wie viele {E} gibt es im Geschoss '{ST}'?"], fi: ["Kuinka monta {E} kerroksessa '{ST}' on?"], fr: ["Combien de {E} y a-t-il à l'étage '{ST}' ?"], sv: ["Hur många {E} finns på plan '{ST}'?"],
    },
  },
  count2Storey: {
    train: ["How many {E} and {E2} are on '{ST}'?", "How many {E} and {E2} are shown on the floor plan of '{ST}'?", "Count the {E} and {E2} on {ST}."],
    test: ["What is the number of {E} and {E2} located on '{ST}'?"],
    other: { de: ["Wie viele {E} und {E2} gibt es im Geschoss '{ST}'?"] },
  },
  count3Storey: { train: ["Count the {E}, {E2} and {E3} on '{ST}'.", "How many {E}, {E2} and {E3} are there on {ST} in total?"], test: ["Give me the total of {E}, {E2} and {E3} on '{ST}'."] },
  countModel: {
    train: ["How many {E} are there in the whole building?", "Total number of {E} in the model", "How many {E} in the entire building?", "How many {E} does the building have?", "{E} in the whole model?"],
    test: ["What is the overall number of {E} in this model?"],
    other: { de: ["Wie viele {E} gibt es im ganzen Gebäude?"], fi: ["Kuinka monta {E} koko rakennuksessa on?"], fr: ["Combien de {E} y a-t-il dans tout le bâtiment ?"], sv: ["Hur många {E} finns det i hela byggnaden?"] },
  },
  count2Model: {
    train: ["How many {E} and {E2} does the model contain?", "Count all {E} and {E2} in the building.", "How many {E} and {E2} are there in the whole building?"],
    test: ["Across the whole building, how many {E} and {E2} are there?"],
  },
  roomsStorey: {
    train: ["How many rooms are on '{ST}'?", "Number of rooms on {ST}", "How many spaces does '{ST}' have?", "rooms on {ST}?"],
    test: ["What is the room count of '{ST}'?"],
    other: { de: ["Wie viele Räume gibt es im Geschoss '{ST}'?"], fi: ["Kuinka monta huonetta kerroksessa '{ST}' on?"] },
  },
  roomsModel: { train: ["How many rooms does the building have?", "How many spaces are in the model?", "Number of rooms in the whole building"], test: ["What is the total number of rooms in this building?"] },
  roomsAreaStorey: { train: ["How many square metres of rooms are on '{ST}'?", "Total room area on {ST} in m²", "What is the combined area of all rooms on '{ST}'?"], test: ["What do all rooms of '{ST}' add up to in m²?"] },
  whichStorey: {
    train: ["Which is the {P} room on '{ST}'?", "What is the {P} room on {ST}?", "{P} room on '{ST}'?"],
    test: ["Name the {P} space of '{ST}'."],
    other: { de: ["Welches ist der {Pde} Raum im Geschoss '{ST}'?"] },
  },
  whichModel: { train: ["Which room is the {P} in the building?", "What is the {P} room of the whole model?"], test: ["Which space in the whole model is the {P}?"] },
  extremeAreaStorey: { train: ["What is the area of the {P} room on '{ST}'?", "How big is the {P} room on {ST}, in m²?"], test: ["How many m² does the {P} room on '{ST}' have?"] },
  extremeAreaModel: { train: ["How big is the {P} room in the building, in m²?", "Area of the {P} room in the model?"], test: ["What does the {P} room of the building measure in m²?"] },
  averageStorey: { train: ["What is the average room area on '{ST}'?", "Average room size on {ST} in m²"], test: ["How large is a room on '{ST}' on average?"] },
  averageModel: { train: ["Average room size in the building in m²", "What is the average area of a room in this model?"], test: ["Mean room area across the whole building?"] },
  listStorey: {
    train: ["Which rooms are on '{ST}'?", "List the rooms on '{ST}'.", "What spaces does '{ST}' have?"],
    test: ["Name every room located on '{ST}'."],
    other: { de: ["Welche Räume gibt es im Geschoss '{ST}'?"] },
  },
  namedCount: { train: ["How many '{RN}' rooms are there in the building?", "How many rooms are named '{RN}'?", "Number of '{RN}' rooms in the model"], test: ["What is the number of rooms called '{RN}' in the model?"] },
  namedArea: { train: ["What is the total area of all '{RN}' rooms?", "How many square metres do the '{RN}' rooms have in total?", "What is the area of '{RN}'?"], test: ["How much floor area do the rooms named '{RN}' have altogether?"] },
  namedCountStorey: { train: ["How many '{RN}' are on '{ST}'?", "How many rooms named '{RN}' does {ST} have?"], test: ["What is the number of '{RN}' rooms on '{ST}'?"] },
  named2Area: { train: ["What is the combined area of '{RN}' and '{RN2}'?", "Total area of the rooms '{RN}' and '{RN2}' in m²"], test: ["What do '{RN}' and '{RN2}' measure together in m²?"] },
  wallLength: { train: ["What is the total wall length on '{ST}'?", "How long are all the walls on '{ST}' together, in metres?", "wall length on {ST}"], test: ["How many metres of wall are there on '{ST}'?"] },
  wallVolume: { train: ["Total wall volume on '{ST}' in m³", "What is the volume of the walls on '{ST}'?"], test: ["How many cubic metres of wall does '{ST}' have?"] },
  wallSideArea: { train: ["What is the total side area of the walls on '{ST}'?", "Net side area of all walls on {ST} in m²"], test: ["How much wall surface, counted on one side, is there on '{ST}' in m²?"] },
  slabVolume: { train: ["Slab volume on '{ST}'?", "What is the volume of all floor slabs on '{ST}' in m³?"], test: ["How many m³ of slab are on '{ST}'?"] },
  missingCount: { train: ["How many {E} are on '{XS}'?", "Number of {E} on {XS}"], test: ["What is the number of {E} on '{XS}'?"] },
  missingRooms: { train: ["How many rooms are on '{XS}'?", "Which rooms are on '{XS}'?"], test: ["What is the room count of '{XS}'?"] },
  missingWalls: { train: ["What is the total wall length on '{XS}'?"], test: ["How many metres of wall are there on '{XS}'?"] },
  showStorey: {
    train: ["Show me the {E} on '{ST}'.", "Highlight all {E} on '{ST}'.", "Where are the {E} on {ST}?", "Mark the {E} on '{ST}'."],
    test: ["Can you point out the {E} of '{ST}'?"],
    other: { de: ["Zeig mir die {E} im Geschoss '{ST}'."] },
  },
  showModel: { train: ["Where are the {E}?", "Show me all {E} in the building.", "Highlight the {E}."], test: ["Indicate every one of the {E} in the building."] },
  showRooms: { train: ["Show the rooms on '{ST}'.", "Where are the rooms of {ST}?", "Mark all rooms on '{ST}'."], test: ["Point out the spaces of '{ST}'."] },
  showNamed: { train: ["Where is '{RN}'?", "Find the room '{RN}'.", "Show me '{RN}'.", "Highlight the '{RN}' rooms."], test: ["Locate the room called '{RN}'."] },
} satisfies Record<string, Wording>;
const ABSENT_STOREYS = ["Level 99", "Basement 3", "12th floor", "Mezzanine B", "Storey 42", "Penthouse level", "Sublevel 7", "Etage 15", "Kerros 19", "Geschoss 23"];
const IFC_NONE: Record<Split, string[]> = {
  train: ["What is the weather like today?", "Who won the football match yesterday?", "Translate 'door' into French.", "What is 17 times 23?", "Write me a poem about concrete.", "What time is it?", "Recommend a good restaurant nearby.", "Wie wird das Wetter morgen?", "Kerro vitsi."],
  test: ["How do I bake bread?", "What is the capital of Finland?", "Tell me a joke."],
};
const IFC_FACTS: Record<Split, [string, string][]> = {
  train: [
    ["What materials are the walls made of?", "text"], ["How thick are the exterior walls?", "length"], ["Which software was the model created with?", "text"], ["What is the fire rating of the doors?", "text"],
    ["What are the heights of the building levels?", "text"], ["What types of windows are used?", "text"], ["How many light fixtures are there?", "count"], ["How many air terminals does the building have?", "count"],
    ["What is the building's address?", "text"], ["What is the width of the widest door?", "length"], ["What is the U-value of the external walls?", "text"], ["Describe the building.", "text"],
    ["What is the roof made of?", "text"], ["How many door types are there?", "count"], ["What is the footprint area of the building?", "area"], ["What is the total volume of concrete in the slabs?", "volume"],
    ["Which walls are load-bearing?", "text"], ["Aus welchem Material bestehen die Wände?", "text"], ["Mistä materiaalista seinät on tehty?", "text"], ["Which IFC schema does the file use?", "text"],
  ],
  test: [
    ["Which materials are used in the floor slabs?", "text"], ["What is the thickness of the interior walls?", "length"], ["Who is the author of this model?", "text"], ["How many sprinklers are installed?", "count"],
    ["What kinds of doors does the building have?", "text"], ["What is the gross volume of the building?", "volume"],
  ],
};

function ifcCallOfIntent(question: string, type: QuestionType, menu: IfcMenu): Call | null {
  const intent = parseIfcQuestion(question, type);
  if (!intent) return null;
  const storeys = menu.storeys.map((storey) => storey.name);
  const onStorey = (name: string | null) => (name !== null && storeys.includes(name) ? name : null);
  switch (intent.kind) {
    case "area_room": {
      if (intent.storey !== null && !onStorey(intent.storey)) return null;
      // "All rooms on 'Attic'" in a language the parser has no words for: the one quoted name is the storey.
      if (intent.storey === null && onStorey(intent.room) && !menu.roomNames.some(([name]) => name === intent.room)) return ifc({ storey: intent.room, measure: "area", answer_type: "area" });
      return ifc({ rooms: [intent.room], storey: intent.storey ?? "", measure: "area", answer_type: "area" });
    }
    case "area_storey_rooms": return onStorey(intent.storey) ? ifc({ storey: intent.storey, measure: "area", answer_type: "area" }) : null;
    case "wall_length": case "wall_side_area": case "wall_volume": case "slab_volume":
      return onStorey(intent.storey) ? ifc({ operation: "storey_total", storey: intent.storey, quantity: intent.kind, answer_type: intent.kind === "wall_length" ? "length" : intent.kind === "wall_side_area" ? "area" : "volume" }) : null;
    case "count": {
      const storey = intent.scope === "model" ? "" : onStorey(intent.name) ?? (intent.scope === "storey" ? null : "");
      if (storey === null) return null;
      if (intent.element === "space") return ifc({ storey });
      return menu.elements.some(([kind]) => kind === intent.element) ? ifc({ operation: "count_elements", elements: [intent.element], storey }) : null;
    }
    case "text": return null;
  }
}

const asIfcCall = (call: Call): IfcCall =>
  (call.operation === "count_elements" ? { operation: "count_elements", elements: call.elements, storey: call.storey || null }
  : call.operation === "storey_total" ? { operation: "storey_total", quantity: call.quantity, storey: call.storey || null }
  : { operation: "rooms", rooms: call.rooms, storey: call.storey || null, pick: call.pick, measure: call.measure }) as IfcCall;

async function ifcItems(ifcPath: string, rows: QuestionRow[], split: Split, datasetRows: number, rounds: number): Promise<Item[]> {
  const menu = await ifcMenu(ifcPath);
  const base = { type: "ifc" as const, drawing: basename(ifcPath), split, request: (question: string) => ifcRequest(question, menu, ifcHint(question)) };
  const items: Item[] = [];
  const storeys = menu.storeys.slice(0, 40).map((storey) => storey.name);

  // The dataset's wording, a few rows of each template, kept when the call computes the expected answer.
  const byTemplate = new Map<string, QuestionRow[]>();
  for (const row of rows) {
    const key = `${row.type}:${row.question.replace(/'[^']*'|«[^»]*»|„[^“”]*[“”]|"[^"]*"/g, "_").slice(0, 60)}`;
    byTemplate.set(key, [...(byTemplate.get(key) ?? []), row]);
  }
  const perTemplate = Math.max(1, Math.ceil(datasetRows / Math.max(1, byTemplate.size)));
  for (const [, group] of [...byTemplate].sort()) {
    for (const row of some(group, perTemplate)) {
      const call = ifcCallOfIntent(row.question, row.type as QuestionType, menu);
      if (!call) continue;
      const answer = await solveIfcCall(ifcPath, asIfcCall(call), row.type as QuestionType, row.question).catch(() => null);
      if (!answer || isCorrect(row.type, row.answer, answer.value) !== true) continue;
      items.push({ ...base, question: row.question, call, lang: languageOf(row.question), family: "dataset", template: String(call.operation), rewordable: true, anchors: [call.storey as string, ...(call.rooms as string[])].filter(Boolean) });
    }
  }

  const elements = menu.elements.filter(([kind]) => kind !== "space");
  if (elements.length === 0) return items;
  const add = (name: keyof typeof IFC, slots: Record<string, string | ((lang: string) => string)>, call: Call, rewordable = true) => {
    let { template, lang } = wording(IFC[name], split);
    const translated = (kind: string) => ELEMENT_WORDS[kind]?.[lang];
    const used = (call.elements as string[] | undefined) ?? [];
    if (lang !== "en" && used.some((kind) => !translated(kind))) ({ template, lang } = { template: pick(IFC[name].train), lang: "en" });
    const filled = fill(template, Object.fromEntries(Object.entries(slots).map(([key, value]) => [key, typeof value === "function" ? value(lang) : value])));
    items.push({ ...base, question: filled, call: ifc(call), lang, family: "constructed", template: name, rewordable: rewordable && lang === "en", anchors: [call.storey as string, ...((call.rooms as string[]) ?? [])].filter(Boolean) });
  };
  const E = ([kind, plural]: [string, string, number]) => (lang: string) => ELEMENT_WORDS[kind]?.[lang] ?? plural;
  const names = menu.roomNames.slice(0, 40).map(([name]) => name);
  for (let round = 0; round < rounds; round++) {
    const [e1, e2, e3] = some(elements, 3);
    const st = storeys.length > 0 ? pick(storeys) : null;
    const [rn, rn2] = some(names, 2);
    const extreme = pick(EXTREMES);
    const P = { P: pick(extreme.P), Pde: extreme.Pde };
    const counted = (chosen: [string, string, number][], over: Call = {}): Call => ({ operation: "count_elements", elements: chosen.map(([kind]) => kind), ...over });

    add("countModel", { E: E(e1) }, counted([e1]));
    if (e2) add("count2Model", { E: E(e1), E2: E(e2) }, counted([e1, e2]));
    if (round % 2 === 0) add("showModel", { E: E(e1) }, counted([e1], { locate: true }), false);
    if (round % 3 === 0) add("roomsModel", {}, {});
    if (round % 3 === 1) add("whichModel", P, { pick: extreme.pick, measure: "list", answer_type: "text" });
    if (round % 3 === 2) add("extremeAreaModel", P, { pick: extreme.pick, measure: "area", answer_type: "area" });
    if (round % 4 === 0) add("averageModel", {}, { measure: "average", answer_type: "area" });
    if (st) {
      add("countStorey", { E: E(e1), ST: st }, counted([e1], { storey: st }));
      if (e2) add("count2Storey", { E: E(e1), E2: E(e2), ST: st }, counted([e1, e2], { storey: st }));
      if (e3 && round % 3 === 0) add("count3Storey", { E: E(e1), E2: E(e2), E3: E(e3), ST: st }, counted([e1, e2, e3], { storey: st }));
      if (round % 2 === 1) add("showStorey", { E: E(e2 ?? e1), ST: st }, counted([e2 ?? e1], { storey: st, locate: true }), false);
      add(round % 2 === 0 ? "roomsStorey" : "roomsAreaStorey", { ST: st }, round % 2 === 0 ? { storey: st } : { storey: st, measure: "area", answer_type: "area" });
      add(round % 2 === 0 ? "whichStorey" : "extremeAreaStorey", { ...P, ST: st }, round % 2 === 0 ? { storey: st, pick: extreme.pick, measure: "list", answer_type: "text" } : { storey: st, pick: extreme.pick, measure: "area", answer_type: "area" });
      if (round % 3 === 0) add("averageStorey", { ST: st }, { storey: st, measure: "average", answer_type: "area" });
      if (round % 3 === 1) add("listStorey", { ST: st }, { storey: st, measure: "list", answer_type: "text" });
      if (round % 3 === 2) add("showRooms", { ST: st }, { storey: st, locate: true }, false);
      const total = pick(["wallLength", "wallVolume", "wallSideArea", "slabVolume"] as const);
      const quantity = { wallLength: "wall_length", wallVolume: "wall_volume", wallSideArea: "wall_side_area", slabVolume: "slab_volume" }[total];
      add(total, { ST: st }, { operation: "storey_total", storey: st, quantity, answer_type: total === "wallLength" ? "length" : total === "wallSideArea" ? "area" : "volume" });
    }
    if (rn) {
      add(round % 2 === 0 ? "namedCount" : "namedArea", { RN: rn }, round % 2 === 0 ? { rooms: [rn] } : { rooms: [rn], measure: "area", answer_type: "area" });
      if (st && round % 3 === 0) add("namedCountStorey", { RN: rn, ST: st }, { rooms: [rn], storey: st });
      if (rn2 && round % 3 === 1) add("named2Area", { RN: rn, RN2: rn2 }, { rooms: [rn, rn2], measure: "area", answer_type: "area" });
      if (round % 3 === 2) add("showNamed", { RN: rn }, { rooms: [rn], locate: true }, false);
    }
    const xs = pick(ABSENT_STOREYS.filter((name) => !storeys.includes(name)));
    if (round % 3 === 0) add("missingCount", { E: E(e1), XS: xs }, counted([e1], { missing: [xs] }), false);
    if (round % 3 === 1) add("missingRooms", { XS: xs }, { missing: [xs] }, false);
    if (round % 6 === 2) add("missingWalls", { XS: xs }, { operation: "storey_total", quantity: "wall_length", answer_type: "length", missing: [xs] }, false);
    if (round % 3 === 0) {
      const none = pick(IFC_NONE[split]);
      items.push({ ...base, question: none, call: ifc({ operation: "none", answer_type: "text" }), lang: languageOf(none), family: "constructed", template: "none", rewordable: false });
    }
    const [fact, type] = pick(IFC_FACTS[split]);
    const factLang = languageOf(fact);
    items.push({ ...base, question: fact, call: ifc({ operation: "model_facts", answer_type: type }), lang: factLang, family: "constructed", template: "facts", rewordable: factLang === "en" });
  }
  // The missing-rooms list question names rooms, not a count.
  for (const item of items) if (item.template === "missingRooms" && /^Which/.test(item.question)) item.call = ifc({ ...item.call, measure: "list", answer_type: "text" });
  return items;
}

/** The benchmark's free questions about a model: facts, unless they are about rooms, storeys or counts the other operations cover. */
function benchItems(ifcPath: string, menu: IfcMenu, rows: QuestionRow[], split: Split, limit: number): Item[] {
  const base = { type: "ifc" as const, drawing: basename(ifcPath), split, request: (question: string) => ifcRequest(question, menu, ifcHint(question)) };
  const free = rows.filter((row) => !/\b(rooms?|spaces?|level|floor|storey|units?|largest|smallest|how many)\b/i.test(row.question));
  return some(free, limit).map((row) => ({
    ...base, question: row.question, call: ifc({ operation: "model_facts", answer_type: inferType(row.question) }), lang: "en", family: "dataset" as const, template: "bench", rewordable: true,
  }));
}

// ---------------------------------------------------------------------------------------------------------------
// Drawings, rewordings, files
// ---------------------------------------------------------------------------------------------------------------

/** The plans eval-paraphrase samples (evenly spaced), kept out of training so that its score is on unseen plans. */
function evaluationPlans(paths: string[]): Set<string> {
  const held = new Set<string>();
  for (const count of [10, 12, 20, 24, 30]) for (let i = 0; i < count; i++) held.add(paths[Math.floor((i * paths.length) / count)]);
  return held;
}

/** True when a rewording still names the room number, apartment letter, storey or room it is about. */
function keeps(question: string, anchor: string): boolean {
  if (anchor.length <= 2) return new RegExp(`(?<![\p{L}\p{N}])${anchor}(?![\p{L}\p{N}])`, "u").test(question);
  return question.toLowerCase().includes(anchor.toLowerCase());
}

const scale = Number(option("scale", "1"));
const swiss = [...questionsByPath().keys()].filter((path) => path.split("/")[1] === "swiss_dwellings" && isAvailable(path)).sort();
const evaluated = evaluationPlans(swiss);
const free = swiss.filter((path) => !evaluated.has(path));
const testPlans = free.filter((_, i) => i % 25 === 7);
const trainPlans = free.filter((_, i) => i % 3 === 0 && i % 25 !== 7).slice(0, Math.round(320 * scale));

const items: Item[] = [];
for (const path of trainPlans) items.push(...(await dxfItems(path, "train", 2)));
for (const path of testPlans) {
  const all = await dxfItems(path, "test", 1);
  items.push(...some(all.filter((item) => item.family === "dataset"), 3), ...some(all.filter((item) => item.family === "constructed"), 5));
}
console.log(`dxf: ${trainPlans.length} training plans, ${testPlans.length} test plans, ${items.length} items`);

items.push(...rasterDataset("train"), ...rasterItems("train", Math.round(220 * scale)));
items.push(...rasterDataset("test").filter((item) => item.template !== "cubicasa5k" || random() < 0.5), ...some(rasterItems("test", 8), 110));
console.log(`raster: ${items.filter((item) => item.type === "raster").length} items`);

const modelsDir = join(datasetRoot(), "data", "ifc_models");
const models = readdirSync(modelsDir).filter((name) => name.endsWith(".ifc")).sort();
const testModels = new Set(models.filter((_, i) => i % 7 === 3));
const rowsOfModel = new Map<string, QuestionRow[]>();
for (const [path, rows] of questionsByPath()) {
  if (path.split("/")[1] !== "ifc_models") continue;
  const model = `${basename(path, extname(path)).split("_plan-")[0]}.ifc`;
  rowsOfModel.set(model, [...(rowsOfModel.get(model) ?? []), ...rows]);
}
for (const model of models) {
  const split: Split = testModels.has(model) ? "test" : "train";
  try {
    const made = await ifcItems(join(modelsDir, model), rowsOfModel.get(model) ?? [], split, split === "train" ? 90 : 60, split === "train" ? Math.round(34 * scale) : 4);
    items.push(...(split === "train" ? made : [...some(made.filter((item) => item.family === "dataset"), 20), ...some(made.filter((item) => item.family === "constructed"), 28)]));
  } catch (error) {
    console.log(`  skipped ${model}: ${error instanceof Error ? error.message.slice(0, 100) : error}`);
  }
}
const benchDir = join(datasetRoot(), "data", "ifc_bench");
const benches = readdirSync(benchDir).filter((name) => name.endsWith(".ifc")).sort();
for (const [i, model] of benches.entries()) {
  const split: Split = i % 8 === 5 ? "test" : "train";
  try {
    const menu = await ifcMenu(join(benchDir, model));
    items.push(...benchItems(join(benchDir, model), menu, questionsByPath().get(`data/ifc_bench/${model}`) ?? [], split, split === "train" ? 30 : 8));
    if (split === "train") items.push(...(await ifcItems(join(benchDir, model), [], "train", 0, Math.round(12 * scale))));
  } catch (error) {
    console.log(`  skipped ${model}: ${error instanceof Error ? error.message.slice(0, 100) : error}`);
  }
}
console.log(`ifc: ${models.length - testModels.size}+${benches.length} training models, ${testModels.size} test models, ${items.filter((item) => item.type === "ifc").length} items`);

// Rewordings: the training styles on training questions, the held-out styles on test questions.
let rewordCalls = 0;
if (!args.includes("--no-reword")) {
  const planner = createPlanner();
  if (!planner) throw new Error("rewording needs a hosted model: set PLANNER_MODEL");
  const counting = { id: planner.id, ask: async (request: VisionRequest) => { const result = await planner.ask(request); if (!result.cached) rewordCalls++; return result; } };
  const quota: Record<string, number> = { "train:dxf": 800, "train:raster": 400, "train:ifc": 700, "test:dxf": 45, "test:raster": 35, "test:ifc": 40 };
  for (const split of ["train", "test"] as const) {
    const sources: Item[] = [];
    for (const type of ["dxf", "raster", "ifc"] as const) {
      const candidates = items.filter((item) => item.split === split && item.type === type && item.rewordable);
      // The few dataset templates about raster plans are what users reword most, so each is reworded several times.
      const repeated = type === "raster" ? candidates.filter((item) => item.family === "dataset" && item.template === "cubicasa5k") : [];
      const repeats = split === "train" ? 5 : 1;
      const rest = candidates.filter((item) => !repeated.includes(item));
      sources.push(...Array.from({ length: repeats }, () => repeated).flat(), ...some(rest, Math.max(0, Math.round(quota[`${split}:${type}`] * (split === "train" ? scale : 1)) - repeated.length * repeats)));
    }
    const order = some(sources, sources.length);
    const reworded = await rewordInStyles(order.map((item) => ({ question: item.question, countable: countable(item.call) })), STYLE_SETS[split === "train" ? "train" : "heldout"], counting, 6, Number(option("concurrency", "12")));
    let kept = 0;
    for (const rewording of reworded) {
      const source = order[rewording.index];
      if (!(source.anchors ?? []).every((anchor) => keeps(rewording.question, anchor))) continue;
      kept++;
      items.push({
        ...source, question: rewording.question, call: rewording.locate ? { ...source.call, locate: true } : source.call, family: "reworded", template: rewording.style,
        lang: /language/.test(rewording.style) ? "other" : source.lang, rewordable: false,
      });
    }
    console.log(`reworded ${split}: ${order.length} questions, ${reworded.length} rewordings, ${kept} kept`);
  }
}

const seen = new Set<string>();
const files: Record<Split, string[]> = { train: [], test: [] };
const tally = new Map<string, number>();
for (const item of items) {
  const request = item.request(item.question);
  const { developer, user } = turns(request);
  const call = JSON.parse(completionJson(item.call, request.schema as Record<string, any>));
  const key = `${item.split}|${developer}|${user}`;
  if (seen.has(key)) continue;
  seen.add(key);
  // A test row carries the whole request, so that any interpreter can be scored on it (scripts/interp-eval.ts).
  const row = { developer, question: user, call, lang: item.lang, family: item.family, type: item.type, template: item.template, drawing: item.drawing, asked: item.question };
  files[item.split].push(JSON.stringify(item.split === "test" ? { ...row, request } : row));
  for (const group of [`${item.split} total`, `${item.split} type=${item.type}`, `${item.split} family=${item.family}`, `${item.split} ${item.type}/${item.family}`, `${item.split} lang=${item.lang}`, `${item.split} op=${item.type}.${call.operation}`]) {
    tally.set(group, (tally.get(group) ?? 0) + 1);
  }
}
for (const split of ["train", "test"] as const) writeFileSync(join(outDir, `${split}.jsonl`), some(files[split], files[split].length).join("\n") + "\n");
const counts = Object.fromEntries([...tally].sort());
writeFileSync(join(outDir, "counts.json"), JSON.stringify({ counts, rewordCalls }, null, 1));
console.log(JSON.stringify(counts, null, 1));
console.log(`hosted calls made for rewording: ${rewordCalls}`);
