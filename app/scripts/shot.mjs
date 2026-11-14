// Screenshot of the running app: node scripts/shot.mjs "<url>" <out.png> [waitSelector] [timeoutMs]
import { chromium } from "playwright";

const [url, out, selector = ".placard", timeout = "120000"] = process.argv.slice(2);
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
await page.goto(url);
try {
  await page.waitForSelector(selector, { timeout: Number(timeout) });
  await page.waitForTimeout(600);
} catch {
  console.log(`selector ${selector} did not appear`);
}
await page.screenshot({ path: out });
await browser.close();
console.log("saved", out);
