# Road Crack Recovery v2

**NO-GO for promotion or a threshold change.** The rebalanced checkpoint recovered historical Road Crack recall at 0.30, but detected only 3 of 78 independently screened cracks. All four checkpoints tested through the report routes allowed unrelated photos into the manual-review queue. The production checkpoint and deployment were untouched.

## Dataset and split verification

- The [v1 audit](ROAD_CRACK_RECOVERY.md) found 631 QA-approved training images flagged against the combined historical holdouts by normalized source name, perceptual hash, or both. That count is a candidate screen. Four adjacent train/test scenes were visually verified. On DNIT route `290RS294095`, train frame `31245` and test frame `31240` have different bytes and identical perceptual hashes. The historical test retains 634 images and 976 boxes, including 320 cracks. Its original checksum and results are retained.
- The separate evaluation uses 74 positive photos from 34 source groups with 78 crack, 100 pothole, one drainage and one streetlight box. It includes 72 RDD2022 India road photos, a leaf-blocked ditch and a visibly bent lamppost. It also uses 36 negative photos from 18 distinct Objectron video scenes, three scenes each for a cup, shoe, laptop, camera, chair and book. The negative views contain zero target boxes. [RDD2022 class definitions](https://crddc2022.sekilab.global/data/), [Leaf-blocked ditch](https://www.geograph.org.uk/photo/7420931), [Bent lamppost](https://www.geograph.org.uk/photo/957464), [Objectron](https://github.com/google-research-datasets/Objectron)
- The split screen used SHA-256, 64-bit perceptual hashes in original and mirrored orientation with Hamming distance ≤6, and 100-frame RDD source blocks with frame buffers. Of 79 shortlisted road photos, seven shared a prior training source block and were excluded. An externally sourced drainage photo was also excluded after matching a known v9 training photo at pHash distance zero. The retained test samples had no cross-split match across 7,914 known reference files after deduplication. The minimum pHash distance to a known reference was 8. The v2 train and validation folds had zero exact or perceptual matches at the same cutoff and no shared RDD blocks.
- RDD frame blocks approximate scene identity where route metadata is unavailable. The screen covers available local data, including the known historical v9 export, v1 training and v2 train/validation inputs. Unknown pretraining sources remain outside the audit. The independent panel is mostly vehicle-mounted India imagery. Mobile Bacolod pairs, larger Streetlight and Drainage samples, and additional negative families such as animals and faces are coverage gaps in this panel.

| Dataset | Train images / pure backgrounds | Train boxes in canonical ID order 0–3 | Validation images / boxes |
| --- | ---: | --- | ---: |
| V1 and v2 schedule control | 743 / 99 | 167 / 141 / 466 / 459 | 108 / 226 for v1, 126 / 269 for v2 |
| V2 rebalanced | 778 / 81 | 167 / 141 / 507 / 540 | 126 / 269 |

V2 retained all positives used by v1 and added 53 visually approved training images from RDD. The original boxes were remapped from D00, D10 and D20 to `road_crack`, and from D40 to `pothole`, including all potholes in mixed scenes. Nine prior training-only corrections tightened crack boxes. Historical test annotations were preserved. V2 rebalanced kept all 21 verified intact-pavement images and 60 of 78 previously verified background photos, sampled as 48 high-scoring false positives plus 12 lower-score examples. The pure-background share went from 13.3% to 10.4%. Both v2 runs started from the same v9 weights and used AdamW, 3 epochs, LR 0.00004, final LR factor 0.01, no warmup, 640 px, batch 8, seed 42, and AMP and mosaic disabled. Both used the same validation, including 18 separate RDD images. The rebalanced run changes crack representation and background sampling together, so their effects cannot be attributed independently.

## Results at confidence 0.30

Independent and historical recall use class-aware, one-to-one box matching at IoU ≥0.50. Precision is measured on the labeled positive benchmark and negative image rate is measured separately. A dash means a class had no prediction at the cutoff. Pair agreement describes raw model detections. The backend test is below.

| Checkpoint | Historical crack recall | Historical negative images / pairs | Independent crack recall | Independent negative images / pairs | Independent mAP50 / mAP50–95 |
| --- | ---: | --- | ---: | --- | ---: |
| Baseline v9 | 58.13% (186/320) | 27/29 · 9/10 | 1.28% (1/78) | 33/36 · 14/18 | 1.50% / 0.47% |
| First hard-negative | 47.81% (153/320) | 14/29 · 4/10 | 0% (0/78) | 19/36 · 7/18 | 0.78% / 0.29% |
| V1 same LR | 46.88% (150/320) | 13/29 · 4/10 | 6.41% (5/78) | 12/36 · 3/18 | 4.34% / 1.36% |
| V1 lower LR | 52.19% (167/320) | 14/29 · 5/10 | 5.13% (4/78) | 14/36 · 4/18 | 4.24% / 1.40% |
| V2 schedule control | 56.88% (182/320) | 21/29 · 5/10 | 3.85% (3/78) | 14/36 · 3/18 | 3.08% / 0.84% |
| V2 rebalanced | **59.69% (191/320)** | 21/29 · 6/10 | **3.85% (3/78)** | 20/36 · 6/18 | 2.51% / 0.68% |

| Independent checkpoint | Broken Streetlight P / R / AP50 | Clogged Drainage P / R / AP50 | Pothole P / R / AP50 | Road Crack P / R / AP50 |
| --- | --- | --- | --- | --- |
| Baseline v9 | 0 / 0 / 0 | 0 / 0 / 0 | — / 0 / 0.96 | 100 / 1.28 / 5.06 |
| V2 schedule control | 0 / 0 / 0.19 | — / 0 / 0 | 7.14 / 1.00 / 2.90 | 33.33 / 3.85 / 9.22 |
| V2 rebalanced | 0 / 0 / 0.20 | — / 0 / 0 | 0 / 0 / 0.92 | 25.00 / 3.85 / 8.94 |

All cells in the per-class table are percentages. On the historical panel, v2 rebalanced changed Streetlight recall from 73.46% to 68.52%, Drainage from 84.24% to 81.28%, and Pothole from 73.88% to 76.98%. Its historical crack precision fell from 52.10% to 43.41% and crack AP50 fell from 52.92% to 48.99%. Historical mAP50 and mAP50–95 changed from 68.72% / 39.30% to 67.24% / 38.64%. The independent panel reproduced misses across all classes and provides insufficient Streetlight and Drainage samples to certify performance.

## Confidence sweep

The reusable [sweep script](training/sweep_operating_points.py) measures precision, recall, baseline matches lost and gained, and negative rates for all four classes at every cutoff. It uses the same cached predictions within each evaluation, image size 640, test-time augmentation, maximum 100 detections, and a common 0.001 floor for AP. AP stays constant across operating points by design.

| Confidence | Historical v1 lower LR crack P / R | Historical v2 rebalanced crack P / R | Independent v2 rebalanced crack P / R | Independent v2 negative images / agreeing pairs | Independent v2 cracks missed |
| ---: | --- | --- | --- | --- | ---: |
| 0.15 | 24.09% / 68.44% | 23.20% / 70.63% | 21.82% / 15.38% | 32/36 · 11/18 | 66 |
| 0.20 | 30.58% / 62.50% | 28.91% / 65.31% | 29.03% / 11.54% | 29/36 · 9/18 | 69 |
| 0.25 | 36.84% / 56.88% | 34.68% / 61.56% | 22.22% / 5.13% | 24/36 · 8/18 | 74 |
| 0.30 | 40.05% / 52.19% | 43.41% / 59.69% | 25.00% / 3.85% | 20/36 · 6/18 | 75 |
| 0.35 | 46.20% / 49.38% | 47.70% / 55.00% | 30.00% / 3.85% | 18/36 · 6/18 | 75 |
| 0.40 | 51.75% / 46.25% | 55.74% / 51.56% | 25.00% / 2.56% | 15/36 · 4/18 | 76 |

- The historical v1 regression is mostly confidence-related under this protocol. At the floor, baseline and v1 lower LR match 298 and 294 cracks. Between the floor and 0.30 they lose 112 and 127 matches. The historical 19-instance net loss consists of 15 extra below-cutoff losses and four additional misses even at the floor. For v2 rebalanced, 296 match at the floor, 105 fall below 0.30 and 24 are unmatched at the floor. It recovers 12 baseline misses while losing seven previous baseline matches at 0.30.
- On the independent panel, v2 rebalanced has 55 floor matches. Of those 52 fall below 0.30, and 23 of 78 are unmatched as the correct class even at 0.001. This points to both score calibration and failures of localization or class assignment; the aggregate does not identify which explains each floor miss. Input domain and annotation styles likely contribute to the large historical-to-independent gap, but their individual effects were not measured. Lowering the cutoff to 0.15 adds nine correct crack detections and twelve negative images with detections versus 0.30 on the independent panel.
- Missed instances describe detector failures. The separate evidence regressions cover legitimate alternate views, signed proofs, and low-confidence manual routing. This panel does not estimate the real-world rejection rate for legitimate reports.

## Actual backend routing

Each row uses real default FastAPI `/predict` outputs on the original bytes, replayed through the authenticated Node preview and submit routes against isolated SQLite with valid coordinates. The replay preserved the provider's missing relevance assertion by overriding the test helper's synthetic `VERIFIED` fixture default. Each pending report was verified in the database. Raw offline pair counts above are distinct from the stored report outcome.

| Checkpoint | Negative pairs | HTTP 422 | HTTP 201 pending / AI-confirmed | Evidence review on preview |
| --- | ---: | ---: | ---: | ---: |
| Baseline v9 | 18 | 0 | 18 / 0 | 17 |
| V1 lower LR | 18 | 0 | 18 / 0 | 10 |
| V2 schedule control | 18 | 0 | 18 / 0 | 10 |
| V2 rebalanced | 18 | 0 | 18 / 0 | 13 |

The historical negative panel had one hard-blocked Camo pair and nine pending pairs per checkpoint under the same default policy. The [damage assessment service](../server/application/use-cases/damageDetection.service.js) requires an explicit verified relevance assertion for confident predictions. Its unverified path returns `EVIDENCE_REVIEW_REQUIRED`. The [report use case](../server/application/use-cases/report.service.js) can persist an inconclusive result as pending after category, description, evidence and location validation. A clean file-format or duplicate check cannot establish that ordinary photos depict infrastructure.

Proposed server policy for a follow-up:

1. **No supported detection.** Offer a retake or explicit manual submission with issue category and a description of what is visible. Store the reason for triage. Keep AI category and confirmation unset.
2. **Uncertain evidence.** Keep genuinely plausible alternate angles, weak predictions and ambiguous near-duplicates eligible for pending Barangay review. Keep the evidence reason and human decision in the audit trail.
3. **Demonstrably invalid evidence.** Enforce the existing stable rejection codes before issuing assessment proofs or writing report rows. Keep `DUPLICATE_EVIDENCE` for proven duplicates and `INVALID_EVIDENCE` for reliably identified unsuitable content such as a known camera placeholder. Broaden hard rejection only with a separately validated deterministic check and evidence-specific error. Ordinary cup, furniture, or other unrelated photos may remain pending with current capabilities.

The Citizen preview now treats conflicting weak labels as unverified, suppresses competing guesses in the summary and image zoom, and removes low-confidence boxes. A low scene score remains an advisory. The screenshot reproduced in the frontend regression uses 27.9%, 5.5%, and 43% scene similarity. The original photo files were unavailable for physical-scene or detector replay verification.

## Integrity and reproducibility

| Checkpoint path | SHA-256 |
| --- | --- |
| `models/production/best.pt`, before and after | `6e55d6fec65531180e1655e1b3c5931101fbf96e23346dff272b29c5422cd3d2` |
| `runs/neighborlens-v9/road_crack_recovery_v2/schedule_control/weights/best.pt` | `646ed407304a7da81eb8b250d268aaaab04f8e5807138bb709c2b6c48e4c6d04` |
| `runs/neighborlens-v9/road_crack_recovery_v2/rebalanced_hard_negatives/weights/best.pt` | `fa6b525deb7fb98621d487c8ea90e063190c7826d2b477c3b2fce1044833a95b` |

Local results are under `.data/road-crack-recovery-v2/`, including `historical-sweep.json`, `historical-v2-sweep.json`, `independent-sweep.json`, `backend-raw-results.json`, the train/validation manifests, and the independent evaluation at `independent-final/manifest.json`. Independent manifest SHA-256 is `ddc087469bd3c1e03c9e4768a1e7eee6a3cedf0cf4faacbcfd0cec766aa544e4`. The manifest records per-image and per-label checksums, source IDs and excluded items. Ultralytics run folders contain `args.yaml`, `results.csv` and experimental weights. The canonical IDs are 0 `broken_streetlight`, 1 `clogged_drainage`, 2 `pothole` and 3 `road_crack`.

Focused tests passed on OpenCV 5 with 62 Python tests passed and two skipped, 64 Node tests passed, and six Playwright checks passed across desktop and mobile Chromium projects.

Before another promotion decision, freeze a route- and capture-session-disjoint Bacolod mobile panel, with labeled alternate-view pairs and sufficient examples of each class. Then compare one training factor at a time against the same protected data.
