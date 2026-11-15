# Blueline: measured accuracy, cost and speed

Everything here was measured on the Stoa dataset with the dataset's own scoring rules (a count must be exact; an
area, length or volume must be within 2%). State of 15 November 2026. Costs are list prices in US dollars; times are
on a laptop CPU (i7-11800H) unless a line says otherwise.

The app answers in one of three modes, chosen in the question box: **Blueline only** (the default: our own models
and scripts, nothing is sent out), **Best accuracy** (the server adds outside models where they do better) and
**Custom** (the user picks the models). The numbers below are measured through those modes.

## In short

- Vector drawings are answered by geometry scripts with no model at all: 99.4% right on all 37,584 questions about
  Swiss apartment floors and on all 3,062 numeric questions about IFC models, in milliseconds, at no cost.
- Raster floor plans in Blueline only are answered by detectors we trained ourselves: 85.9% right on 200 drawings
  they never saw, with no call to an outside model. A hosted vision model alone gets 77.1% (Claude Sonnet 5.5) or
  85.1% (Gemini 4 Hydrogen) on the same questions and costs $0.009 to $0.07 per drawing.
- Best accuracy adds one Gemini reading per drawing to our detectors: 88.5%, for about $0.02 and 8 seconds per
  drawing.
- Questions in any wording are turned into a structured call by a small Gemma we fine-tuned. It runs on the CPU in
  0.9 seconds, costs nothing, and gives the same end results as Claude Haiku 5.5 on 536 of 556 test questions
  against Haiku's 539.
- Projected over the three numeric parts of the dataset (126,160 questions): about 90% right in Blueline only,
  about 92% in Best accuracy.

## Accuracy by part of the dataset

| Part of the dataset | Questions in the dataset | Measured on | Right |
|---|---|---|---|
| Swiss apartment floors (CAD geometry) | 37,584 | every question | 37,376 (99.4%) |
| IFC building models, numeric answers | 3,062 | every question | 3,044 (99.4%) |
| Raster floor plans, Blueline only | 85,514 | 1,781 questions on 200 held-out drawings | 1,530 (85.9%) |
| Raster floor plans, Best accuracy | 85,514 | the same 1,781 questions | 1,576 (88.5%) |
| Practice drawing sheets | 64 | the 48 with a numeric answer | 48 (100%) |
| IFC building models, free-text answers | 820 | 46 questions it was not tuned on, graded by a language model | 25 right, 13 partly right, 8 wrong |

The raster drawings were held out from detector training, in two samples of 100 (`raster-test100.txt`,
`raster-test100b.txt`). The sheets and the free-text answers need a language model to word the answer, so Blueline
only does not answer those two parts (884 questions, 0.7% of the dataset) and offers to ask them again in Best
accuracy, where Claude Sonnet 5.5 words them.

## Raster floor plans: who answers, how often right, at what price

1,781 count questions on 200 held-out drawings. "Blueline detectors" are our two YOLO11 models (ONNX, on the CPU).

| Mode or line-up | Right | Outside calls per drawing | Outside cost per drawing |
|---|---|---|---|
| **Blueline only**: the detectors answer every kind | 1,530 (85.9%) | 0 | $0 |
| **Best accuracy**: symbols by the middle count of the two detectors and Gemini's reading; room types by Gemini | 1,576 (88.5%) | 1 | $0.018 |
| Best accuracy with Gemini at its default thinking level (`GEMINI_THINKING=default`) | 1,585 (89.0%) | 1 | about $0.07 |
| Best accuracy on a server with the Anthropic key only: Claude Sonnet 5.5 in Gemini's place | 1,558 (87.5%) | 1 | $0.009 |
| Custom, Gemini 4 Hydrogen as the reader: detectors for symbols, Gemini for room types | 1,555 (87.3%) | 1 once a room type is asked | $0.018 |
| Custom, Claude Sonnet 5.5 as the reader | 1,548 (86.9%) | 1 once a room type is asked | $0.009 |
| Gemini 4 Hydrogen alone, default thinking | 1,516 (85.1%) | 1 | about $0.07 |
| Gemini 4 Hydrogen alone, low thinking | 1,507 (84.6%) | 1 | $0.018 |
| Claude Sonnet 5.5 alone | 1,373 (77.1%) | 1 | $0.009 |
| Gemma 4 31B alone, hosted (first sample only, 916 questions, 12 failed calls) | 537 (58.6%) | 1 | not priced |

The first two rows and the two Custom rows with Gemini were run through the app's modes (`npm run eval -- --mode ...`);
the Sonnet rows are computed from the counts each component gave for every question when it was run on its own.

Gemini 4 Hydrogen thinks at its "high" level unless told otherwise, and that thinking is most of what a reading
costs. At "low" it reads the same 200 drawings 9 questions worse, alone and in Best accuracy, a difference inside
the noise of these samples, for a quarter of the price and of the wait. The modes therefore read at low.

Per kind of question (right answers out of the number asked; Gemini at low thinking):

| Kind | Asked | Blueline only | Best accuracy | Gemini alone | Sonnet alone |
|---|---|---|---|---|---|
| Toilet bowls | 200 | 188 | 192 | 184 | 181 |
| Sinks | 199 | 174 | 179 | 163 | 143 |
| Showers and bathtubs | 182 | 162 | 170 | 159 | 130 |
| Doors | 156 | 119 | 117 | 99 | 52 |
| Windows | 200 | 97 | 103 | 87 | 59 |
| Storeys | 200 | 191 | 199 | 199 | 196 |
| WC rooms | 98 | 95 | 95 | 95 | 97 |
| Kitchens | 129 | 118 | 125 | 125 | 125 |
| Saunas | 137 | 133 | 133 | 133 | 129 |
| Balconies | 61 | 55 | 58 | 58 | 58 |
| Bedrooms | 125 | 111 | 115 | 115 | 116 |
| Bathrooms | 94 | 87 | 90 | 90 | 87 |
| All | 1,781 | 1,530 | 1,576 | 1,507 | 1,373 |

Our detectors lead on everything that is drawn as a symbol; the outside models lead on room types, which are read
from labels. Windows are the weak kind for everyone: the same window is drawn as one object in some plans and as two
in others, and the annotations follow the drawing.

## Understanding the question

A language model reads every question and returns a structured call (what to count or measure, where, whether to
mark it); scripts and detectors then compute the answer. Blueline only uses our tuned Gemma for this, Best accuracy
Claude Haiku 5.5.

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
avoid the words show, mark and where. More in [gemma.md](gemma.md).

## What an answer costs and how long it takes

| Step | Runs | Cost per call | Time per call | How often |
|---|---|---|---|---|
| CAD geometry script | our server, CPU | $0 | 4 ms for the first question on a plan, under 1 ms after | every question about a DXF plan |
| IFC scripts | our server, CPU | $0 | 0.36 s for the first question on a model (median; up to 2.9 s), 15 ms after | every numeric IFC question |
| Blueline detectors | our server, CPU | $0 | 2.7 s for both models; 1.8 s on the demo server's six cores | once per raster drawing; later questions reuse the scan (8 ms) |
| Blueline interpreter (tuned Gemma) | our server, CPU | $0 | 0.9 s | once per question |
| Claude Haiku 5.5 as interpreter | Anthropic API | $0.0003 | 2.8 s | once per question |
| Gemini 4 Hydrogen reading a drawing, low thinking (the modes' setting) | Google API | $0.018 | 8 s | once per raster drawing |
| The same at the model's default thinking level | Google API | $0.07 on average, $0.05 median, $0.015 to $0.27 | 38 s on average, 29 s median | once per raster drawing |
| Claude Sonnet 5.5 reading a drawing | Anthropic API | $0.009 | 4.7 s | once per raster drawing |
| Claude Sonnet 5.5 wording a sheet answer | Anthropic API | $0.018 | 3.6 s | once per sheet question |
| Claude Sonnet 5.5 wording an IFC free-text answer | Anthropic API | $0.017, two calls per question | 3.4 s per call | every free-text IFC question |

How the outside prices were obtained: the Anthropic figures are what the API reported for our calls at $2 and $10 per
million input and output tokens for Sonnet 5.5 and $0.10 and $0.50 for Haiku 5.5. The Gemini figures are its token
use at Google's listed $1.50 and $7.50 per million input and output tokens, thinking tokens billed as output: at the
default level 2,928 input, 454 output and 8,156 thinking tokens per reading on average over 20 drawings (thinking
from 1,069 to 34,644), at low 1,244 thinking tokens on average over 197 readings.

The $0 in the rows of our own scripts and models means that no outside provider is paid, so the person asking pays
nothing. Whoever hosts the app pays for the server's time, and what that costs depends on the hosting: about 0.05 EUR
per 1,000 scanned drawings and 0.04 EUR per 1,000 interpreted questions on a small CPU server at Verda's price, when
the server is kept busy (projected from the load test in [scaling.md](scaling.md)); a server that is busy a quarter
of the time costs four times that per drawing.

Put together, for one raster drawing and the questions asked about it:

| Mode | Outside cost | Wait for the first answer | Wait for later answers |
|---|---|---|---|
| Blueline only | $0 | about 3.6 s (detectors and interpreter); 3.4 s measured on the public demo | about 0.9 s (interpreter) |
| Best accuracy | $0.018 per drawing and $0.0003 per question | about 10 s (Gemini's reading); 9 s measured on the public demo | about 2.8 s (interpreter) |
| Sonnet alone, for comparison | $0.009 per drawing | about 5 s | cached reading |

And for the whole raster part of the dataset (85,514 questions on 4,787 drawings):

| Mode | Projected right | Outside cost for all drawings |
|---|---|---|
| Blueline only | 85.9% | $0 |
| Best accuracy | 88.5% | about $87 for the readings, about $27 if Haiku interprets every question |
| Gemini 4 Hydrogen alone, default thinking | 85.1% | about $330 |
| Claude Sonnet 5.5 alone | 77.1% | about $43 |

The vector parts cost nothing in any mode. Scoring the dataset's own wording needs no interpreter either: the
keyword parser reads it identically, which is how the full-dataset numbers above were run.

One six-core server answers about 56 questions a minute for a single user and scans 30 raster drawings a minute, with
the interpreter as the first limit when several people ask at once. The load test, and how that scales on Verda, is
in [scaling.md](scaling.md).

## An open model we host ourselves, for the answers that need wording

Blueline only cannot word a free-text answer. We tested whether an open model on our own GPU could: Gemma 4 31B
(4-bit) served with vLLM on the Verda A100, used as the app's text model and graded like the rows above.

| Part | Claude Sonnet 5.5 | Gemma 4 31B on our GPU |
|---|---|---|
| IFC free-text answers, the 46 unseen questions | 25 right, 13 partly, 8 wrong | 21 right, 17 partly, 8 wrong |
| Practice drawing sheets, 64 questions | all 48 numeric answers right | 44 right, 20 wrong |

It is close to Sonnet on the IFC facts and not on the sheets, which need rows of a schedule counted and summed. A
call took 9 seconds on a GPU shared with a training run. It is not wired into a mode yet.

## What the models cost to make

Both models were trained on Verda with a 200 EUR coupon, of which about 83 EUR was spent by the morning of
15 November: an A100 instance for a day (data, training queue, and the public demo) and a four-hour burst
of eight L40S GPUs at spot price for eight detector runs side by side. One detector run takes 75 to 135 minutes on
one GPU; the interpreter's three epochs took about 90 minutes. Details and the run-by-run history:
[what we built on Verda](verda.md), [training/README.md](../training/README.md).

## How to repeat it, and what to keep in mind

The commands for the accuracy numbers are in [app/README.md](../app/README.md) under "Measure it yourself"; model
calls are cached, so a repeated run costs nothing. The cost and time figures come from timing the app's own calls on
samples: 20 drawing readings by Gemini at its default thinking level and 197 at low, 40 interpretations by Haiku,
19 text calls by Sonnet, and 234 answers by the scripts and detectors.

- The raster numbers come from 200 drawings; three training runs of one recipe differ by about 13 questions in
  2,235, so differences of a few questions between lines are within noise. The gap between our detectors and the
  outside models on symbols is far outside it.
- Gemini's cost per reading at its default thinking level swings by a factor of ten; the average is from 20 drawings.
- The free-text IFC answers are graded by a language model on 46 questions, a small sample.
- The reworded questions use styles that were also used while building the interpreters; the field-by-field table
  is the held-out measure.
- Times were taken on one laptop and on the demo server's six cores.
