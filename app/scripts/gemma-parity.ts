/**
 * Checks, after every conversion to GGUF, that this machine feeds the local interpreter the tokens it was trained on.
 * training/gemma/eval_interpreter.py --parity-out writes the prompt of the first test pair as Python rendered and
 * tokenized it; this renders the same pair with models/gemma.ts and tokenizes and evaluates it with node-llama-cpp.
 *
 *   npx tsx scripts/gemma-parity.ts <model.gguf> <test.jsonl> <parity.json>
 */
import { readFileSync } from "node:fs";
import { getLlama, LlamaCompletion } from "node-llama-cpp";
import { renderPrompt, turns } from "../server/src/models/gemma.js";

const [modelPath, pairsPath, parityPath] = process.argv.slice(2);
const row = JSON.parse(readFileSync(pairsPath, "utf8").split("\n")[0]);
const parity = JSON.parse(readFileSync(parityPath, "utf8")) as { prompt: string; ids: number[] };
const same = (a: readonly number[], b: readonly number[]) => a.length === b.length && a.every((token, i) => token === b[i]);

const prompt = renderPrompt(turns(row.request));
const llama = await getLlama({ gpu: false });
const model = await llama.loadModel({ modelPath });
const context = await model.createContext({ contextSize: 4096 });
const sequence = context.getSequence();
const ids = model.tokenize(prompt, true);
await new LlamaCompletion({ contextSequence: sequence }).generateCompletion(ids, { maxTokens: 1, temperature: 0 });

console.log(JSON.stringify({
  promptIdentical: `<bos>${prompt}` === parity.prompt,
  tokensIdentical: same(ids, parity.ids.slice(1)),
  evaluatedIdentical: same(sequence.contextTokens.slice(0, parity.ids.length), parity.ids),
  promptTokens: parity.ids.length,
}));
process.exit(0);
