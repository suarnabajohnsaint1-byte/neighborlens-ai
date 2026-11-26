# Face-aware evidence validation experiment

**NO-GO for production enablement.** The filter removed five of seven selfie false positives in this panel and preserved all matched defects in the measured labeled panels. Two portrait false positives remained. The person-and-defect controls are composites, and the occlusion controls did not establish reliable detection of a blocked view. The filter remains opt-in.

## Implementation and scope

The existing four-class YOLOv8m checkpoint runs first. The optional validator uses OpenCV `FaceDetectorYN` with the dynamic-input YuNet 2026may asset. It consumes face rectangles in memory and discards the landmark output. There are no identity embeddings or face regions in API responses, assessment proofs, or reports. Normal inference does not load the face model. Explicit opt-in verifies the model SHA-256 and runs a startup smoke test before loading YOLO weights. A per-image OpenCV error returns the ordinary YOLO result to the existing backend evidence workflow. [OpenCV 5 FaceDetectorYN documentation](https://docs.opencv.org/5.0/main_modules/objdetect_dnn_face.html), [Pinned official YuNet asset and checksum](https://raw.githubusercontent.com/opencv/opencv_zoo/47534e27c9851bb1128ccc0102f1145e27f23f98/models/face_detection_yunet/face_detection_yunet_2026may.onnx)

Face proposals use a 0.80 face score and a maximum 640-pixel input edge. A detection box is suppressed if the face covers at least 50% of the box, or if the box center lies in the face, the box covers at least 70% of the face, and at least 10% of the box is shared. The validator retains other detections. If all eligible detections are suppressed, or only weak detections remain after suppression, FastAPI returns HTTP 200 and a review outcome. The Citizen preview requests a clearer photo or lets the citizen submit for Barangay review. The existing exact and known-invalid photo checks still reject proven invalid evidence. A face check supplies no positive assertion that a photo contains a genuine defect.

The Citizen card now opens with a plain-language status and an issue description. Per-photo scores, scene comparison, and model details are available under **Detection details**. Green boxes mark eligible detections in a confirmed pair. Amber marks matching suggestions that still need review.

## Raw versus filtered YOLOv8m v9

The comparison uses the same YOLO predictions on both sides, confidence 0.30, 640 px, test-time augmentation, 100 maximum detections and class-aware one-to-one matching at IoU ≥0.50. AP uses the 0.001 diagnostic floor. Precision and AP include the 65 separately labeled negative images in addition to each labeled defect panel. Negative-pair agreement is a raw detection metric and does not measure report approval.

| Evaluation | Raw YOLOv8m | YOLOv8m plus face validation |
| --- | ---: | ---: |
| Selfies with an eligible false detection | 7/7 | 2/7 |
| Unrelated non-selfie images with a false detection | 53/58 | 53/58 |
| All negative images with a false detection | 60/65 | 55/65 |
| Agreeing negative photo pairs | 23/28 | 21/28 |
| Historical mAP50 / mAP50–95 | 65.36% / 37.45% | 65.77% / 37.68% |
| Independent mAP50 / mAP50–95 | 1.38% / 0.43% | 1.39% / 0.43% |
| Historical legitimate matched defects | 691 | 691 |
| Independent legitimate matched defects | 1 | 1 |
| Four original and four mixed composite images, legitimate matched defects | 27 | 27 |

| Historical class | Raw precision / recall / AP50 | Filtered precision / recall / AP50 | Negative images with this false class, raw → filtered |
| --- | --- | --- | ---: |
| Broken Streetlight | 36.17% / 73.46% / 50.39% | 37.07% / 73.46% / 52.03% | 51 → 46 of 65 |
| Clogged Drainage | 70.95% / 84.24% / 84.87% | 70.95% / 84.24% / 84.88% | 13 → 13 of 65 |
| Pothole | 64.18% / 73.88% / 73.26% | 64.18% / 73.88% / 73.26% | 2 → 2 of 65 |
| Road Crack | 52.10% / 58.13% / 52.92% | 52.10% / 58.13% / 52.92% | 0 → 0 of 65 |

The historical panel has 634 images and known training overlap as documented in the [v2 recovery audit](ROAD_CRACK_RECOVERY_V2.md). The separate 74-image panel was screened against available training data and has one annotated drainage and one annotated streetlight instance. Only one crack was matched by baseline v9 at 0.30 on that panel, so the zero-suppression result there provides limited assurance. The seven selfie files include alternate views and crops. Those counts cannot be interpreted as seven independent people or a field false-positive estimate.

### Real inference endpoint checks

- The public portrait and phone-portrait smoke cases changed from a strong streetlight false positive to review. The selected selfie pair changed from raw `DETECTED` to `EVIDENCE_REVIEW_REQUIRED`. The Node integration test verified that the review response issues no detected proof and can be stored as a pending report.
- Four controlled composites put a portrait beside a labeled defect. All four primary detections survived. These controls use compositing and establish spatial behavior rather than performance on real mixed incident photos.
- Four crack-occlusion composites retained an eligible road-crack box. The filter removed a separate face-associated streetlight prediction in one variant and a drainage prediction in another. The retained boxes did not meet the face-overlap rule. The controls therefore failed to establish when a partly obscured crack should trigger a request for a clearer image.
- The mug false positive remained. One of three visually selected intact-road controls still produced a pothole false positive. The other two had weak candidates and no eligible detection. These cases need better raw detector behavior or other validated evidence checks.

## Separate raw Road Crack recovery

The new v3 checkpoint starts from production v9, uses the same v2 rebalanced data and validation folds, and reduces geometric scale augmentation from 0.50 to 0.25. The run kept 3 epochs, 640 px, batch 8, AdamW, LR 0.00004, no warmup and seed 42. The face detector was disabled during training and these comparisons.

| Raw YOLO at confidence 0.30 | Baseline v9 | Rebalanced v2 | Reduced-scale v3 |
| --- | ---: | ---: | ---: |
| Historical crack recall | 186/320 (58.13%) | 191/320 (59.69%) | 185/320 (57.81%) |
| Historical negative images / agreeing pairs | 27/29 · 9/10 | 21/29 · 6/10 | 19/29 · 4/10 |
| Independent crack recall | 1/78 (1.28%) | 3/78 (3.85%) | 5/78 (6.41%) |
| Independent negative images / agreeing pairs | 33/36 · 14/18 | 20/36 · 6/18 | 15/36 · 4/18 |
| Independent mAP50 / mAP50–95 | 1.50% / 0.47% | 2.51% / 0.68% | 4.30% / 1.32% |

V3 missed the historical gate by one label. Its historical Streetlight recall fell from 73.46% to 66.05%, Drainage from 84.24% to 79.31%, and Pothole increased from 73.88% to 76.63% against v9. Independent crack recall remains too low for promotion. The next benchmark needs labeled Bacolod mobile pairs, varied people and camera conditions, and reliable counts for all four classes.

## Reproduction and research reporting

- Production checkpoint `models/production/best.pt` SHA-256 before and after was `6e55d6fec65531180e1655e1b3c5931101fbf96e23346dff272b29c5422cd3d2`.
- Experimental v3 weights `runs/neighborlens-v9/road_crack_recovery_v3/reduced_scale/weights/best.pt` SHA-256 is `6bdfbdaa8da0dcce20ce126cc8fc0e97fbd234de78ec657c46b4630b4bd39ec1`.
- Local reproduction uses [benchmark_face_evidence.py](training/benchmark_face_evidence.py). The benchmark manifests, per-image audits, real route smoke results and v3 sweeps are under `.data/face-aware-experiment/`. The YuNet asset is an explicitly supplied local file with SHA-256 `ebafce4e3c118d6554634be5c27ab333b4c047a9a8c3faf1d7cf93101c22f0f0`.
- For a Citizen Portal already pointing to local inference, stop the running inference process and use `npm run ai -- --face-dev`. This uses `.venv-yolo`, the locally stored YuNet asset, and the regular configured inference address. The flag requires a loopback development server. For an isolated inference-only test, use `python -m ai.inference.inference_api --port 8002 --enable-portrait-filter --portrait-model .data/face-aware-experiment/face_detection_yunet_2026may.onnx`. The experiment was never deployed.
- The focused OpenCV 5 suite passed 65 tests with the actual YuNet asset. The full Python suite passed 212 tests with 14 skips in the existing project test environment, which supplies the dataset-only dependencies missing from the inference environment. Node evidence and frontend tests passed 116 cases. Playwright passed 12 desktop and mobile checks.
- In the paper, report raw YOLOv8m results and results of the combined pipeline in separate tables. Include overlap thresholds, positive suppression, mixed-scene and occlusion limits, and the group composition. The four canonical classes are identical in both rows.
