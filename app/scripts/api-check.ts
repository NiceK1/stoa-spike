// One call through the API provider, to confirm it is interchangeable with the local CLI provider.
//   npx tsx scripts/api-check.ts ../dataset/data/cubicasa5k/high_quality-12239.png
import { loadEnv } from "../server/src/config.js";
import { AnthropicApiVision } from "../server/src/models/vision.js";
import { INVENTORY_PROMPTS, INVENTORY_SCHEMA } from "../server/src/solvers/raster.js";

loadEnv();
const vision = new AnthropicApiVision();
const result = await vision.ask({
  imagePath: process.argv[2],
  system: INVENTORY_PROMPTS.v2,
  prompt: "Take the inventory of this floor plan.",
  schema: INVENTORY_SCHEMA,
});
const counts = Object.fromEntries(Object.entries(result.output).map(([k, v]) => [k, Array.isArray(v) ? v.length : v]));
console.log(vision.id, result.seconds.toFixed(1) + "s", "USD " + result.costUsd.toFixed(4), JSON.stringify(counts));
