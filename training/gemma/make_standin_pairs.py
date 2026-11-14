"""Template-generated stand-in pairs for the feasibility run (not the real training data).

Held-out rows are half seen frames with unseen question/menu combinations and half
frames that never occur in training (family "unseen_frame").
"""
import argparse
import json
import random

INSTRUCTION = (
    "You turn one question about a building drawing into one JSON call. Answer with JSON only.\n"
    'Format: {"operation":"count_kind"|"count_rooms"|"area_rooms"|"area_apartment"|"none",'
    '"kinds":[...],"labels":[...],"apartment":string|null,"show":true|false}\n'
    "count_kind counts things of the listed kinds. count_rooms and area_rooms take room labels "
    "exactly as written in the menu. area_apartment takes one apartment. Use none when the question "
    "is not about counting or measuring this drawing. show is true only when the user asks to see, "
    "find or highlight things."
)

RASTER_KINDS = ["window", "door", "toilet", "sink", "shower", "bathtub", "sauna", "kitchen",
                "bedroom", "living_room", "bathroom", "balcony", "stairs", "storey"]
CAD_KINDS = ["window", "door", "toilet", "sink", "shower", "bathtub"]

# concept -> (en plural, de plural, fi partitive singular, fi nominative plural)
NOUNS = {
    "window": ("windows", "Fenster", "ikkunaa", "ikkunat"),
    "door": ("doors", "Türen", "ovea", "ovet"),
    "toilet": ("toilet bowls", "WC-Schüsseln", "WC-istuinta", "WC-istuimet"),
    "sink": ("sinks", "Waschbecken", "pesuallasta", "pesualtaat"),
    "shower": ("showers", "Duschen", "suihkua", "suihkut"),
    "bathtub": ("bathtubs", "Badewannen", "kylpyammetta", "kylpyammeet"),
    "sauna": ("saunas", "Saunen", "saunaa", "saunat"),
    "kitchen": ("kitchens", "Küchen", "keittiötä", "keittiöt"),
    "bedroom": ("bedrooms", "Schlafzimmer", "makuuhuonetta", "makuuhuoneet"),
    "living_room": ("living rooms", "Wohnzimmer", "olohuonetta", "olohuoneet"),
    "bathroom": ("bathrooms", "Badezimmer", "kylpyhuonetta", "kylpyhuoneet"),
    "balcony": ("balconies", "Balkone", "parveketta", "parvekkeet"),
    "stairs": ("staircases", "Treppen", "portaikkoa", "portaikot"),
    "storey": ("storeys", "Geschosse", "kerrosta", "kerrokset"),
    "wc_room": ("WC rooms", "WC-Räume", "vessaa", "vessat"),
    "hall": ("hallways", "Flure", "eteistä", "eteiset"),
    "storage": ("storage rooms", "Abstellräume", "varastoa", "varastot"),
    "utility": ("utility rooms", "Hauswirtschaftsräume", "kodinhoitohuonetta", "kodinhoitohuoneet"),
    "study": ("home offices", "Arbeitszimmer", "työhuonetta", "työhuoneet"),
    "dining": ("dining rooms", "Esszimmer", "ruokailutilaa", "ruokailutilat"),
    "dressing": ("dressing rooms", "Ankleidezimmer", "vaatehuonetta", "vaatehuoneet"),
    "terrace": ("terraces", "Terrassen", "terassia", "terassit"),
    "garage": ("garages", "Garagen", "autotallia", "autotallit"),
    "corridor": ("corridors", "Korridore", "käytävää", "käytävät"),
    "technical": ("technical rooms", "Technikräume", "teknistä tilaa", "tekniset tilat"),
}

# room concept -> labels as they appear on plans, by plan language
ROOM_LABELS = {
    "bedroom": {"fi": ["MH"], "de": ["Schlafzimmer", "Zimmer"], "en": ["Bedroom"]},
    "kitchen": {"fi": ["K", "KEITTIÖ"], "de": ["Küche"], "en": ["Kitchen"]},
    "living_room": {"fi": ["OH"], "de": ["Wohnzimmer", "Wohnen"], "en": ["Living room"]},
    "bathroom": {"fi": ["KPH", "KH"], "de": ["Bad"], "en": ["Bathroom"]},
    "wc_room": {"fi": ["WC"], "de": ["WC"], "en": ["WC"]},
    "sauna": {"fi": ["S", "SAUNA"], "de": ["Sauna"], "en": ["Sauna"]},
    "hall": {"fi": ["ET"], "de": ["Flur", "Diele"], "en": ["Hall"]},
    "balcony": {"fi": ["PARVEKE"], "de": ["Balkon"], "en": ["Balcony"]},
    "storage": {"fi": ["VAR"], "de": ["Abstellraum"], "en": ["Storage"]},
    "utility": {"fi": ["KHH"], "de": ["Waschküche"], "en": ["Utility"]},
    "study": {"fi": ["TYÖH"], "de": ["Büro"], "en": ["Study"]},
    "dining": {"fi": ["RT"], "de": ["Essen"], "en": ["Dining"]},
    "dressing": {"fi": ["VH"], "de": ["Ankleide"], "en": ["Dressing"]},
    "terrace": {"fi": ["TERASSI"], "de": ["Terrasse"], "en": ["Terrace"]},
    "garage": {"fi": ["AT"], "de": ["Garage"], "en": ["Garage"]},
    "corridor": {"fi": ["KÄYTÄVÄ"], "de": ["Gang"], "en": ["Corridor"]},
    "technical": {"fi": ["TEKN"], "de": ["Technik"], "en": ["Technical"]},
}

AND = {"en": " and ", "de": " und ", "fi": " ja "}
IN_APARTMENT = {"en": " in apartment {A}", "de": " in Wohnung {A}", "fi": " asunnossa {A}"}

# {N}: noun phrase ({P} = Finnish partitive form), {Q}: optional apartment qualifier.
# The last frame of every list is reserved for the held-out set.
FRAMES = {
    ("count", False): {
        "en": ["How many {N} are there{Q}?", "Count the {N}{Q}.", "What is the number of {N}{Q}?",
               "Number of {N}{Q}?", "Tell me how many {N} there are{Q}."],
        "de": ["Wie viele {N} gibt es{Q}?", "Zähle die {N}{Q}.", "Wie hoch ist die Anzahl der {N}{Q}?",
               "Anzahl der {N}{Q}?", "Wie viele {N} sind{Q} vorhanden?"],
        "fi": ["Kuinka monta {P} on{Q}?", "Laske {N}{Q}.", "Montako {P} piirustuksessa on{Q}?",
               "Paljonko on {N}{Q}?", "Kerro, kuinka monta {P} löytyy{Q}."],
    },
    ("count", True): {
        "en": ["Show me the {N}{Q}.", "Where are the {N}{Q}?", "Highlight all {N}{Q}.",
               "Can you point out the {N}{Q}?"],
        "de": ["Zeige mir die {N}{Q}.", "Wo sind die {N}{Q}?", "Markiere alle {N}{Q}.",
               "Kannst du mir die {N}{Q} zeigen?"],
        "fi": ["Näytä {N}{Q}.", "Missä {N} ovat{Q}?", "Korosta kaikki {N}{Q}.",
               "Voitko osoittaa {N}{Q}?"],
    },
    ("area", False): {
        "en": ["What is the total area of the {N}{Q}?", "How large are the {N}{Q}?", "Area of the {N}{Q}?",
               "How many square metres do the {N} cover{Q}?"],
        "de": ["Wie groß ist die Gesamtfläche der {N}{Q}?", "Welche Fläche haben die {N}{Q}?",
               "Fläche der {N}{Q}?", "Wie viele Quadratmeter haben die {N}{Q}?"],
        "fi": ["Kuinka suuret {N} ovat yhteensä{Q}?", "Paljonko pinta-alaa {N} vievät{Q}?",
               "Pinta-ala: {N}{Q}?", "Montako neliötä {N} kattavat{Q}?"],
    },
    ("area", True): {
        "en": ["Show the {N}{Q} and their area.", "Highlight the {N}{Q} and give their total area.",
               "Mark the {N}{Q} and tell me how big they are."],
        "de": ["Zeige die {N}{Q} mit ihrer Fläche.", "Markiere die {N}{Q} und nenne die Gesamtfläche.",
               "Hebe die {N}{Q} hervor und sag mir, wie groß sie sind."],
        "fi": ["Näytä {N}{Q} ja niiden pinta-ala.", "Korosta {N}{Q} ja kerro yhteispinta-ala.",
               "Merkitse {N}{Q} ja kerro, kuinka suuret ne ovat."],
    },
    ("apartment", False): {
        "en": ["What is the area of apartment {A}?", "How big is apartment {A}?", "Floor area of flat {A}?",
               "How many square metres is apartment {A}?"],
        "de": ["Wie groß ist Wohnung {A}?", "Welche Fläche hat die Wohnung {A}?", "Wohnfläche von Wohnung {A}?",
               "Wie viele Quadratmeter hat Wohnung {A}?"],
        "fi": ["Mikä on asunnon {A} pinta-ala?", "Kuinka suuri asunto {A} on?", "Asunnon {A} pinta-ala?",
               "Montako neliötä asunnossa {A} on?"],
    },
    ("apartment", True): {
        "en": ["Show apartment {A} and its area.", "Highlight flat {A} and tell me its size.",
               "Where is apartment {A} and how big is it?"],
        "de": ["Zeige Wohnung {A} und ihre Fläche.", "Markiere Wohnung {A} und nenne ihre Größe.",
               "Wo ist Wohnung {A} und wie groß ist sie?"],
        "fi": ["Näytä asunto {A} ja sen pinta-ala.", "Korosta asunto {A} ja kerro sen koko.",
               "Missä asunto {A} on ja kuinka suuri se on?"],
    },
    ("none", False): {
        "en": ["Who is the architect?", "What is the scale of the drawing?", "When was the building built?",
               "How much does the apartment cost?", "Hello", "What will the weather be tomorrow?",
               "What are the walls made of?", "Who owns the house?"],
        "de": ["Wer ist der Architekt?", "Welchen Maßstab hat der Plan?", "Wann wurde das Gebäude gebaut?",
               "Was kostet die Wohnung?", "Hallo", "Wie wird das Wetter morgen?",
               "Aus welchem Material sind die Wände?", "Wem gehört das Haus?"],
        "fi": ["Kuka on arkkitehti?", "Mikä on piirustuksen mittakaava?", "Milloin talo on rakennettu?",
               "Paljonko asunto maksaa?", "Hei", "Millainen sää huomenna on?",
               "Mistä materiaalista seinät ovat?", "Kuka omistaa talon?"],
    },
}
NONE_HELD_OUT = 2


def make_menu(rng):
    if rng.random() < 0.35:
        return {"drawing": "raster plan", "kinds": RASTER_KINDS, "rooms": {}, "apartments": []}
    plan_lang = rng.choice(["fi", "fi", "de", "en"])
    concepts = rng.sample(sorted(ROOM_LABELS), rng.randint(8, 15))
    rooms = {c: rng.choice(ROOM_LABELS[c][plan_lang]) for c in concepts}
    style = rng.choice(["A1", "A", "1"])
    n = rng.randint(2, 8)
    if style == "A1":
        apartments = [f"{rng.choice('ABCD')}{i}" for i in rng.sample(range(1, 40), n)]
    elif style == "A":
        apartments = rng.sample(list("ABCDEFGHJK"), n)
    else:
        apartments = [str(i) for i in rng.sample(range(1, 60), n)]
    return {"drawing": "CAD plan", "kinds": CAD_KINDS, "rooms": rooms, "apartments": apartments}


def render_developer(menu):
    lines = [INSTRUCTION, f"Drawing: {menu['drawing']}", "Kinds: " + ", ".join(menu["kinds"])]
    if menu["rooms"]:
        lines.append("Room labels: " + ", ".join(menu["rooms"].values()))
    if menu["apartments"]:
        lines.append("Apartments: " + ", ".join(menu["apartments"]))
    return "\n".join(lines)


def noun_phrase(concepts, lang):
    col = {"en": 0, "de": 1, "fi": 3}[lang]
    n = AND[lang].join(NOUNS[c][col] for c in concepts)
    p = AND[lang].join(NOUNS[c][2] for c in concepts)
    return n, p


def make_pair(rng, held_out_frame):
    lang = rng.choice(["en", "de", "fi"])
    menu = make_menu(rng)
    cad = menu["drawing"] == "CAD plan"
    intents = ["count", "count", "count", "none"] + (["area", "area", "apartment"] if cad else [])
    intent = rng.choice(intents)
    show = intent != "none" and rng.random() < 0.3
    frames = FRAMES[(intent, show)][lang]
    reserved = NONE_HELD_OUT if intent == "none" else 1
    frame = rng.choice(frames[-reserved:] if held_out_frame else frames[:-reserved])
    call = {"operation": "none", "kinds": [], "labels": [], "apartment": None, "show": show}
    n = p = ""
    apartment = None

    if intent == "apartment":
        apartment = rng.choice(menu["apartments"])
        call.update(operation="area_apartment", apartment=apartment)
    elif intent in ("count", "area"):
        use_rooms = cad and (intent == "area" or rng.random() < 0.5)
        pool = sorted(menu["rooms"]) if use_rooms else menu["kinds"]
        concepts = rng.sample(pool, 2 if rng.random() < 0.2 else 1)
        n, p = noun_phrase(concepts, lang)
        if use_rooms:
            call.update(operation="count_rooms" if intent == "count" else "area_rooms",
                        labels=[menu["rooms"][c] for c in concepts])
        else:
            call.update(operation="count_kind", kinds=concepts)
        if cad and rng.random() < 0.3:
            apartment = rng.choice(menu["apartments"])
            call["apartment"] = apartment

    q = IN_APARTMENT[lang].format(A=apartment) if apartment and intent != "apartment" else ""
    question = frame.format(N=n, P=p, Q=q, A=apartment)
    return {"developer": render_developer(menu), "question": question, "call": call, "lang": lang,
            "family": "unseen_frame" if held_out_frame else "seen_frame"}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--train", type=int, default=2400)
    ap.add_argument("--heldout", type=int, default=300)
    ap.add_argument("--out-dir", default=".")
    ap.add_argument("--seed", type=int, default=7)
    args = ap.parse_args()
    rng = random.Random(args.seed)

    seen = set()

    def unique(n, held_out_frame):
        rows = []
        while len(rows) < n:
            row = make_pair(rng, held_out_frame)
            key = (row["developer"], row["question"])
            if key not in seen:
                seen.add(key)
                rows.append(row)
        return rows

    train = unique(args.train, False)
    heldout = unique(args.heldout // 2, False) + unique(args.heldout - args.heldout // 2, True)
    rng.shuffle(heldout)
    for name, rows in (("train", train), ("heldout", heldout)):
        with open(f"{args.out_dir}/standin_{name}.jsonl", "w", encoding="utf-8") as f:
            for row in rows:
                f.write(json.dumps(row, ensure_ascii=False) + "\n")
        print(name, len(rows))


if __name__ == "__main__":
    main()
