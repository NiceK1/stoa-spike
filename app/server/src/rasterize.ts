import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, rename } from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";
import { cacheDir } from "./config.js";

const LONG_SIDE = 2400;
const inFlight = new Map<string, Promise<string>>();

/** Builds `out` once, even under concurrent calls; the file appears only when it is complete. */
function once(out: string, build: (temporary: string) => Promise<unknown>): Promise<string> {
  if (existsSync(out)) return Promise.resolve(out);
  const running = inFlight.get(out);
  if (running) return running;
  const call = (async () => {
    const temporary = out.replace(/(\.\w+)$/, `.${process.pid}.${randomBytes(4).toString("hex")}$1`);
    await build(temporary);
    await rename(temporary, out);
    return out;
  })().finally(() => inFlight.delete(out));
  inFlight.set(out, call);
  return call;
}

/** Renders the first page of a PDF, or an SVG, to a cached PNG and returns its path. */
export async function rasterize(file: string): Promise<string> {
  const data = await readFile(file);
  const out = join(cacheDir("raster"), `${createHash("sha256").update(data).digest("hex").slice(0, 24)}.png`);
  return once(out, async (temporary) => {
    if (file.toLowerCase().endsWith(".pdf")) {
      const mupdf = await import("mupdf");
      const document = mupdf.Document.openDocument(data, "application/pdf");
      const page = document.loadPage(0);
      const [x0, y0, x1, y1] = page.getBounds();
      const scale = LONG_SIDE / Math.max(x1 - x0, y1 - y0);
      const pixmap = page.toPixmap(mupdf.Matrix.scale(scale, scale), mupdf.ColorSpace.DeviceRGB, false, true);
      await sharp(Buffer.from(pixmap.asPNG())).png().toFile(temporary);
    } else {
      await sharp(data, { density: 200 }).resize({ width: LONG_SIDE, height: LONG_SIDE, fit: "inside" }).flatten({ background: "#ffffff" }).png().toFile(temporary);
    }
  });
}

/**
 * Returns an upright copy when the image carries an EXIF rotation, otherwise the file itself.
 * Browsers apply the tag when drawing; sharp, the detector and the vision model read the stored pixels.
 */
export async function upright(file: string): Promise<string> {
  const { orientation = 1 } = await sharp(file).metadata();
  if (orientation === 1) return file;
  const data = await readFile(file);
  const out = join(cacheDir("raster"), `${createHash("sha256").update(data).digest("hex").slice(0, 24)}-upright.jpg`);
  return once(out, (temporary) => sharp(data).autoOrient().flatten({ background: "#ffffff" }).jpeg({ quality: 95 }).toFile(temporary));
}
