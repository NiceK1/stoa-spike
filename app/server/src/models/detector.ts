/**
 * Object detector behind one interface: a hosted model now, our own ONNX weights later.
 * Boxes are in pixels of the original image, top-left origin.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { cachedJson } from "../cache.js";
import { REPO_ROOT, cacheDir } from "../config.js";

export interface Detection {
  cls: string;
  score: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Detector {
  readonly id: string;
  /** Lowest score worth counting, per class. Classes not listed here are not offered. */
  readonly thresholds: Record<string, number>;
  detect(imagePath: string): Promise<Detection[]>;
  /** Name of the model that counts this class, when several models sit behind one detector. */
  nameFor?(cls: string): string;
  /** The individual models behind this detector, when there are several. */
  readonly members?: Detector[];
}

/** A model hosted on Roboflow's serverless API. */
export class RoboflowDetector implements Detector {
  readonly id: string;

  constructor(
    private readonly apiKey: string,
    private readonly modelId = "cubicasa5k-2-qpmsa/6",
    // Picked on the 30 drawings of raster-sample.txt, so they flatter this model on that sample.
    readonly thresholds: Record<string, number> = { window: 0.5, door: 0.3 },
  ) {
    this.id = `roboflow:${modelId}`;
  }

  async detect(imagePath: string): Promise<Detection[]> {
    const image = await readFile(imagePath);
    const key = createHash("sha256").update(this.id).update(image).digest("hex").slice(0, 32);
    const body: any = await cachedJson(join(cacheDir("detector"), `${key}.json`), async () => {
      const response = await fetch(`https://serverless.roboflow.com/${this.modelId}?confidence=0.1`, {
        method: "POST",
        headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/x-www-form-urlencoded" },
        body: image.toString("base64"),
      });
      if (!response.ok) throw new Error(`Roboflow ${response.status}: ${(await response.text()).slice(0, 200)}`);
      return response.json();
    });
    // The API reports centre-based boxes.
    return (body.predictions ?? []).map((p: any) => ({
      cls: String(p.class).toLowerCase(), score: p.confidence, x: p.x - p.width / 2, y: p.y - p.height / 2, w: p.width, h: p.height,
    }));
  }
}

interface OnnxSpec {
  model: string;
  input: { name: string; shape: number[] };
  output: { name: string };
  classes: string[];
  thresholds: Record<string, number>;
}

/**
 * Our own detector, exported to ONNX and run locally on the CPU. The JSON file next to the weights gives the
 * class names, the input size and the per-class thresholds (tuned on validation drawings only).
 */
export class OnnxDetector implements Detector {
  readonly id: string;
  readonly thresholds: Record<string, number>;
  private readonly spec: OnnxSpec;
  private session: Promise<import("onnxruntime-node").InferenceSession> | null = null;

  constructor(private readonly specPath: string) {
    this.spec = JSON.parse(readFileSync(specPath, "utf8"));
    this.id = `onnx:${this.spec.model.replace(/\.onnx$/, "")}`;
    this.thresholds = this.spec.thresholds;
  }

  async detect(imagePath: string): Promise<Detection[]> {
    const image = await readFile(imagePath);
    const kernel = (process.env.DETECTOR_KERNEL ?? "linear") as "linear" | "cubic" | "lanczos3" | "nearest";
    // The weights' size and date are part of the key, so re-exported weights under the same name start a fresh cache.
    const weights = statSync(join(dirname(this.specPath), this.spec.model));
    const key = createHash("sha256").update(`${this.id}:${kernel}:${weights.size}:${weights.mtimeMs}`).update(image).digest("hex").slice(0, 32);
    return cachedJson(join(cacheDir("detector"), `${key}.json`), () => this.run(image, kernel));
  }

  private async run(image: Buffer, kernel: "linear" | "cubic" | "lanczos3" | "nearest"): Promise<Detection[]> {
    const { default: sharp } = await import("sharp");
    const ort = await import("onnxruntime-node");
    const size = this.spec.input.shape[2];
    const { width = 0, height = 0 } = await sharp(image).metadata();
    // Letterbox: scale to fit, centre on a grey square, exactly as in training.
    const scale = Math.min(size / width, size / height);
    const w = Math.round(width * scale), h = Math.round(height * scale);
    const left = Math.floor((size - w) / 2), top = Math.floor((size - h) / 2);
    const { data, info } = await sharp(image)
      .flatten({ background: "#ffffff" })
      .toColourspace("srgb")
      .resize(w, h, { fit: "fill", kernel })
      .extend({ top, bottom: size - h - top, left, right: size - w - left, background: { r: 114, g: 114, b: 114 } })
      .raw()
      .toBuffer({ resolveWithObject: true });

    const plane = size * size;
    const input = new Float32Array(3 * plane);
    for (let i = 0; i < plane; i++) {
      for (let c = 0; c < 3; c++) input[c * plane + i] = data[i * info.channels + Math.min(c, info.channels - 1)] / 255;
    }
    if (!this.session) this.session = ort.InferenceSession.create(join(dirname(this.specPath), this.spec.model));
    const output = await (await this.session).run({ [this.spec.input.name]: new ort.Tensor("float32", input, [1, 3, size, size]) });
    const rows = output[this.spec.output.name].data as Float32Array;

    const detections: Detection[] = [];
    for (let i = 0; i + 5 < rows.length; i += 6) {
      const score = rows[i + 4];
      if (score <= 0) continue;
      const x1 = (rows[i] - left) / scale, y1 = (rows[i + 1] - top) / scale;
      detections.push({
        cls: this.spec.classes[Math.round(rows[i + 5])], score,
        x: x1, y: y1, w: (rows[i + 2] - left) / scale - x1, h: (rows[i + 3] - top) / scale - y1,
      });
    }
    return detections;
  }
}

/** Several detectors behind one: each class is counted by the model that measured best for it. */
export class RoutedDetector implements Detector {
  readonly id: string;
  readonly thresholds: Record<string, number> = {};

  constructor(private readonly routes: Map<string, Detector>, readonly members: Detector[]) {
    for (const [cls, detector] of routes) this.thresholds[cls] = detector.thresholds[cls];
    this.id = `onnx:${[...new Set([...routes.values()].map((d) => d.id.split(":")[1]))].join("+")}`;
  }

  nameFor(cls: string): string {
    return (this.routes.get(cls)?.id ?? this.id).split(":")[1];
  }

  async detect(imagePath: string): Promise<Detection[]> {
    const detectors = [...new Set(this.routes.values())];
    const results = await Promise.all(detectors.map((d) => d.detect(imagePath)));
    return results.flatMap((detections, i) => detections.filter((d) => this.routes.get(d.cls) === detectors[i]));
  }
}

/**
 * Which weights count which class, best first, by exact-count accuracy on the validation drawings.
 * Classes not listed go to the all-class model.
 */
const ALL_CLASS_MODEL = "floorplan-yolo11m-1280";
const PREFERRED: Record<string, string[]> = {
  window: ["floorplan-symbols-yolo11l-1280"],
  sink: ["floorplan-symbols-yolo11l-1280"],
  shower: ["floorplan-symbols-yolo11l-1280"],
  bathtub: ["floorplan-symbols-yolo11l-1280"],
};

function onnxDetector(): Detector | null {
  if (process.env.DETECTOR_SPEC) return new OnnxDetector(process.env.DETECTOR_SPEC);
  const folder = join(REPO_ROOT, "models");
  if (!existsSync(folder)) return null;
  const byName = new Map<string, OnnxDetector>();
  for (const file of readdirSync(folder).filter((f) => f.endsWith(".json"))) {
    const name = file.replace(/\.json$/, "");
    if (existsSync(join(folder, `${name}.onnx`))) byName.set(name, new OnnxDetector(join(folder, file)));
  }
  if (byName.size === 0) return null;
  if (byName.size === 1) return [...byName.values()][0];

  const routes = new Map<string, Detector>();
  const classes = new Set([...byName.values()].flatMap((d) => Object.keys(d.thresholds)));
  for (const cls of classes) {
    const order = [...(PREFERRED[cls] ?? []), ALL_CLASS_MODEL, ...byName.keys()];
    const chosen = order.map((name) => byName.get(name)).find((d) => d && cls in d.thresholds);
    if (chosen) routes.set(cls, chosen);
  }
  return new RoutedDetector(routes, [...byName.values()]);
}

/**
 * DETECTOR picks the detector: "onnx" (our weights in ../models), "roboflow" (hosted), "none".
 * By default our weights are used when present, otherwise the hosted model when its key is set.
 */
export function createDetector(): Detector | null {
  const choice = process.env.DETECTOR;
  if (choice === "none") return null;
  if (choice !== "roboflow") {
    const detector = onnxDetector();
    if (detector) return detector;
    if (choice === "onnx") throw new Error("DETECTOR=onnx, but no detector weights were found in ../models");
  }
  const key = process.env.ROBOFLOW_API_KEY;
  return key ? new RoboflowDetector(key) : null;
}
