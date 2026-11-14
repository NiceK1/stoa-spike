# Blueline: measured accuracy, cost and speed

Everything here was measured on the Stoa dataset with the dataset's own scoring rules (a count must be exact; an
area, length or volume must be within 2%). State of 15 November 2026. Costs are list prices in US dollars; times are
on a laptop CPU (i7-11800H) unless a line says otherwise.

## In short

- Vector drawings are answered by geometry scripts with no model at all: 99.4% right on all 37,584 questions about
  Swiss apartment floors and on all 3,062 numeric questions about IFC models, in milliseconds, at no cost.
- Raster floor plans are answered by detectors we trained ourselves: 85.9% right on 200 drawings they never saw,
  with no call to an outside model. A hosted vision model alone gets 77.1% (Claude Sonnet 5.5) or 85.1% (Gemini 4
  Hydrogen) on the same questions and costs $0.009 or about $0.07 per drawing.
- The best line-up we measured adds one Gemini reading per drawing to our detectors: 89.0%, for about $0.07 and
  half a minute per drawing.
- Questions in any wording are turned into a structured call by a small Gemma we fine-tuned. It runs on the CPU in
  0.9 seconds, costs nothing, and gives the same end results as Claude Haiku 5.5 on 536 of 556 test questions
  against Haiku's 539.
- Projected over the three numeric parts of the dataset (126,160 questions): about 90% right with our own models
  only, about 92% with the best line-up.

## Accuracy by part of the dataset

| Part of the dataset | Questions in the dataset | Measured on | Right |
|---|---|---|---|
| Swiss apartment floors (CAD geometry) | 37,584 | every question | 37,376 (99.4%) |
| IFC building models, numeric answers | 3,062 | every question | 3,044 (99.4%) |
| Raster floor plans, our own models only | 85,514 | 1,781 questions on 200 held-out drawings | 1,530 (85.9%) |
| Raster floor plans, best line-up | 85,514 | the same 1,781 questions | 1,585 (89.0%) |
| Practice drawing sheets | 64 | the 48 with a numeric answer | 48 (100%) |
| IFC building models, free-text answers | 820 | 46 questions it was not tuned on, graded by a language model | 25 right, 13 partly right, 8 wrong |

The raster drawings were held out from detector training, in two samples of 100 (`raster-test100.txt`,
`raster-test100b.txt`). The sheets and the free-text answers need a language model to word the answer, so our own
models alone do not answer those two parts (884 questions, 0.7% of the dataset).

## Raster floor plans: who answers, how often right, at what price

1,781 count questions on 200 held-out drawings. "Blueline detectors" are our two YOLO11 models (ONNX, on the CPU).

| Who answers | Right | Outside calls per drawing | Outside cost per drawing |
|---|---|---|---|
| Blueline detectors alone | 1,530 (85.9%) | 0 | $0 |
| Best line-up: symbols by the middle count of the two detectors and Gemini's reading; room types by Gemini | 1,585 (89.0%) | 1 | about $0.07 |
| Detectors for drawn symbols, Gemini 4 Hydrogen for room types | 1,562 (87.7%) | 1 once a room type is asked | about $0.07 |
| Detectors for drawn symbols, Claude Sonnet 5.5 for room types | 1,548 (86.9%) | 1 once a room type is asked | $0.009 |
| Detectors and Sonnet vote on symbols, Sonnet for room types (removed from the app on 14 November) | 1,569 (88.1%) | 1 | $0.009 |
| Gemini 4 Hydrogen alone | 1,516 (85.1%) | 1 | about $0.07 |
| Claude Sonnet 5.5 alone | 1,373 (77.1%) | 1 | $0.009 |
| Gemma 4 31B alone, hosted (first sample only, 916 questions, 12 failed calls) | 537 (58.6%) | 1 | not priced |

The best line-up is computed from the counts each component gave for every question when it was run through the app
on its own; it is not yet one setting in the app. The app is getting a switch between the first two lines ("Blueline
only", the default, and "Best accuracy") and a third position to pick the engines by hand; this page will carry the
numbers measured through that switch when it ships.

Per kind of question (right answers out of the number asked):

| Kind | Asked | Blueline detectors | Best line-up | Gemini alone | Sonnet alone |
|---|---|---|---|---|---|
| Toilet bowls | 200 | 188 | 193 | 184 | 181 |
| Sinks | 199 | 174 | 180 | 164 | 143 |
| Showers and bathtubs | 182 | 162 | 168 | 155 | 130 |
| Doors | 156 | 119 | 120 | 106 | 52 |
| Windows | 200 | 97 | 102 | 85 | 59 |
| Storeys | 200 | 191 | 198 | 198 | 196 |
| WC rooms | 98 | 95 | 97 | 97 | 97 |
| Kitchens | 129 | 118 | 127 | 127 | 125 |
| Saunas | 137 | 133 | 134 | 134 | 129 |
| Balconies | 61 | 55 | 59 | 59 | 58 |
| Bedrooms | 125 | 111 | 115 | 115 | 116 |
| Bathrooms | 94 | 87 | 92 | 92 | 87 |
| All | 1,781 | 1,530 | 1,585 | 1,516 | 1,373 |

Our detectors lead on everything that is drawn as a symbol; the outside models lead on room types, which are read
from labels. Windows are the weak kind for everyone: the same window is drawn as one object in some plans and as two
in others, and the annotations follow the drawing.

## Understanding the question

A language model reads every question and returns a structured call (what to count or measure, where, whether to
mark it); scripts and detectors then compute the answer. Three interpreters were measured.

End results of the app on the same questions, by who interpreted them:

| Sample | Questions | Claude Haiku 5.5 | Blueline interpreter (tuned Gemma) |
|---|---|---|---|
| Reworded, Swiss apartment floors | 120 | 120 | 119 |
| Reworded, raster floor plans | 72 | 65 | 65 |
| Reworded, IFC models | 40 | 40 | 40 |
| Dataset wording, Swiss, English | 150 | 150 | 150 |
| Dataset wording, Swiss, German, French and Italian | 20 | 20 | 20 |
| Dataset wording, raster, English | 72 | 65 | 65 |
| Dataset wording, raster, Finnish | 12 | 11 | 11 |
| Dataset wording, IFC, English | 58 | 57 | 56 |
| Dataset wording, IFC, other languages | 12 | 11 | 10 |
| All | 556 | 539 | 536 |

"Reworded" means a language model rewrote dataset questions in five styles (casual, show-me, terse keywords, another
language, typos) and the original expected answer decides. The raster misses are counting errors that both
interpreters share. With no interpreter, a keyword parser answers 103 of 250 reworded questions; with one, 236.

The call itself, compared field by field on 200 question-to-call pairs from drawings, question templates and
rewording styles that were kept out of training:

| Interpreter | Calls right in every field the operation reads | Dataset wording (36) | Constructed questions (62) | Held-out rewordings (102) |
|---|---|---|---|---|
| Claude Haiku 5.5 | 188 (94.0%) | 33 | 58 | 97 |
| Blueline interpreter, three epochs (current) | 183 (91.5%) | 36 | 56 | 91 |
| Blueline interpreter, 0.85 epoch (first version) | 174 (87.0%) | 35 | 57 | 82 |
| The same Gemma before fine-tuning | 0 | | | |

The Blueline interpreter is FunctionGemma 270M fine-tuned on 53,632 question-to-call pairs generated from this app,
run as a 292 MB file on the CPU. On all 1,257 held-out pairs it gets 1,093 right (87.0%). Its known weak spots:
languages it was not trained on (a Romanian and a Dutch question in the table above), and show-me requests that
avoid the words show, mark and where.

## What an answer costs and how long it takes

| Step | Runs | Cost per call | Time per call | How often |
|---|---|---|---|---|
| CAD geometry script | our server, CPU | $0 | 4 ms for the first question on a plan, under 1 ms after | every question about a DXF plan |
| IFC scripts | our server, CPU | $0 | 0.36 s for the first question on a model (median; up to 2.9 s), 15 ms after | every numeric IFC question |
| Blueline detectors | our server, CPU | $0 | 2.7 s for both models; 1.1 s per model on the demo server | once per raster drawing; later questions reuse the scan (8 ms) |
| Blueline interpreter (tuned Gemma) | our server, CPU | $0 | 0.9 s | once per question |
| Claude Haiku 5.5 as interpreter | Anthropic API | $0.0003 | 2.8 s | once per question |
| Gemini 4 Hydrogen reading a drawing | Google API | $0.07 on average, $0.05 median, $0.015 to $0.27 | 38 s on average, 29 s median | once per raster drawing |
| Claude Sonnet 5.5 reading a drawing | Anthropic API | $0.009 | 4.7 s | once per raster drawing |
| Claude Sonnet 5.5 wording a sheet answer | Anthropic API | $0.018 | 3.6 s | once per sheet question |
| Claude Sonnet 5.5 wording an IFC free-text answer | Anthropic API | $0.017, two calls per question | 3.4 s per call | every free-text IFC question |

How the outside prices were obtained: the Anthropic figures are what the API reported for our calls at $2 and $10 per
million input and output tokens for Sonnet 5.5 and $0.10 and $0.50 for Haiku 5.5. The Gemini figure is its token
use on 20 held-out drawings (2,928 input tokens, 454 output tokens and 8,156 thinking tokens per reading on
average) at Google's listed $1.50 and $7.50 per million input and output tokens; thinking tokens are billed as
output and vary from 1,069 to 34,644 per drawing, which is where both the cost and the wait come from.

Put together, for one raster drawing and the questions asked about it:

| Line-up | Outside cost | Wait for the first answer | Wait for later answers |
|---|---|---|---|
| Our own models only | $0 | about 3.6 s (detectors and interpreter) | about 0.9 s (interpreter) |
| Best line-up, Haiku interpreting | about $0.07 per drawing and $0.0003 per question | about half a minute (Gemini's reading) | about 2.8 s (interpreter) |
| Sonnet alone, for comparison | $0.009 per drawing | about 5 s | cached reading |

And for the whole raster part of the dataset (85,514 questions on 4,787 drawings):

| Line-up | Projected right | Outside cost for all drawings |
|---|---|---|
| Our own models only | 85.9% | $0 |
| Best line-up | 89.0% | about $330 for the readings, about $27 if Haiku interprets every question |
| Gemini 4 Hydrogen alone | 85.1% | about $330 |
| Claude Sonnet 5.5 alone | 77.1% | about $43 |

The vector parts cost nothing in any line-up. Scoring the dataset's own wording needs no interpreter either: the
keyword parser reads it identically, which is how the full-dataset numbers above were run.

## What the models cost to make

Both models were trained on Verda with a 200 EUR coupon, of which about 79 EUR was spent by the morning of
15 November: an A100 instance for a day (data, training queue, and the public demo) and a four-hour burst of eight
L40S GPUs at spot price for eight detector runs side by side. One detector run takes 75 to 105 minutes on one GPU;
the interpreter's three epochs took about 90 minutes. Details and the run-by-run history:
[what we built on Verda](verda.md), [training/README.md](../training/README.md).

## How to repeat it, and what to keep in mind

The commands for the accuracy numbers are in [app/README.md](../app/README.md) under "Measure it yourself"; model
calls are cached, so a repeated run costs nothing. The cost and time figures come from timing the app's own calls on
samples: 20 drawing readings by Gemini, 40 interpretations by Haiku, 19 text calls by Sonnet, and 234 answers by the
scripts and detectors.

- The raster numbers come from 200 drawings; three training runs of one recipe differ by about 13 questions in
  2,235, so differences of a few questions between lines are within noise. The gap between our detectors and the
  outside models on symbols is far outside it.
- Gemini's cost per reading swings by a factor of ten with its thinking; the average is from 20 drawings.
- The free-text IFC answers are graded by a language model on 46 questions, a small sample.
- The reworded questions use styles that were also used while building the interpreters; the field-by-field table
  is the held-out measure.
- Times were taken on one laptop and on the demo server's six cores; they are not a load test.
