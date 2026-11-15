export type QuestionType = "count" | "area" | "length" | "volume" | "text";

export type Point = [number, number];
export type Polygon = Point[];

/** A numbered marker on a raster image, in image pixels. A box when w and h are set, otherwise a point. */
export interface Mark {
  n: number;
  x: number;
  y: number;
  w?: number;
  h?: number;
  label?: string;
}

export type Evidence =
  | { kind: "svg"; svg: string; caption: string }
  | { kind: "image"; imageUrl: string; width: number; height: number; marks: Mark[]; caption: string };

/** Whose work a part of an answer is: our code, a model we trained, a model we host, or a model outside. */
export type SourceTier = "script" | "own-model" | "self-hosted-model" | "external-model";

export interface Contributor {
  /** What identifies it: a script's name ("CAD geometry script"), a detector's weights, a model's id with its provider. */
  name: string;
  /** A model as a person reads it: "Blueline detector (trained YOLO11)", "Gemini 4 Hydrogen (Google)". Scripts are read by their name. */
  label?: string;
  tier: SourceTier;
  /** Its share of the answer, said when several contributed or the name alone leaves it open. */
  did?: string;
}

export interface Understanding extends Contributor {
  /**
   * "stated-type": the caller's answer type left one route, so no reading was needed.
   * "nobody": no pipeline took the drawing. Neither names a script or model; `name` and `why` say what happened.
   */
  by: "model" | "keyword-parser" | "stated-type" | "nobody";
  /** The call the interpreter model returned, in words. */
  reading?: string;
  /** Why no interpreter model read the question. */
  why?: string;
  /** A model that reworded the question for the keyword parser. */
  helper?: Contributor;
}

export interface AnswerSource {
  understoodBy: Understanding;
  /** Everything that computed, counted, read or worded the value; empty when there is none. */
  calculatedBy: Contributor[];
  /** With no value, or with a part of it left out: why nothing was calculated and what it would have taken. */
  needed?: string;
  from: {
    /** Name of the file the value was taken from, which may be the vector twin of the file asked about. */
    file: string;
    /** What in the file was used: layers and shapes, storey and element class, sheet rows, detection boxes, the image. */
    used: string;
  };
}

export type ModeId = "blueline" | "best" | "custom";

/** What an answer with no value says when the question needed an outside model and the line-up has none. */
export interface OutsideAdvice {
  /** Why there is none, as a clause that follows "and": "Blueline only calls none". */
  none: string;
  /** What would answer the question, as a sentence without its full stop. */
  remedy?: string;
  /** The mode to offer for asking again: set only when that mode has an outside model on this server. */
  retry?: ModeId;
}

export interface Answer {
  value: number | string | null;
  unit?: string;
  /** Which path produced the value, e.g. "dxf-geometry", "ifc-geometry", "detector", "vision-model". */
  pipeline: string;
  /** What the value was derived from, in words a site engineer can check. */
  method: string;
  /** True when code computed the value from vector data; false when a model estimated it. */
  exact: boolean;
  /** The question kind the solver recognised, for per-kind accuracy tables. */
  kind?: string;
  evidence?: Evidence;
  note?: string;
  source: AnswerSource;
  /** With no value for want of an outside model: the mode that has one here, so the client can offer to ask again in it. */
  retry?: { mode: ModeId };
}

/** An answer as a pipeline returns it; the router adds who understood the question. */
export type Solved = Omit<Answer, "source"> & { source: Omit<AnswerSource, "understoodBy"> };

export interface AskInput {
  /** Absolute path of the drawing. */
  file: string;
  question: string;
  type?: QuestionType;
}

export interface QuestionRow {
  path: string;
  question: string;
  answer: number | string;
  unit: string | null;
  type: QuestionType | "other";
}
