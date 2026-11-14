"""Exact match of the whole call on held-out pairs, with free and JSON-schema-constrained greedy decoding.

Also writes the prompt text and token ids of the first row (--parity-out) so the Node side can be
checked for token-identical prompts.
"""
import argparse
import json
import re
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


def normal(call):
    """The call without what a correct reading may vary: the free-text reason, the order of lists, the case of free words."""
    if not isinstance(call, dict):
        return None
    out = {}
    for key, value in call.items():
        if key == "reason":
            continue
        if isinstance(value, list):
            value = sorted(str(v).lower() if key == "missing" else str(v) for v in value)
        if key == "items":
            value = str(value).strip().lower()
        out[key] = value
    return out


# The fields each operation reads; the app ignores the others (see runTakeoff, planRaster and planIfc in app/server/src/planner.ts).
USED = {
    "dxf": {
        "count_symbols": ["symbols", "labels", "room_numbers", "apartments", "missing", "locate"],
        "count_apartments": ["locate"],
        "rooms": ["labels", "room_numbers", "apartments", "pick", "measure", "missing", "broader_label", "locate", "answer_type"],
        "area_apartment": ["apartments", "missing", "locate"],
        "area_floor": ["locate"],
        "compare": ["symbols", "labels", "room_numbers", "apartments", "measure", "missing"],
        "none": [],
    },
    "raster": {"count_known": ["targets", "whole_drawing", "locate"], "count_other": ["items", "locate"], "read": ["answer_type"]},
    "ifc": {
        "count_elements": ["elements", "storey", "missing", "locate"],
        "rooms": ["rooms", "storey", "pick", "measure", "missing", "locate", "answer_type"],
        "storey_total": ["quantity", "storey", "missing"],
        "model_facts": ["answer_type"],
        "none": [],
    },
}
NAMED = re.compile("^(room|apartment) +")


def effective(call, kind):
    """The call reduced to what its operation reads, with 'room 9.99' and '9.99' in missing taken as the same."""
    call = normal(call)
    fields = USED.get(kind, {}).get(call.get("operation")) if call else None
    if fields is None:
        return call
    out = {"operation": call["operation"], **{f: call.get(f) for f in fields}}
    if isinstance(out.get("missing"), list):
        out["missing"] = sorted(NAMED.sub("", word) for word in out["missing"])
    return out


def matches(text, row, reduce=False):
    try:
        call = json.loads(text)
    except json.JSONDecodeError:
        return False
    kind = row.get("type", "?")
    return effective(call, kind) == effective(row["call"], kind) if reduce else normal(call) == normal(row["call"])


def score(rows, outputs, reduce=False):
    groups = defaultdict(lambda: [0, 0])
    valid = 0
    for row, text in zip(rows, outputs):
        try:
            json.loads(text)
            valid += 1
        except json.JSONDecodeError:
            pass
        hit = matches(text, row, reduce)
        kind = row.get("type", "?")
        keys = ["all", "type=" + kind, "lang=" + row.get("lang", "?"), "family=" + row.get("family", "?"),
                "type+family=" + kind + "/" + row.get("family", "?"), "op=" + kind + "." + row["call"].get("operation", "?")]
        if row.get("family") == "reworded":
            keys.append("style=" + row.get("template", "?"))
        for key in keys:
            groups[key][0] += hit
            groups[key][1] += 1
    return {"valid_json": valid, **{k: f"{h}/{n}" for k, (h, n) in sorted(groups.items())}}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", required=True)
    ap.add_argument("--heldout", required=True)
    ap.add_argument("--schema", default="")
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--max-new-tokens", type=int, default=200)
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
    rows = load_pairs(args.heldout, args.limit)
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
    report["free_fields_used"] = score(rows, free, reduce=True)
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
                f.write(json.dumps({"question": row["question"], "gold": row["call"], "free": free[i], "hit": matches(free[i], row), "hit_used": matches(free[i], row, True),
                                    "constrained": constrained[i] if i < len(constrained) else None,
                                    **{k: row.get(k) for k in ("type", "family", "template", "lang", "drawing", "asked")}},
                                   ensure_ascii=False) + "\n")


if __name__ == "__main__":
    main()
