# Backend, AI and severity QA

Latest continuation: [27 October Report Details full regression](report-details-full-regression-2026-10-27.md). Release remains YELLOW. Five additional defects were fixed; final Node and isolated MySQL suites pass. Earlier dated tables below remain historical evidence, not the latest aggregate result.


Assessment date: 26 October 2026. Branch: `feature/brgy-com-feed-brgy-proof/24/10-2026`; starting commit: `ad816a6`. Findings describe the local working tree. No deployment, production migration, Aiven mutation, retraining or checkpoint replacement was performed.

## Execution boundaries

Windows, Node 22.17.0, MySQL 8.0.46, Python 3.13.7, PyTorch 2.14.0+cu126, Ultralytics 8.4.150, FastAPI 0.141.1 and Chromium were used. The requirements file pins Ultralytics 8.4.152, so this execution does not prove that exact dependency combination. GPU inference was available. These timings do not establish CPU or hosted service performance.

The configured database was local MySQL, not Aiven. A read-only schema inventory found migrations 001–014 tracked. Functional and destructive tests instead used new temporary MySQL data directories and random loopback ports, checked against `@@datadir`. Browser integration also used explicitly injected temporary SQLite databases. Local filesystem storage replaced configured Supabase storage in test processes. No cloud object was created or deleted.

Evidence is retained under `.data/qa-2026-10-26/`, which is ignored by Git. Logs may contain test fixture tokens; do not publish raw logs without redaction.

## Backend results

The final combined Node run passed 1,092 tests with zero failures or skips (`node-final-acceptance.log`). This includes unit and isolated integration coverage; it is not a count of 1,092 real MySQL tests. The separate actual MySQL runtime run passed 43 tests (`mysql-runtime-final.log`).

New actual FastAPI → Express → MySQL verification passed four TAP cases, including its parent suite, with no skips (`fullstack-live-ai-mysql.log`). It exercised signed assessments from the real checkpoint, two-photo association, original AI/category persistence, unknown severity, concurrent report retries, jurisdiction isolation, status evidence and publication approval. The same test deliberately skips its real-inference child without explicit `QA_REAL_INFERENCE_URL` and `QA_REAL_IMAGE`; that skip is not a passing AI test.

Backend layers remain controller → application service → domain rules → injected repositories/adapters. Fixes reuse these boundaries:

- Report retries use a validated request key and a hash of validated content, signed proofs and image bytes. The actor row is locked before the transaction rechecks prior audit metadata. Matching retries return the original authorized report. Different content with the same key receives a conflict. Unused uploaded objects are removed. Publication and notification work is not repeated.
- Concurrent operational updates check the locked row against the state originally read. A stale competing update returns conflict; required completion evidence and terminal-state rules remain enforced.
- AI normalization rejects missing prediction arrays, malformed coordinates and invalid supplied image dimensions. Explicit empty detections remain valid no-detection results. Adapters no longer return provider error bodies to users.
- Migration tracking now rejects changed checksums for already applied migration files before running new statements.
- Destructive MySQL helpers reject nonloopback hosts and unsafe database names before opening a connection.

Focused before/after evidence: `report-retry-before.log`, `inference-contract-before.log`, `migration-drift-before.log`, `severity-regression-before.log`, `test-isolation-final.log`.

Report history, action-proof foreign keys, rollback, same-key status requests, private media, portal login isolation, expired/stale tokens, cross-barangay access, SQL injection inputs, XSS rendering, publication rejection, rate limits and notification tickets are covered by the existing suites and the new regressions. Passing fixture-based security tests does not establish resistance to every attack or distributed rate-limit behavior across serverless instances.

## Existing infrastructure severity rules

Technical bug priority P0–P3 is separate from infrastructure damage severity.

YOLO detects a category and confidence. The inspected runtime provides no validated impact measurement or severity model. `damageDetection.rules.js` accepts supplied severity enum values and maps them through the existing rules:

| Supplied severity | Classification | Priority |
| --- | --- | --- |
| low | MINOR | Low |
| medium | MINOR | Medium |
| high | MAJOR | High |
| critical | MAJOR | Critical |
| absent or invalid | Unassessed | Unprioritized |

Neither category nor confidence supplies severity. For each of broken streetlight, clogged drainage, pothole and road crack, regression tests check that even high confidence without a severity field remains unassessed. Explicit low/high fixtures check the existing mapping; they are synthetic domain inputs, not measured severity predictions from the checkpoint.

No documented physical Minor/Major thresholds, authorized manual severity override endpoint, or dedicated severity-change audit history were found. Therefore these physical scenarios remain blocked by a business-rule gap:

| Damage | Minor impact criteria | Major impact criteria | Insufficient evidence |
| --- | --- | --- | --- |
| Broken streetlight | Not defined | Not defined | Preserve null |
| Clogged drainage | Not defined | Not defined | Preserve null |
| Pothole | Not defined | Not defined | Preserve null |
| Road crack | Not defined | Not defined | Preserve null |

Changing report operational status is not a severity override. Citizens and Barangay users cannot gain a nonexistent override by sending extra fields. Concurrent manual severity changes cannot be claimed tested when there is no supported command to execute. Analytics tests verify existing explicit MINOR/MAJOR aggregation, jurisdiction/date scope and null handling; this does not validate missing physical policy.

A confirmed persistence defect used `highestSeverity || 'low'`. It is now `highestSeverity ?? null`. New additive migration 015 makes `damage_verifications.highest_severity` nullable. Private MySQL verification preserves a legacy low value, stores unknown as SQL NULL, checks foreign keys and verifies repeat migration execution. Nine focused migration/runner cases passed (`migrations-line-endings-final.log`), including valid LF/CRLF checkout history and rejection of changed SQL. No historical severity values were backfilled or guessed.

The configured local database already allowed NULL despite tracking only 001–014: schema drift was observed. Migration 015 was applied only to disposable databases. Operators must back up and apply it to an intended deployment before using this persistence change. Its NOT NULL rollback requires resolving existing NULL rows explicitly; it must not manufacture low severity to make rollback succeed.

## Actual checkpoint identity

Canonical file: `models/production/best.pt`, 19,166,426 bytes.

SHA256: `f218ccde1a6d27455250fa40a6b38515170fba746512be7c10198fc46d1e6ef2`.

The loaded model reports **YOLO11s**, release/training name **beta_testing_v3**. It is not the historical YOLOv8m description. Class IDs match the intended four classes: 0 broken_streetlight, 1 clogged_drainage, 2 pothole, 3 road_crack. No production `model_manifest.json` was found. This is an open release-provenance issue; no model was selected or replaced on the owner's behalf.

Embedded training arguments report maximum 200 epochs, image size 640, batch 8, optimizer auto, patience 30 and device 0. They are checkpoint metadata, not a newly executed training run. `model-identity.json` records the inspected identity.

## Real inference and held-out evaluation

The local API ran at loopback port 8016 with confidence 0.30 and image size 640. Health reported the identity above. Four representative held-out single-image requests returned HTTP 200; all returned bounding boxes stayed within their supplied image sizes. One actual pair request returned HTTP 200. Corrupted image input returned 400; unsupported MIME returned 415. See `live-ai-results.json` and `live-ai-probe.log`.

HTTP 200 is a working transport contract, not proof that a prediction is correct. The four individual probes produced these actual results:

| Held-out annotation class | API result | Confidence | Interpretation |
| --- | --- | ---: | --- |
| Broken streetlight | Broken streetlight, accepted | 69.61% | Correct top class for this probe |
| Clogged drainage | Inconclusive, low confidence | 15.44% | No accepted detection at threshold 0.30 |
| Pothole | Road crack, accepted | 54.40% | Wrong top class for this probe |
| Road crack | Road crack, accepted | 42.39% | Correct top class for this probe |

These observations are retained as model errors/limitations, not converted into passing classification assertions. The full held-out evaluation below supplies the larger sample and class metrics.

Single-request wall times were 4,128.44 ms for the first measured request, then 75.94, 76.64 and 70.21 ms. The pair took 435.89 ms. These four samples do not establish p95, capacity or a cold-start SLA. Controlled adapter tests separately cover unavailable service, timeout, invalid JSON/status, empty output, low confidence, mismatch and malformed geometry.

Dataset: locally installed `Neighborlens.v6-neighborlens_beta_testing_v3.yolov8/data.local.yaml`. Counts: 4,219 training, 1,194 validation and 606 held-out test images. The test split contains 920 annotations: 162 streetlights, 193 drainages, 266 potholes and 299 road cracks. Exact file SHA256 comparisons found zero test overlap with train and validation. Near duplicates, shared scenes and annotation quality were not independently audited; zero exact overlap does not prove absence of leakage.

Evaluation used only the designated test split, GPU device 0, image size 640, batch 4 and workers 0. No training was run.

| Class | Precision | Recall | F1 | mAP@50 | mAP@50–95 |
| --- | ---: | ---: | ---: | ---: | ---: |
| Broken streetlight | 53.23% | 61.11% | 56.90% | 55.04% | 30.48% |
| Clogged drainage | 92.85% | 79.27% | 85.53% | 89.03% | 50.51% |
| Pothole | 79.84% | 63.53% | 70.76% | 74.65% | 38.65% |
| Road crack | 63.56% | 46.15% | 53.48% | 52.68% | 29.37% |
| All classes | 72.37% | 62.52% | — | 67.85% | 37.25% |

Per-class F1 is computed from the corresponding reported precision and recall. No overall F1 is invented from the mean values. The confusion matrix records seven potholes predicted as cracks and seven cracks predicted as potholes, plus 125 crack misses and 130 background detections labeled crack at the matrix's operating threshold. Matrix counts and precision/recall use different operating points and should not be combined as if they were one threshold.

GPU evaluation averaged 0.211 ms preprocessing, 4.355 ms inference and 1.158 ms postprocessing per image. These are evaluation batch timings, not browser request latency. Evidence: `heldout-metrics.json`, `heldout-evaluation.log`, `metrics/production-heldout/`.

Road-crack recall and broken-streetlight precision warrant further dataset/error review. No repository acceptance threshold was found; these are measured limitations, not a fabricated failed target. Lighting, occlusion, orientation and resolution were not separately labeled into benchmark subgroups. Synthetic browser fixtures test overlays and scaling; the live full-stack test validates persistence, not pixel-perfect real-output overlays in every browser.

## Remaining limits and release decision

**YELLOW for local QA.** Technical defect totals across the audited application/tooling: P0 0, P1 2, P2 13, P3 2; 16 fixed and verified, one model-provenance issue open. These counts do not describe infrastructure damage severity. See the overall report for the final suite ledger. Open issues: checkpoint provenance/dependency mismatch and missing physical severity/manual-review policy. No active P0/P1 finding should be inferred from those policy gaps alone, and no global security certification is claimed.

Remote Vercel/Render configuration, hosted inference latency, Supabase failures against a real account, physical camera devices, Firefox/WebKit, screen readers, distributed notification/rate-limit behavior and long-duration memory profiling were not executed. Registration browser tests ran real OCR on rendered fictional identity documents, including PHILSYS/passport/name/date persistence; they do not benchmark real government ID accuracy. The historical v2 dataset test explicitly skips because that dataset is unavailable. A remote release still needs deployment-specific smoke tests, an approved model identity and an operator-managed migration plan.

## 27 October remediation and YOLOv8 release decision
This section supersedes the earlier missing manual-review workflow and provisional suite results. The historical audit remains above for traceability. The required release architecture is now explicitly YOLOv8, with validation mAP@50 at least 68%. Local production remains YOLO11s; no claim is made about the currently deployed remote checkpoint.
### Report review persistence and authorization
Migration `016_report_coordination_and_severity.sql` adds report-specific coordination messages, per-user monotonic read cursors and append-only severity review history. Existing account/report/publication rows are retained. SQLite test schema version is 9. Only disposable, identity-verified MySQL databases were migrated; the configured local database and Aiven were not migrated.
Existing report access checks are reused and rechecked while holding the report lock. Only active authenticated Admin or the assigned Barangay role can access these endpoints. Citizen, anonymous and foreign-Barangay access is denied. SQL is parameterized, browser message rendering uses text nodes, requests are no-store, reads are rate-limited to 120/user/minute and writes to 40/user/minute.
- `GET /api/reports/:id/review`: newest 50 messages, chronological display, `before` cursor, `hasMore`, per-user unread count, latest 50 severity reviews and input descriptors.
- `POST /api/reports/:id/messages`: meaningful 1–500-character message with a 16–64-character request key. Exact retries return the original record; conflicting payloads return 409. Message, audit and authorized-recipient notifications commit together. Notification payloads omit private message content.
- `POST /api/reports/:id/messages/read`: validates report membership and advances only that reader’s cursor; older reads cannot decrease it.
- `POST /api/reports/:id/severity`: reviewer confirmation/override with category, observed evidence, meaningful 10–500-character reason, request key and `expectedReviewId`. Row locking and optimistic review IDs reject concurrent stale assessments with 409. History, current triage and audit commit together.
The user approved the default: review required, reviewer confirms. Without an approved configured policy, every automatic recommendation stays null/REVIEW_REQUIRED. A human can confirm Minor/Major after recording inspected safety impact and a reason. Unknown or unmeasured values remain unknown. Numeric input maxima are sanity limits, not LGU severity thresholds. Detection confidence, category and image pixels never supply physical measurements.
Optional `REPORT_SEVERITY_POLICY_JSON` is server configuration. A recommendation requires `approvedBy`, `version`, category rules and all observations required by those rules. `majorAtOrAbove` uses inclusive numeric comparisons; `majorWhen` uses exact booleans; any matching condition recommends Major, otherwise Minor. No numeric policy is supplied or enabled by default. The shared table column is labeled Severity, because current triage may come from a human reviewer rather than an AI decision. Approval metadata in configuration is an operator assertion, not independent proof of LGU approval.
Current triage uses the existing legacy columns `reports.ai_classification` and `ai_priority`; reviewer identity, previous values, evidence and reason live in `report_severity_reviews`. Original AI assessment JSON is not rewritten. Minor priorities are Low/Medium; Major priorities High/Critical; review-required clears both current values. The API’s `assessment` field describes the rule recommendation, which may still be REVIEW_REQUIRED after a human confirmation; `severityHistory[0].classification` contains the confirmed human decision.
Operational rejection requires a meaningful reason, explicit browser confirmation, authorized jurisdiction, audit/history and owner notification. Rejection notification persistence is atomic with the status/history/audit update; a failed write rolls the rejection back, and events publish only after commit. Rejected is terminal and retries do not duplicate history. Existing ongoing/resolution proof requirements remain. Operational rejection does not approve/reject the independent community publication request; that queue remains pending until a separate publication decision.
### Shared frontend changes
Admin and Barangay use the same report details renderer and new reusable `ReportReviewPanel`. Activity and operational actions have separate responsive columns. The action-photo chooser is styled and accessible, validates existing file/count limits, previews selected photos, removes individual files and opens the existing EvidenceZoom viewer. Private coordination, unread/pagination and severity forms share theme tokens, wrap at narrow widths and preserve draft state. Existing refresh lifecycle is reused rather than adding a new polling loop. Citizen receives no private panel or private endpoint access.
A confirmed queue retry race was also fixed: entering Pending Posts while a publication request was finishing used to skip a replacement request. The existing coalescing loader now queues that retry. Registration and publication browser fixtures now wait for page initialization/AI scan completion; their data/auth/security assertions remain intact.
### Checkpoint inventory
All 31 local checkpoints below were loaded through Ultralytics, not identified by their filenames. Architecture uses graph/module evidence and YAML scale metadata. Entries whose helper reported an unconfirmed YOLOv8 variant have C2f graphs, depth multiplier 0.67, width multiplier 0.75 and 25,858,636 parameters with four classes: standard YOLOv8m. Missing epoch history is marked unknown; stripped best checkpoints commonly store epoch -1, which is not an epoch count. Historical embedded metrics are not comparable release benchmarks.
- C1: 0=broken_streetlight, 1=clogged_drainage, 2=pothole, 3=road_crack.
- C2: 0=damaged_road, 1=clogged_drainage, 2=damaged_street_light, 3=damaged_traffic_light.
- C3: 0=person, 1=bicycle, 10=fire hydrant, 11=stop sign, 12=parking meter, 13=bench, 14=bird, 15=cat, 16=dog, 17=horse, 18=sheep, 19=cow, 2=car, 20=elephant, 21=bear, 22=zebra, 23=giraffe, 24=backpack, 25=umbrella, 26=handbag, 27=tie, 28=suitcase, 29=frisbee, 3=motorcycle, 30=skis, 31=snowboard, 32=sports ball, 33=kite, 34=baseball bat, 35=baseball glove, 36=skateboard, 37=surfboard, 38=tennis racket, 39=bottle, 4=airplane, 40=wine glass, 41=cup, 42=fork, 43=knife, 44=spoon, 45=bowl, 46=banana, 47=apple, 48=sandwich, 49=orange, 5=bus, 50=broccoli, 51=carrot, 52=hot dog, 53=pizza, 54=donut, 55=cake, 56=chair, 57=couch, 58=potted plant, 59=bed, 6=train, 60=dining table, 61=toilet, 62=tv, 63=laptop, 64=mouse, 65=remote, 66=keyboard, 67=cell phone, 68=microwave, 69=oven, 7=truck, 70=toaster, 71=sink, 72=refrigerator, 73=book, 74=clock, 75=vase, 76=scissors, 77=teddy bear, 78=hair drier, 79=toothbrush, 8=boat, 9=traffic light.
- D1: `Neighborlens.v4-neighborlens_beta_testing_v1.yolov8/data.local.yaml`.
- D2: `data/datasets/neighborlens_paper_aligned_v3_1_remediated/data.yaml`.
- D3: `data/datasets/Neighborlens.v5-neighborlens_beta_testing_v2.yolov8/data.yaml`.
- D4: `dataset/neighborlens_v1/data.yaml`.
- D5: `dataset/neighborlens_paper_aligned_v2/data.yaml`.
- D6: `dataset/neighborlens_v1/data.yaml`.
- D7: `dataset/neighborlens_v2/data.yaml`.
- D8: `dataset/neighborlens_v2_experimental/data.yaml`.
- D9: `dataset/neighborlens_v3/data.yaml`.
- D10: `/home/lq/codes/ultralytics/ultralytics/cfg/datasets/coco.yaml`.
- D11: `Neighborlens.v6-neighborlens_beta_testing_v3.yolov8/data.local.yaml`.
- D12: `coco.yaml`.

| Checkpoint | Graph architecture | Classes | Dataset | Recorded epochs / image size | Embedded val mAP50 | SHA256 |
| --- | --- | --- | --- | --- | --- | --- |
| `models/backups/best_pre_v3_20261024-212725.pt` | YOLOv8m | C1 | D1 | unknown / 640 | 59.15% | `d4748b0bf1bd878a4e202e046bd076d46ca4e2596ea97c855be9e8dfa8db4182` |
| `models/backups/best_v3_1_interim.pt` | YOLOv8m (graph/scale) | C1 | D2 | unknown / 640 | 21.19% | `fcaee8d4ee3e04ae907103f3b3556a9bd8fc6aa0d58b328efef352331ed66f4a` |
| `models/backups/neighborlens_v1_20261022_031944_best.pt` | YOLOv8m | C1 | D1 | unknown / 640 | 59.15% | `d4748b0bf1bd878a4e202e046bd076d46ca4e2596ea97c855be9e8dfa8db4182` |
| `models/candidates/neighborlens_v2_map50_60.0.pt` | YOLOv8m (graph/scale) | C1 | D3 | unknown / 640 | 59.95% | `c1c2a0ff39952b50da6205ad202f733f16b59880dcc4d38533d44b36fee763d7` |
| `models/checkpoints/infrastructure_v3/weights/last.pt` | YOLOv8m | C2 | D4 | 1 / 800 | 0.80% | `0f61fc89a60149b555558987e07c3b5b2b8819e53a66536d1733593144ea6113` |
| `models/checkpoints/neighborlens_paper_aligned_v2_baseline/weights/best.pt` | YOLOv8m | C1 | D5 | 100 / 640 | 37.87% | `3987c464f56911ae5dd571f6596e53b60700aefcd6301c782bfa91379e898428` |
| `models/checkpoints/neighborlens_paper_aligned_v2_baseline/weights/last.pt` | YOLOv8m | C1 | D5 | 100 / 640 | 40.79% | `80cc0e6151b336a3484f5005136b0cb9dd7ae375da607fc01e167326074df8b9` |
| `models/checkpoints/neighborlens_v8/weights/best.pt` | YOLOv8m | C2 | D6 | 16 / 800 | 6.09% | `5876b8352e2ec4e17076b441a0b8d3c2a0a2f586a66b885979f28891635b1964` |
| `models/checkpoints/neighborlens_v8/weights/last.pt` | YOLOv8m | C2 | D6 | 16 / 800 | 3.56% | `85da5e92bebf6e332b4a45cfd211b691e4ed3fdd561a34d57eebb73002799683` |
| `models/checkpoints/neighborlens_v8_baseline_v2/weights/best.pt` | YOLOv8m | C2 | D7 | 80 / 800 | 33.07% | `9f27b5be276620efe27e98d12fa256b93c6a82a2e7e0ed16ed8de75c675b0932` |
| `models/checkpoints/neighborlens_v8_baseline_v2/weights/last.pt` | YOLOv8m | C2 | D7 | 80 / 800 | 21.72% | `b8d8e14ca409b3f40ac740104f63dc44e71607829c113c43742e0d9a0a25997b` |
| `models/checkpoints/neighborlens_v8_experimental/weights/best.pt` | YOLOv8m | C2 | D8 | 80 / 800 | 11.07% | `6776ebec82a2b1695c6eeab0c6c901277bc5f187e327418d9eb12cd89a4b0cb1` |
| `models/checkpoints/neighborlens_v8_experimental/weights/last.pt` | YOLOv8m | C2 | D8 | 80 / 800 | 9.48% | `f693f2068f81109427c6763cc9b53f80f73c668a46ad8a524ce00dfc68b2c438` |
| `models/checkpoints/neighborlens_v8_phase3_e2_1024/weights/best.pt` | YOLOv8m | C2 | D7 | 80 / 1024 | 21.30% | `5605b3a668bf9a882605c8a0e8783822f931b41ac1382a989d4d475f60a2c20a` |
| `models/checkpoints/neighborlens_v8_phase3_e2_1024/weights/last.pt` | YOLOv8m | C2 | D7 | 80 / 1024 | 14.22% | `359f0202e4319868066ffd26fe03afa4c317850c1c05fed7c223d30c38596543` |
| `models/checkpoints/neighborlens_v8_phase3_e3_road_remediation/weights/best.pt` | YOLOv8m | C2 | D9 | 80 / 800 | 29.52% | `aca373c7df49b175e4b9244742658110572541ecb50489937364736f9f37fc6a` |
| `models/checkpoints/neighborlens_v8_phase3_e3_road_remediation/weights/last.pt` | YOLOv8m | C2 | D9 | 80 / 800 | 18.46% | `a0d0bf0a01b398d57ee4b91c39659544330b05e0b99c6ff68982b8c84895b490` |
| `models/checkpoints/neighborlens_v8_phase4b/weights/best.pt` | YOLOv8m | C2 | D6 | 80 / 800 | 11.07% | `87d4974d1f9a9cf728530f468e73e38b74c3b0dba5f5a86a7467265f0d738b21` |
| `models/checkpoints/neighborlens_v8_phase4b/weights/last.pt` | YOLOv8m | C2 | D6 | 80 / 800 | 9.48% | `19255c8d8c645df77913862dcfb5a3cc30ed76370b3d8e23e70e94d892ac2723` |
| `models/checkpoints/yolo26n.pt` | YOLO26n | C3 | D10 | unknown / 640 | 55.72% | `9b09cc8bf347f0fc8a5f7657480587f25db09b34bf33b0652110fb03a8ad4fef` |
| `models/production/archive/best_legacy_before_canonical.pt` | YOLOv8m | C2 | D4 | unknown / 800 | 0.80% | `78374f446f7cc47c46e10a6a6219eb53e218f8bc7bbe62eaa768be9fc66a7e1e` |
| `models/production/best.pt` | YOLO11s | C1 | D11 | unknown / 640 | 68.84% | `f218ccde1a6d27455250fa40a6b38515170fba746512be7c10198fc46d1e6ef2` |
| `runs/detect/runs/neighborlens/beta_testing_v3/weights/best.pt` | YOLO11s | C1 | D11 | 91 / 640 | 68.84% | `f218ccde1a6d27455250fa40a6b38515170fba746512be7c10198fc46d1e6ef2` |
| `runs/detect/runs/neighborlens/beta_testing_v3/weights/last.pt` | YOLO11s | C1 | D11 | 91 / 640 | 66.50% | `a9d5db7d3af72c0a37ca37e27218dc93f6c0217c57de257255390710819e82aa` |
| `runs/detect/runs/neighborlens/v2_baseline/weights/best.pt` | YOLOv8m (graph/scale) | C1 | D3 | 56 / 640 | 59.95% | `c1c2a0ff39952b50da6205ad202f733f16b59880dcc4d38533d44b36fee763d7` |
| `runs/detect/runs/neighborlens/v2_baseline/weights/last.pt` | YOLOv8m (graph/scale) | C1 | D3 | 56 / 640 | 57.68% | `d8e7a8650fb30d27a3cc1a6f74efd73a41deb08c221a44e47c8f085be91f5879` |
| `runs/detect/runs/neighborlens/v2_continued_epoch56_to120/weights/best.pt` | YOLOv8m (graph/scale) | C1 | D3 | 64 / 640 | 59.40% | `1c26c7cc4b264bcdcc9fd1880d156dc5aa7f7b1bec8f5ca6dcb26291229c13e7` |
| `runs/detect/runs/neighborlens/v2_continued_epoch56_to120/weights/last.pt` | YOLOv8m (graph/scale) | C1 | D3 | 64 / 640 | 56.03% | `5e58a0f3251c73e095de8512bf378ca6f5d2d108728e1e830490730967034c0e` |
| `runs/detect/runs/neighborlens_v4/yolov8m_baseline/weights/best.pt` | YOLOv8m | C1 | D1 | 85 / 640 | 59.15% | `d4748b0bf1bd878a4e202e046bd076d46ca4e2596ea97c855be9e8dfa8db4182` |
| `runs/detect/runs/neighborlens_v4/yolov8m_baseline/weights/last.pt` | YOLOv8m | C1 | D1 | 85 / 640 | 55.70% | `4dd2ed6902fabb28a441cd4a08c8bae58446d83e8e0980338c62897940a9d724` |
| `yolov8m.pt` | YOLOv8m | C3 | D12 | unknown / 640 | unknown | `5d4a90cdc7a21786cc59cd19778e9eafff836df9e2da32524737c7ee6efe4fe5` |

COCO checkpoints and legacy class maps are not eligible replacements for the required four-class production contract, even when their architecture is YOLOv8. Aliases with identical checksums are retained in the inventory rather than counted as independent training results.

### Same-split comparison
All three models used the same v6 validation images (1,194) and held-out test images (606), image size 640, batch 4, GPU device 0, workers 0, confidence 0.001 and IoU 0.7. Windows-safe evaluation hardlinks renamed image and label stems together by SHA256; image/label bytes were unchanged. No training or tuning used these test results. Earlier exact-overlap checks found no identical test image bytes in train/validation, but scene leakage/near duplicates and annotation quality are not certified.
| Checkpoint | Split | Precision | Recall | mAP50 | mAP50–95 |
| --- | --- | ---: | ---: | ---: | ---: |
| `models/production/best.pt` | val | 73.01% | 65.43% | 68.71% | 39.87% |
| `models/production/best.pt` | test | 72.41% | 62.60% | 67.85% | 37.24% |
| `models/candidates/neighborlens_v2_map50_60.0.pt` | val | 61.86% | 52.88% | 54.14% | 30.20% |
| `models/candidates/neighborlens_v2_map50_60.0.pt` | test | 58.20% | 52.98% | 54.15% | 29.52% |
| `runs/detect/runs/neighborlens_v4/yolov8m_baseline/weights/best.pt` | val | 57.09% | 47.47% | 47.03% | 25.07% |
| `runs/detect/runs/neighborlens_v4/yolov8m_baseline/weights/best.pt` | test | 56.60% | 49.70% | 46.98% | 24.15% |

| Checkpoint / split | Class | Precision | Recall | F1 | mAP50 | mAP50–95 |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| `models/production/best.pt` / val | broken_streetlight | 60.35% | 65.48% | 62.81% | 62.06% | 36.58% |
| `models/production/best.pt` / val | clogged_drainage | 91.13% | 82.62% | 86.67% | 89.76% | 54.49% |
| `models/production/best.pt` / val | pothole | 72.67% | 65.57% | 68.94% | 69.08% | 39.25% |
| `models/production/best.pt` / val | road_crack | 67.88% | 48.04% | 56.26% | 53.93% | 29.16% |
| `models/production/best.pt` / test | broken_streetlight | 53.23% | 61.11% | 56.90% | 55.05% | 30.47% |
| `models/production/best.pt` / test | clogged_drainage | 92.85% | 79.27% | 85.53% | 89.03% | 50.51% |
| `models/production/best.pt` / test | pothole | 79.84% | 63.53% | 70.76% | 74.65% | 38.65% |
| `models/production/best.pt` / test | road_crack | 63.73% | 46.49% | 53.76% | 52.67% | 29.32% |
| `models/candidates/neighborlens_v2_map50_60.0.pt` / val | broken_streetlight | 51.42% | 51.16% | 51.29% | 48.58% | 26.63% |
| `models/candidates/neighborlens_v2_map50_60.0.pt` / val | clogged_drainage | 87.07% | 81.05% | 83.96% | 88.13% | 52.36% |
| `models/candidates/neighborlens_v2_map50_60.0.pt` / val | pothole | 53.53% | 27.09% | 35.98% | 28.43% | 13.87% |
| `models/candidates/neighborlens_v2_map50_60.0.pt` / val | road_crack | 55.41% | 52.22% | 53.77% | 51.44% | 27.94% |
| `models/candidates/neighborlens_v2_map50_60.0.pt` / test | broken_streetlight | 50.74% | 55.96% | 53.22% | 47.80% | 25.67% |
| `models/candidates/neighborlens_v2_map50_60.0.pt` / test | clogged_drainage | 79.20% | 78.93% | 79.06% | 86.15% | 51.77% |
| `models/candidates/neighborlens_v2_map50_60.0.pt` / test | pothole | 49.95% | 22.18% | 30.72% | 28.89% | 11.84% |
| `models/candidates/neighborlens_v2_map50_60.0.pt` / test | road_crack | 52.90% | 54.85% | 53.86% | 53.76% | 28.80% |
| `runs/detect/runs/neighborlens_v4/yolov8m_baseline/weights/best.pt` / val | broken_streetlight | 38.79% | 37.21% | 37.98% | 29.65% | 15.13% |
| `runs/detect/runs/neighborlens_v4/yolov8m_baseline/weights/best.pt` / val | clogged_drainage | 79.23% | 77.81% | 78.51% | 80.48% | 43.60% |
| `runs/detect/runs/neighborlens_v4/yolov8m_baseline/weights/best.pt` / val | pothole | 55.54% | 24.60% | 34.10% | 28.69% | 14.78% |
| `runs/detect/runs/neighborlens_v4/yolov8m_baseline/weights/best.pt` / val | road_crack | 54.82% | 50.25% | 52.43% | 49.28% | 26.75% |
| `runs/detect/runs/neighborlens_v4/yolov8m_baseline/weights/best.pt` / test | broken_streetlight | 37.12% | 40.74% | 38.85% | 26.38% | 13.17% |
| `runs/detect/runs/neighborlens_v4/yolov8m_baseline/weights/best.pt` / test | clogged_drainage | 80.72% | 76.17% | 78.38% | 79.98% | 41.91% |
| `runs/detect/runs/neighborlens_v4/yolov8m_baseline/weights/best.pt` / test | pothole | 59.00% | 26.69% | 36.76% | 33.18% | 14.50% |
| `runs/detect/runs/neighborlens_v4/yolov8m_baseline/weights/best.pt` / test | road_crack | 49.55% | 55.18% | 52.21% | 48.37% | 27.04% |

Neither tested YOLOv8m candidate meets the required validation target or maintains the current held-out baseline. The v2 candidate reaches 54.14% validation / 54.15% test mAP50; the v4 candidate reaches 47.03% / 46.98%. Current YOLO11s reaches 68.71% / 67.85%. The YOLO11 result does not satisfy a YOLOv8 architecture requirement. Broken-streetlight precision and road-crack recall remain weaknesses; class-level values above must accompany aggregate claims.
### Training and promotion gate
The v6 readiness audit failed: no manifest and Roboflow/augmentation lineage risks in validation/test; skipped visual checks cannot certify scene separation. The clean scene-grouped paper-aligned dataset also fails the existing readiness policy: only 93 training images across 92 scenes and insufficient independent train/validation/test scenes in all four classes. The safe `python -m ai.training.train_yolo --check-only --model yolov8m.pt --data data/datasets/neighborlens_paper_aligned_v3_1_remediated/data.yaml --name neighborlens_yolov8m_release_candidate --workers 0` failed 12 class/split coverage gates. CUDA is available; data readiness, rather than GPU absence, blocks eligible retraining. No insufficient-support bypass was used.
No model was trained, relabeled, promoted or deployed. QA-016 stays open. The canonical checkpoint and local inference deployment build copy both remain SHA256 `f218ccde1a6d27455250fa40a6b38515170fba746512be7c10198fc46d1e6ef2`. The existing promoter is specifically pinned to the historical v3.1 interim release and cannot be reused unchanged to promote a different qualified model. A future qualified YOLOv8 candidate needs independently reviewed class/data/metrics evidence, a reviewed atomic promotion update, explicit checkpoint replacement approval and separate deployment authorization. No approval is requested for an unqualified candidate.
Evidence is under `.data/remediation-2026-10-26/`: `checkpoints.json`, `comparison.json`, `comparison.log`, `training-readiness.json`, `training-readiness.log` and `yolov8-training-feasibility.log`. Ultralytics plots/confusion matrices are under `runs/detect/.data/remediation-2026-10-26/benchmarks/`. These are ignored local artifacts; retain approved redacted release evidence separately. No remote deployed checkpoint checksum was verified.

### Final local inference probe

The unchanged production checkpoint was loaded by an owned loopback FastAPI process on port 8016. Health reported YOLO11s `beta_testing_v3` and the four canonical class IDs. Four representative held-out samples returned HTTP 200 with zero coordinate/confidence bounds violations. Measured wall times were 6,175.91 ms for the first request and 116.93/124.92/114.18 ms for subsequent samples. A two-photo request returned 200 in 867.65 ms. Invalid image bytes returned 400 and invalid MIME returned 415. These are bounded local measurements, not remote cold-start or throughput guarantees.

The real Node → FastAPI → private MySQL lifecycle test passed four TAP cases without skipping the inference case (`real-ai-mysql-final.log`). Its original-AI and citizen-category persistence assertions remained intact. The owned AI process was stopped afterward. No external inference or hosted storage was called. Evidence: `live-ai-results.json`, `live-ai-probe.log`, `live-ai-server.log`.

## Final remediation run ledger — 27 October 2026

Results below supersede earlier provisional counts. Logs are under `.data/remediation-2026-10-26/`. Suites overlap; do not add these totals. TAP includes parent cases, and the registration migration suite also contains a nested 66/66 passing browser run. The optional inference case skipped in the complete migration invocation was executed separately against owned loopback FastAPI and passed. The Python skip is the unavailable historical v2 dataset immutability check, not a passing dataset audit. Current v6 and clean-dataset training-readiness gates failed separately and remain release blockers.

| Scope | Command | Final result | Evidence |
| --- | --- | --- | --- |
| Node unit/integration/security | `npm test` | 1,116 passed; 0 failed; 0 skipped | `node-release-final.log` |
| Private MySQL runtime | `node tests/support/run-isolated-mysql.js` | 43 passed; 0 failed; 0 skipped | `mysql-runtime-release.log` |
| Complete private MySQL migrations/integration | `node --test --test-concurrency=1 tests/migrations/*.test.js` | 115 passed; 0 failed; 1 optional real-inference case skipped | `migrations-release-complete.log` |
| Real FastAPI → Node → private MySQL | `QA_REAL_INFERENCE_URL=http://127.0.0.1:8016 and QA_REAL_IMAGE set; node --test tests/migrations/qa-backend-lifecycle-mysql.test.js` | 4 passed; 0 failed; 0 skipped | `real-ai-mysql-final.log` |
| Complete Report Details desktop/mobile | `npx playwright test --config=playwright.report-details.config.js` | 156 passed; 0 failed | `details-release-complete.log` |
| Phase 2 desktop/mobile | `npx playwright test --config=playwright.phase2.config.js` | 44 passed; 0 failed | `phase2-verified.log` |
| Barangay desktop/mobile | `npx playwright test --config=playwright.barangay.config.js` | 32 passed; 0 failed | `barangay-verified.log` |
| Shared Admin/Barangay responsive UI | `npx playwright test --config=playwright.shared-reports.config.js` | 16 passed; 0 failed | `shared-release-final.log` |
| Citizen publication desktop/mobile | `npx playwright test --config=playwright.publication.config.js` | 14 passed; 0 failed | `publication-verified.log` |
| New staff review browser workflow | `npx playwright test --config=playwright.report-review.config.js` | 8 passed; 0 failed | `review-browser-release.log` |
| EvidenceZoom standalone unit suite | `node --test tests/unit/evidence-zoom.test.js` | 24 passed; 0 failed | `evidence-zoom-final.log` |
| Python AI/tooling suite | `.venv/Scripts/python.exe -m pytest ai/tests -q` | 170 passed; 0 failed; 1 skipped; 14 deprecation warnings | `python-full.log` |
| Focused rejection notification/policy/persistence | `node --test --test-concurrency=1 tests/integration/report-review-workflow.test.js tests/migrations/report-review-mysql.test.js server/tests/notification.service.test.js server/tests/admin-live-reports.test.js` | 35 passed; 0 failed | `rejection-notification-verified.log` |

The full 156-case Report Details suite passed twice in this remediation; the final release run followed the rejection notification transaction fix. Earlier migration failures reproduced the queue race, a page-initialization fixture race and the rejection notification rollback bug; all failing cases were corrected and the complete migration suite rerun to zero failures. An initial Phase 2 launch was refused because another owned suite occupied its port; it was rerun after that suite exited and all 44 cases passed. No backend limiter was disabled to shorten tests.

Final checks: `git diff --check` passed; 32 changed/new JavaScript files passed syntax checks; the added-line scan found no new code comments or credential patterns. Checkpoint hashes were rechecked and unchanged. Desktop and 375/768/1440 review layouts were captured and visually inspected; blank fixture images/offline map placeholders in those screenshots do not establish live map/media availability. The existing production/candidate weights, configured databases, cloud storage and deployments were left unchanged. Prior staged work remains staged; this remediation’s new edits were not staged, committed or pushed.

Release decision remains YELLOW. Local regression results do not close QA-016, certify training data, authorize migration 016 on an existing deployment, verify hosted integrations, or replace the required model promotion/deployment approvals. The explicit deployment/rollback procedure and full candidate metrics are in the overall and backend/AI reports.

## Report Details regression — 27 October 2026

The latest bounded source audit and isolated runtime results are recorded in [Report Details full regression](report-details-full-regression-2026-10-27.md). It supersedes earlier run totals for this audit, preserves historical evidence, and keeps the target release YELLOW while migrations 017–018 and runtime prerequisites remain unresolved. Five newly reproduced defects cover transactional operational notifications, stale incident progress, omitted activity actors, excessive severity-form scrolling and dropped comment refreshes. No configured migration, cloud write, server restart or model replacement was performed.

Final verified totals for this continuation: Node 1,164 passed; full isolated migration suite 174 passed/1 optional skipped; actual MySQL runtime 43 passed; real AI-to-MySQL lifecycle 4 passed; Python 170 passed/1 historical-dataset skipped. Full browser runs: Details 156, shared reports 16, Barangay 32, publication 14, Phase 2 44, Citizen/auth 20, report review 24; all zero failures. The 192-combination visual matrix recorded no overflow, page exceptions or local 5xx. Optional default E2E checks remained three skipped; cloud storage was not enabled. See the focused report for the retained failed runs, exact evidence and target blockers.

## 9 November 2026 severity and detection follow-up

### Severity classification

The verified local Windows MySQL instance was queried in a read-only transaction using the configured loopback target. No report content or user identifiers were collected. The distribution reproduces the reported Major-only pattern among classified records.

| Evidence source | Major | Minor | Unassessed |
|---|---:|---:|---:|
| Legacy pair verification, no submission snapshot | 4 | 0 | 3 |
| Version 1 signed submission snapshot | 0 | 0 | 16 |
| No assessment evidence | 0 | 0 | 15 |
| Total | 4 | 0 | 34 |

The four Major rows are older records. Their archived pair values are three high and one critical. One of the high pair records is invalid, so these values are historical evidence rather than confirmation of physical severity. Sixteen archived pair rows contain low severity while the corresponding reports are unassessed. Eight of the fourteen snapshot-linked low records have valid pairs and six do not. A stored pair result is a separate verification record and does not set report severity. Representative signed snapshots show road crack at confidence 0.6134 and 0.4579, and pothole at 0.8105, all with NULL report classification. The original historical creation paths of the four Major rows were not reconstructed from these archives.

Current YOLO inference emits defect class, confidence and boxes with null physical severity. The submission pipeline keeps signed prediction evidence separate. Explicit recognized provider levels in the single-image assessment retain the established mapping of low/medium to Minor and high/critical to Major. Unknown or absent levels write NULL explicitly. The historical SQL column default is MINOR, and the application supplies the value on report creation. Staff confirmation requires an authorized assigned Barangay reviewer, observed impact and a reason. Minor accepts Low/Medium priority and Major accepts High/Critical. A configured approved policy can recommend Major on an inclusive measured threshold or an exact impact condition. The default remains review required and does not infer physical impact from pixels, class or confidence.

The local Major-only pattern comes from retained legacy labels and unassessed newer submissions. Separately, the Barangay summary compared stored labels verbatim while its filters normalized casing and spaces. `server/infrastructure/repositories/reportPage.query.js` now normalizes the summary consistently. The local distribution contained no case/space anomalies, so this query defect did not cause the observed local 4/0 count. Existing report rows were preserved.

| Severity check | Status | Evidence |
|---|---|---|
| Reproduce Major-only among assessed rows and identify current behavior | PASS | Read-only grouped SQL in `.data/severity-local-distribution.json` and de-identified samples in `.data/severity-local-evidence.json` |
| Minor, Major, invalid and unassessed handling | PASS | Domain boundaries, API validation, SQLite normalization regression and private MySQL persistence including reviewer history |
| Matching API and staff dashboard results | PASS | Browser fixtures confirm one Minor and one Major via authorized API, verify both returned values, and verify both Admin and Barangay counters increase by exactly one while a third unassessed record contributes to neither |
| Historical justification for each physical Major decision | BLOCKED | Archived classifications and pair output do not contain enough reviewed physical evidence to reconstruct historical decisions |

```powershell
node --test --test-concurrency=1 server/tests/report-severity-policy.test.js server/tests/qa-severity-persistence.test.js tests/integration/admin-classification.test.js tests/integration/report-export.test.js tests/migrations/qa-severity-mysql.test.js tests/migrations/report-review-mysql.test.js
npx playwright test --config=playwright.report-review.config.js --grep 'staff severity counters|Barangay operates an unassessed' --output=.data/severity-browser
```

The first command passed 63/63 and the second passed 4/4, with zero failures or skips. Logs are `.data/severity-followup.log` and `.data/severity-browser.log`.

### YOLO evaluation and training readiness

The working tree was evaluated from base commit `4dd7466cbae62790811941105a6cd3badb5c6f36` with Ultralytics 8.4.150, PyTorch 2.14.0+cu126, and an RTX 3060 with 12 GiB VRAM. The current production file is YOLO11s `beta_testing_v3`. The saved training arguments show 200 epochs and image size 640. The local YOLOv8m reference is an existing checkpoint.

The original v6 directory was absent, but the v6 ZIP was recovered from Downloads. Its test image and label byte multisets exactly match the 606-image test snapshot used below. Its official validation split has 1,193 images. The existing 1,194-image validation snapshot contains an extra copied validation image from the earlier local setup. The YOLOv8m result below uses that snapshot to reproduce the previous diagnostic reference.

| v6 archive split | Images | Streetlight boxes | Drainage boxes | Pothole boxes | Crack boxes |
|---|---:|---:|---:|---:|---:|
| Train | 4,219 | 1,252 | 1,408 | 1,890 | 2,183 |
| Validation | 1,193 | 344 | 374 | 523 | 607 |
| Test | 606 | 162 | 193 | 266 | 299 |

Class IDs are 0 broken streetlight, 1 clogged drainage, 2 pothole, and 3 road crack. The archive has matched image and label counts and no malformed annotation lines or out-of-frame boxes under the structural check. Seventeen test labels are empty, 108 test boxes cover less than 0.5% of their image, and 26 test images have mean grayscale intensity below 60 as a low-light proxy. The archive has no split manifest or test freeze manifest. Exact image-byte overlap is zero. Removing the Roboflow suffix yields 32 shared filename lineage keys across train/validation, 21 across train/test, and 7 across validation/test. A 64-bit difference-hash screen at Hamming distance ≤3 flagged 164, 119 and 31 cross-split candidate pairs respectively. These candidates require human scene review. Semantic annotation correctness, occlusion coverage and deployment distribution shift remain unverified.

The remediated scene-grouped alternative has 93 train, 31 validation and 30 test images. Its audit found 223 boxes, eight intentional background labels, zero malformed lines, and no cross-split exact or perceptual matches in the audit. The existing full readiness gate still failed all 12 class/split scene-coverage checks. The v5 export lacks a manifest and its check hit a Windows file lookup error on a long label path. The initial legacy audit CLI used the wrong directory layout and class names for the remediated dataset. Its zero counts were discarded. The verified audit uses a read-only hardlink view matching that utility's layout and the four canonical names.

| Run | Model | Dataset and split | Change | mAP50 | mAP50–95 | Precision | Recall |
|---|---|---|---|---:|---:|---:|---:|
| Production diagnostic | YOLO11s | v6 test snapshot, 606 images | Re-evaluation of unchanged production weights | 67.85% | 37.24% | 72.41% | 62.60% |
| YOLOv8m reference | Existing YOLOv8m | v6 validation snapshot, 1,194 images | Re-evaluation of existing candidate | 54.14% | 30.20% | 61.86% | 52.88% |
| New training | YOLOv8 candidate | Eligible scene-grouped split required | Blocked by dataset readiness | — | — | — | — |

Both evaluations used image size 640, batch 4, CUDA device 0, workers 0, confidence 0.001 and NMS IoU 0.7. These are different splits and the scores do not form a head-to-head comparison. The production run measured 8.26 ms inference per image and the YOLOv8m reference measured 18.19 ms per image inside the validator. These measurements exclude service/network overhead. The tested production artifact and Vercel build copy both have SHA256 `f218ccde1a6d27455250fa40a6b38515170fba746512be7c10198fc46d1e6ef2`. The YOLOv8m reference `models/candidates/neighborlens_v2_map50_60.0.pt` has SHA256 `c1c2a0ff39952b50da6205ad202f733f16b59880dcc4d38533d44b36fee763d7`. Snapshot hashes are retained in the local metrics JSON.

| Class | Production test AP50 | Production test AP50–95 | YOLOv8m validation AP50 | YOLOv8m validation AP50–95 |
|---|---:|---:|---:|---:|
| Broken streetlight | 55.05% | 30.47% | 48.58% | 26.63% |
| Clogged drainage | 89.03% | 50.51% | 88.13% | 52.36% |
| Pothole | 74.65% | 38.65% | 28.43% | 13.87% |
| Road crack | 52.67% | 29.32% | 51.44% | 27.94% |

The production confusion matrix at the low diagnostic threshold recorded class false positives/false negatives of 4,493/55, 2,402/41, 5,420/76 and 15,000/68 in class-ID order. Counts at this operating point should not be used as deployment error rates. At sample confidence 0.25, four class-selected images yielded a streetlight detection at 0.813, a drainage-labeled image with no detections, a pothole-labeled image with a road crack prediction at 0.645, and a crack-labeled image with a road crack prediction at 0.645. Images may have multiple labels. Full box predictions, matrix values, inference timings and plots are stored in `.data/nov09-yolo/`.

The measured weakness to investigate first in a qualified YOLOv8 run is pothole recall at 27.09%, alongside low road-crack AP. The experiment should begin with reviewed pothole/crack annotations, enough independent scenes in every class, and explicit coverage for small objects and low light. Select changes using validation and evaluate the new frozen test once after selection. No severity accuracy estimate was made because the detection labels contain no physical severity ground truth.

| Model check | Status | Evidence |
|---|---|---|
| Dataset structural audit and diagnostic baseline | PASS | v6 ZIP audit, clean dataset audit and current GPU evaluations |
| Independently qualified 75% detection benchmark | BLOCKED | v6 split lineage remains unresolved and the scene-grouped alternative lacks class coverage |
| Controlled new training and promotion | BLOCKED | Both dataset gates prevent an eligible experiment. No candidate was trained or qualified |

```powershell
.venv/Scripts/python.exe .data/nov09-yolo-archive-audit.py
.venv/Scripts/python.exe .data/nov09-yolo-dataset-audit.py
.venv/Scripts/python.exe .data/nov09-yolo-baseline.py
.venv/Scripts/python.exe -m ai.training.train_yolo --check-only --model models/candidates/neighborlens_v2_map50_60.0.pt --data data/datasets/neighborlens_paper_aligned_v3_1_remediated/data.yaml --workers 0
.venv/Scripts/python.exe -m ai.training.train_yolo --check-only --model models/candidates/neighborlens_v2_map50_60.0.pt --data data/datasets/Neighborlens.v5-neighborlens_beta_testing_v2.yolov8/data.yaml --workers 0
```

Target achieved: NO. Production promotion: NOT_APPROVED. The production checkpoint remains the rollback reference. Logs are `.data/nov09-yolo-*.log` and the structured experiment evidence is under `.data/nov09-yolo/`.
