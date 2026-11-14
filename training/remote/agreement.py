"""Which annotation rule reproduces Stoa's answers? Compares candidate counting rules per question kind."""
import json
import re
import sys
from collections import Counter, defaultdict

QUESTIONS = "/data/stoa/junction-dataset/questions.jsonl"
KINDS = (  # needle in the English question -> kind; the bathroom question also mentions WC rooms, so it goes first
    ("bathrooms or washrooms", "bathrooms"), ("How many windows", "windows"), ("How many floors", "floors"), ("toilet bowls", "toilets"),
    ("sinks and wash basins", "sinks"), ("showers and bathtubs", "showers_bathtubs"), ("How many doors", "doors"),
    ("How many saunas", "saunas"), ("How many kitchens", "kitchens"), ("How many bedrooms", "bedrooms"),
    ("separate WC rooms", "wc_rooms"), ("How many balconies", "balconies"),
)


def load_truth():
    truth, unknown = defaultdict(dict), Counter()
    for line in open(QUESTIONS, encoding="utf-8"):
        r = json.loads(line)
        if "/cubicasa5k/" not in r["path"] or not re.match(r"(How|What) ", r["question"]):
            continue
        kind = next((k for needle, k in KINDS if needle in r["question"]), None)
        if kind is None:
            unknown[r["question"][:70]] += 1
            continue
        truth[r["path"].split("/")[-1][:-4]][kind] = r["answer"]
    return truth, unknown


def fixtures(d, *names):
    return sum(1 for f in d["fixtures"] if f["name"].split()[-1] in names or f["name"] in names)


def spaces(d, test):
    return sum(1 for s in d["spaces"] if test(s))


WC = re.compile(r"\bWC\b", re.I)
BATH_LABEL = re.compile(r"\b(KH|KPH|PH|PESUH|SH|PSH|PE|KYLPYH|KYLPYHUONE|PESUHUONE|SUIHKU|SUIHKUH)\b", re.I)

RULES = {
    "windows": {
        "all Window": lambda d: len(d["windows"]),
    },
    "floors": {
        "Floorplan groups": lambda d: d["floors"],
    },
    "doors": {
        "all Door": lambda d: len(d["doors"]),
        "Door except None": lambda d: sum(1 for x in d["doors"] if not x["kind"].startswith("None")),
    },
    "toilets": {
        "Toilet": lambda d: fixtures(d, "Toilet"),
        "Toilet+Urinal": lambda d: fixtures(d, "Toilet", "Urinal"),
    },
    "sinks": {
        "Sink family": lambda d: sum(1 for f in d["fixtures"] if "Sink" in f["name"]),
        "Sink family, DoubleSinkRight not counted": lambda d: sum(1 for f in d["fixtures"] if "Sink" in f["name"] and "DoubleSinkRight" not in f["name"]),
    },
    "showers_bathtubs": {
        "Shower+Bathtub": lambda d: fixtures(d, "Shower", "Bathtub"),
        "Shower+ShowerCab+Bathtub family": lambda d: sum(1 for f in d["fixtures"] if f["name"].split()[-1] in ("Shower", "ShowerCab", "ShowerPlatform") or "Bathtub" in f["name"]),
        "Shower*+Bathtub*": lambda d: sum(1 for f in d["fixtures"] if "Shower" in f["name"] or "Bathtub" in f["name"]),
    },
    "saunas": {
        "Space Sauna": lambda d: spaces(d, lambda s: s["kind"].startswith("Sauna")),
    },
    "kitchens": {
        "Space Kitchen*": lambda d: spaces(d, lambda s: s["kind"].startswith("Kitchen")),
    },
    "bedrooms": {
        "Space Bedroom": lambda d: spaces(d, lambda s: s["kind"].startswith("Bedroom")),
    },
    "balconies": {
        "Space Outdoor Balcony*": lambda d: spaces(d, lambda s: s["kind"].startswith("Outdoor Balcony")),
    },
    "wc_rooms": {
        "Space Bath with WC label": lambda d: spaces(d, lambda s: s["kind"].startswith("Bath") and WC.search(s["label"]) is not None),
        "any Space with WC label": lambda d: spaces(d, lambda s: WC.search(s["label"]) is not None),
        "Space label exactly WC": lambda d: spaces(d, lambda s: s["label"].strip().upper() == "WC"),
    },
    "bathrooms": {
        "Space Bath without WC label": lambda d: spaces(d, lambda s: s["kind"].startswith("Bath") and WC.search(s["label"]) is None),
        "Space Bath not labelled exactly WC": lambda d: spaces(d, lambda s: s["kind"].startswith("Bath") and s["label"].strip().upper() != "WC"),
        "Space with bath label": lambda d: spaces(d, lambda s: BATH_LABEL.search(s["label"]) is not None),
    },
}

if __name__ == "__main__":
    feats = {json.loads(l)["stem"]: json.loads(l) for l in open("/data/feat/features.jsonl")}
    truth, unknown = load_truth()
    print("drawings with features:", len(feats), "| with questions:", len(truth), "| both:", len(set(feats) & set(truth)))
    if unknown:
        print("unmapped English questions:", unknown.most_common(5))
    verbose = len(sys.argv) > 1
    for kind, rules in RULES.items():
        asked = [(stem, t[kind]) for stem, t in truth.items() if kind in t and stem in feats]
        print(f"\n{kind}: asked on {len(asked)} drawings, answer distribution {dict(Counter(a for _, a in asked).most_common(6))}")
        for name, rule in rules.items():
            ok = sum(1 for stem, a in asked if rule(feats[stem]) == a)
            print(f"   {ok / max(1, len(asked)):6.1%}  {name}")
            if verbose:
                wrong = [(stem, a, rule(feats[stem])) for stem, a in asked if rule(feats[stem]) != a][:4]
                for stem, a, got in wrong:
                    d = feats[stem]
                    detail = Counter(x["kind"] for x in d["doors"]) if kind == "doors" else Counter(f["name"] for f in d["fixtures"] if any(w in f["name"] for w in ("Sink", "Shower", "Bath", "Toilet", "Urinal"))) if kind in ("sinks", "showers_bathtubs", "toilets") else [(s["kind"], s["label"]) for s in d["spaces"]] if kind != "windows" else Counter(w["kind"] for w in d["windows"])
                    print(f"        {stem}: stoa {a}, rule {got} | {str(dict(detail) if isinstance(detail, Counter) else detail)[:230]}")
    # which drawings get which kinds asked
    print("\nkinds asked per drawing:", Counter(len(t) for t in truth.values()).most_common(8))
