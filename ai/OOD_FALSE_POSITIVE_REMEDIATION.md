# NeighborLens false-positive and road-crack replay

## What changed

The rollout candidate is **under evaluation**. The Citizen backend prevents unverified YOLO predictions from becoming confirmed defects. The model still mislabels some unrelated photos and missed a crack in one of the two screenshot crops.

The former path accepted a canonical class above the model cutoff in `ai/inference/damage_contract.py`. The Node preview, pair verifier and submission used confidence and class agreement as confirmation. Duplicate, screenshot and portrait checks still run, but ordinary photos can pass those checks and trigger the same incorrect prediction from different angles.

The backend now requires `evidence_relevance: "VERIFIED"` from the trusted inference result for confirmation. YOLOv8m v9 supplies no independent verification, so its eligible predictions enter `EVIDENCE_REVIEW_REQUIRED`. The portal shows per-photo suggestions in that state with no green confirmation, automatic category, boxes, or persisted AI class. Signed proofs still bind to the citizen, the photo digest and the evidence order. Older detected proofs are reassessed before a new report is saved. The authenticated Barangay review path remains available.

## iPhone crack report

These are local crops of the two previews in the provided screenshot. The original camera files were unavailable. Class, confidence and box are from the current inference API.

| Photo | Current YOLOv8m v9 | Bounding box in replay pixels (x, y, width, height) | Experimental checkpoint |
| --- | --- | --- | --- |
| 1 | Road Crack, 42.98% | 0.00, 0.00, 153.55, 214.04 | Road Crack, 36.03% |
| 2 | Clogged Drainage, 66.25% | 8.00, 4.54, 225.25, 208.46 | No eligible prediction |

With the updated Citizen code, the two findings are visible as unverified suggestions with an explanation that the photos disagree. In an isolated authenticated replay, the pair was submitted under **Road Damage** and returned HTTP 201 with status `pending` and `EVIDENCE_REVIEW_REQUIRED`. That test used a valid Bacolod coordinate. The out-of-area warning in the screenshot is independent.

## Controlled fine-tuning

The three-epoch experiment used a QA-filtered v9 subset with 495 labeled training images and 78 visually reviewed zero-box backgrounds. Validation used 93 labeled images and 12 distinct backgrounds. Sources with matching contents or known source filenames in the protected split were excluded from the added training subset. This does not establish scene-level independence of the original v9 export. The existing test files were read and copied for evaluation. The protected test digest was `387bb544261b9da0a757bde83edd2bb2923e7a6a455487ad520faf68b77810ff` for 634 images and 976 boxes.

The held-out negative panel used 29 images and 10 pairs, including seven public multi-view cup sequences, the coffee and cat examples, screens, public portraits, and local crops of phone screenshots. The samples are deliberately enriched for difficult cases. The percentages describe this panel. [COCO128 source](https://github.com/ultralytics/assets/releases/tag/v0.0.0) and [Objectron multi-view source](https://github.com/google-research-datasets/Objectron)

| Measurement | Promoted v9 | Experimental |
| --- | ---: | ---: |
| Negative images with an eligible detection at 0.30 | 27/29 (93.1%) | 14/29 (48.3%) |
| Negative images still eligible after portrait check | 22/29 | 13/29 |
| Negative pairs accepted by raw class agreement | 9/10 | 4/10 |
| Negative pairs accepted after portrait check | 7/10 | 4/10 |
| Protected test mAP@0.5 | 68.81% | 66.31% |
| Protected test mAP@0.5:0.95 | 39.85% | 37.62% |
| Missed labeled defects at confidence 0.30 and IoU 0.50 | 285 | 331 |

The authenticated Citizen replay on the initial nine-pair panel yielded six false confirmations with the old confidence-and-class policy and zero with the relevance requirement. The old policy was replayed by supplying the attestation in the isolated harness to the same recorded model output. The full backend also applied its existing evidence checks. The zero count describes withholding automatic confirmation from unverified results.

| Class | v9 precision / recall | Experimental precision / recall | v9 → experimental missed boxes at 0.30 |
| --- | ---: | ---: | ---: |
| Broken Streetlight | 52.76% / 67.28% | 49.33% / 62.50% | 43 → 58 |
| Clogged Drainage | 83.10% / 82.36% | 87.74% / 81.10% | 32 → 36 |
| Pothole | 72.28% / 68.38% | 68.37% / 74.23% | 76 → 70 |
| Road Crack | 60.86% / 46.88% | 59.10% / 42.19% | 134 → 167 |

Precision and recall are from the standard Ultralytics validation calculation on the test copy at image size 640 with augmentation, confidence floor 0.001 and a maximum of 100 boxes. The missed-box column comes from a separate production-cutoff replay with one-to-one label matching.

Genuine smoke controls with a matching box were retained in all four classes by both checkpoints. A test-only composite adding a public portrait beside a labeled pothole retained the pothole with IoU 0.862 on v9 and 0.909 on the experiment. A real, independently labeled person-next-to-pothole photo was unavailable. The coffee cup remained a false streetlight detection at 56.72% and some cup pairs still agreed. The cat sample produced no detection. Camo Studio remained blocked by the Node screen gate despite raw detections from both checkpoints.

## Configurable COCO benchmark

Both checkpoints were replayed on the same 29 verified negatives, 10 negative view pairs and 634 protected test images (976 defect annotations). The benchmark takes object classes and overlap thresholds as arguments and records the complete experiment settings. It accepts empty and missing labels as zero-box background and reports them separately. The protected copy contained 617 non-empty label files and 17 empty ones. The negative panel had 29 images without label files.

| Detector | Overlap cutoff | Negative images with a prediction | Negative pairs that agreed | Protected mAP@0.5 / @0.5:0.95 | Correct boxes suppressed at 0.30 | Defect instances lost to veto |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| v9 | Off | 27/29 | 9/10 | 68.72% / 39.30% | 0 | 0 |
| v9 | 0.25 | 6/29 | 1/10 | 68.75% / 39.32% | 0 | 0 |
| v9 | 0.50 | 9/29 | 1/10 | 68.75% / 39.31% | 0 | 0 |
| v9 | 0.75 | 16/29 | 3/10 | 68.73% / 39.30% | 0 | 0 |
| Experimental | Off | 14/29 | 4/10 | 65.66% / 37.54% | 0 | 0 |
| Experimental | 0.25 | 4/29 | 0/10 | 65.75% / 37.59% | 1 | 0 |
| Experimental | 0.50 | 6/29 | 1/10 | 65.74% / 37.58% | 0 | 0 |
| Experimental | 0.75 | 8/29 | 2/10 | 65.66% / 37.54% | 0 | 0 |

Pair agreement measures two model outputs at confidence 0.30. The Citizen API adds evidence validation and requires independent relevance before confirmation. A focused backend test run covered duplicate and unsuitable evidence, unverified pair results, signed proofs and manual review.

The benchmark revision passed all six focused Python regressions and 12 Node report-evidence tests. The full Python run before the final configuration regression passed 205 tests with 12 skips. The final configuration regression passed in the focused run.

| Class | v9 recall at 0.30 | Experimental recall at 0.30 |
| --- | ---: | ---: |
| Broken Streetlight | 119/162 (73.46%) | 104/162 (64.20%) |
| Clogged Drainage | 171/203 (84.24%) | 167/203 (82.27%) |
| Pothole | 215/291 (73.88%) | 221/291 (75.95%) |
| Road Crack | 186/320 (58.13%) | 153/320 (47.81%) |

Each veto setting retained the same per-class recall at IoU 0.50 for its checkpoint. The experimental model lost one correct drainage box at 0.25 overlap, and an alternate eligible box still matched the same defect. The verifier found configured objects in 75 protected images containing 107 annotated instances. A synthetic regression test also reproduces a real loss when a verifier box overlaps a defect and there is no alternate match. The benchmark computes AP with Ultralytics integration and confidence-ordered box matching on identical predictions for each setting. The earlier standard validator results use a different matching and preprocessing path.

On a separate set of 14 visually reviewed COCO128 photos centered on bicycles, snowboards, boats, vehicles and other objects outside this configuration, the veto changed no decisions. v9 flagged 7/14 and the experimental model flagged 5/14 before and after every tested cutoff. Configured classes appeared in four images and may have been incidental. This panel was excluded from the experiment dataset by COCO image ID and exact hash. Its counts measure coverage on these examples.

Keep the COCO veto offline. The experiment reduced false positives and also lost 33 road-crack matches on the protected set. Prioritize the next four-class fine-tuning run with verified hard negatives from a wider range of scenes and verified hard positives from different capture angles. Use an independent validation split to select the checkpoint and calibrate any thresholds. If false accepts remain elevated at usable recall, evaluate a relevance model that sees the proposed region and its surroundings using separate unseen categories and verified mixed scenes. Keep uncertain evidence in the existing Barangay review path.

Raw results are in `.data/ood-hard-negative-v1/region-relevance-v2.json` and `.data/ood-hard-negative-v1/region-relevance-v2-outside-list.json`. The latter records the supplemental image IDs and checksums.

## Reproduction and verification

- Starting checkpoint is `models/production/best.pt` and the training input is `runs/neighborlens-v9/yolov8m_v9_qa_filtered_exp01/weights/best.pt`. Both still hash to `6e55d6fec65531180e1655e1b3c5931101fbf96e23346dff272b29c5422cd3d2`.
- The experiment is `runs/detect/runs/neighborlens-v9/yolov8m_v9_hard_negatives_exp01/weights/best.pt`, SHA‑256 `a73ad82e95cb0689a555ac94d1dff0c91dfa8881d9d2e2758dcecd2b9a50c1f5`. The production checkpoint and the earlier run are unchanged. No remote deployment took place.
- The ignored `.data/ood-hard-negative-v1` directory holds the reviewed background manifest, split manifest, raw predictions with SHA‑256 and bounding boxes, pair decisions, positive controls, training log and evaluation JSON. The supplied toolkit ZIP and original camera photo folder were absent, so the reproducible local audit uses the checked-in audit command, available fixtures, public samples and local screenshot crops. The public coffee and Chelsea regression images are CC0. [scikit-image image credits](https://scikit-image.org/docs/stable/api/skimage.data.html)

```powershell
.\.venv-yolo\Scripts\python.exe -m ai.training.build_hard_negative_experiment --export $Export --negatives $ReviewedManifest --out $NewDataset
$env:NL_EXPERIMENT_DATA = Join-Path $NewDataset 'data.yaml'
.\.venv-yolo\Scripts\python.exe -c "import os; from ultralytics import YOLO; YOLO('runs/neighborlens-v9/yolov8m_v9_qa_filtered_exp01/weights/best.pt').train(data=os.environ['NL_EXPERIMENT_DATA'], project='runs/neighborlens-v9', name='yolov8m_v9_hard_negatives_exp01_replay', exist_ok=False, resume=False, epochs=3, imgsz=640, batch=8, device=0, workers=0, amp=False, optimizer='AdamW', lr0=0.0002, seed=42, mosaic=0, plots=False)"
.\.venv\Scripts\python.exe -m ai.training.audit_ood_negatives --images $NegativePanel --pairs $PairManifest --weights $Checkpoint --out $FreshAuditOutput --conf 0.30 --imgsz 640
.\.venv\Scripts\python.exe -m ai.training.benchmark_region_relevance --weights $ProductionWeights --candidate $CandidateWeights --verifier models/checkpoints/yolo26n.pt --negatives $NegativePanel --negative-pairs $PairManifest --test-images $ProtectedImages --test-labels $ProtectedLabels --object-classes person cup cat dog keyboard laptop tv 'cell phone' --overlap-thresholds 0.25 0.50 0.75 --out $FreshBenchmarkOutput
.\.venv\Scripts\python.exe -m pytest ai/tests -q --disable-warnings
npm run test:unit
npm run test:integration
npx playwright test --config playwright.phase2.config.js --grep 'disagreeing AI suggestions|borderline duplicate|portrait rejection|Camo Studio evidence|accepts the suggestion'
```

Python passed 200 tests with 12 skips. Node passed 548 unit and 646 integration tests. The focused desktop and mobile Chromium run passed 10 tests. These include authorized and unauthorized persistence, signed review evidence, stale proofs, existing rejection rules, the four independently verified class fixtures and the disagreement UI.

## Affected files

- `server/application/use-cases/damageDetection.service.js`, `server/application/use-cases/report.service.js`
- `frontend/js/citizen/damagePairAssessment.js`, `frontend/js/citizen/citizen.js`
- `ai/training/audit_ood_negatives.py`, `ai/training/build_hard_negative_experiment.py`, `ai/training/benchmark_region_relevance.py`
- `server/tests/assessment-evidence-remediation.test.js`, `server/tests/damage-contract.test.js`, `server/tests/damage-detection.test.js`, `server/tests/pair-stability.test.js`, `server/tests/qa-inference-contract.test.js`
- `tests/integration/report-evidence.test.js`, `tests/browser/phase-2.spec.js`, `tests/support/test-app.js`, `tests/fixtures/report-evidence/coffee.png`, `tests/fixtures/report-evidence/chelsea.png`
