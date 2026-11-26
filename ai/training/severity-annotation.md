# Two-photo severity annotation protocol

**Purpose.** Build a reference set for deciding when the two images a citizen already submits can support a Minor or Major suggestion. The local engineering authority must approve the operational criteria and reference an identifiable version before binary annotation begins. This draft defines how to collect evidence. It sets no engineering thresholds.

## Unit of review

One record represents one physical defect at one inspection event. Assign a stable site ID to the road segment, drain or light asset. Use the same site ID for return visits, repaired conditions, alternate views, frames from the same sequence and augmentations. Collect two independently captured views before repair, one showing the surrounding asset and one showing the defect. Record the time, capture angle, distance or scale source, lighting, obstructions and any condition change between inspection and capture. Reject mismatched defects and copied or near-identical photos. Never pair unrelated photos just because their category matches.

An infrastructure inspector records the operational finding, method, units, measurement uncertainty, date and signed inspection reference. Two qualified reviewers independently assess the photos before seeing each other's judgement or model output. Keep their original assessments, the evidence visible in each view and reasons for uncertainty. An independent qualified adjudicator resolves disagreements and records a rationale. Maintain reviewer credentials and approval records in the inspection system. Use opaque identifiers in the research export.

| Defect and reviewer | Required evidence in the inspection record | When to assign a photo target |
|---|---|---|
| **Road crack** · pavement engineer or qualified road inspector | Mark the same crack, visible endpoints, branches and valid road surface in both views. Record crack type, calibrated opening width, measured length and any step or displacement used by the rule. Record uncertainty and identify shadows, sealed joints or texture. | Major when the confirmed applicable Major criterion is visible and identifiable. Minor when all required Minor conditions are established. If the decisive opening or displacement cannot be resolved in the images, use Insufficient even when the inspection class is known. |
| **Pothole** · pavement engineer or qualified road inspector | Delineate the cavity rim and valid pavement. Record maximum depth, length and width or diameter, their uncertainty, rim breakup, water, shadow and wheel-path location. Record how the bottom was established. | Apply the approved rule to the inspection. Give a binary photo target only when both views support the decisive condition. If water hides the bottom and depth determines the class, use Insufficient. |
| **Clogged drainage** · drainage engineer or qualified drainage inspector | Identify inlet/outlet type, the effective opening, comparable opening and obstruction masks, debris, water depth and observed flow or backup under recorded conditions. Separate grate bars from debris. Record the obstruction denominator and measurement uncertainty. | A wet street alone cannot establish blockage. Minor requires positive evidence of limited obstruction under the approved rule. Major requires verified qualifying impairment or obstruction with corresponding visible evidence. An unseen opening or unknown flow when decisive gives Insufficient. |
| **Broken streetlight** · qualified electrical or structural inspector as applicable | Identify asset, fixture, pole, base, visible components, deformation and exposure. Reference authorized inspection or function-test findings. Record which findings are visible and which required testing. | Apply a binary photo target only when the decisive inspected condition is visible. A daytime exterior photo cannot establish nighttime operation or energization. Unknown hazards and missing decisive details give Insufficient. |

Keep two separate values. `inspection_class` is MINOR, MAJOR or UNKNOWN. The image `label` is MINOR, MAJOR or INSUFFICIENT. A genuinely Major site with obscured evidence should stay in evaluation as inspected Major with an INSUFFICIENT photo target. The evaluation counts a Minor prediction on that case in its false-Minor rate. Missing labels and unusable views must never default to Minor. References to measurements belong to the reviewer workflow. The classifier receives only features from the two photos.

## Build and freeze the dataset

1. From the repository root, run the following with the project's AI environment. The inventory records relative paths, source families, SHA-256, a perceptual fingerprint and existing defect annotations. It deduplicates identical files and assigns no severity. Use a fresh destination for each export.

   ```powershell
   $dataset = "$env:USERPROFILE/Downloads/Neighborlens.v9-neighborlens_final_test_v2.yolov8"
   .\.venv\Scripts\python -m ai.training.severity_dataset $dataset inventory.jsonl
   ```

2. Use the inventory to find candidate views. Verify provenance before pairing. Untraceable export photos may be used for segmentation research. They cannot supply a site, a second view or a severity judgement by inference. For prospectively collected photos use the same inventory layout with canonical `data.yaml` and split directories containing `images/`. Category label files are optional.
3. Freeze the local rubric, review roster, source/site crosswalk and split before fitting. The policy JSON requires `version`, `approval_ref`, a `rule_refs` object mapping each supported class to its rule, a `reviewers` object mapping qualified reviewer IDs to their classes and `research_score_cutoffs` mapping each class to two predeclared decision cutoffs. Use development data or preregistered operating requirements to justify cutoffs. Scores between them abstain. Set acceptance limits for false-Minor risk, Major recall, coverage and case/site counts before inspecting the test predictions.
4. Export adjudicated records as JSONL. The following is the field contract. Blank placeholders are deliberately ineligible for training. Store detailed inspection measurements and individual reports under the referenced inspection record.

   ```json
   {
     "photos": ["<first image SHA-256>", "<second image SHA-256>"],
     "category": "road_crack",
     "site_id": "", "event_id": "", "inspection_ref": "", "rubric_version": "",
     "capture_context": "", "evidence": "", "inspection_class": "",
     "visually_supported": null, "label": "", "independent_of_detector_training": false,
     "reviews": [
       {"reviewer": "", "label": "", "basis": ""},
       {"reviewer": "", "label": "", "basis": ""}
     ],
     "adjudicator": "", "resolution": ""
   }
   ```

5. Split by normalized site ID using deterministic SHA-256 buckets, 60% training, 20% development and 20% test in expectation. Freeze identifiers before examining outcomes. Repeated events at a site stay together. The loader rejects reused images/events, shared augmentation families across splits and perceptually close images across splits. Manually audit near duplicates, shared video sequences and geographic overlap as fingerprints can miss cropped or mirrored views. Test sites require verified independence from detector development. Verify adequate representation of each category, class and image condition at independent sites. Collect additional cases if any group is missing.

## Train and evaluate a candidate

From the repository root and using the same inventory, reviewed records and approved policy for both commands:

```powershell
.\.venv\Scripts\python -m ai.training.severity_classifier train $dataset inventory.jsonl reviews.jsonl policy.json pothole.candidate.json pothole
.\.venv\Scripts\python -m ai.training.severity_classifier evaluate $dataset inventory.jsonl reviews.jsonl policy.json pothole.candidate.json pothole
```

Repeat for each supported class. The CLI checks the frozen YOLO hash, replays both images through the local pair endpoint and reads the candidate visual measurements. Per-view features are combined by minimum and maximum. Neither the reviewer measurements nor detection confidence enter the classifier. The research baseline fits standardized L2-regularized logistic regression on reviewed, usable binary training cases. It estimates a decision score. A missing view, disagreeing class or score inside the abstention band gives Insufficient. An insufficient holdout case remains in the denominator even when no features could be extracted.

The model JSON binds data, policy, detector and feature version. The separate evaluation command reads the frozen test partition and reports a three-way confusion matrix, Major precision/recall/F1, coverage, false-Minor risk among all inspected Major cases, and incorrect binary activations on other defect categories. Review these by lighting, distance, viewpoint and site, with site-level uncertainty intervals and case counts, before any production decision. Do not tune on the test set. If the model changes after seeing those results, reserve a new independent test set. Approval requires a validated end-to-end pair decision per enabled class. No generated candidate file is automatically loaded into a Citizen scan.

## External evidence

The Attain dataset provides expert-annotated severity for pavement defects in vehicle-mounted smartphone images. Its native grades, site provenance and capture conditions need a documented crosswalk and local independent validation before it can support NeighborLens operational labels. It covers pavement; drainage and streetlights require separate evidence. [Dataset and annotations](https://data.mendeley.com/datasets/nykrzdm74f/1) · [Authors' collection and labeling methods](https://pmc.ncbi.nlm.nih.gov/articles/PMC12167439/)
