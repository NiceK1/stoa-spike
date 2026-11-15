# Take-off check (web app)

Ask a quantity question about a construction drawing. The answer comes back with the drawing and every
counted or measured item marked and numbered, so a person can verify it.

## Run

```
cd app
npm install
npm run build        # builds the web client into web/dist
npm run server       # http://127.0.0.1:8787
```

For development, `npm run dev` restarts the server on changes and `npm run web` serves the client on port 5173.
A drawing and a question can be linked directly: `http://127.0.0.1:8787/?path=data/cubicasa5k/<name>.png&q=<question>`.
The server's front page is the landing page (`deploy/hf-space/landing.html`, the same one the Hugging Face demo opens with);
the app itself is at `/app.html`, and a link that names a drawing as above opens the app directly.

## Modes

The ask window has one setting for all its questions, the mode. The browser remembers it and sends it with every
question; a question without a mode is asked in Blueline only. A mode says which engine does each of four jobs
(`server/src/modes.ts`):

| Job | Blueline only (`blueline`, the default) | Best accuracy (`best`) | Custom (`custom`) |
|---|---|---|---|
| Understands the question | Blueline interpreter (tuned Gemma), on the CPU; the keyword parser when its weights file is missing | Claude Haiku 5.5 (Anthropic), else Gemini 4 Hydrogen (Google), else the Blueline interpreter | the user's pick: Blueline interpreter, Claude Haiku 5.5, Gemini 4 Hydrogen, or the keyword parser only |
| Counts the drawn symbols on an image plan (window, door, toilet bowl, sink, shower, bathtub) | Blueline detector (trained YOLO11), the one routed to the class | the middle of three independent counts: each of the two Blueline detectors and the reader's inventory of the drawing | the routed Blueline detector, no vote |
| Reads room types, storeys and anything else on an image plan | the Blueline detectors for the seven room types and storeys; any other question gets no value and the reason | the reader: Gemini 4 Hydrogen (Google), else Claude Sonnet 5.5 (Anthropic) | the reader the user picks: none (then as in Blueline only), Gemini 4 Hydrogen, Claude Sonnet 5.5 |
| Words answers from a building model's facts and from a sheet's text | nobody: no value and the reason | Claude Sonnet 5.5 (Anthropic), else the reader | the reader |
| Calls that leave the server | none | one interpretation per question; one reading per image plan, shared by all its questions; one reading per question about something else on it; one or two text calls per facts or sheet question | whatever the picks call |

Layered DXF plans and IFC quantities are computed by the scripts in every mode; only who understands the question
differs there.

In Blueline only and Best accuracy the line-up is fixed and shown read-only; Best accuracy is shown as "auto" with what
it resolves to on this server. The pickers are open in Custom only.

**When an outside model fails.** If the reader fails on a count our detectors can make (a room type, a storey), the
detectors answer and the answer says that the reader did not. Any other failed outside call is reported in one
sentence that names the model, with the provider's own message folded under it (`server/src/failure.ts`). Every answer
format the app sends is converted for Gemini, which takes one type per field and no empty menu value
(`geminiSchema` in `server/src/models/vision.ts`); a test runs all of them through the conversion.

**In the page** the setting is an oval in the question box (`web/src/ModePill.tsx`, with the choice in
`web/src/useModes.ts` and the reading of `GET /api/modes` in `web/src/modes.ts`). It sits on one bar with the Ask
button and names the mode; its outline is a closed blue line while only our own models and scripts answer, and a
broken amber one, whose dashes travel while a question is out, when a question may go to an outside model. The oval
opens a short list (a sheet from the bottom edge on a phone): the three modes as one choice, each with a few words
and its measured result on held-out image plans. What a mode is made of is kept out of the list: its description and
who does each job show in a card beside the list for the mode under the pointer or with the keyboard's focus. Custom
opens its two pickers under it, where an engine that cannot run here is listed but
cannot be picked. The choice is kept in the browser's `localStorage`
(`blueline.mode`). A remembered choice that cannot run on this server gives way to the server's default, and the panel
says so once. An answer with no value for want of an outside model carries `retry`, and the page then offers to ask
the question again in that mode, which also becomes the setting. A server without `/api/modes` and the static demo
build show no oval and send no mode.

**Which engines can run** is worked out once, when the server starts. An engine that cannot run is listed with the
reason, is not offered in Custom, and is skipped by Best accuracy:

| Engine | Can run when |
|---|---|
| Blueline interpreter (tuned Gemma) | its GGUF file is there: `../models/interpreter/interpreter-q8_0.gguf`, or the file `PLANNER_MODEL` names with `PLANNER_PROVIDER=gemma-local` |
| Blueline detector (trained YOLO11) | the weights are in `../models` (`DETECTOR`, below) |
| Claude Haiku 5.5, Claude Sonnet 5.5 (Anthropic) | `ANTHROPIC_API_KEY` is set (they then run through the API); or the local `claude` CLI is the configured provider (`VISION_PROVIDER` unset or `claude-cli`, or `PLANNER_PROVIDER=claude-cli`) and `claude` is on the PATH. A provider variable that names `claude-cli` keeps the CLI in use although a key is set |
| Gemini 4 Hydrogen (Google) | `GEMINI_API_KEY` is set |
| a reader we host ourselves | `VISION_PROVIDER=openai-compatible` with `VISION_BASE_URL` and `VISION_MODEL`; offered in Custom, never chosen by Best accuracy |

So the public demo (both keys, no CLI) offers every engine through its API, a developer's PC with no variables offers
the Claude engines through the CLI, and a server with `VISION_PROVIDER=none` and no keys has the Blueline engines only.
There Best accuracy and Custom still work: they resolve to the Blueline line-up and their summary says so ("No outside
model can run on this server, so Best accuracy resolves to the Blueline engines. Nothing leaves this server."). An
empty key counts as no key. `VISION_PROVIDER=none` on its own only rules the CLI out: a key still makes its engines
available, and the default mode still calls none of them.

**The vote in Best accuracy.** A drawn symbol is counted by every detector that knows its class and by the reader's
inventory of the drawing, and the middle count is the answer (the lower middle one for an even number of counts). The
inventory is the same single reading that gives the room types, so the vote costs no extra call. The marks on the
drawing are those of a count that equals the answer: the routed detector's boxes, else the other detector's, else the
reader's positions. The source lists every count and the script that took the middle; the `method` sentence reads
`middle of 3 independent counts of window symbols (floorplan-symbols-yolo11l-1280: 14; floorplan-yolo11m-1280: 13;
gemini-api:gemini-4-hydrogen: 11)`, and the answer's `pipeline` is `symbol-vote`. A vote needs three counts: with one
detector installed, or when the reader's call fails, the routed detector answers alone and the method says why. On a
drawing the detectors do not recognise the reader answers alone, as in every mode with a reader.

**A question the mode cannot answer** (in Blueline only, or in Custom without a reader: a count of an unknown kind, a
count in a part of an image plan, a free reading, a question about a building model's facts, a sheet's text) gets no
value. Its `source.needed` says why and which mode would answer it, and the answer carries `retry: { mode: "best" }`
when Best accuracy has an outside model on this server, so that the client can offer to ask again there.

Measured per mode, on the two held-out raster samples of 100 drawings (1,781 questions in the dataset's wording, bulk
mode, 15 November 2026). Vector drawings score the same in every mode (Measured, below):

| Mode | Correct | Outside calls | Cost and time of the outside calls |
|---|---|---|---|
| Blueline only | 1,530, 85.9% (sample A 773 of 916, sample B 757 of 865) | none | nothing leaves the server |
| Best accuracy | 1,576, 88.5% (sample A 807, sample B 769) | one Gemini reading per drawing; one Haiku interpretation per question | a reading: about $0.02 and 8 s, once per drawing; an interpretation: about $0.0003 and 2.8 s |

| Kind | Asked | Blueline only | Best accuracy |
|---|---|---|---|
| Windows | 200 | 97 | 103 |
| Doors | 156 | 119 | 117 |
| Toilet bowls | 200 | 188 | 192 |
| Sinks | 199 | 174 | 179 |
| Showers and bathtubs | 182 | 162 | 170 |
| The drawn symbols together | 937 | 740 | 761 |
| Saunas | 137 | 133 | 133 |
| Kitchens | 129 | 118 | 125 |
| Bedrooms | 125 | 111 | 115 |
| WC rooms | 98 | 95 | 95 |
| Bathrooms | 94 | 87 | 90 |
| Balconies | 61 | 55 | 58 |
| Storeys | 200 | 191 | 199 |
| Room types and storeys together | 844 | 790 | 815 |

Custom with Gemini as the reader counts the symbols as Blueline only does and the room types as Best accuracy does:
1,555, 87.3%.

In the modes Gemini reads at its low thinking level. At the model's own default (high; `GEMINI_THINKING=default`) Best
accuracy scored 1,585 (89.0%) and Custom with Gemini 1,562 (87.7%): 9 and 7 questions more out of 1,781, which is
inside the noise of these samples, for about $0.07 and a median of 29 s per reading instead of $0.02 and 8 s.

The server's side of it:

- `GET /api/modes` returns `{ default, modes, interpreters, readers }`: the three modes, each with its label, a
  description, `auto`, `editable`, `outside` (an outside model is in the line-up), a one-line `summary` ("Nothing leaves
  this server.") and its `lineup`, four rows in display order (`interpreter`, `symbols`, `reader`, `text`) with the
  engines of each; and the engines Custom can pick from, each with `available` and, when it cannot run, `unavailable`.
  `?interpreter=<id>&reader=<id>` describes Custom for those picks.
- `POST /api/ask` takes `mode` (`blueline`, `best`, `custom`; Blueline only when left out) and, read with `custom`
  only, `interpreter` (`blueline`, `haiku`, `gemini`, `keywords`) and `reader` (`none`, `gemini`, `sonnet`). An unknown
  mode or pick, or an engine that cannot run here, is a 400 whose `error` names the choices. The reply carries the
  `mode` that answered.
- `GET /api/health` names the default mode and its models.
- `npm run eval` and `npm run eval:paraphrase` take `--mode`, with `--engine-interpreter` and `--reader` for custom,
  and build their line-up with the same resolver. Without `--mode` the environment picks the models, as before.

## How a question is answered

`server/src/router.ts` picks the pipeline from the file. In the dataset, files with the same name and a different
extension are the same drawing, and `<model>_plan-<level>.pdf` was rendered from `<model>.ifc`, so a question about a
PDF is answered from its vector twin when one is there.

| Drawing | Pipeline | Evidence shown | Model calls to compute the answer |
|---|---|---|---|
| IFC model, or a PDF rendered from one | stored quantities, else geometry, read with web-ifc | storey plan with the measured rooms or elements highlighted | none |
| IFC model, question about its facts (types, materials, properties) | facts extracted from the model, answered by a language model | storey plan when a rule matched | one text call |
| Layered DXF, or a PDF/PNG with a DXF of the same name | room outlines, labels and symbols from the CAD layers | plan with the counted shapes numbered | none |
| PDF sheet with a text layer (schedules, notes) | text rows with positions, answered by a language model | the rows used, boxed on the page | one text call |
| Raster floor plan, a count of a known kind | each of the 13 known kinds (window, door, toilet bowl, sink, shower, bathtub; sauna, kitchen, bedroom, WC room, bathroom, balcony; storey) is counted by our trained detector routed to its class | numbered boxes on the image | none |
| Raster floor plan, anything else | the outside vision model (the reader of the mode), as the fallback: items of other kinds, a count limited to a part of the drawing, a free reading, and any count on a drawing the detectors do not recognise | numbered marks on the image, or the drawing | one vision call per question; one per drawing for the known kinds on an unrecognised drawing, shared by all its questions |

The table is the line-up of Blueline only, where the two rows that need a language model and the last row get no value
and the reason; Best accuracy and Custom put an outside model there (Modes, above). Before a pipeline computes
anything, the question is read by the interpreter, which costs one small text call per question when it is a hosted
model (next section). Vector answers are exact and labelled so; model answers are labelled as estimates.
Models sit behind two interfaces, `VisionModel` (`server/src/models/vision.ts`) and `Detector`
(`server/src/models/detector.ts`), so a provider can be replaced without touching the pipelines.

### The source of an answer

Under the value the app shows a Source block of three lines. They come from the `source` field of the answer
(`AnswerSource` in `server/src/types.ts`), which every pipeline fills where it computes the value:

| Line | What it says | Example |
|---|---|---|
| Understood by | the interpreter model with the reading it returned; or the keyword parser with the reason no model read the question (bulk mode, no interpreter configured, its call failed); or the stated answer type, when that left nothing to interpret | `claude-cli:claude-haiku-5-5` as "net area of apartment A" |
| Calculated by | every script or model that computed, counted, read or worded the value, each with what it did when several contributed; with no value, why nothing was calculated and what it would have taken | `CAD geometry script`; or `IFC facts script (web-ifc)`: extracted the model's facts as text, with `claude-cli:claude-sonnet-5-5`: wrote the answer from those facts |
| From | the file the value was taken from (the vector twin, when the question was asked about a PDF or PNG of it) and what in it was used | `site3387_bldg5238_floor23498.dxf`: indoor room outlines inside unit A: 9 room outlines on layer ROOM_OUTLINE |

Each name carries a tag for its tier, so a reader sees at a glance which answers used only models we trained and ran
ourselves:

| Tag | `tier` | Who | `label`, with `name` as the secondary text |
|---|---|---|---|
| Blueline script | `script` | the keyword parser, the CAD geometry script, the IFC scripts (model records, stored quantities, geometry, facts), the sheet text script, the middle count script of the vote | none: a script is read by its `name` |
| Blueline model | `own-model` | the ONNX detectors and the local Gemma interpreter | `Blueline detector (trained YOLO11)` with the weights, `floorplan-symbols-yolo11l-1280`; `Blueline interpreter (tuned Gemma)` with `gemma-local:interpreter-q8_0` |
| self-hosted model | `self-hosted-model` | a model behind `VISION_PROVIDER=openai-compatible` | `gemma-4-31b (self-hosted)` |
| outside model | `external-model` | `claude-cli`, `anthropic-api`, `gemini-api`, the Roboflow detector, and any provider the app does not know | product and vendor: `Claude Haiku 5.5 (Anthropic)`, `Claude Sonnet 5.5 (Anthropic)`, `Gemini 4 Hydrogen (Google)`, with the id, `gemini-api:gemini-4-hydrogen`; none for an unknown provider |

The `tier` and `name` values are ids and do not change; `label` (`server/src/source.ts`) is what a person reads.

An answer with no value says in `needed` why nothing was calculated and what it would have taken; the block prints it
as "Not calculated", and the note under the block then leaves that sentence out. The `method` sentence of an answer
says the same as the source in one line; the client shows it when a server sends no `source`.

### Local first, the outside vision model as the fallback

Nothing our own models can do is sent to an outside vision model. On a raster drawing the interpreter's call decides
the tier (`server/src/solvers/raster.ts`):

| The interpreter's call | Who answers | Why |
|---|---|---|
| `count_known` on the whole drawing, the drawing in the detectors' style | our detectors, no model call | |
| `count_known` on a drawing where the detectors find fewer than 3 items with 60% confidence (an elevation, a historic scan) | outside vision model, one inventory of the drawing | the detectors' count would be a confident zero |
| `count_known` limited to a part of the drawing ("the kitchen sink", "in enlarged plan 6A") | outside vision model, from the full question | the detectors count on the whole drawing only |
| `count_other` (stairs, wardrobes, fireplaces) | outside vision model | the detectors do not know the kind |
| `read` (a text, a dimension, a schedule entry) | outside vision model | the detectors count items and cannot read |

The source of every raster answer names and tags the tier, and its `method` sentence says it in plain words: `window
symbols counted by our detectors (floorplan-symbols-yolo11l-1280), no outside model`, against `staircases read by the
outside vision model claude-cli:claude-sonnet-5-5 because our detectors do not know this kind of item`. A fallback
model we host ourselves (`VISION_PROVIDER=openai-compatible`) is called the self-hosted vision model there, and a
detector hosted elsewhere (`DETECTOR=roboflow`) an outside detector. When several kinds are asked, each part says its
own tier.

In a line-up without an outside model (Blueline only, Custom without a reader, or a script run with
`VISION_PROVIDER=none`) a question of the fallback tier is not an error: the answer has no value, and its note says
why and what would answer it, for example `No answer: this question needs an outside vision model, because our
detectors count on the whole drawing only, not in a part of it, and Blueline only calls none. Best accuracy, or a
reader chosen in Custom, would answer it.` The same holds for a question about a building model's facts, which a
language model writes the answer to. When one of several kinds cannot be counted, the others are still counted and
marked, and the note says which one is missing.

## How questions are understood

**The model interprets, the scripts compute.** Every question goes to an interpreter: a language model that gets the
question, a short menu of what this drawing supports, and the reading of the keyword parser as a hint ("a keyword
parser reads this as: count all doors on the whole floor"; the model is told that this parser ignores qualifiers).
It returns one structured call: the operation, its classes and parameters, whether the user asked to be shown things,
and the answer type. Code then computes the answer and the marks, so the numbers stay exact
(`server/src/planner.ts`, called from `server/src/router.ts`).

| Drawing | Menu the interpreter sees | The call it returns |
|---|---|---|
| Layered DXF | this plan's room labels with the number of rooms carrying each, its apartments, its room numbers, the number of each symbol (median 0.5k characters, at most 1.2k over the 1,040 Swiss plans; labels and numbers are cut off at 60 and 120) | `operation` (`count_symbols`, `count_apartments`, `rooms`, `area_apartment`, `area_floor`, `compare`, `none`), `symbols[]`, `labels[]` (only this plan's labels can be chosen), `room_numbers[]`, `apartments[]`, `pick` (all, largest, smallest), `measure` (count, area, average, list), `missing[]`, `broader_label`, `reason`, `locate`, `answer_type` |
| Raster image, or a PDF sheet | the 13 kinds our detectors know | `operation` (`count_known`, `count_other`, `read`), `targets[]`, `whole_drawing`, `items`, `locate`, `answer_type` |
| IFC model | storey names with elevations and room counts, the element classes present with their counts, room names (at most 60, those sharing a word with the question first; median 1.0k characters, at most 1.9k over the 29 models) | `operation` (`count_elements`, `rooms`, `storey_total`, `model_facts`, `none`), `elements[]`, `storey` (one of the model's storeys, or the whole model), `rooms[]`, `pick`, `measure`, `quantity`, `missing[]`, `reason`, `locate`, `answer_type` |

What the code does with a call:

- Several kinds or several rooms in one question are all counted or measured and all marked; the answer is the total
  and a sentence says what it consists of ("The total of 31 consists of 20 doors and 11 windows").
- Symbols of one apartment or room on a DXF plan are found by containment: a fixture lies inside its room, a door or
  window reaches the outline of the rooms it serves, so an entrance door belongs to its apartment.
- Sums, averages and comparisons are computed from the rooms the model selects ("Apartment A: 107.40 m²; Apartment B:
  80.20 m². Largest: apartment A, 27.20 m² more than apartment B."). Rooms that tie for largest are all named.
- A room number, label, apartment or storey that the drawing does not have is not replaced: the answer says that the
  drawing does not have it and lists what it has.
- The answer says which of the plan's labels a word was matched to, and it is labelled an estimate when the model
  took a broader label for want of an exact one ("the living room" on a plan that labels every room 'Zimmer').
- A question the drawing cannot answer gets the reason in a sentence, and a request to show, mark or find things
  returns the marks or says why there are none.
- A raster question limited to part of the drawing ("the kitchen sink", "in enlarged plan 6A") is counted by the
  outside vision model from the full question, because the detectors count on the whole drawing only; the method
  line says so.

The first line of every answer's source says how the question was read and by whom, and the `method` sentence starts
with the same, for example `understood as "count doors in apartment A" by claude-cli:claude-haiku-5-5; door symbols on
layer DOOR; those lying in or reaching the outline of one of the 11 rooms in apartment A`.

The keyword parsers read a question on their own in two cases only. The source then names the keyword parser with
the reason, and the method sentence starts with `read by the keyword parser (...)`:

- **Bulk mode**, `INTERPRETER=templates` or `--interpreter templates` in the evaluation scripts: free, and how the
  dataset's own wording is scored in the tables below. `npm run eval` refuses to send more than 200 questions to the
  interpreter unless `--interpreter model` is given.
- **Fallback**: no interpreter model is configured (`VISION_PROVIDER=none` or `PLANNER_PROVIDER=none`), or its call
  failed or named nothing runnable. A show-request is then honoured only when it names nothing but the thing to show.

One interpretation is one text call, cached by question and menu. Measured with `PLANNER_MODEL=claude-haiku-5-5`
through the local CLI over 646 calls: 4.4 seconds per call on average (median 4.2, nine in ten under 5.5) and $0.0007
(DXF $0.0007, raster $0.0006, IFC $0.0009). A request is 3 to 6 thousand characters, of which the system prompt is 2.1
to 3.5 thousand. Without `PLANNER_MODEL` the vision model does the interpreting, which is slower. The interpreter only
needs the text side of `VisionModel` with a JSON schema, so `PLANNER_PROVIDER` and `PLANNER_MODEL` can point it at any
model.

Model first against bulk mode on the same questions in the dataset's own wording, asked without the answer type
(14 November 2026, interpreter claude-haiku-5-5):

| Sample | Questions | Bulk mode | Model first |
|---|---|---|---|
| Swiss apartment floors, 30 plans, all 12 kinds, English | 150 | 150 | 150 |
| Swiss apartment floors, 10 plans, German, French and Italian wording | 20 | 20 | 20 |
| Raster floor plans, the 30 drawings of `raster-dev.txt`, all 12 kinds, English | 90 | 76 | 76 |
| Raster floor plans, 12 drawings, Finnish wording | 12 | 10 | 10 |
| IFC models, 30 models and sheets, numeric questions, English | 58 | 57 | 57 |
| IFC models, 7 models and sheets, numeric questions in other languages | 13 | 8 | 12 |
| Practice drawing sheets, with the dataset's answer type | 48 scorable | 48 | 48 |

The raster rows of this table and of the next three were measured while room types and storeys were still read by the
vision model (`RASTER_DETECTOR_TARGETS=symbols` today); they compare how questions are read, which the local-first
default does not change.

No kind is read worse by the model than by the templates; every miss is a counting or geometry miss that both modes
share. The bulk-mode misses on IFC questions in other languages come from the keyword guess of the answer type; with
the type stated, as in the tables under Measured, the cached rewrite of `server/src/rewrite.ts` reads them.

Reworded dataset questions (`npm run eval:paraphrase`): a language model rewrites each sampled question in one of
five styles (casual, show/mark/where, terse keywords, another language, typos), the app answers it without being told
the answer type, and the original expected answer decides.

| Sample | Questions | Model first | Same questions in the dataset's wording |
|---|---|---|---|
| Swiss apartment floors, 24 plans | 120 | 120 (100%) | 120 |
| Raster floor plans, the 30 drawings of `raster-dev.txt` | 90 | 76 (84%) | 76 |
| IFC models, 20 models | 40 | 40 (100%) | 40 |

The style set was used while building the interpreter, so these are development numbers, not held-out ones. On raster
drawings 89 of the 90 reworded questions were read as the kind of the original; the other one ("... the ones marked
MH") was read as a count limited to part of the drawing and answered by the vision model. The 14 raster misses are
counting errors that the dataset's wording has as well.

### A local interpreter: fine-tuned FunctionGemma on the CPU

The Blueline interpreter is a small open model inside the Node process. It reads every question in Blueline only,
whenever its weights file is there, and a script run without `--mode` gets it with `PLANNER_PROVIDER=gemma-local`. It is
FunctionGemma 270M, fine-tuned on this app's own question-to-call pairs, as a 292 MB GGUF file (q8_0) run on the CPU
with `node-llama-cpp` (`server/src/models/gemma.ts`). Nothing leaves the machine and a call costs nothing. The planner
and the router are unchanged. The provider puts the first line of the instruction, a one-line summary of the schema and
the drawing's menu into the developer turn, and the question with the keyword parser's reading into the user turn,
exactly as in training. A grammar built from the request's JSON schema constrains the output, so a call is always
valid and names only this drawing's labels, apartments and storeys. A missing model file or an unusable call leaves
the question to the keyword parser, like any other interpreter failure.

```bash
# the weights are not in the repository: download them (292 MB) to models/interpreter/interpreter-q8_0.gguf
curl -L --create-dirs -o ../models/interpreter/interpreter-q8_0.gguf https://huggingface.co/NiceK1/blueline-interpreter-functiongemma-270m/resolve/main/interpreter-q8_0.gguf
PLANNER_PROVIDER=gemma-local npm start
# or name the file; PLANNER_THREADS sets the CPU threads (default 8, or fewer cores)
PLANNER_PROVIDER=gemma-local PLANNER_MODEL=C:/models/interpreter-q8_0.gguf npm start
```

Haiku against the local Gemma on the same questions, answered by the app end to end (14 November 2026; the raster
sample is the 24 drawings of `raster-dev.txt` now on disk):

| Sample | Questions | claude-haiku-5-5 | Local Gemma | What the local model missed |
|---|---|---|---|---|
| Reworded, Swiss apartment floors, 24 plans | 120 | 120 | 119 | "all the bedrooms" matched to 'Soggiorno' on a plan that labels them 'Camera da letto' |
| Reworded, raster floor plans | 72 | 65 | 64 | three misreadings that add kinds nobody asked for ("bedrooms makuuhuone MH number", two questions with typos about kitchens and sinks); the other five are counting errors that the dataset's wording has as well |
| Reworded, IFC models, 20 models | 40 | 40 | 40 | |
| Dataset wording, Swiss, 30 plans, English | 150 | 150 | 150 | |
| Dataset wording, Swiss, German, French and Italian | 20 | 20 | 20 | |
| Dataset wording, raster, English | 72 | 65 | 65 | the same seven counting errors |
| Dataset wording, raster, Finnish | 12 | 11 | 11 | the same counting error |
| Dataset wording, IFC, 30 models and sheets, English | 58 | 57 | 56 | a room name with an apostrophe ('IMMUNIZ'N ROOM (1D40)') cut at the apostrophe; the other is a wall-area miss both share |
| Dataset wording, IFC, other languages | 12 | 11 | 11 | the same wall-area miss |

The reworded samples use the development styles, which the model was trained on (on other plans; the IFC models are
partly the same). On held-out pairs, from plans and models outside training, test-only question templates and
rewording styles kept for the test (`heldout` in `server/src/paraphrase.ts`), it is weaker than Haiku:

| Held-out pairs, the call compared field by field | Pairs | Untuned FunctionGemma | Local Gemma | claude-haiku-5-5 (first 200) |
|---|---|---|---|---|
| Whole call, all pairs (Python, free decoding) | 1,257 | 0 of 200 | 1,075 (85.5%) | |
| Whole call, first 200 pairs (Node, q8_0, grammar) | 200 | | 174 (87.0%) | 160 (80.0%) |
| Fields the operation reads, first 200 pairs | 200 | | 174 (87.0%) | 188 (94.0%) |
| ... dataset wording | 36 | | 35 | 33 |
| ... constructed questions | 62 | | 57 | 58 |
| ... reworded in the held-out styles | 102 | | 82 (80.4%) | 97 (95.1%) |
| ... layered DXF / IFC / raster | 94 / 59 / 47 | | 89 / 54 / 31 | 88 / 57 / 43 |

Haiku loses whole-call matches to fields its operation does not read (`measure` on an apartment area, `""` written
out), which the second measure ignores. The local model's misses on all 1,257 pairs: it copies an item it never saw
in training wrongly into `items` (raster `count_other` 11 of 54), it misses a show-request that avoids the words show,
mark and where (19 of 62), it is weak in languages outside its training (Polish, Danish, Norwegian, Portuguese, Dutch,
Estonian: 71 of 119), and it drops the second kind in "compare the number of X with the number of Y". Dataset wording
is read right 199 times of 201, constructed questions 359 of 397, held-out rewordings 517 of 659.

One interpretation takes 0.9 seconds on a laptop CPU (i7-11800H, 8 threads; median 0.93, nineteen in twenty under
1.4) against 4.6 seconds for Haiku through the CLI; the model loads in about a second on the first question. The
prompt is 300 to 1,400 tokens and the call 30 to 65. How the pairs were built and the model trained:
`training/gemma/README.md`; `scripts/interp-pairs.ts` writes the pairs, `scripts/interp-eval.ts` scores any
interpreter on the held-out ones, `scripts/gemma-parity.ts` checks the tokens after a conversion.

## Measured

Scored with the dataset's rules (counts exact; areas, lengths and volumes within 2%) on 14 November 2026, in bulk
mode.

| Part of the dataset | Questions | Correct | |
|---|---|---|---|
| Swiss apartment floors (DXF geometry) | 37,584 | 37,376 | 99.4% |
| IFC models, numeric questions | 3,062 | 3,044 | 99.4% |
| Practice drawing sheets (PDF text) | 48 scorable | 48 | 100% |
| Raster floor plans, 200 held-out drawings, Blueline only: our detectors alone | 1,781 | 1,530 | 85.9% |
| Raster floor plans, the same drawings, Best accuracy: the vote on symbols, Gemini 4 Hydrogen for room types | 1,781 | 1,576 | 88.5% |
| IFC models, free-text questions (graded sample it was not tuned on) | 46 | 25, and 13 partly | 54% |

Raster floor plans, on drawings the detectors never saw in training (two samples of 100, English questions; the
Finnish questions map to the same targets):

| Who answers | Sample A (916) | Sample B (865) | Both | Vision calls per drawing |
|---|---|---|---|---|
| Blueline only (`--mode blueline`): our trained detectors for all 13 kinds | 773 | 757 | 1,530, 85.9% | 0 |
| Best accuracy (`--mode best`): the middle of both detectors' counts and Gemini 4 Hydrogen's on symbols, Gemini for room types and storeys | 807 | 769 | 1,576, 88.5% | 1, shared by all questions about the drawing |
| The same with Gemini at its default thinking level (`GEMINI_THINKING=default`) | 813 | 772 | 1,585, 89.0% | 1, shared by all questions about the drawing |
| The line-up of Custom with Claude Sonnet 5.5 as the reader, measured before the modes with `RASTER_DETECTOR_TARGETS=symbols` and Sonnet through the CLI: detectors for drawn symbols, one Sonnet reading for room types and storeys | 791 | 757 | 1,548, 86.9% | none for a symbol question; 1 once a room type or storey is asked |
| Custom with Gemini 4 Hydrogen as the reader (`--mode custom --reader gemini`) | 791 | 764 | 1,555, 87.3% | none for a symbol question; 1 once a room type or storey is asked |
| Sonnet 5.5 alone (`--no-detector`) | 713 | 660 | 1,373, 77.1% | 1 |
| Gemini 4 Hydrogen alone (`--no-detector`) | 791 | 725 | 1,516, 85.1% | 1 |
| Gemma 4 31B alone, hosted (`--no-detector`, sample A only, 12 failed calls) | 537 | | 58.6% | 1 |

Gemini 4 Hydrogen is the best outside reader of room types measured here (822 of 844 on both samples, against 808 for
Sonnet 5.5 and 790 for our detectors), while our detectors are ahead of it on the drawn symbols (740 of 937 against 694).
The public demo therefore uses our detectors for symbols and Gemini for room types until our own models match it there.

All 200 drawings pass the detectors' in-domain guard, so the default made no vision call on these samples. What the
optional setting buys, per room kind on both samples (exact counts; the symbols are the same in both rows above):

| Kind | Asked | Our detectors (default) | Sonnet 5.5 reading |
|---|---|---|---|
| Storeys | 200 | 191 | 196 |
| WC rooms | 98 | 95 | 97 |
| Kitchens | 129 | 118 | 125 |
| Saunas | 137 | 133 | 129 |
| Balconies | 61 | 55 | 58 |
| Bedrooms | 125 | 111 | 116 |
| Bathrooms | 94 | 87 | 87 |
| All seven | 844 | 790 | 808 |

Windows are the weak kind (97 of 200 drawings counted exactly); doors are at 76%, every other kind between 87% and 99%.

The vote of Best accuracy was first measured with Sonnet 5.5 as the third count: 809 and 760 (88.1%). With Gemini 4
Hydrogen it scores 813 and 772 (89.0%) at the model's default thinking level and 807 and 769 (88.5%) at low, which
the modes use. It needs a reading of every drawing, which is why it is a mode and not the
default.

Things that were tried and measured but are not in the code:

- Passing the detectors' findings to the vision model as hints lifted the vision model's own score from 713 to 779 on
  sample A, but the vote dropped, because the hinted reading stopped being an independent opinion.
- Three vision readings per drawing instead of one gained a few questions at three times the cost.
- A larger detector at a higher resolution (YOLO11x at 1536 px) scored below YOLO11l at 1280 px on the test drawings.
- Reading the room labels (MH, K, KH, WC, S, PARVEKE, "2. kerros") with a local OCR engine, to close the gap to the
  vision model on room types without a model call. PP-OCRv4 through `onnxruntime-node` reads the labels well where
  they are printed upright; tesseract.js reads almost nothing on these line drawings. Counting the seven room kinds
  from the labels alone scored 267 of 445 on sample A and 241 of 399 on sample B, against 410 and 380 for the
  detectors: 20 and 13 of the 100 drawings carry no label it can read in any rotation, many rooms have none (open
  kitchens), and the single letters K and S also turn up as noise and in apartment formulas ("3h+k+s"). The best
  combination with the detectors' boxes, chosen on sample A (a kitchen box under the threshold counts when a kitchen
  label lies in it; more sauna labels than sauna boxes win; a bathroom box whose only label names another room is
  dropped), gained 4 questions on A (414) and lost 2 on B (378), so it is not in the app. It would have added about
  1 second per drawing (one reading upright and one upside-down; all four rotations take 2 seconds).

## Measure it yourself

```
npm run eval -- --source swiss_dwellings --interpreter templates       # bulk mode: keyword parsers, no model call
npm run eval -- --source ifc_models --interpreter templates
npm run eval -- --source opening_design --interpreter templates        # needs STOA_DATASET=../dataset
npm run eval -- --source opening_design --interpreter model            # the interpreter reads every question
npm run eval -- --mode blueline --source cubicasa5k --sample ../raster-test100.txt --interpreter templates   # sample A in Blueline only; raster-test100b.txt is sample B
npm run eval -- --mode best --source cubicasa5k --sample ../raster-test100.txt --interpreter templates       # Best accuracy: needs the keys, one reading per drawing
npm run eval -- --mode custom --reader gemini --source cubicasa5k --sample ../raster-test100.txt --interpreter templates   # Custom; --engine-interpreter picks its interpreter
npm run eval -- --source cubicasa5k --sample ../raster-test100.txt --interpreter templates     # without --mode the environment picks the models
RASTER_DETECTOR_TARGETS=symbols npm run eval -- --source cubicasa5k --sample ../raster-test100.txt --interpreter templates   # room types and storeys by the vision model
npm run eval -- --source cubicasa5k --sample ../raster-test100.txt --interpreter templates --no-detector                      # the vision model alone
npm run eval -- --source ifc_bench --per-file 2 --judge --interpreter templates   # free text, graded by a language model
npm run eval:paraphrase -- --source swiss_dwellings --drawings 24 --per-file 5      # reworded questions, model first
npm run eval:paraphrase -- --source cubicasa5k --sample ../raster-dev.txt --drawings 30 --per-file 3
npm run eval:paraphrase -- --source ifc_models --drawings 20 --per-file 2 --original   # same sample, dataset wording
npm run eval:paraphrase -- --source swiss_dwellings --drawings 30 --per-file 5 --original --interpreter templates   # and in bulk mode
npm test
# what a call costs and how long it takes (docs/results.md); the last three make paid calls
npx tsx scripts/measure-latency.ts                                        # scripts and detectors, first and later questions
PLANNER_PROVIDER=anthropic-api PLANNER_MODEL=claude-haiku-5-5 npx tsx scripts/measure-interp-cost.ts <pairs>/test.jsonl 0 40
VISION_PROVIDER=anthropic-api npx tsx scripts/measure-text-cost.ts ifc_bench 8 1
npx tsx scripts/measure-gemini-reading.ts low raster-test100.txt 0 20 4   # tokens, seconds and cost per drawing reading
```

Set `STOA_DATASET=../dataset-full` to score against the full dataset instead of the preview; the practice sheets and
the drawings of `raster-dev.txt` are in the preview only. Model calls are cached in `.cache/vision`, so a repeated
run costs nothing. `raster-dev.txt` is for tuning prompts; the two test samples are held out from detector training
and should not be tuned on.

## Configuration

The server and the scripts read `../.env` and the environment. The server answers in the mode each question names,
so for it the variables decide which engines can run (Modes, above); a script run without `--mode` takes its models
straight from them, as it always did.

| Variable | For the server and a script run with `--mode` | For a script run without `--mode` |
|---|---|---|
| `STOA_DATASET` | dataset folder, default `../dataset` | the same |
| `ANTHROPIC_API_KEY` | makes Claude Haiku 5.5 and Claude Sonnet 5.5 available, through the API | used with `VISION_PROVIDER` or `PLANNER_PROVIDER` `anthropic-api` |
| `GEMINI_API_KEY` | makes Gemini 4 Hydrogen available | used with `gemini-api` |
| `GEMINI_THINKING` | Gemini's thinking level in the modes: `low` (default), `medium`, `high`, or `default` for the model's own | the level for `gemini-api`; unset leaves it to the model |
| `VISION_PROVIDER` | unset or `claude-cli`: the Claude engines may run through the local `claude` CLI (without a key, or always when `claude-cli` is named). `openai-compatible` (with `VISION_BASE_URL`, `VISION_MODEL`, optionally `VISION_API_KEY` and `VISION_IMAGE_MIN_SIDE`): a reader we host ourselves, offered in Custom. Any other value, `none` included, only rules the CLI out | the vision model: `claude-cli` (default), `anthropic-api`, `gemini-api`, `openai-compatible`, or `none`: no outside model, questions read by the keyword parsers unless `PLANNER_PROVIDER` names an interpreter, and a question that only an outside model could answer gets no value and the reason |
| `VISION_MODEL` | not read: the engines are the measured models (`claude-haiku-5-5`, `claude-sonnet-5-5`, `gemini-4-hydrogen`); it names the model of a self-hosted reader | model id, default `claude-sonnet-5-5` |
| `PLANNER_PROVIDER`, `PLANNER_MODEL` | `gemma-local` with a `.gguf` path in `PLANNER_MODEL` names the Blueline interpreter's weights file; `claude-cli` makes the CLI the way to the Claude engines. Otherwise not read | the interpreter model that reads every question, default the vision model; a small one is enough (measured: `claude-haiku-5-5`). `PLANNER_PROVIDER` picks its provider (default the vision provider; `gemma-local` is the fine-tuned Gemma on this machine's CPU; `none` leaves the keyword parsers) |
| `PLANNER_EFFORT`, `VISION_EFFORT`, `PLANNER_THREADS` | the effort of Haiku and of Sonnet through the CLI; the CPU threads of the Blueline interpreter | the same |
| `INTERPRETER` | `templates` is the bulk mode: the keyword parsers read the questions and no interpreter is asked, in any mode | the same |
| `DETECTOR` | `onnx` (our weights in `../models`, the default when present), `roboflow` (needs `ROBOFLOW_API_KEY`; an outside detector), `none` | the same |
| `RASTER_DETECTOR_TARGETS` | not read: the mode decides (every kind in Blueline only, drawn symbols when there is a reader) | `all` (default: the detectors count every kind they know, with no vision call), `symbols` (the detectors count drawn symbols and one reading by the vision model gives room types and storeys), `none` (the vision model counts everything) |
| `INVENTORY_PROMPT` | version of the prompt for the reader's inventory of a drawing, default `v3` | the same |

The first count on a drawing takes about 3 seconds on a laptop CPU (both detectors scan it once; later questions about
the same drawing reuse the scan) and costs nothing. A fallback reading by the outside model takes about 5 seconds
and costs about $0.009 with `anthropic-api`; through the local CLI it takes about 20 seconds.

## Detector weights

`../models/*.onnx` with a `.json` next to each (classes, input size, per-class thresholds tuned on validation
drawings). They are trained with the scripts in `../training` on the public CubiCasa5k annotations, which Stoa's raster
drawings come from. Ultralytics YOLO is AGPL-3.0 and CubiCasa5k is CC BY-NC-SA 4.0, so the weights are for
non-commercial use. The weights are not in the repository.
