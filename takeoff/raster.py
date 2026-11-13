"""Counts on raster floor plans, asked of a vision model through the local `claude` CLI.

The model gets one tool, Read, confined to the folder holding the image, and must return JSON
matching a schema: one integer per question.
"""
import json
import os
import shutil
import subprocess
import time

from .scoring import is_correct

SYSTEM = (
    "You read architectural floor plans and count what is drawn on them. "
    "Open the image with the Read tool before answering. Count each drawn symbol or labelled room once, "
    "go through the plan room by room, and give an exact integer for every question."
)
SCHEMA = {
    "type": "object",
    "properties": {
        "answers": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {"id": {"type": "integer"}, "count": {"type": "integer"}},
                "required": ["id", "count"],
                "additionalProperties": False,
            },
        }
    },
    "required": ["answers"],
    "additionalProperties": False,
}


def graded(rows, answers):
    """(row, model's answer, correct) per question; `answers` is keyed by 1-based question number."""
    for number, row in enumerate(rows, 1):
        got = answers.get(str(number))
        yield row, got, is_correct("count", row["answer"], got)


def count(image_path, questions, model, effort=None, timeout=600):
    """Ask all questions about one image in a single call. Returns answers by question index, plus cost and time."""
    exe = shutil.which("claude")
    if not exe:
        return {"error": "the `claude` CLI is not on PATH"}
    numbered = "\n".join(f"{i}. {q}" for i, q in enumerate(questions, 1))
    prompt = (f"The floor plan is the image file `{os.path.basename(image_path)}` in the current folder.\n"
              f"Answer each question with a count, using its number as the id.\n\n{numbered}")
    command = [exe, "-p", "--model", model, "--output-format", "json", "--json-schema", json.dumps(SCHEMA),
               "--system-prompt", SYSTEM, "--tools", "Read", "--strict-mcp-config", "--safe-mode",
               "--disable-slash-commands", "--no-session-persistence"]
    if effort:
        command += ["--effort", effort]
    started = time.monotonic()
    try:
        done = subprocess.run(command, input=prompt, capture_output=True, text=True, encoding="utf-8",
                              cwd=os.path.dirname(os.path.abspath(image_path)), timeout=timeout)
        result = json.loads(done.stdout)
    except subprocess.TimeoutExpired:
        return {"error": f"timed out after {timeout}s"}
    except ValueError:
        return {"error": f"unreadable CLI output: {(done.stderr or done.stdout)[:300]}"}

    out = {
        "seconds": round(time.monotonic() - started, 1),
        "cost_usd": result.get("total_cost_usd") or 0.0,
        "turns": result.get("num_turns"),
    }
    structured = result.get("structured_output")
    if result.get("is_error") or not isinstance(structured, dict):
        out["error"] = f"no structured output ({result.get('subtype')}): {str(result.get('result'))[:300]}"
        return out
    out["answers"] = {str(a["id"]): a["count"] for a in structured["answers"]}
    return out
