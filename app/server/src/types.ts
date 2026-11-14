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
  /** A name a person can recognise: "CAD geometry script", a detector's model name, an external model's id. */
  name: string;
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
