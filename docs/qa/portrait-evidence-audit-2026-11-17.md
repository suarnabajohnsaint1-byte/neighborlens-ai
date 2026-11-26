# Portrait evidence audit

## Reproduction

The Citizen Portal on iPhone Safari displayed `broken_streetlight` for both selfie photos at 56.8% and 59.1%. Replaying the two visible photo crops through the running YOLOv8m v9 service produced the same class at 59.82% and 68.51%. The crops contain material from the screenshot and are separate from the original camera files. Two public NASA portrait crops reproduced the same class at 72.62% and 61.47%. The running service used the manifest-matched checkpoint `6e55d6fec65531180e1655e1b3c5931101fbf96e23346dff272b29c5422cd3d2`, image size 640 and confidence cutoff 0.30.

The failure combines model and intake behavior. `YoloDetector` applies the existing image resize, test-time augmentation and Ultralytics post-processing. Its four-class output really did contain eligible boxes. `decide` can return zero detections and does not assign a class to an empty result. The Node evidence gate detects duplicates and obvious flat graphics, then accepts model candidates by their class and confidence. The two different selfie frames passed that gate and the same-class pair rule. The legacy submission fallback also selected a single positive image when the client supplied no assessment proofs.

## Contract and domain change

- Filter candidate boxes centered on a prominent frontal face with two OpenCV cascades. Each must find a face rectangle at least 12% of the image, with overlap of at least 15% of the candidate box. The smallest face and smallest overlap among the eligible boxes in the two phone crops and two public crops were approximately 14% and 17%. Geometry alone is insufficient. The v9 test export contains 32 annotations covering over 70% of their image, including legitimate close-up drainage defects. The first cascade alone falsely flagged a leaf-covered drain and suppressed a true detection. Agreement is required because the second cascade found no face on that image and corroborated all four portrait crops.
- If that signal accounts for every eligible box in a photo, `/predict` and both pair paths return the existing 422 evidence-error shape with `INVALID_EVIDENCE`. Node propagates the known error before proof issuance or new report persistence. If an eligible candidate survives outside the face, it is evaluated normally. The filter does not identify individuals or treat a person's presence as a rejection. Ordinary `NO_DETECTION`, low-light uncertainty, low confidence and the existing manual-review path retain their current semantics.
- Submission-time inference must independently find the same accepted class in both views before it writes the legacy detected fields. Reports with an unconfirmed pair can still enter manual review under the existing contract. The original signed assessment remains a separate historical snapshot.
- Both cascades ship with the existing OpenCV 4 dependency. The guard leaves endpoint paths, weights and YOLO confidence thresholds unchanged. Face coordinates are only used in memory.

## Scope limits

The full NASA portrait, person with camera, cat and cup of coffee also produced eligible detections at 40.67%, 65.58%, 69.58% and 74.34%. These cases require verified background and mixed-scene examples for a more general relevance gate or a separately validated model update. The moving cutoff needed to reject them would also discard genuine detections. Camo Studio remains covered by the existing Node screenshot guard.

The training snapshot contains 65 empty labels among 5,544 training images. Validation has 21 empty labels among 1,259 images. Test has 17 among 634. Empty labels show the absence of annotated boxes and do not establish that the images are verified negatives. No file was byte-identical across splits. Removing the `.rf.` augmentation suffix yielded 32 shared train/validation names, 21 train/test names and 7 validation/test names. These are candidate scene overlaps pending visual review. The release manifest has no frozen test hash. A controlled follow-up should audit label semantics and scene lineage, mine high-confidence negatives, and hold out verified indoor, household and person-with-damage scenes before any checkpoint promotion.

## Verification

The two-cascade guard rejected all four close portrait crops with the real v9 checkpoint. In an isolated Node API using real inference, false acceptance fell from 8 of 9 to 4 of 9 on the diagnostic negative panel. Two portraits are crops of the same phone screenshot and two are crops of one public portrait. These counts describe the panel. They are not a deployment false-positive-rate estimate. The four residual positives were the full astronaut portrait, person with camera, cat and coffee. Camo Studio returned 422 in both runs through the existing screenshot guard.

The same phone pair returned HTTP 422 `INVALID_EVIDENCE` through Citizen assessment, the pair API, and direct report submission. The isolated database gained no reports, report images or publication requests. The regression for an eligible candidate beside a prominent face uses injected boxes to verify that the unaffected candidate survives. The data export had no independently corroborated prominent face, so this is not a real mixed-scene sensitivity estimate.

| v9 test export, 634 images and 976 boxes | Baseline | Two-cascade guard |
| --- | ---: | ---: |
| True positives at confidence 0.30 and IoU 0.50 | 691 | 691 |
| False positives at confidence 0.30 and IoU 0.50 | 487 | 487 |
| False negatives at confidence 0.30 and IoU 0.50 | 285 | 285 |
| Precision at confidence 0.30 and IoU 0.50 | 58.66% | 58.66% |
| Recall at confidence 0.30 and IoU 0.50 | 70.80% | 70.80% |
| mAP50 | 67.91% | 67.91% |
| mAP50–95 | 38.77% | 38.77% |

This paired diagnostic evaluated the available v9 test export at image size 640 with the existing augmentation, diagnostic confidence floor 0.05 and a maximum of 100 boxes. Absolute test results are separate from the manifest's recorded validation metrics. The leaf-covered drain that triggered the first cascade alone retained its `clogged_drainage` detection at 82.77% with the two-cascade guard.

Separate smoke checks found a correctly localized eligible box in each class. Confidence was 45.66% for broken streetlight, 85.74% for clogged drainage, 89.23% for pothole and 87.60% for road crack. A deliberately dimmed and blurred pothole fixture returned HTTP 200 with `no_detection` and null confidence. That synthetic low-light control exercises model abstention and is separate from representative night photography.

An offline scan with the existing pretrained COCO checkpoint flagged 13 test-export candidates with people or body parts near labeled damage. Two visually inspected drain scenes showed only legs or shoes at the edges and retained drainage detections at 55.41% and 86.93%. The two pothole-labeled candidates showed people and damaged infrastructure, but their provenance is unverified and v9 returned only streetlight detections. One was a market image with three pothole labels and no clearly visible pothole at those boxes. It needs annotation review. A verified photo of a person beside a pothole and a close face beside genuine damage still needs to be added to the held-out panel.

The original iPhone screenshot confirms capture and the baseline false positive through Cloudflare. The revised guard was first exercised in an isolated OpenCV 4 runtime.

A second iPhone screenshot showed an 86.4% streetlight detection. The tunnel still served an older local Python process, and its virtual environment had OpenCV 5 and OpenCV 4 headless installed into the same `cv2` namespace. The active OpenCV 5 import lacked `CascadeClassifier`. A full-frame crop of the screenshot replayed at 84.29% before the restart. After installing OpenCV 4.14.0.94 and restarting the local inference service, both screenshot crops returned HTTP 422 `INVALID_EVIDENCE`. The same error reached the authenticated Citizen API through the local server for the screenshot crop and through HTTPS Cloudflare for the public portrait. Neither response carried an assessment proof. The known drain still scored 82.77%, and identical photos still returned `DUPLICATE_EVIDENCE`. The v9 checkpoint SHA-256 remained `6e55d6fec65531180e1655e1b3c5931101fbf96e23346dff272b29c5422cd3d2`.

The local and CI dependency lists now select OpenCV 4 through the standard `opencv-python` package. The inference API returns HTTP 503 `EVIDENCE_CHECK_UNAVAILABLE` if the face classifiers cannot load and a prediction would otherwise be accepted. Low-confidence output retains its existing behavior. The follow-up checks passed 200 Python tests with 12 skips, 29 focused Node tests, and six desktop and mobile Chromium tests. A fresh iPhone capture is pending confirmation.

The Node suite passed 1,192 tests. The Python suite passed 198 with 12 skips. Six desktop and mobile Chromium checks covered portrait rejection, Camo Studio rejection and successful AI-assisted submission. The camera changes also passed eight Chromium checks and a WebKit permission-handling check.

The public portrait test fixture is a crop of NASA's photograph distributed by [scikit-image sample data](https://scikit-image.org/docs/stable/api/skimage.data.html). The user's photo crops were used only in the local replay.

## Changed components

- Inference and packaging. `ai/inference/portrait_evidence.py`, `ai/inference/inference_api.py`, `inference-vercel/build.py`. The Vercel staging checksum gate keeps its existing approved hash.
- Report acceptance and error transport. `server/application/use-cases/damageDetection.service.js`, `server/infrastructure/ai/localYolo/localYoloClient.js`. The existing Citizen UI interprets `INVALID_EVIDENCE`, displays the backend's message and keeps the retake action visible.
- Regression coverage. `ai/tests/test_inference_api_contract.py`, `ai/tests/test_vercel_inference_entrypoint.py`, `server/tests/inference-service-auth.test.js`, `server/tests/report.service.test.js`, `tests/integration/report-evidence.test.js`, `tests/browser/phase-2.spec.js`, `tests/fixtures/report-evidence/public-portrait.jpg`.
