# NeighborLens YOLOv8m road-crack recall recovery

## Regression diagnosis

The operating-point replay reproduced 186/320 Road Crack matches for baseline v9 and 153/320 for the first hard-negative checkpoint. The net loss of 33 consists of **40 matches lost, 7 gained, 146 retained, and 127 missed by both**. All 40 lost instances had a same-class candidate at IoU ≥0.50 below confidence 0.30. The median confidence of the closest eligible v9 box was 0.4142, and of the closest same-class candidate box was 0.1258. The median labeled box covered 9.4% of the image among losses and 15.1% among retained Road Crack matches. All 40 were DNIT roadway frames by source name and visual review.

The first experiment retained 233 Road Crack boxes from the QA-filtered training export's 3,507. Road Crack represented approximately 41% of boxes in the QA export and 24% in that experiment. Its 78 pure negatives represented 13.6% of the 573 training images. Positive sampling, capture-domain mix and background supervision all changed in that run. Those factors are plausible contributors to the score regression. The paired scores establish the failure at the current cutoff.

### Annotation and split audit

| v9 split | Images | Missing label files | Empty labels | Streetlight / drainage / pothole / crack boxes |
| --- | ---: | ---: | ---: | --- |
| Raw train | 5,751 | 0 | 65 | 1,251 / 1,480 / 2,206 / 3,862 |
| QA-filtered train | 5,544 | 0 | 65 | 1,251 / 1,480 / 2,202 / 3,507 |
| Validation | 1,259 | 0 | 21 | 342 / 395 / 659 / 668 |
| Test | 634 | 0 | 17 | 162 / 203 / 291 / 320 |

The parser found zero out-of-bounds or nonpositive geometries in these splits. The 40 lost cases show a mixture of thin longitudinal cracks, fine crack networks, and some broad or visually ambiguous annotations around patched surfaces. These cases remain in the frozen evaluation. Missing boxes cannot be ruled out by file-presence or coordinate checks. The new set uses nine visually confirmed training-only corrections from the local manual review set. Those tighten prior whole-tile Road Crack boxes around the visible defect. Ambiguous corrections and unlabeled road scenes with visible damage were excluded.

The source-file audit found zero exact train-to-holdout matches, with 133 normalized source-group flags and 502 perceptual-hash flags against validation/test/negative holdout. The union contained 631 QA-approved training images. Four candidate train/test pairs were visually inspected and confirmed as adjacent scenes with matching landmarks. For example, the same DNIT route `290RS294095` contains training frame `31245` and test frame `31240` with identical perceptual hashes and different bytes. The positive benchmark is useful for a controlled comparison with the historical baseline. Its scene independence from the v9 initialization has been disproven.

## Experimental dataset and training

- The training set contains 743 images. It includes 585 QA-reviewed v9 positives, 50 visually screened RDD crack images, nine manually corrected crack images, 21 visibly undamaged paved-road backgrounds, and 78 previously reviewed COCO128 zero-target backgrounds. COCO128 was used as an image source for background examples. Training and evaluation used only the four-class YOLOv8m detector.
- The previous 78 background images included 33 tagged with people, eight cups, seven dogs, three cats, seven chairs, four couches, four benches, three beds and nine dining tables. Tags are non-exclusive. The 12 separate validation backgrounds included six people, one cup, two elephants and other outdoor subjects. These are source tags, not NeighborLens bounding boxes.
- The training set contains 167 Streetlight, 141 Drainage, 466 Pothole and 459 Road Crack boxes. Validation contains 96 positive frames and the 12 distinct COCO128 backgrounds. Road Crack sampling covers small, medium and large labeled regions. The road images include sunshine and shade, narrow and wider damage, longer road views and close pavement crops. Low-light and alternate-angle behavior remain underrepresented in independently verified data.
- RDD2022 D00, D10 and D20 map to class 3. D40 maps to class 2, including in mixed crack-and-pothole frames. All remapped boxes were retained for the selected RDD positive images. The canonical NeighborLens IDs and four-class contract are unchanged. [RDD2022 annotation specification](https://crddc2022.sekilab.global/data/)
- The builder rejects exact image hashes, normalized source groups, shared DNIT route IDs and normal/mirrored perceptual-hash distances ≤6 against protected splits. It also screens training against the final validation set. The protected test export stayed at 634 images and 976 annotations with SHA‑256 `387bb544261b9da0a757bde83edd2bb2923e7a6a455487ad520faf68b77810ff` over relative image and label paths and bytes. Historical leakage in the pretrained v9 weights remains.

Both new runs initialize from the verified baseline, train for three epochs at image size 640 and batch 8 on the RTX 3060, and select `best.pt` by training validation fitness. Both use AdamW, seed 42, no mosaic, no AMP and the same data manifest. The controlled setting is starting learning rate, `0.0002` matching the previous experiment and `0.00008` for the conservative update. The frozen test is evaluated after both runs. Exact hyperparameters are recorded in each run's `args.yaml`.

The other-class screening rule for this experiment is an absolute drop greater than three percentage points from v9 in precision, recall, or AP@0.50 at the reported evaluation settings. The user specified Gate C qualitatively, so this is an explicit review threshold rather than an established deployment standard.

## Protected evaluation and decision

| Checkpoint | Negative image false positives | Negative pairs agreeing | Road Crack recall | Road Crack misses | mAP@0.50 / @0.50:0.95 |
| --- | ---: | ---: | ---: | ---: | ---: |
| Baseline v9 | 27/29 (93.10%) | 9/10 | 186/320 (58.13%) | 134 | 68.72% / 39.30% |
| Previous hard-negative | 14/29 (48.28%) | 4/10 | 153/320 (47.81%) | 167 | 65.66% / 37.54% |
| Balanced, same LR | 13/29 (44.83%) | 4/10 | 150/320 (46.88%) | 170 | 67.87% / 37.84% |
| Balanced, lower LR | 14/29 (48.28%) | 5/10 | 167/320 (52.19%) | 153 | 66.04% / 37.30% |

All detector metrics use the same frozen 634 positive-panel images, 29 verified negative images and 10 negative pairs. The protected image and label copies were byte-checked against the original export. Negative image digests matched the earlier audit. Inference used image size 640, augmentation, confidence 0.30 for operating-point metrics, AP prediction floor 0.001, and a maximum of 100 boxes. Matching at the operating point is one-to-one at IoU 0.50. Reported pair agreement measures model predictions. No veto or portrait filter was applied to these detector metrics.

| Checkpoint | Streetlight P / R / AP50 | Drainage P / R / AP50 | Pothole P / R / AP50 | Road Crack P / R / AP50 |
| --- | ---: | ---: | ---: | ---: |
| Baseline v9 | 45.59 / 73.46 / 61.32 | 75.33 / 84.24 / 87.33 | 64.56 / 73.88 / 73.31 | 52.10 / 58.13 / 52.92 |
| Previous hard-negative | 44.26 / 64.20 / 53.33 | 86.53 / 82.27 / 87.15 | 59.09 / 75.95 / 75.00 | 51.17 / 47.81 / 47.17 |
| Balanced, same LR | 55.90 / 67.28 / 60.37 | 89.39 / 78.82 / 88.75 | 70.76 / 73.20 / 75.38 | 50.17 / 46.88 / 46.98 |
| Balanced, lower LR | 47.41 / 67.90 / 57.06 | 85.42 / 80.79 / 87.44 | 65.94 / 72.51 / 75.81 | 40.05 / 52.19 / 43.85 |

Precision and recall are percentages at confidence 0.30. The lower-LR candidate lost 32 baseline crack matches and gained 13, leaving 19 fewer matches than v9. It recovered 14 net matches versus the previous experiment, with lower Road Crack precision and AP50. Across Streetlight, Drainage, Pothole and Road Crack respectively, the same-LR candidate lost 14, 14, 12 and 46 baseline matches, and the lower-LR candidate lost 13, 9, 10 and 32. The artifact records gained matches and exact label identities.

**NO-GO for deployment.** Both recovery candidates pass Gate B. Both fail Gate A and the experimental Gate C thresholds for Streetlight and Drainage recall. Gate D fails because the initialization has verified historical scene overlap. The new data passes the recorded split screens, and original checkpoints and class mappings were preserved. A future run needs a genuinely route-disjoint benchmark and weights with traceable training provenance before its scores can support deployment.

### Actual backend evidence admission

The ten negative pairs were sent through the real authenticated Citizen preview and submission routes in an isolated SQLite instance with valid test coordinates. The inference adapter replayed the measured output for each checkpoint and exact image digest. HTTP 201 and the resulting row were checked independently of model agreement.

| Backend policy | Checkpoints | Rejected | Persisted pending | Persisted as AI-confirmed |
| --- | --- | ---: | ---: | ---: |
| Default, portrait filter off | All four, individually | 1/10 | 9/10 | 0/10 |
| Experimental portrait filter, separate historical replay | Baseline v9 | 3/10 | 7/10 | 0/10 |
| Experimental portrait filter, separate historical replay | Each fine-tuned checkpoint | 2/10 | 8/10 | 0/10 |

Under the default policy, Camo Studio was rejected by the existing backend evidence check. The other nine pairs entered the pending human-review queue. These are actual negative submissions admitted for review, even when the detector abstained. The backend under test requires a separate relevance attestation for AI confirmation.

### Checkpoints

| Checkpoint path | SHA-256 |
| --- | --- |
| `models/production/best.pt` and `runs/neighborlens-v9/yolov8m_v9_qa_filtered_exp01/weights/best.pt` | `6e55d6fec65531180e1655e1b3c5931101fbf96e23346dff272b29c5422cd3d2` |
| `runs/detect/runs/neighborlens-v9/yolov8m_v9_hard_negatives_exp01/weights/best.pt` | `a73ad82e95cb0689a555ac94d1dff0c91dfa8881d9d2e2758dcecd2b9a50c1f5` |
| `runs/neighborlens-v9/road_crack_recovery_v1/balanced_same_lr/weights/best.pt` | `ac717c1611ddb2af34bf4a6a8948ee583ef09d70e499e9ec8f678a1fd75b3fa1` |
| `runs/neighborlens-v9/road_crack_recovery_v1/balanced_lower_lr/weights/best.pt` | `80943b9cb7fac42ab4d8b4ca44223c0550a4108fddfe11b6858e0a873d6364f3` |

## Reproduction artifacts

Experimental scripts, input manifests, evidence panels, predictions and logs are under `.data/road-crack-recovery-v1/`. The prior benchmark and earlier training runs remain intact. Ordinary expert review of ambiguous test annotations would require a separately versioned benchmark.

## OpenCV 5 inference compatibility

This section records the original Haar experiment. The current opt-in uses YuNet and is documented in [Face-aware evidence validation](FACE_AWARE_EVIDENCE_EXPERIMENT.md).

Default local and staged inference runs without the experimental portrait filter. Use `--enable-portrait-filter` for a local experiment or `create_app(..., enable_portrait_filter=True)` from Python. Explicit opt-in validates both cascades before model loading and fails at startup if they are unavailable. The local requirements retain `opencv-python==5.0.0.93`. [OpenCV migration guide](https://github.com/opencv/opencv/wiki/OpenCV-4-to-5-migration#35-objdetect-haar-and-hog-moved-to-contrib)

The installed OpenCV 5 environment returned HTTP 200 with the expected class from the original checkpoint for all four classes on both `/predict` and `/verify-pair`. The second view in this smoke check was a geometric crop of each verified control. All four pairs retained perspective alignment. Exact duplicates returned HTTP 422 `DUPLICATE_EVIDENCE`. Opt-in in the same environment exited before serving with the dependency message.

The inference contract and staged entrypoint suite passed 56 tests with two skips on OpenCV 5. The skips cover real Haar asset tests. Those tests ran in the existing Haar-capable environment, where seven focused tests passed. Fifteen Node backend evidence and inference authentication tests passed. See `opencv5-smoke.log`, `opencv5-optional-portrait.patch`, `backend-raw-results.json` and `evaluation.json` in the artifact directory.
