# Training plan: one A100, 12 hours

**Conclusion.** Windows and doors are held back by the labels, not the model. The research found no published method, dataset or newer detector that fixes this, and no exact-count result for a trained detector on CubiCasa5k. Spend the hours on consistent targets and better count selection, starting with a CPU check of how many window points are reachable at all. Experiments 4 to 6 are our own designs, not proven recipes. Windows are one kind of twelve: +10 points there is about +0.8 overall if kinds weigh equally.

## 1. What limits us now (our measurements)

- Windows (45.5%): 42% of wrong objects are merges or splits from an annotation convention that differs between drawings; 32% are found but under threshold.
- On drawings it trained on, the model gets only 55% of window counts and 77% of door counts, so capacity, epochs and data volume are not the limit.
- Doors (68%): 41% of errors are confident detections with no annotation; sliding, folding and roll-up doors are 3% of annotations but 35% of misses.

## 2. The plan

Ranked by expected gain per GPU hour. "Worked" means a paired gain on dev of at least 4 points on the targeted kind (windows carry about 2 points of noise) with no other kind down more than 1. Gains quoted are estimates.

**1. Ceiling and convention probe** (CPU plus 15 min GPU; gates 4 and 5)
- Change: merge annotated windows that are collinear and within 3 px into runs, predictions likewise. Report exact-count on run counts and the oracle "predicted runs × true elements per run". Label each drawing pane-level or unit-level, cross-tabulate against the CubiCasa folder and image size, and train `yolo11s-cls` (imgsz 640, 30 epochs) on that label.
- Worked if: held-out AUC is 0.7 or more. Near 0.5 the convention is annotator habit: keep the count rule that maximises validation exact-count and move the hours to doors.
- Evidence: our measurement; predictability untested; the CubiCasa paper defines no window rule [1].

**2. Calibrated counts** (CPU)
- Change: run the detectors at conf 0.01 and mark each detection matched or unmatched. Per class, fit LightGBM (200 trees, depth 4) on logit(score), short side, aspect ratio, border distance, neighbour count and score rank, 5-fold grouped by drawing. Compare count rules: p > 0.5, round(Σp), Poisson-binomial mode.
- Targets: the under-threshold third of window and door errors; estimated 1 to 4 points.
- Evidence: published result for size-conditional calibration (search snippet only) [10]; count rules plausible, untested. Raw soft counts gave us nothing, but those scores were uncalibrated.

**3. Unit gate and door inspection** (CPU)
- Change: drop window and door detections outside the annotated unit. Measure the oracle gain with the SVG room-and-wall mask (dilated about 10 px), then approximate it with the box around all detections of the all-class model, or a `unit` class added in 5. Sort 30 confident unannotated door detections into neighbouring unit, leafless doorway, label omission, other.
- Targets: false positives outside the unit (a third of window false positives; door share unknown).
- Evidence: plausible, untested; gating openings is published practice [1][3].

**4. Multiplicity classifier** (10 min GPU; only if 1 passes)
- Change: crop ground-truth runs (16 px margin, rotated horizontal, 64×256, jittered); timm `resnet18`, classes 1, 2, 3, 4+, AdamW 1e-3, 30 epochs. Inference: merge detector boxes into runs and sum predicted multiplicities; per drawing, pool P(≥2) over runs and apply one convention, threshold tuned on validation.
- Targets: merges and splits; estimated +5 to +15 window points if the convention is predictable, near zero if not.
- Evidence: plausible, untested; analogue in fruit counting [12].

**5. Relabelled detector** (1.5 h GPU)
- Change, labels only, otherwise the current `yolo11l` 1280/60 settings: window runs with classes `window_x1` to `window_x4p`; doors split by SVG subtype (read the names off the SVGs), leafless doorway as a detected, uncounted class; drawings with sliding, folding or roll-up doors repeated 3×; window and door boxes under 12 px on the short side at model scale widened to 12 px. Window count is Σk over kept boxes after class-agnostic NMS, plus the drawing-level rule from 4.
- Targets: merges and splits, rare doors, thin marks scored low (the assigner weights by CIoU⁶ [9]).
- Evidence: plausible, untested; fine door classes are learnable on CubiCasa [6].

**6. Drawing-safe augmentation** (1.5 h GPU; labels from 5)
- Change: `mosaic=0, scale=0.2, translate=0.05, flipud=0.5, hsv_h=0, hsv_s=0, hsv_v=0.2`. Default mosaic hides the whole-drawing context the convention depends on; default `scale=0.5` shrinks 6 px marks to 3 px [9].
- Evidence: plausible, untested; nothing published for line drawings.

**7. YOLO26l at 1280** (1.5 h GPU; start at hour 0 on current labels, while the GPU would otherwise idle)
- Change: `YOLO('yolo26l.pt')`, same data and arguments; score both the NMS head and `nms=False`. Train 5 on whichever architecture wins.
- Targets: thin marks and doors slightly, nothing on the convention; also a less correlated voter.
- Evidence: published result on COCO only (+1.6 to +2.8 AP over YOLO11) [8].

**8. RF-DETR-M as third voter** (up to 3 h GPU, after two probes: CPU ONNX under 3 s per drawing, one epoch under 6 min)
- Change: `RFDETRMedium(resolution=1280)` (or 1232), 30 epochs, total batch 16, lr 1e-4, COCO-format labels from 5.
- Evidence: published result on mAP (61.5 against 57.0 for YOLO11m on RF100-VL) [7]; untested on thin marks, CPU latency unknown.

About 8 GPU hours plus a 2-hour reserve for export and threshold tuning. If time runs short, drop 8, then 6, then 7.

## 3. What not to spend GPU time on

- Larger models, higher input size, more epochs: `yolo11x` at 1536 was worse on every kind; scaling YOLO up does not help on small custom datasets [7].
- More NMS, flip, box-fusion or per-drawing threshold tuning for windows: tried, no gain.
- Vision-language fine-tuning, counting foundation models, point counters, distillation: the best published VLM gets 0.39 on doors and 0.34 on windows [4], and Sonnet alone (77.1%) is a weaker teacher than our detectors (85.9%).
- Raster-to-vector transformers: 256 px input, about 35 h of training [5].
- External data: a 1:1 synthetic mix moved opening F1 from 0.840 to 0.848 [3]; CubiCasa-derived Roboflow sets would leak our held-out drawings.
- NWD loss patches, DEIMv2, Co-DETR, joint wall segmentation [2]: set-up cost or confounded evidence.

## 4. Evaluation protocol

- Compare paired on the same dev drawings: per-kind exact-count, wins and losses per drawing, sign test. Each configuration runs once, so smaller gains are unconfirmed.
- Fit thresholds, calibrators and the convention rule on validation or by cross-validation grouped by drawing, never on the drawings being scored.
- Re-run the error analysis after each detector run to confirm the targeted cause moved.
- Combine at count level, not box level (box fusion did not help windows). Keep the current vote as default; try a regularised multinomial logistic regression on each detector's count, calibrated soft count and Sonnet's count, predicting a correction from −2 to +2, and adopt it per kind only where it beats the vote in grouped cross-validation. Published support is mixed [11].
- Test: one run of the frozen pipeline at the end. A split that has already guided choices is a dev set.

## 5. With eight GPUs

- Three seeds per configuration, separate ablations of each label change, and 5-fold cross-fitting so the second-stage models train on out-of-fold detections.
- `yolo26l-p2`, and 2× upscaled crop training with tiled inference, if thin marks remain a large share of errors.
- RF-DETR-L, a boundary-class segmentation counter, and a whole-image count regressor (`convnext_tiny`, 12 outputs) as a voter for small-count kinds.

## 6. Sources

1. https://ar5iv.arxiv.org/html/1904.01920 (CubiCasa5K paper)
2. https://ar5iv.labs.arxiv.org/html/2309.00348 (MuraNet, joint wall segmentation)
3. https://arxiv.org/abs/2608.25608 (2026 preprint: openings, synthetic mix, ink gate)
4. https://arxiv.org/abs/2601.04819 (AECV-Bench; per-model figures from a search summary)
5. https://arxiv.org/html/2602.09016v1 (Raster2Seq)
6. https://arxiv.org/html/2508.07714v1 (DoorDet)
7. https://arxiv.org/html/2511.09554v1 (RF-DETR, RF100-VL); https://rfdetr.roboflow.com/learn/train/ (recipe)
8. https://arxiv.org/html/2606.03748v1 and https://docs.ultralytics.com/models/yolo26/ (YOLO26)
9. https://raw.githubusercontent.com/ultralytics/ultralytics/main/ultralytics/utils/tal.py (assigner); https://docs.ultralytics.com/usage/cfg/ (defaults)
10. https://arxiv.org/pdf/2112.01901 (box-size confidence bias)
11. https://arxiv.org/pdf/1604.03505 (counting: detection, regression, ensembles)
12. https://shreyasskandan.github.io/publication/icra_applesoranges_2017 (per-blob count network; search summary only)

## Skeptic's review of this plan

The diagnosis holds (labels, not the model, limit windows and doors), and the plan fits one A100 and CPU deployment, but three things should change before GPU hours are spent.

1. The gate in recommendation 1 can pass without the convention being predictable, and its AUC 0.7 bar is too low to produce a count gain.
2. Recommendations 4 and 5 keep the convention noise inside the multiplicity label, so they do not deliver the "consistent targets" the conclusion promises. Training each part on convention-pure drawings is the option the plan missed.
3. Two citations do not support their claims: DoorDet [6] has no structural door classes, and [3] does not gate openings.

What holds up, checked against the sources:
- [1] exists and defines no window annotation rule.
- [9] confirms the assigner metric is score^alpha x CIoU^6 (beta = 6.0), and the defaults mosaic=1, scale=0.5, close_mosaic=10.
- [10] and [12] exist and match their descriptions, though [10] reports only up to 0.6 mAP.
- [7] confirms 61.5 against 57.0 AP (50:95) on RF100-VL and the sentence that scaling YOLO families does not help there.
- [8] (docs page) confirms YOLO26l at 55.0 against 53.4 for YOLO11l (+1.6; x is +2.8), a `nms=False` head, and that `yolo26-p2` exists only as a config without weights.
- Time: five detector-size runs at about 1.4 h plus RF-DETR behind its probe is about 8 h, which fits.
- Deployment: every component exports to ONNX; the gap is that the CPU limit is checked per model, not for the whole pipeline.

Not opened: [2], [4], [5], [11] and the YOLO26 arXiv paper. They only back the "do not spend" list.

- **Recommendation 1: convention probe and its AUC gate**: The gate can pass for the wrong reason, and its bar is too low. The plan does not say how a drawing is labelled pane-level or unit-level. A drawing with no multi-pane windows shows neither convention; if it is lumped with unit-level, the classifier learns "this drawing has multi-pane windows" and reaches a high AUC without predicting the convention. Separately, AUC 0.7 gives almost no gain over always applying the majority convention. Correction: Use three labels: pane-level (at least one pair of touching collinear annotated windows), unit-level (at least one annotated window on which the current detector at a low threshold puts two or more boxes), and none. Report the share of drawings showing both, which tests the "consistent inside a drawing" claim. Train and score the classifier on pane-level against unit-level drawings only, with cropping, RandAugment and erasing off; also try frozen image embeddings plus logistic regression. Replace the AUC gate with a decision gate: held-out window exact-count using the predicted convention must beat the majority-convention rule by at least 4 points. Also report the exact-count with the true convention as the ceiling, and stop window work if that ceiling is under 4 points.

- **Recommendations 4 and 5: window multiplicity (crop classifier, classes window_x1 to window_x4p)**: The multiplicity target is itself convention-dependent, so the inconsistency moves from box granularity into the class label instead of being removed. Pooling P(>=2) over runs measures how many multi-pane windows a drawing has, not which convention its annotator used. The 4+ cap makes long glazing runs wrong by construction. Four window classes split the score when a third of window errors are already under threshold. Correction: This is the option the plan missed: split the window count into three parts, each trained on consistent labels.
(a) Detector: one class `window_run`, derived the same way for every drawing.
(b) Panes per run: train only on pane-level and no-evidence drawings, where elements per run equal physical panes; no cap (ordinal or regression output, or count mullions along the run axis).
(c) Convention: one decision per drawing from recommendation 1, or the majority rule if it is not predictable.
Count is the sum of panes if pane-level, otherwise the number of runs (check on unit-level drawings that elements per run is 1). Feed both candidate counts to the count-level combiner alongside Sonnet's count.

- **Recommendation 2: calibrated counts**: The 1 to 4 point estimate is unsupported, the idea sits close to post-processing we already measured as giving nothing, and the plan's own protocol cannot confirm a gain of that size. Correction: Do not run it as a stand-alone item. Fit it after the run-level relabel, on run-level matches, and add the features that carry information the score lacks: the other detector's best-overlapping score, whether the box touches another detection, and the drawing-level convention probability. Time-box it to about an hour of work. Expect at most 2 points on windows; doors are the better target, since fusing two models already helped there.

- **Recommendation 3: unit gate and door inspection**: The "published practice" evidence does not cover gating to the annotated unit, and the window upside is very small. The valuable part is the door inspection, which is buried in the item. Correction: Do the 30-door inspection first: it takes 15 minutes, needs no code and decides the door classes in recommendation 5. Compute the oracle gain per kind with the SVG mask before building any approximation, and drop the window gate if the oracle is under 2 points. Reword the evidence to "wall gating is published [1]; unit gating is untested".

- **Recommendation 5: door subtypes, oversampling and box widening**: The citation for learnable door subtypes is wrong, the rare-door fix targets the smaller door cause, and box widening has a side effect on stacked windows. Correction: Mark door subtypes as untested. Use three door classes: swing, sliding+folding+roll-up, and leafless doorway (detected, not counted). Apply one door threshold after class-agnostic NMS across them, because per-subtype thresholds on 239 validation drawings rest on a handful of objects. Check that the installed 8.4 `tal.py` has the small-box expansion. Do not widen a box where a parallel neighbour lies within 12 px. Re-run the error analysis per cause to attribute the bundled changes.

- **Recommendations 6 and 7: what the GPU runs at hour 0, and the order of 5 and 6**: The hour-0 slot goes to YOLO26, which the plan itself says does nothing for the main cause. The augmentation change needs no new labels, addresses a named cause, and tests the reading of our key measurement. Running 5 and then 6 costs two runs where one would do. Correction: At hour 0, run the augmentation change on the current labels and score it on validation and on the 300 training drawings. Run YOLO26l alongside if GPU memory and data loading allow, otherwise after. Then train the relabelled detector once, with the winning augmentation and architecture.

- **Section 3: "higher input size" ruled out**: The evidence is confounded. Resolution has not been tested in isolation, although thin marks are a named cause. Correction: State it as untested. A five-minute check exists: run the existing yolo11l weights at imgsz 1600 on validation and see whether the not-found thin marks appear; test-time scale is not on the list of things already tried. Keep P2 or tiled training deprioritised unless that check moves counts.

- **Recommendation 8 and deployment: CPU time**: The 3-second probe is per model, while the limit applies to the whole pipeline. Three detectors at 1280, two small classifiers and a tree model may not fit in "a few seconds". Correction: Set one CPU limit for the full pipeline, measured in the Node app. RF-DETR enters only if the total fits or it replaces a voter. Export the LightGBM model as ONNX or a tree dump, and check feature parity between Python and Node on about 20 drawings.

- **Section 4: evaluation protocol**: The "worked" criterion does not say whether it is measured on the single model or on the final vote, and "dev" is not tied to a split. Correction: Measure every "worked" decision on the vote output as well as the single model. Fit second-stage models by cross-validation grouped by drawing over validation plus test, and report the final figure as a dev number, not a clean test number.

Suggested order: 1. Convention probe (recommendation 1, with three-way labels and a decision-level gate) plus the 30-door inspection from recommendation 3, both at hour 0 on CPU: they decide the window and door label design.
2. Augmentation change (recommendation 6) on the current labels as the hour-0 GPU run, scored on validation and the 300 training drawings; run the imgsz-1600 inference check on the existing weights alongside: both test a named cause and need no new labels.
3. Relabelled detector (recommendation 5, revised: single `window_run` class, three door classes), trained once with the winning augmentation: it removes merges and splits from the box target.
4. Panes-per-run classifier (recommendation 4, revised: trained on pane-level and no-evidence drawings only), combined with the drawing-level convention from step 1: it only pays if step 1 passes.
5. Calibrated counts (recommendation 2), on run-level matches with cross-model and convention features, time-boxed: small expected gain, better for doors than windows.
6. YOLO26l at 1280 (recommendation 7) as a less correlated voter: nothing on the convention, so it should not hold the first GPU slot unless it can share the GPU.
7. Unit gate (rest of recommendation 3), only if its oracle gain is at least 2 points on a kind: the window share is about 4% of wrong objects.
8. RF-DETR-M (recommendation 8), only if the whole pipeline stays inside the CPU limit.
