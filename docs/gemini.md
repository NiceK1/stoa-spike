# How Blueline uses the Gemini API

Blueline answers quantity questions about construction drawings and marks every counted item on the drawing, so a
person can check the answer. Vector drawings are answered by geometry code, and raster floor plans by detectors we
trained ourselves. Gemini 4 Hydrogen is the second opinion that turns that into the most accurate line-up we
measured, and the reader for everything our own models cannot do.

Live demo: https://blueline.65-108-33-91.sslip.io. Switch the question box from "Blueline only" to "Best accuracy"
to see Gemini at work; the Source lines under each answer say what Gemini did and what our own models did.

## The problem

A cost estimator counts doors, windows and fixtures off floor plans by hand, and a wrong count becomes a wrong
order. A vision model alone can answer such a question, but it cannot be checked and it is wrong too often: on 200
floor plans our detectors had never seen, the best outside model alone answered 85.1% of the count questions
exactly. An estimator needs the answer, the marks that prove it, and a number they can trust.

## What Gemini does in the app

1. **One reading per drawing, not one call per question.** Gemini is asked once for an inventory of the drawing as
   structured output: every item of the thirteen kinds the dataset asks about, each with its position. Every later
   question about that drawing is answered from the stored reading.
2. **A vote with our detectors on drawn symbols.** For windows, doors, toilets, sinks, showers and bathtubs the app
   takes the middle of three independent counts: our two detectors and Gemini's reading. Gemini alone is behind our
   detectors on these (692 of 937 against 740), but as the third voice it corrects them: 761.
3. **Room types and storeys.** These are read from labels such as MH, KH or "2. kerros", which is reading, not
   detection, and Gemini is the best reader we measured: 815 of 844, against 808 for Claude Sonnet 5.5 and 790 for
   our detectors. The app draws our detector's outline around each room Gemini counted, so the answer can be
   checked on the drawing.
4. **Anything else.** Items our detectors were never trained on (stairs, fireplaces, wardrobes), a count limited to
   one part of a drawing, a dimension or a note to read, and drawings in a style the detectors do not recognise
   all go to Gemini, and the answer says so.

If a Gemini call fails, a count our detectors can make is still answered, by them, and the answer says that Gemini
did not take part.

## What it adds, measured

1,781 count questions on 200 held-out floor plans, exact counts only:

| Who answers | Right | Gemini calls per drawing | Cost per drawing |
|---|---|---|---|
| Our detectors alone (the app's default mode) | 1,530 (85.9%) | 0 | $0 |
| Gemini 4 Hydrogen alone | 1,507 (84.6%) | 1 | $0.018 |
| Our detectors and Gemini together (Best accuracy) | 1,576 (88.5%) | 1 | $0.018 |
| The same with Gemini at its default thinking level | 1,585 (89.0%) | 1 | about $0.07 |
| Claude Sonnet 5.5 alone, for comparison | 1,373 (77.1%) | | $0.009 |
| Gemma 4 31B alone, for comparison (100 drawings) | 537 of 916 (58.6%) | | |

Neither side reaches 88% alone. The detectors are precise about what is drawn, Gemini is good at what is written,
and the vote uses each where it is strong.

## Tuning the thinking level

Gemini 4 Hydrogen thinks at its "high" level by default, and on this task the thinking is most of the bill: a
reading uses about 2,900 input tokens, 450 output tokens and, on average, 8,200 thinking tokens (from 1,069 to
34,644), which makes it about $0.07 and half a minute per drawing. We read the same 200 drawings again with the
thinking level set to low: 1,244 thinking tokens on average, $0.018 and 8 seconds per drawing, and 9 questions
fewer right out of 1,781, alone and in the vote. That difference is inside the noise of the sample, so the app reads
at low and an estimator waits eight seconds instead of thirty.

## Why Gemini, and what we are honest about

- It is the strongest outside reader of these drawings we measured, by more than seven points over Claude Sonnet 5.5
  alone.
- Its structured output gives positions for every item in one call, which is what makes a model's answer
  checkable on the drawing.
- Its thinking level is a cost dial that we could measure and set.
- It is not the default. The default mode answers with our own models and sends nothing out; Gemini is what the
  user turns on when the last points of accuracy are worth two cents per drawing, and the app always shows which
  answers it touched.
- Our answer formats needed converting for Gemini (one type per field, no empty menu value); a test now runs every
  format the app sends through that conversion.

## In the code

- `app/server/src/models/vision.ts`: `GeminiApiVision` (structured output from a JSON schema, the thinking level,
  image sizing, caching, the cost of each call).
- `app/server/src/solvers/raster.ts`: the inventory reading, the vote, the outlines and the fallback rules.
- `app/server/src/modes.ts`: what Best accuracy and Custom resolve to on a server.
- [results.md](results.md): all measurements, with what every call costs.
