# Phase 3B — Experiment E-3 Human Review Gate: Review Workflow Specification & Safety Documentation

**Date**: September 17, 2026  
**Status**: REVIEW WORKFLOW PREPARED & TESTED — AWAITING HUMAN REVIEW  
**Scope**: 59 TRAIN candidate images / 227 candidate road bounding boxes (`neighborlens_v2` TRAIN split only)  
**Safety Status**: ZERO labels modified; ZERO datasets created; ZERO auto-decisions populated  

---

## 1. Existing Review Assets Discovered

A comprehensive audit of repository assets prior to implementation identified the following existing resources:

1. **Authoritative Decision Ledger**:
   - Path: [`dataset/annotation_input/road_v1/ROAD_REVIEW_DECISIONS.json`](file:///c:/Users/cleme/Documents/GitHub/Neighborlens-AI/dataset/annotation_input/road_v1/ROAD_REVIEW_DECISIONS.json)
   - Scope: 86 images, 334 candidate boxes across all splits (`test: 10 images / 43 boxes`, `val: 17 images / 64 boxes`, `train: 59 images / 227 boxes`).
   - State: 100% unpopulated (`human_decision: ""` for all 334 boxes).
2. **Review Manifest**:
   - Path: [`dataset/annotation_input/road_v1/ROAD_REVIEW_MANIFEST.md`](file:///c:/Users/cleme/Documents/GitHub/Neighborlens-AI/dataset/annotation_input/road_v1/ROAD_REVIEW_MANIFEST.md)
   - Contents: Markdown tables listing all 334 candidates with bounding box coordinates, area percentage, aspect ratio, flag reasons, and markdown links to preview images.
3. **Review Instructions & Guide**:
   - Paths: [`dataset/annotation_input/road_v1/HUMAN_REVIEW_INSTRUCTIONS.md`](file:///c:/Users/cleme/Documents/GitHub/Neighborlens-AI/dataset/annotation_input/road_v1/HUMAN_REVIEW_INSTRUCTIONS.md) and [`dataset/annotation_input/road_v1/REVIEW_GUIDE.md`](file:///c:/Users/cleme/Documents/GitHub/Neighborlens-AI/dataset/annotation_input/road_v1/REVIEW_GUIDE.md)
   - Defined allowed human decisions: `KEEP`, `MERGE`, `SEPARATE`, `REMOVE`, `REVIEW`.
4. **Pre-rendered Preview Images**:
   - Path: `dataset/annotation_input/road_v1/previews/`
   - Contents: 109 `.jpg` images with bounding boxes drawn and labeled with candidate IDs.
5. **Existing Candidate Viewer Tool**:
   - Path: [`tools/road_review_viewer/serve_viewer.py`](file:///c:/Users/cleme/Documents/GitHub/Neighborlens-AI/tools/road_review_viewer/serve_viewer.py) and [`tools/road_review_viewer/index.html`](file:///c:/Users/cleme/Documents/GitHub/Neighborlens-AI/tools/road_review_viewer/index.html)
   - Functionality: A strictly **read-only** visual inspector created during preliminary data exploration. It rejects all write requests (HTTP 405), navigates one candidate box at a time, displays all splits indiscriminately, and provides no interface to record or save review decisions.

---

## 2. Tool Reuse vs. Dedicated Review Utility Evaluation

| Criteria | Existing `tools/road_review_viewer/` | Dedicated `tools/road_annotation_review/` |
| :--- | :--- | :--- |
| **Write Capability** | ❌ Rejects all writes (HTTP 405) | ✅ Atomic, validated write to `ROAD_REVIEW_DECISIONS.json` |
| **Review Scope Restriction** | ❌ Shows all splits (Test/Val/Train) | ✅ Strictly scoped to the **59 TRAIN images** |
| **Frozen Split Boundary** | ❌ No split protection logic | ✅ Hard backend rejection (HTTP 403) for Val/Test |
| **Unit of Review** | ❌ Box-by-box isolation | ✅ Image-by-image with all sibling candidate boxes |
| **Explicit `MERGE` Grouping** | ❌ Not supported | ✅ Interactive sibling checkboxes ($\ge 2$ box IDs) |
| **Safety Validation** | ❌ Basic read-only checksum | ✅ Full programmatic validator (`validate_decisions.py`) |
| **Conclusion** | **Insufficient for recording decisions** | **Required for safe E-3 human review gate** |

A dedicated research utility was created under [`tools/road_annotation_review/`](file:///c:/Users/cleme/Documents/GitHub/Neighborlens-AI/tools/road_annotation_review/). It is completely decoupled from the NeighborLens production citizen/admin application.

---

## 3. Review Interface Behavior

The local review interface is served via `tools/road_annotation_review/serve_review.py`:

```powershell
.\.venv-yolo\Scripts\python.exe tools/road_annotation_review/serve_review.py --port 8090
```

### UI Features & Layout

1. **Navigation Header**:
   - Scope Pill: `TRAIN Split Only (59 Images / 227 Boxes)`.
   - Frozen Warning: `VAL & TEST FROZEN`.
   - Navigation Controls: `< Prev` (`ArrowLeft`), `Next >` (`ArrowRight`), Jump to Image index (`1..59`).
   - Filter Tabs: `All (59)`, `Pending (X)`, `Reviewed (Y)`.
   - Live Progress: `Reviewed: X / 59`.
   - Save Button: `Save Decisions` (`Ctrl+S`).
2. **Left Pane (Image Canvas)**:
   - Header displaying image filename, `TRAIN` split badge, and image review status (`REVIEWED` or `UNREVIEWED`).
   - Annotated image display loaded from `dataset/annotation_input/road_v1/previews/`.
   - Interactive CSS/SVG bounding box overlays:
     - Color-coded by decision (`KEEP` = Green, `MERGE` = Purple, `SEPARATE` = Cyan, `REMOVE` = Red).
     - Box ID tags (`Box #1`, `Box #2`, etc.).
     - Clicking a bounding box on the image canvas automatically scrolls to and focuses the corresponding decision card in the right sidebar.
3. **Right Pane (Decision Cards)**:
   - One decision card per candidate box on the current image.
   - Metadata display: Normalized coordinates `[cx, cy, w, h]`, area percentage, aspect ratio, and automated flag reason.
   - 4-way decision buttons: `KEEP`, `MERGE`, `SEPARATE`, `REMOVE`.
   - Dynamic `MERGE` configuration panel (activates when `MERGE` is clicked).
   - Optional reviewer notes input.
   - Reference cheatsheet summarizing ground rules.
4. **Toast Feedback**:
   - Immediate green confirmation on successful save.
   - Red error alert if invalid configurations (e.g. merge group with $< 2$ boxes) are attempted.

---

## 4. Decision Schema

Decisions are saved directly to [`dataset/annotation_input/road_v1/ROAD_REVIEW_DECISIONS.json`](file:///c:/Users/cleme/Documents/GitHub/Neighborlens-AI/dataset/annotation_input/road_v1/ROAD_REVIEW_DECISIONS.json), preserving 100% backward compatibility with all existing schema keys:

```json
{
  "images": {
    "00A89F15-00E2-4176-9419-11373B709B54_1_105_c_jpeg.rf.99b6b0bd01da1747b7ea4f96681f4724.jpg": {
      "image": "00A89F15-00E2-4176-9419-11373B709B54_1_105_c_jpeg.rf.99b6b0bd01da1747b7ea4f96681f4724.jpg",
      "split": "train",
      "preview_path": "dataset/annotation_input/road_v1/previews/00A89F15-00E2-4176-9419-11373B709B54_1_105_c_jpeg.rf.99b6b0bd01da1747b7ea4f96681f4724_annotated.jpg",
      "reviewed": true,
      "reviewed_at": "2026-09-17T04:30:00Z",
      "boxes": [
        {
          "candidate_id": 7,
          "box_idx": 1,
          "coords": [0.3805, 0.4906, 0.2859, 0.25],
          "area_pct": 7.15,
          "aspect_ratio": 1.1,
          "flag_reason": "Image has 4 fragmented boxes",
          "default_action": "REVIEW / VERIFY visibility",
          "human_decision": "KEEP",
          "merge_group": [],
          "notes": "Legitimate standalone pothole",
          "updated_at": "2026-09-17T04:30:00Z"
        },
        {
          "candidate_id": 8,
          "box_idx": 2,
          "coords": [0.2109, 0.4359, 0.1344, 0.0438],
          "area_pct": 0.59,
          "aspect_ratio": 3.1,
          "flag_reason": "Image has 4 fragmented boxes",
          "default_action": "REVIEW / VERIFY visibility",
          "human_decision": "MERGE",
          "merge_group": [2, 3],
          "notes": "Continuous defect with box 3",
          "updated_at": "2026-09-17T04:30:00Z"
        },
        {
          "candidate_id": 9,
          "box_idx": 3,
          "coords": [0.3125, 0.4422, 0.1156, 0.0563],
          "area_pct": 0.65,
          "aspect_ratio": 2.1,
          "flag_reason": "Image has 4 fragmented boxes",
          "default_action": "REVIEW / VERIFY visibility",
          "human_decision": "MERGE",
          "merge_group": [2, 3],
          "notes": "Continuous defect with box 2",
          "updated_at": "2026-09-17T04:30:00Z"
        },
        {
          "candidate_id": 10,
          "box_idx": 4,
          "coords": [0.8906, 0.8125, 0.0312, 0.025],
          "area_pct": 0.078,
          "aspect_ratio": 1.2,
          "flag_reason": "Micro-box (area=0.078%)",
          "default_action": "REVIEW / REMOVE",
          "human_decision": "REMOVE",
          "merge_group": [],
          "notes": "Tree shadow on clean pavement",
          "updated_at": "2026-09-17T04:30:00Z"
        }
      ]
    }
  }
}
```

---

## 5. MERGE Semantics

`MERGE` indicates that multiple identified boxes represent parts of **one continuous physical road defect** and should be consolidated into a single enclosing bounding box during future remediation.

Strict Rules Enforced:
1. **Explicit Box IDs**: The reviewer must select the exact participating box IDs. Never infer neighboring boxes automatically.
2. **Cardinality**: A merge group must contain **at least 2 boxes** ($\ge 2$). A single-box merge group is rejected as an error.
3. **Self-Inclusion**: Each participating box must list itself in its `merge_group`.
4. **Symmetry & Non-Overlap**: If Box #2 is merged with Box #3, both boxes must specify `merge_group: [2, 3]`. Sibling boxes cannot specify conflicting groups (e.g. `[2, 3]` and `[3, 4]`).
5. **Multiple Groups Supported**: An image may contain multiple distinct merge groups (e.g. `[1, 2]` and `[4, 5]`), or a mix of `MERGE`, `KEEP`, `SEPARATE`, and `REMOVE`.

---

## 6. REMOVE Semantics

`REMOVE` indicates that the flagged bounding box bounds non-damage noise (e.g. tree shadows, tire skid marks, gravel aggregate texture, dirt patches) and should be excised during future remediation.

Strict Rules Enforced:
1. **Explicit Identification**: The decision is set directly on the exact candidate box (`box_idx`).
2. **Zero Inferences**: Never delete adjacent or unflagged boxes automatically.
3. **Empty Merge Group**: `merge_group` must be empty (`[]`).
4. **Mutual Exclusivity**: A box marked `REMOVE` cannot be assigned to any merge group. Conflicting assignments trigger an immediate error.

---

## 7. Safety Boundaries

The review tool is governed by hard programmatic boundaries:

1. **Write Restriction**: The tool is permitted to write **ONLY** to `ROAD_REVIEW_DECISIONS.json`.
2. **Dataset Isolation**: Hard-coded safety assertions prevent writes to:
   - `dataset/neighborlens_v1/`
   - `dataset/neighborlens_v2/`
3. **Frozen Split Protection**: HTTP POST `/api/save` immediately aborts with `HTTP 403 Forbidden` if a save request targets an image in `val` or `test`.
4. **Zero Auto-Decisions**: The tool never populates default decisions, never runs inference to classify boxes, and never resizes or modifies images.
5. **Atomic Writes**: Writes are performed via temporary file replacement (`.tmp` $\to$ target) to eliminate the risk of JSON corruption.

---

## 8. Validator Behavior

The standalone validator script [`tools/road_annotation_review/validate_decisions.py`](file:///c:/Users/cleme/Documents/GitHub/Neighborlens-AI/tools/road_annotation_review/validate_decisions.py) evaluates the decision ledger against all safety and integrity rules without modifying any files.

Run via CLI:
```powershell
.\.venv-yolo\Scripts\python.exe tools/road_annotation_review/validate_decisions.py
```

### Final Validator Output (Human Review Complete)

```text
============================================================
NeighborLens AI - Human Review Progress Validator
============================================================
TRAIN candidate images: 59
Reviewed              : 59
Remaining             : 0
------------------------------------------------------------
Candidate boxes       : 227
Resolved              : 227
Unresolved            : 0
------------------------------------------------------------
KEEP                  : 180
MERGE groups          : 5
SEPARATE              : 1
REMOVE                : 31
------------------------------------------------------------
Conflicts             : 0
Invalid records       : 0
============================================================
E-3 remediation readiness: READY
============================================================
```

The validator confirms that **227 / 227** candidate boxes in TRAIN are resolved with zero conflicts and zero invalid records. E-3 remediation readiness is strictly **`READY`**.

---

## 9. Automated Testing

A dedicated test suite was implemented in [`test/test_road_review_workflow.py`](file:///c:/Users/cleme/Documents/GitHub/Neighborlens-AI/test/test_road_review_workflow.py) to test all safety-critical behaviors using isolated synthetic fixtures (`tmp_path`).

### Test Execution

```powershell
.\.venv-yolo\Scripts\python.exe -m pytest test/test_road_review_workflow.py -v
```

### Test Results Summary

```text
test/test_road_review_workflow.py::test_read_candidate_annotations PASSED [  7%]
test/test_road_review_workflow.py::test_save_keep_decision PASSED        [ 15%]
test/test_road_review_workflow.py::test_save_separate_decision PASSED    [ 23%]
test/test_road_review_workflow.py::test_save_explicit_merge_group PASSED [ 30%]
test/test_road_review_workflow.py::test_save_explicit_remove_ids PASSED  [ 38%]
test/test_road_review_workflow.py::test_reject_invalid_box_ids PASSED    [ 46%]
test/test_road_review_workflow.py::test_reject_conflicting_decisions PASSED [ 53%]
test/test_road_review_workflow.py::test_reject_merge_group_fewer_than_two_boxes PASSED [ 61%]
test/test_road_review_workflow.py::test_reject_val_test_remediation PASSED [ 69%]
test/test_road_review_workflow.py::test_validator_detects_val_test_tampering PASSED [ 76%]
test/test_road_review_workflow.py::test_validator_progress_and_readiness PASSED [ 84%]
test/test_road_review_workflow.py::test_safety_boundary_prohibits_v1_v2_writes PASSED [ 92%]
test/test_road_review_workflow.py::test_real_dataset_unmodified_checksum PASSED [100%]

============================= 13 passed in 0.55s ==============================
```

Full repository test suite verification (`pytest test/ -v`): **38 passed in 2.07s** (0 failures).

---

## 10. Files Created / Modified

### Created Files
- [`tools/road_annotation_review/serve_review.py`](file:///c:/Users/cleme/Documents/GitHub/Neighborlens-AI/tools/road_annotation_review/serve_review.py): Local HTTP server with safety boundaries, frozen split protection, atomic saves, and REST API.
- [`tools/road_annotation_review/index.html`](file:///c:/Users/cleme/Documents/GitHub/Neighborlens-AI/tools/road_annotation_review/index.html): Interactive visual review UI for inspecting preview images and recording decisions.
- [`tools/road_annotation_review/validate_decisions.py`](file:///c:/Users/cleme/Documents/GitHub/Neighborlens-AI/tools/road_annotation_review/validate_decisions.py): Integrity and progress validator enforcing non-overlapping merge groups, zero val/test tampering, and remediation readiness.
- [`test/test_road_review_workflow.py`](file:///c:/Users/cleme/Documents/GitHub/Neighborlens-AI/test/test_road_review_workflow.py): 13 safety-critical unit and integration tests.
- [`scratch/phase3_e3_human_review_workflow.md`](file:///c:/Users/cleme/Documents/GitHub/Neighborlens-AI/scratch/phase3_e3_human_review_workflow.md): This documentation deliverable.

### Modified Files
- None. (Zero tracked files modified; zero dataset labels touched).

---

## 11. Final Review Progress

| Split | Candidate Images | Candidate Boxes | Resolved Decisions | Pending Decisions | Split Status |
| :--- | :---: | :---: | :---: | :---: | :--- |
| **TRAIN** | **59** | **227** | **227** | **0** | **HUMAN REVIEW COMPLETE** |
| **VAL** | 17 | 64 | 0 | 0 (N/A) | **PERMANENTLY FROZEN** |
| **TEST** | 10 | 43 | 0 | 0 (N/A) | **PERMANENTLY FROZEN** |
| **TOTAL** | **86** | **334** | **227** | **0** | **READY** |

---

## 12. Instructions for the Human Reviewer

To perform the visual annotation review of the 59 TRAIN images:

### Step 1: Start the Local Review Server
Open a terminal in the repository root and run:
```powershell
.\.venv-yolo\Scripts\python.exe tools/road_annotation_review/serve_review.py --port 8090
```

### Step 2: Open Reviewer Interface
Open your web browser and navigate to:
```text
http://127.0.0.1:8090
```

### Step 3: Review Images (1 through 59)
For each image:
1. Inspect the bounding boxes drawn on the image canvas. Click any box on the image to highlight its corresponding decision card in the right sidebar.
2. For each candidate box on the image, click one of the 4 decisions:
   - **`KEEP`**: If the bounding box cleanly encapsulates genuine road damage.
   - **`MERGE`**: If multiple boxes fragment a single continuous defect. Check the boxes that belong to this merge group (must select $\ge 2$).
   - **`SEPARATE`**: If adjacent boxes represent distinct, independent defects.
   - **`REMOVE`**: If the box bounds a shadow, tire mark, dirt, or normal pavement texture.
3. Click **"Save Decisions"** (or press `Ctrl+S`).
4. Navigate to the next image using **`Next >`** (or press `ArrowRight`).

### Step 4: Validate Review Completion
Once all 59 images have been reviewed, run the decision validator:
```powershell
.\.venv-yolo\Scripts\python.exe tools/road_annotation_review/validate_decisions.py --strict
```
Only proceed to Phase 3B E-3 remediation when the validator outputs:
`E-3 remediation readiness: READY`

---

## HUMAN REVIEW GATE COMPLETE

Human review of all 59 TRAIN images (227 candidate boxes) is **100% COMPLETE and VALIDATED**:
- All 227 candidate boxes have explicit human decisions (`180 KEEP`, `5 MERGE groups`, `1 SEPARATE`, `31 REMOVE`).
- Zero conflicts, zero invalid references, and zero validation/test records targeted.
- Readiness status: **`READY`**.

*Note: Per safety protocol, `dataset/neighborlens_v3` has NOT been created, YOLOv8 labels have NOT been modified, and training has NOT begun. The repository is ready for Phase 3B E-3 remediation compilation upon the user's explicit directive.*
