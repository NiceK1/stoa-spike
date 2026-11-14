// Renders docs/training-history.svg to training-history.png at 2x: node docs/render_training_figure.mjs
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
// Playwright is installed for the app only.
const { chromium } = createRequire(path.join(here, "..", "app", "package.json"))("playwright");

const svg = readFileSync(path.join(here, "training-history.svg"), "utf8");
const [, width, height] = svg.match(/<svg[^>]* width="(\d+)" height="(\d+)"/).map(Number);
const out = path.join(here, "training-history.png");

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 2 });
await page.setContent(`<style>html,body{margin:0}svg{display:block}</style>${svg}`);
await page.screenshot({ path: out, clip: { x: 0, y: 0, width, height } });
await browser.close();
console.log("saved", out);
