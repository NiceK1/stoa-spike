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
}

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
