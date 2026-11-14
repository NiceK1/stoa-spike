"""Exact match of the whole call on held-out pairs, with free and JSON-schema-constrained greedy decoding.

Also writes the prompt text and token ids of the first row (--parity-out) so the Node side can be
checked for token-identical prompts.
"""
import argparse
import json
import time
from collections import defaultdict

import torch
from transformers import AutoModelForCausalLM, AutoTokenizer

from interp_format import load_pairs, load_schema, prompt_text


def lmfe_schema(node):
    """lm-format-enforcer wants anyOf where the node-llama-cpp schema uses a list of types."""
    if isinstance(node, dict):
        if isinstance(node.get("type"), list):
            rest = {k: lmfe_schema(v) for k, v in node.items() if k != "type"}
            return {"anyOf": [{"type": t} for t in node["type"]], **rest}
        return {k: lmfe_schema(v) for k, v in node.items()}
    if isinstance(node, list):
        return [lmfe_schema(v) for v in node]
    return node


def generate(model, tok, prompts, max_new_tokens, batch_size, allowed_fn=None):
    outputs = []
    for i in range(0, len(prompts), batch_size):
        enc = tok(prompts[i:i + batch_size], return_tensors="pt", padding=True,
                  add_special_tokens=False).to(model.device)
        with torch.no_grad():
            out = model.generate(**enc, max_new_tokens=max_new_tokens, do_sample=False,
                                 prefix_allowed_tokens_fn=allowed_fn, pad_token_id=tok.pad_token_id)
        for row in out[:, enc.input_ids.shape[1]:]:
            outputs.append(tok.decode(row, skip_special_tokens=True).strip())
    return outputs


def score(rows, outputs):
    groups = defaultdict(lambda: [0, 0])
    valid = 0
    for row, text in zip(rows, outputs):
        try:
            call = json.loads(text)
            valid += 1
        except json.JSONDecodeError:
            call = None
        hit = call == row["call"]
        for key in ("all", "lang=" + row.get("lang", "?"), "family=" + row.get("family", "?"),
                    "op=" + row["call"].get("operation", "?")):
            groups[key][0] += hit
            groups[key][1] += 1
    return {"valid_json": valid, **{k: f"{h}/{n}" for k, (h, n) in sorted(groups.items())}}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", required=True)
    ap.add_argument("--heldout", required=True)
    ap.add_argument("--schema", required=True)
    ap.add_argument("--max-new-tokens", type=int, default=80)
    ap.add_argument("--batch-size", type=int, default=50)
    ap.add_argument("--constrained-limit", type=int, default=50,
                    help="rows decoded under the schema (lm-format-enforcer is slow on a 262k vocabulary); 0 skips it")
    ap.add_argument("--predictions-out")
    ap.add_argument("--parity-out")
    ap.add_argument("--max-gpu-gb", type=float, default=0, help="fail instead of growing past this on a shared GPU")
    args = ap.parse_args()
    if args.max_gpu_gb:
        total = torch.cuda.get_device_properties(0).total_memory / 2**30
        torch.cuda.set_per_process_memory_fraction(args.max_gpu_gb / total)

    tok = AutoTokenizer.from_pretrained(args.model)
    tok.padding_side = "left"
    model = AutoModelForCausalLM.from_pretrained(args.model, dtype=torch.float32).to("cuda").eval()
    rows = load_pairs(args.heldout)
    schema = load_schema(args.schema)
    prompts = [prompt_text(tok, row) for row in rows]

    if args.parity_out:
        ids = tok(prompts[0], add_special_tokens=False).input_ids
        with open(args.parity_out, "w", encoding="utf-8") as f:
            json.dump({"prompt": prompts[0], "ids": ids}, f, ensure_ascii=False)

    report = {"model": args.model, "n": len(rows)}
    start = time.time()
    free = generate(model, tok, prompts, args.max_new_tokens, args.batch_size)
    report["free"] = score(rows, free)
    report["free_seconds"] = round(time.time() - start, 1)
    print(json.dumps(report, indent=1, ensure_ascii=False), flush=True)
    constrained = []
    if args.constrained_limit:
        import transformers
        import transformers.tokenization_utils as tokenization_utils
        # lm-format-enforcer 0.11 imports this name from its pre-5.0 location
        if not hasattr(tokenization_utils, "PreTrainedTokenizerBase"):
            tokenization_utils.PreTrainedTokenizerBase = transformers.PreTrainedTokenizerBase
        from lmformatenforcer import JsonSchemaParser
        from lmformatenforcer.integrations.transformers import build_transformers_prefix_allowed_tokens_fn
        fn = build_transformers_prefix_allowed_tokens_fn(tok, JsonSchemaParser(lmfe_schema(schema)))
        start = time.time()
        n = args.constrained_limit
        constrained = generate(model, tok, prompts[:n], args.max_new_tokens, args.batch_size, fn)
        report = {"constrained": score(rows[:n], constrained), "free_same_rows": score(rows[:n], free[:n]),
                  "constrained_seconds": round(time.time() - start, 1)}
        print(json.dumps(report, indent=1, ensure_ascii=False), flush=True)

    if args.predictions_out:
        with open(args.predictions_out, "w", encoding="utf-8") as f:
            for i, row in enumerate(rows):
                f.write(json.dumps({"question": row["question"], "gold": row["call"], "free": free[i],
                                    "constrained": constrained[i] if i < len(constrained) else None},
                                   ensure_ascii=False) + "\n")


if __name__ == "__main__":
    main()
