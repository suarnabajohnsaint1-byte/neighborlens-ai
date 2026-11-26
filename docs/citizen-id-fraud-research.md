# Citizen ID fraud research

Phase 2.1 runs real models in a separate FastAPI research process. It does not change YOLOv8 report inference or issue identity approvals. The Node adapter authenticates the exact response bytes and checks the capture identifier and both ordered frame hashes. A signed research response still sends the application to review.

## Model and license review

| Candidate | Artifact and license | Outcome |
| --- | --- | --- |
| [TruFor upstream](https://github.com/grip-unina/TruFor/tree/ae54475df6f41a491d7615100feb19263dec13f7) | Pin source revision `ae54475df6f41a491d7615100feb19263dec13f7`. The downloaded archive matched the authors' MD5 `7bee48f3476c75616c3c5721ab256ff8`. SHA-256 `953f1f7eda0dd2c5ece322ae9c185ba1079c1265aa5fdf319ef5a20604d206d8` is enforced by the loader. The upstream license restricts use to informational and nonprofit purposes. | Ran the upstream detector head with `weights_only=True` on an RTX 3060. Node verified the signed research response over loopback HTTP and withheld enrollment approval. |
| [PhotoHolmes](https://github.com/photoholmes/photoholmes#license) | The wrapper is Apache-2.0. Individual methods and weights have their own terms. TruFor retains its restrictive terms through PhotoHolmes. | Selected TruFor as a baseline and loaded its pinned upstream implementation directly. The PhotoHolmes package itself was not run. |
| [FREUID a31 submission](https://github.com/gc22-shin/FREUIDChallenge2026/tree/a68e6d7a570fd6648f381984d0bcfca46b91943e) | MIT source. SHA-256 pins for `best.pt` and `field_boxes_v2.json` are in the loader. The [challenge dataset](https://freuid2026.microblink.com/) is restricted to noncommercial research. Source licensing alone does not clear model deployment rights. | Ran the pinned checkpoint on CUDA. It returned the same score for an exploratory original and edited synthetic pair under a foreign crop layout. The five published crop layouts do not include PhilSys. |
| [LavleshJ FREUID](https://huggingface.co/LavleshJ/freuid-fraud-detector/tree/main) | Model card lists `freuid_fold1.pt`; the public file tree does not contain it and the direct weight URL returned 404. | No inference run for this checkpoint. |
| [LC&DF](https://github.com/chenlewis/LC-DF-For-DPAD) | BSD-3-Clause source and an upstream pretrained download link. The weight artifact, usage rights, and compatibility with the current runtime remain unverified. | Dedicated screen-recapture candidate. No verified checkpoint is loaded. |
| [RISA](https://huggingface.co/HanyueShen/risa-recaptured-image-detection) | Research-only tensor release. The author does not publish the raw-image feature pipeline. | No reproducible end-to-end test from a document photo. |

TruFor's official archive is linked in the [authors' README](https://github.com/grip-unina/TruFor/blob/main/TruFor_train_test/README.md#inference-using-our-provided-weights-no-training-required). The copy used in this run came from a [public mirror](https://huggingface.co/DaniilOr/detect/tree/main). An independent download from the university returned the same SHA-256 and matched the authors' published MD5. No model weights or research images are checked into NeighborLens.

## Preliminary actual inference

The exploratory score threshold was fixed at 0.50 for both cohorts. Scores at or above the threshold counted as flags. These samples do not establish Philippine ID performance or a production threshold.

| Cohort | True negatives | False positives | True positives | False negatives | Accuracy | Precision | Recall | False-positive rate | False-negative rate |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| AI inpaint-and-rewrite | 8 | 2 | 4 | 6 | 60% | 66.7% | 40% | 20% | 60% |
| Monitor recapture | 2 | 0 | 0 | 6 | 25% | Undefined | 0% | 0% | 100% |

The AI-edit cohort used the ten `positive` and ten `fraud_inpaint_and_rewrite` examples among rows 0–29 of the Albanian [IDSpace scan preview](https://huggingface.co/datasets/cactuslab/IDSpace), a CC BY 4.0 synthetic dataset. It tests AI text edits on simulated scans.

The monitor cohort used actual camera-recapture patches published in [DLC-2021 Figure 7](https://www.mdpi.com/2313-433X/8/7/181#fig_body_display_jimaging-08-00181-f007). Results use column 2 as negatives and columns 3–5 as positives across both rows of the 550×262 figure. The 104-pixel-high patches start at y=5 and y=132, with x=116–219 for originals and 102-pixel-wide recapture crops starting at x=224, 333, and 442. The patches share mock documents and are not independent. This measures how the **tampering model** behaves on screen photographs. It supplies no evidence of capability for a dedicated recapture classifier.

On the four original TruFor demo images the two pristine scores were below 0.50 and the two manipulated scores were above it. That verifies basic inference on upstream examples. It is separate from the ID experiments above.

## Remaining production dependencies

- Authorized PhilSys issuer and holder verification, with credentials and an approved evidence-handling arrangement.
- The Bacolod CPDO-approved machine-readable city boundary and pinned SHA-256.
- A licensed, dedicated display-recapture detector and a tampering detector validated on independent, consented Philippine ID captures. The preliminary scores above do not support releasing either detector for automated enrollment.
- A validated independent fraud service returning signed checks under the production contract. A research score, absent result, or inconclusive result cannot satisfy it.

## Local ID fraud benchmark, Phase 2

**Finding.** Grayscale printed copies were the weakest tested fraud category across both checkpoints. At a fixed 0.50 score threshold, TruFor detected 0 of 9 and the FREUID foreign-layout probe detected 2 of 9. The false-positive rates on matched laminated originals were 44.4% and 55.6%, respectively. These results do not support an enrollment rule or a production-readiness claim.

### Audit and protocol

- The existing 0.50 threshold was fixed before scoring. The pinned TruFor source revision, checkpoint SHA-256, FREUID checkpoint SHA-256, and crop configuration SHA-256 matched the existing Phase 2.1 pins. TruFor is a research tampering detector with restrictive upstream terms. FREUID a31 has no PhilSys layout. Its Mauritius field crops here are an explicitly out-of-layout transfer probe, not a supported configuration.
- The physical cohort uses licensed DLC-2021 captures of laminated mock documents, monitor presentations, and unlaminated grayscale copies. Two published video frames per clip were resized to the app's 1,600-pixel maximum long edge and scored through the existing FastAPI research inference functions. The larger frame score represents the clip. Content was acquired by bounded range requests and checked against the ZIP member CRC and local SHA-256. Nine of twelve planned test document groups were available. Three incomplete groups were excluded after range download failures, before inference.
- The validation set has three matched original-document groups captured on a Samsung S10, under artificial light or colored light with flash, with Philips displays in the recapture class. The test set has nine different document groups captured on an iPhone XR, with low light, bright interference, or daylight and alternating shadow in the physical classes, and HP or MacBook Pro displays in the recapture class. The runner checks document-group, camera, display, lighting, clip-frame, and byte-level separation before scoring. Each source document corresponds to a distinct synthetic identity in the publisher's dataset. Device separation applies to this experiment and does not establish the cameras were absent from pretrained-model training.
- The AI cohort is the public IDSpace Albanian scanner preview subset of 10 synthetic originals and 10 synthetic inpaint-and-rewrite examples. Checked all 20 byte digests for duplicates. The cached preview lacks source-person and capture-session groups, so this is a fixed-threshold external probe. Its results are kept separate from the grouped physical holdout.
- The baseline always clears every sample. The additional physical baseline flags low OpenCV Laplacian variance, choosing its threshold on validation by maximizing recall minus false-positive rate. No model weights were fitted or retrained. OCR was exercised through the existing scanner browser fixtures. These tables measure visual fraud scores and do not measure OCR field accuracy.

Sources: [DLC-2021 protocol and dataset license](https://www.mdpi.com/2313-433X/8/7/181), [DLC-2021 archive and corrected manifest](https://zenodo.org/records/7467028), [DLC-2021 recapture archive](https://zenodo.org/records/6466770), [IDSpace dataset card and license](https://huggingface.co/datasets/cactuslab/IDSpace/blob/main/README.md).

### Test results

Confusion counts are in TN / FP / TP / FN order. A dash means precision is undefined because the model raised no flags.

| Attack | Model or baseline | TN / FP / TP / FN | Precision | Recall | F1 | FPR | FNR |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: |
| Monitor recapture | TruFor | 5 / 4 / 1 / 8 | 20.0% | 11.1% | 14.3% | 44.4% | 88.9% |
| Monitor recapture | FREUID foreign-layout probe | 4 / 5 / 6 / 3 | 54.5% | 66.7% | 60.0% | 55.6% | 33.3% |
| Monitor recapture | Low sharpness | 5 / 4 / 1 / 8 | 20.0% | 11.1% | 14.3% | 44.4% | 88.9% |
| Monitor recapture | Always clear | 9 / 0 / 0 / 9 | — | 0% | 0% | 0% | 100% |
| Grayscale printed copy | TruFor | 5 / 4 / 0 / 9 | 0% | 0% | 0% | 44.4% | 100% |
| Grayscale printed copy | FREUID foreign-layout probe | 4 / 5 / 2 / 7 | 28.6% | 22.2% | 25.0% | 55.6% | 77.8% |
| Grayscale printed copy | Low sharpness | 2 / 7 / 5 / 4 | 41.7% | 55.6% | 47.6% | 77.8% | 44.4% |
| Grayscale printed copy | Always clear | 9 / 0 / 0 / 9 | — | 0% | 0% | 0% | 100% |
| AI inpaint-and-rewrite | TruFor | 8 / 2 / 4 / 6 | 66.7% | 40.0% | 50.0% | 20.0% | 60.0% |
| AI inpaint-and-rewrite | FREUID foreign-layout probe | 4 / 6 / 7 / 3 | 53.8% | 70.0% | 60.9% | 60.0% | 30.0% |
| AI inpaint-and-rewrite | Always clear | 10 / 0 / 0 / 10 | — | 0% | 0% | 0% | 100% |

The low-sharpness baseline matched TruFor's monitor confusion matrix and exceeded both model F1 scores for gray print copies while falsely flagging 7 of 9 originals at its print threshold. FREUID flagged 5 of 9 physical originals and 6 of 10 scanner-preview originals. None of these operating points is suitable for an automatic rejection rule.

### Coverage limits

The clips cover two display devices in the test set and three physical lighting conditions. The iPhone was the camera, not the display under test. Phone-display recaptures, color printed copies, genuine Philippine government IDs, and deliberate angle bins remain unmeasured. This run uses no citizen IDs, cloud inference, paid APIs, or identity providers.

With the nine laminated originals, the TruFor and FREUID false-positive counts were 2/3 and 3/3 under bright interference, 1/4 and 0/4 under low light, and 1/2 and 2/2 under daylight with alternating shadow. These strata are too small for generalization.

### Reproduction

The checked input manifest and downloaded public samples are in the ignored local directory `.data/identity-phase22`. Model files and the AI preview use the existing ignored `.data/identity-phase21` layout. No model weights or document images are tracked.

```powershell
$env:PYTHONPATH = (Resolve-Path .data/identity-phase21/deps).Path
.\.venv\Scripts\python.exe -m ai.identity.benchmark_capture_cohorts --assets .data/identity-phase21 --physical-manifest .data/identity-phase22/benchmark-manifest.csv --ai-preview --device cuda
```

## Phase 2.3 physical screening experiments

**Readiness decision:** Keep the models and new signals in offline research. The existing live-camera scanner, OCR auto-fill rules, warning policy, and independent enrollment gates are unchanged. No learned weights or production thresholds were changed.

### Why the Phase 2 misses and false positives happened

- Grayscale copies are a physical presentation attack. They can preserve the source document's fields and layout. TruFor and FREUID were evaluated here as image-manipulation models, and their model targets do not cover a verified print-presentation attack decision. From the nine-document retest, TruFor found 0 of 9 gray copies from the full scene and 1 of 9 from the annotated document crop. FREUID's foreign-layout probe dropped from 2 to 1 true positives after cropping. The low-chroma document feature found 8 of 9, showing that a measurable print-specific signal is available in this cohort. It also flagged 4 of the 9 laminated originals.
- At the same 0.50 threshold, requiring both captured frames to flag reduced TruFor's laminated-original false positives from 4 to 1 and FREUID's from 5 to 2. For FREUID, using the annotated document alone reduced these false positives to zero, but gray-copy recall also fell. TruFor still falsely flagged 4 originals after cropping. These ablations implicate transient frame evidence and scene framing. They cannot isolate glare, color balance, image resampling, and field-layout mismatch as individual causes, because the clips change several variables together.
- The FREUID submission normally uses a document-specific crop template. The NeighborLens probe applies the Mauritius crop template to mismatched layouts. On full portrait captures it can also crop scene background or the wrong fields. The probe is useful for comparing sensitivity to framing. Its absolute scores do not measure supported-layout performance.

### FREUID checkpoint verification

The pinned a31 asset is `assets/best.pt` from upstream revision `a68e6d7a570fd6648f381984d0bcfca46b91943e`. The local 43,335,979-byte file matched the publisher's SHA-256 `4b0b61edc5e499cb4e21e93bbbe373adbbd9c8f2e010e48983e517c9574a6f99`. The field-box JSON matched `4a1a21c4037da66d761580371a73c51256517a4f8c3c3d87b3ac3812429490c2`. The repository describes the checkpoint as the best validation epoch, epoch 4 of 6, from a seed-42 run initialized with ImageNet-pretrained EfficientNet-B3. The file itself contains `model` and `score`, with no epoch field. [Official checksums](https://raw.githubusercontent.com/gc22-shin/FREUIDChallenge2026/a68e6d7a570fd6648f381984d0bcfca46b91943e/assets/CHECKSUMS.txt) · [Submission provenance](https://github.com/gc22-shin/FREUIDChallenge2026)

Runtime audit matched all 575 loaded state tensors exactly to the checkpoint. The model has 10,698,849 trainable parameters, a six-channel `[40, 6, 3, 3]` stem, an EfficientNet-B3 binary head of `[1, 1536]`, and an SRM residual kernel with 129 nonzero entries. It scores 13 crops with flip averaging and max aggregation in eval mode. The `pretrained=False` constructor prevents a separate download. The strict state-dictionary load installs the trained weights. NeighborLens ran this probe in FP32, while the submission describes an FP16 CUDA path. Treat this as checkpoint verification and local inference, rather than leaderboard reproduction.

Upstream publishes the repository under MIT. The challenge organizers describe the training dataset as noncommercial research only. Clearing deployment rights for the weights is a separate dependency. The present audit uses the already downloaded checkpoint for local research. [Pinned MIT license](https://raw.githubusercontent.com/gc22-shin/FREUIDChallenge2026/a68e6d7a570fd6648f381984d0bcfca46b91943e/LICENSE) · [Challenge data rules](https://freuid2026.microblink.com/#faq)

### Evaluation protocol

- The held-out physical pilot used new DLC-2021 source documents from Azerbaijan, Spain, Estonia, and Slovakia. The rig used an iPhone XR, Lenovo, HP and MacBook Pro displays, daylight and low light, and grayscale and color unlaminated print copies. The validation captures were separate documents and sessions using a Samsung S10, Philips display, and artificial or colored light with flash. The runner checks source documents, frame hashes, and camera/display/lighting separation. Printed-copy hardware models are absent from the published manifest. [DLC-2021 publication](https://www.mdpi.com/2313-433X/8/7/181)
- Candidate features are paper-relative CIELAB chroma for grayscale print, off-axis spectral peaks for display recapture, and high-pass residual variation across tiles for digital edits. The physical measurements use publisher-provided quadrilaterals, bound to the exact annotated frame filename and byte length. This is an offline experiment with reference crops. Automatic corner detection must be evaluated before applying it to live captures. OpenCV sharpness and always-clear are baselines.
- The synthetic edit expansion used the IDSpace scanned preview. A country split alone leaked a known portrait. The overlapping Azerbaijan validation example was excluded before scoring. The validation subset contains 9 originals and 10 inpaint-and-rewrite images. Spain contributes 10 originals, 10 inpaint-and-rewrite images, and 10 crop-and-replace images for evaluation. Five of ten crop-and-replace entries lacked a recoverable portrait key, so that arm is exploratory. [IDSpace dataset card](https://huggingface.co/datasets/cactuslab/IDSpace/blob/main/README.md)
- The two model thresholds stayed at 0.50. Simple signal thresholds were chosen using validation only. The color-copy evaluation reuses the grayscale threshold. The crop-and-replace evaluation reuses the inpaint calibration. No training split was consumed because no retraining was performed.

### Phase 2.3 test results

Counts are TN / FP / TP / FN. Other columns are percentages. A dash indicates no positive prediction and undefined precision. FREUID denotes the foreign-layout probe. The physical rows below are from the four fresh source-document groups. Color copies were available for three of those groups.

| Attack | Method | Confusion counts | Precision | Recall | F1 | FPR | FNR |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: |
| Grayscale print | TruFor | 2 / 2 / 1 / 3 | 33.3 | 25.0 | 28.6 | 50.0 | 75.0 |
| Grayscale print | FREUID | 2 / 2 / 1 / 3 | 33.3 | 25.0 | 28.6 | 50.0 | 75.0 |
| Grayscale print | Low sharpness | 1 / 3 / 4 / 0 | 57.1 | 100.0 | 72.7 | 75.0 | 0.0 |
| Grayscale print | Low document chroma | 3 / 1 / 4 / 0 | 80.0 | 100.0 | 88.9 | 25.0 | 0.0 |
| Color print | TruFor | 1 / 2 / 0 / 3 | 0.0 | 0.0 | 0.0 | 66.7 | 100.0 |
| Color print | TruFor, document only | 2 / 1 / 2 / 1 | 66.7 | 66.7 | 66.7 | 33.3 | 33.3 |
| Color print | FREUID | 1 / 2 / 2 / 1 | 50.0 | 66.7 | 57.1 | 66.7 | 33.3 |
| Color print | Low sharpness | 0 / 3 / 3 / 0 | 50.0 | 100.0 | 66.7 | 100.0 | 0.0 |
| Color print | Low document chroma | 2 / 1 / 0 / 3 | 0.0 | 0.0 | 0.0 | 33.3 | 100.0 |
| Monitor recapture | TruFor | 2 / 2 / 1 / 3 | 33.3 | 25.0 | 28.6 | 50.0 | 75.0 |
| Monitor recapture | FREUID | 2 / 2 / 1 / 3 | 33.3 | 25.0 | 28.6 | 50.0 | 75.0 |
| Monitor recapture | Low sharpness | 3 / 1 / 0 / 4 | 0.0 | 0.0 | 0.0 | 25.0 | 100.0 |
| Monitor recapture | Spectral peak | 4 / 0 / 4 / 0 | 100.0 | 100.0 | 100.0 | 0.0 | 0.0 |
| AI inpaint-and-rewrite | TruFor | 4 / 6 / 6 / 4 | 50.0 | 60.0 | 54.5 | 60.0 | 40.0 |
| AI inpaint-and-rewrite | FREUID | 5 / 5 / 0 / 10 | 0.0 | 0.0 | 0.0 | 50.0 | 100.0 |
| AI inpaint-and-rewrite | Residual discontinuity | 10 / 0 / 0 / 10 | — | 0.0 | 0.0 | 0.0 | 100.0 |
| AI inpaint-and-rewrite | Low sharpness | 0 / 10 / 10 / 0 | 50.0 | 100.0 | 66.7 | 100.0 | 0.0 |
| AI crop-and-replace | TruFor | 4 / 6 / 4 / 6 | 40.0 | 40.0 | 40.0 | 60.0 | 60.0 |
| AI crop-and-replace | FREUID | 5 / 5 / 3 / 7 | 37.5 | 30.0 | 33.3 | 50.0 | 70.0 |
| AI crop-and-replace | Residual discontinuity | 10 / 0 / 0 / 10 | — | 0.0 | 0.0 | 0.0 | 100.0 |
| AI crop-and-replace | Low sharpness | 0 / 10 / 10 / 0 | 50.0 | 100.0 | 66.7 | 100.0 | 0.0 |

Always-clear had zero false positives and zero true positives in every cohort. On the earlier nine-document comparison, the spectral peak feature caught 7 recaptures and flagged 3 originals. The apparently perfect fresh result therefore needs a substantially larger independent screen dataset. Low chroma helped on grayscale and missed every fresh color copy. Sharpness on the AI holdout flagged every original as well as every edit. The residual feature missed every test edit. Several signals expose real domain shifts, even when the F1 number alone looks better.

### Reproduce Phase 2.3

The manifests, member selections, document-corner annotations and source images are in the ignored local `.data/identity-phase22` directory. `phase23-metrics.csv` contains all confusion matrices, thresholds and rates, including the two-frame agreement and document-only ablations. The run used PyTorch 2.14.0+cu126 and OpenCV 4.14.0.

```powershell
$env:PYTHONPATH = (Resolve-Path .data/identity-phase21/deps).Path
.\.venv\Scripts\python.exe -m ai.identity.benchmark_id_signals --assets .data/identity-phase21 --manifest .data/identity-phase22/benchmark-manifest.csv --annotations .data/identity-phase22/phase23-annotations --fresh-manifest .data/identity-phase22/phase23-fresh.csv --ai-manifest .data/identity-phase22/phase23-ai-disjoint.csv --device cuda
```

Production readiness still depends on capture data with phone displays as the source, identified printer models, more independent capture cameras, and explicitly authorized genuine Philippine IDs. Preserve separate document, person and capture-session IDs when collecting these cohorts. Keep printer, phone-display, camera and lighting metadata for matched controls. Then test automatically detected corners against the reference-crop results and establish false-positive limits on genuine captures before considering any live use.
## Single-capture regression benchmark

The physical experiment scored the first listed frame of each DLC-2021 mock capture. The test cohorts contained nine laminated originals, nine monitor recaptures and nine grayscale copies. The AI experiment used the held-out Spanish synthetic IDSpace cohort with ten originals, ten text rewrites and ten crop-and-replace manipulations. Five crop-and-replace samples had an unresolved portrait source, so that row is exploratory.

| Test cohort | Model | TN / FP / TP / FN | Precision | Recall | F1 |
| --- | --- | --- | --- | --- | --- |
| Monitor recapture | TruFor | 5 / 4 / 1 / 8 | 20.0% | 11.1% | 14.3% |
| Monitor recapture | FREUID foreign-layout probe | 4 / 5 / 3 / 6 | 37.5% | 33.3% | 35.3% |
| Grayscale copy | TruFor | 5 / 4 / 0 / 9 | 0% | 0% | 0% |
| Grayscale copy | FREUID foreign-layout probe | 4 / 5 / 2 / 7 | 28.6% | 22.2% | 25.0% |
| AI text rewrite | TruFor | 4 / 6 / 6 / 4 | 50.0% | 60.0% | 54.5% |
| AI text rewrite | FREUID foreign-layout probe | 5 / 5 / 0 / 10 | 0% | 0% | 0% |
| Crop and replace | TruFor | 4 / 6 / 4 / 6 | 40.0% | 40.0% | 40.0% |
| Crop and replace | FREUID foreign-layout probe | 5 / 5 / 3 / 7 | 37.5% | 30.0% | 33.3% |

On the physical originals, false-positive rates were 44.4% for TruFor and 55.6% for FREUID. The monitor false-negative rates were 88.9% and 66.7%, respectively. The grayscale-copy false-negative rates were 100% and 77.8%. In the AI holdout, false-positive rates were 60% and 50%. Text-rewrite false-negative rates were 40% and 100%. Crop-and-replace false-negative rates were 60% and 70%. These are diagnostic results from mock documents. Authorized genuine Philippine IDs, older designs, real wear and device-specific performance still need evaluation.

```powershell
$env:PYTHONPATH = (Resolve-Path .data/identity-phase21/deps).Path
.venv/Scripts/python.exe -m ai.identity.benchmark_capture_cohorts --assets .data/identity-phase21 --physical-manifest .data/identity-phase22/benchmark-manifest.csv --single-capture --ai-preview --device cuda
.venv/Scripts/python.exe -m ai.identity.benchmark_id_signals --assets .data/identity-phase21 --ai-manifest .data/identity-phase22/phase23-ai-disjoint.csv --device cuda
```

## Single-capture PAD and known replay

The scanner already crops one JPEG from the camera guide and starts browser Tesseract and the enrollment request from those bytes. Express normalizes the JPEG, checks the Bacolod location and consumes the capture session. The loopback FastAPI service runs FREUID A31 with its configured foreign crop table, measures sharpness and reads the document number with local Tesseract. Express checks the signed response, capture ID and normalized image SHA-256 before using the result. These checks bind the evidence to the submitted bytes and session. A physical camera and original document still require separate presentation evidence. The browser's screen warning searches OCR text for visible search-interface words. It is a browser warning with limited coverage of ordinary monitors, other phones and printed copies.

FastAPI reports a signed `monitorRecaptureSpectralPeak` measurement from the same image for research. The measurement has no enrollment threshold. FREUID research scores still map to `UNABLE_TO_ASSESS` for Philippine IDs. The server also checks the existing local OCR text for an explicit image-search phrase and two distinct search controls. A signed match requests a retake. The photo and OCR text stay local. This check covers visible search interfaces. A tightly cropped image, another screen app, or a printed copy may have no such text.

The A31 loader verifies and loads the published checkpoint and crop files. It supplies five foreign layouts and no Philippine layout. The limited enrollment path requires usable document evidence and keeps the account `UNVERIFIED`. The verified path requires independent approval. Demo mode allows OCR review only.

### Exact known replay

MySQL already stores keyed fingerprints of enrolled documents and normalized image bytes, separate from the short-lived capture session. The optional local catalog adds exact matches for confirmed replay samples before enrollment approval. A match consumes the session and requests a retake with classification `SUSPICIOUS`. The existing scanner displays the retake feedback and does not autofill. Missing or invalid required assessment evidence still fails closed.

Build the catalog from authorized JPG captures or synthetic replay fixtures. Keep the catalog outside the repository and public static paths. Each line contains the SHA-256 of a JPEG normalized by the same Express code used for enrollment.

```powershell
node scripts/fingerprint-id-replay.js .data/authorized-test-replay.jpg | Set-Content -Encoding utf8 .data/known-replays.sha256
```

Set `REGISTRATION_KNOWN_REPLAY_SHA256_FILE=.data/known-replays.sha256` and restart Express to load the catalog. The default is unset. A configured malformed or unreadable catalog returns a screening-unavailable error for capture requests. Only enroll confirmed replay evidence in the catalog. Changed framing, screen photos, many JPEG re-encodings and unindexed images can all miss an exact comparison. The catalog does not query the web.

### Measured single-capture baselines

The physical run used the existing DLC validation/test split and one frame per clip, with no threshold tuning on test. The test split has nine laminated mock originals and nine examples per attack. FREUID used the current live research layout `BENIN/DL` at the existing diagnostic cutoff of 0.50. The IDSpace digital-edit run used the existing country and identity holdout with `MAURITIUS/ID`. Five crop-and-replace examples have unresolved portrait provenance and that cohort remains exploratory. APCER counts missed attacks and BPCER counts rejected bona fide samples at the stated experimental operating point.

| Research probe | Test attack | TN / FP / TP / FN | Precision | Recall | F1 | APCER | BPCER |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: |
| FREUID BENIN/DL | Monitor | 5 / 4 / 4 / 5 | 50.0% | 44.4% | 47.1% | 55.6% | 44.4% |
| FREUID BENIN/DL | Grayscale print | 5 / 4 / 0 / 9 | 0.0% | 0.0% | 0.0% | 100.0% | 44.4% |
| TruFor | Monitor | 5 / 4 / 1 / 8 | 20.0% | 11.1% | 14.3% | 88.9% | 44.4% |
| TruFor | Grayscale print | 5 / 4 / 0 / 9 | 0.0% | 0.0% | 0.0% | 100.0% | 44.4% |
| FREUID MAURITIUS/ID | AI text rewrite | 5 / 5 / 0 / 10 | 0.0% | 0.0% | 0.0% | 100.0% | 50.0% |
| FREUID MAURITIUS/ID | AI crop and replace | 5 / 5 / 3 / 7 | 37.5% | 30.0% | 33.3% | 70.0% | 50.0% |

The separate local pHash probe used a fixed diagnostic distance of six bits. It matched 9/9 exact DLC original pairs and 9/9 resized, JPEG-reencoded originals. It matched 0/9 monitor pairs and 0/9 grayscale print pairs against the original capture of the same document. Each cohort used nine mismatched control pairs drawn by cycling to the next source document, with 0/9 false matches per cohort. The distinct templates make those controls easier than different ID holders on the same Philippine design. pHash remains offline.

Two real-inference signup runs with synthetic canvas camera input took **3.913 s desktop** and **4.132 s mobile emulation** from capture click to populated fields on this machine. The desktop fixture included faded colors and simulated scratches. These are two browser timing observations, with local OCR assets and CPU inference, and do not estimate production latency or a worn-ID false rejection rate.

```powershell
$env:PYTHONPATH = (Resolve-Path .data/identity-phase21/deps).Path
.venv/Scripts/python.exe -m ai.identity.benchmark_capture_cohorts --assets .data/identity-phase21 --physical-manifest .data/identity-phase22/benchmark-manifest.csv --single-capture --freuid-layout BENIN/DL --device cuda
.venv/Scripts/python.exe -m ai.identity.benchmark_id_signals --assets .data/identity-phase21 --ai-manifest .data/identity-phase22/phase23-ai-disjoint.csv --device cuda
```

For a future candidate with per-sample attack scores, run `python -m ai.identity.benchmark_fraud_scores scores.csv --pad --threshold <validation-selected-value>`. The manifest fields are `sample_id,document_id,session_id,split,category,fraud_score`. Use opaque references. The evaluator rejects cross-split document and session reuse and computes confusion counts, precision, recall, F1 and APCER per attack alongside pooled BPCER and worn-sample false rejection. It returns null for missing cohorts. Keep the underlying physical card and any edited or re-photographed derivatives together when assigning splits.

### Candidate readiness

- The DLC authors publish `models/screen_nn_weights.h5` and `models/unlaminated_nn_weights.h5`. The screen baseline uses TensorFlow/Keras and 224×224 center patches from known document corners. The H5 weights cannot be loaded by the existing PyTorch adapter. The local comparison would require an isolated Keras runtime or verified conversion and a holdout with automatic crops. The paper describes document texture and compression as false-positive sources. The DLC display cohort uses desktop/laptop monitors. [DLC paper](https://pmc.ncbi.nlm.nih.gov/articles/PMC9323793/) · [Publisher archive](https://zenodo.org/records/7467028)
- PyPAD is a research metrics toolkit for the Chilean MobileNetV2 work. The toolkit repository provides formulas and examples, with no deployable checkpoint listed. The EfficientNet-V2 cross-domain paper provides a research comparison, with no Philippine checkpoint or evaluation established here. [PyPAD](https://github.com/jedota/PyPAD) · [EfficientNet-V2 paper](https://arxiv.org/abs/2608.16591)
- FantasyID is a digital-edit evaluation candidate. Review the terms for each image cohort and keep its source identities apart across splits. Its edit data cannot establish the screen/print error rate. [FantasyID paper](https://arxiv.org/abs/2507.20808) · [DeepID challenge](https://deepid-iccv.github.io/)

Deployment of a learned PAD gate is pending access to an approved checkpoint and an independent Philippine holdout. Collect consented genuine older and current Philippine IDs, including actual wear, plus separate monitor, phone-screen and print attacks across held-out devices and sessions. Measure each attack at a fixed threshold, stratify bona fide rejections by condition, and measure uncertainty and latency on physical iOS and Android devices. No authorized worn Philippine cohort was available for a false rejection estimate in this run.
