"""Shared format of the interpreter training pairs.

A pair file is JSONL, one object per line:
  developer  the developer turn exactly as the app renders it at inference (instruction + the drawing's menu)
  question   the user's question
  call       the expected call, an object matching the schema
  lang, family, ...  optional tags, only used for per-group scores

The assistant turn is `call` serialised compactly with keys in schema order, which is
also the order a JSON-schema grammar forces at inference. Pairs written by the app
(app/scripts/interp-pairs.ts) carry their keys in schema order already and are used without a schema file.
"""
import json


def load_schema(path):
    if not path:
        return None
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def load_pairs(path, limit=0):
    rows = []
    with open(path, encoding="utf-8") as f:
        for line in f:
            if line.strip():
                rows.append(json.loads(line))
                if limit and len(rows) >= limit:
                    break
    return rows


def call_to_json(call, schema):
    ordered = {k: call[k] for k in schema["properties"]} if schema else call
    return json.dumps(ordered, ensure_ascii=False, separators=(",", ":"))


def prompt_text(tok, row):
    messages = [
        {"role": "developer", "content": row["developer"]},
        {"role": "user", "content": row["question"]},
    ]
    return tok.apply_chat_template(messages, tokenize=False, add_generation_prompt=True)


def completion_text(row, schema, end_of_turn="<end_of_turn>"):
    return call_to_json(row["call"], schema) + end_of_turn
