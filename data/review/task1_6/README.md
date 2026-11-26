# Task 1.6 Human Review Package

Base dataset: `data/datasets/neighborlens_paper_aligned_v3_clean` (frozen, never edited in place).
Guideline: `docs/dataset_audit/ANNOTATION_GUIDELINE.md`.
Classes: 0 broken_streetlight, 1 clogged_drainage, 2 pothole, 3 road_crack.

## Files

| File | Purpose |
|---|---|
| `review_package.json` | Every entry, grouped as NEEDS_BOUNDING_BOX, NEEDS_CLASS_DECISION, APPROVE_BACKGROUND, EXCLUDE, RESOLVED, with image path, current boxes, reason and the exact action required |
| `annotation_review.json` | Decisions for images inside v3_clean; read by `apply_annotation_review` |
| `quarantine_review.json` | Decisions for the 39 quarantined empty-label images; read by `apply_annotation_review` |
| `sheets/*.jpg` | Contact sheets, one per category, with numbered boxes drawn from the current labels |
| `corrections/<split>/<stem>.txt` | Where corrected YOLO labels for v3_clean images are saved |

Source images are not modified. Contact sheets are drawn copies.

## What blocks v3_1_remediated

Only entries with `blocks_v3_1: true` (AR-003, AR-004, AR-005, AR-006) affect images that are already in v3_clean. The remaining entries concern quarantined images and only add data.

## How to work through it

1. AR-003, AR-004, AR-006: open the image and label listed in `review_package.json`, write the full corrected label file to `corrections/<split>/<stem>.txt` (all lines, not only the changed ones), then set that item's `decision` in `annotation_review.json` to `RESOLVED`. If no change is needed, set `RESOLVED_NO_CHANGE` and write no file.
2. AR-005: for each image decide damage or non-function per the guideline. Keep confirmed ones unchanged. For any image whose only box is not a broken streetlight, add a new item with `decision: EXCLUDE` listing that file; never write an empty correction and never move an image to another split. Then set AR-005 to `RESOLVED`.
3. AR-001 (scene_0051, already excluded): either write identical corrected labels for both copies and set `RESOLVED`, or set `EXCLUDE`.
4. Background approvals: in `quarantine_review.json` set `approved_for_train_background: true` only for images you confirm contain no object of any of the four classes. Nine are proposed (`background_proposal: PROPOSE_APPROVE`); the cap is 10 percent of train images, which is 9 at the current size. Backgrounds always go to train.
5. Missing streetlight boxes (scene_0043, scene_0077, scene_0109, scene_0174) and any ambiguous image you decide is a broken streetlight: copy the image to `data/staging/original_candidates/images/`, put its label in `data/staging/original_candidates/labels/`, and add a provenance row with `source_type=reannotated_existing` and `reentry_of_scene_id=<scene id>`. They enter the next dataset version through the import pipeline, not through v3_1.

## Commands after the review

```
python -m ai.preprocessing.apply_annotation_review --review-dir data/review/task1_6 --corrections-dir data/review/task1_6/corrections
python -m ai.preprocessing.dataset_integrity_gate data/datasets/neighborlens_paper_aligned_v3_1_remediated
python -m ai.preprocessing.dataset_integrity_gate data/datasets/neighborlens_paper_aligned_v3_1_remediated --readiness
python -m ai.training.train_yolo --check-only --baseline-insufficient-support
```

The first gate is structural integrity and must pass. The readiness gate will keep failing on per-class support until new original data is added; see `docs/dataset_audit/DATA_ACQUISITION_PLAN.md`.
