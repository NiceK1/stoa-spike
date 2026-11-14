import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";
import { cacheDir } from "./config.js";

const LONG_SIDE = 2400;

/** Renders the first page of a PDF, or an SVG, to a cached PNG and returns its path. */
export async function rasterize(file: string): Promise<string> {
  const data = await readFile(file);
  const out = join(cacheDir("raster"), `${createHash("sha256").update(data).digest("hex").slice(0, 24)}.png`);
  if (existsSync(out)) return out;

  if (file.toLowerCase().endsWith(".pdf")) {
    const mupdf = await import("mupdf");
    const document = mupdf.Document.openDocument(data, "application/pdf");
    const page = document.loadPage(0);
    const [x0, y0, x1, y1] = page.getBounds();
    const scale = LONG_SIDE / Math.max(x1 - x0, y1 - y0);
    const pixmap = page.toPixmap(mupdf.Matrix.scale(scale, scale), mupdf.ColorSpace.DeviceRGB, false, true);
    await writeFile(out, pixmap.asPNG());
  } else {
    await sharp(data, { density: 200 }).resize({ width: LONG_SIDE, height: LONG_SIDE, fit: "inside" }).flatten({ background: "#ffffff" }).png().toFile(out);
  }
  return out;
}
