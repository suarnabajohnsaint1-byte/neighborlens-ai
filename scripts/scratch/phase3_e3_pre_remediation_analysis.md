# Phase 3B: Experiment E-3 Pre-Remediation Analysis & Preparation Gate Report

**Experiment Target**: `E-3 — Road Annotation Remediation`  
**Evaluation Scope**: Audit human review records in `ROAD_REVIEW_DECISIONS.json`, design proposed dataset lineage (`neighborlens_v3`), and provide a definitive **GO / NO-GO** recommendation.  
**Date**: September 17, 2026  
**Status**: **NO-GO (PENDING HUMAN ANNOTATION DECISIONS)**

---

## 1. Executive Summary & Pre-Remediation Finding

Experiment E-3 was conceptualized to test the hypothesis:
> *"Does human-reviewed remediation of fragmented `damaged_road` annotations improve YOLOv8 road-damage learning while preserving an unaltered, frozen evaluation benchmark?"*

### Critical Pre-Remediation Finding
In strict accordance with the governance rules:
> *"Determine exactly which road annotations have explicit human-reviewed decisions. Do NOT infer approval. Do NOT automatically merge boxes based only on size, proximity, IoU, clustering, model predictions, or heuristics. Only explicitly human-approved remediation may be proposed."*

An exhaustive audit of [`dataset/annotation_input/road_v1/ROAD_REVIEW_DECISIONS.json`](file:///c:/Users/cleme/Documents/GitHub/Neighborlens-AI/dataset/annotation_input/road_v1/ROAD_REVIEW_DECISIONS.json) and [`dataset/annotation_input/road_v1/ROAD_REVIEW_MANIFEST.md`](file:///c:/Users/cleme/Documents/GitHub/Neighborlens-AI/dataset/annotation_input/road_v1/ROAD_REVIEW_MANIFEST.md) reveals:
* **Total flagged candidate boxes**: 334 boxes across 86 images.
* **Explicit Human Decisions Populated**: **0 / 334 (0.0%)**.
* **Decision Status in JSON**: Every single candidate box in `ROAD_REVIEW_DECISIONS.json` currently has `"human_decision": ""`.
* **Heuristic Proposals**: The file `ROAD_REVIEW_MANIFEST.md` contains automated *suggested actions* (e.g. `"default_action": "MERGE into continuous damage box"` based on geometric clustering rules), but **zero decisions have been formally approved or signed off by a human annotator**.

### Definitive Recommendation: **NO-GO FOR IMMEDIATE TRAINING**
Because zero explicit human decisions exist, executing automated bounding box merges or deletions at this time would directly violate the core instruction:
> *"Do NOT automatically merge boxes based only on size, proximity, IoU, clustering, model predictions, or heuristics. Only explicitly human-approved remediation may be proposed."*

Therefore, **`dataset/neighborlens_v3` must NOT be created, and E-3 training must NOT be launched until human annotators record decisions in `ROAD_REVIEW_DECISIONS.json`**.

---

## 2. Dataset Lineage & Governance Plan

When human review decisions are formally populated, the dataset lineage will maintain complete traceability:

```
+---------------------------------------------------------------------------------------------------------+
|                                        DATASET LINEAGE ARCHITECTURE                                     |
+---------------------------------------------------------------------------------------------------------+
| [neighborlens_v1] (Baseline Ground Truth)                                                               |
|   - 242 images / 242 labels                                                                             |
|   - Frozen historical baseline with held-out validation blindspot for Class 2 & 3                       |
|   - Status: PERMANENTLY FROZEN & IMMUTABLE                                                              |
+---------------------------------------------------------------------------------------------------------+
                                      |
                                      v (Stratification & Cluster Preservation)
+---------------------------------------------------------------------------------------------------------+
| [neighborlens_v2] (Phase 2 & Phase 3 Controlled Baseline Dataset)                                       |
|   - 242 images / 242 labels (171 Train / 40 Val / 31 Test)                                              |
|   - All 4 classes represented across all splits; 0 cross-split leakage                                  |
|   - Reference Benchmark for Phase 2 (E-0), E-1, and E-2                                                 |
|   - Status: PERMANENTLY FROZEN & IMMUTABLE                                                              |
+---------------------------------------------------------------------------------------------------------+
                                      |
                                      v (Approved Training Remediations Only)
+---------------------------------------------------------------------------------------------------------+
| [neighborlens_v3] (PROPOSED FUTURE EXPERIMENTAL DATASET)                                                |
|   - Images: Exactly identical to v2 (242 images copied without modification)                            |
|   - Split Assignments: Exactly identical to v2 (171 Train / 40 Val / 31 Test)                           |
|   - Validation Split: 100% byte-for-byte identical to v2 (FROZEN EVALUATION GROUND TRUTH)               |
|   - Test Split: 100% byte-for-byte identical to v2 (FROZEN EVALUATION GROUND TRUTH)                     |
|   - Classes 1, 2, 3: 100% byte-for-byte identical to v2 across all splits                               |
|   - Class 0 (Train only): Remediated strictly according to human decisions in ROAD_REVIEW_DECISIONS.json|
+---------------------------------------------------------------------------------------------------------+
```

---

## 3. Human-Review Audit & Candidate Manifest

An audit of the flagged queue in `dataset/annotation_input/road_v1/` establishes the full candidate breakdown:

### Table 3.1: Candidate Distribution Across Splits
| Dataset Split | Total Road Images | Flagged Images | Total Road Bounding Boxes | Flagged Candidate Boxes | Human Decisions Populated |
| :--- | :---: | :---: | :---: | :---: | :---: |
| **Train** | 80 | **59** | 274 | **227** | **0** |
| **Validation (Frozen)** | 17 | 17 | 75 | 64 | 0 (Must remain frozen) |
| **Test (Frozen)** | 12 | 10 | 52 | 43 | 0 (Must remain frozen) |
| **TOTAL** | **109** | **86** | **401** | **334** | **0 / 334 (0.0%)** |

### Table 3.2: Analysis of Flag Reasons in Training Split (227 Candidate Boxes)
* **High Fragmentation ($\ge 4$ boxes per image)**: 168 boxes across 32 training images.
* **Micro-Boxes (Area $< 0.5\%$)**: 89 boxes across training images.
* **Extreme Aspect Ratio ($> 6:1$)**: 28 boxes across training images.

---

## 4. Evaluation Protocol & Immutability Rules

To maintain strict scientific comparability with the Phase 2 Baseline (E-0) and Experiment E-2:
1. **Unmodified Evaluation Ground Truth**:
   - The validation set (`images/val` and `labels/val`) and test set (`images/test` and `labels/test`) in the proposed `neighborlens_v3` will remain **100% byte-for-byte identical to `neighborlens_v2`**.
   - No bounding box in the validation or test split will be merged, deleted, resized, or moved.
2. **Preventing Artificial Score Inflation**:
   - If evaluation annotations were merged to match the model's unified predictions, mAP would artificially increase simply because the target shrank/consolidated.
   - By evaluating against the **unaltered v2 test ground truth**, any performance gain observed in E-3 will reflect **genuine feature learning improvement** rather than evaluation target manipulation.

---

## 5. Controlled Training Configuration for Future E-3 Run

When human decisions are provided and approved, Experiment E-3 will execute under exact Phase 2 baseline controls:
* **Model**: `yolov8m.pt` (COCO pretrained weights)
* **Dataset**: `dataset/neighborlens_v3/data.yaml`
* **Resolution (`imgsz`)**: **800** (Strict match to Phase 2 baseline; E-2's 1024 resolution is excluded)
* **Batch Size**: 16 (autoBatch matching baseline)
* **Epochs**: 80
* **Patience**: 80
* **Seed**: 0 (`deterministic=True`)
* **Optimizer**: AdamW (`lr0=0.01`, `lrf=0.01`)
* **Output Run**: `runs/detect/neighborlens_v8_phase3_e3_road_remediation/`
* **Isolated Variable**: **Training annotation remediation only**.

---

## 6. Workflow to Unblock Experiment E-3

To transition Experiment E-3 from **NO-GO** to **GO**, the human review process outlined in [`dataset/annotation_input/road_v1/HUMAN_REVIEW_INSTRUCTIONS.md`](file:///c:/Users/cleme/Documents/GitHub/Neighborlens-AI/dataset/annotation_input/road_v1/HUMAN_REVIEW_INSTRUCTIONS.md) must be completed:

1. **Reviewer Inspection**:
   - Open preview images in `dataset/annotation_input/road_v1/previews/`.
   - Inspect the 227 candidate boxes belonging to the **Train** split (59 images).
2. **Populate Decisions**:
   - Open `dataset/annotation_input/road_v1/ROAD_REVIEW_DECISIONS.json`.
   - Set `"human_decision"` to one of:
     - `"KEEP"`: Legitimate distinct defect.
     - `"MERGE"`: Continuous damage fragmented into tiles (provide 1-indexed box numbers in `"merge_group"`).
     - `"SEPARATE"`: Neighboring but distinct defects.
     - `"REMOVE"`: Non-damage artifact (shadows, oil stains, pavement aggregate).
3. **Automated Assembly of `neighborlens_v3`**:
   - Once human decisions are recorded and validated, an automated script will read `ROAD_REVIEW_DECISIONS.json`, merge only the approved training boxes into unified bounding rectangles, copy the frozen val/test splits from v2, and generate `dataset/neighborlens_v3/data.yaml`.
4. **Pre-Training Dataset Audit**:
   - Run `audit_yolo_dataset.py --dataset dataset/neighborlens_v3` to ensure zero orphans, zero coordinate violations, and zero cross-split leakage.

---

## 7. STOP GATE CONFIRMATION

In accordance with strict instructions:
- [x] **STOPPED.**
- [x] **`dataset/neighborlens_v3` has NOT been created.**
- [x] **No annotations or dataset files have been modified.**
- [x] **`dataset/neighborlens_v1` and `dataset/neighborlens_v2` remain 100% frozen and untouched.**
- [x] **Baseline runs (`neighborlens_v8_baseline_v2` and `neighborlens_v8_phase3_e2_1024`) remain completely preserved.**
- [x] **No YOLO training has been initiated.**
- [x] **No source application code has been modified.**

Awaiting your review of this pre-remediation analysis and guidance on whether human decisions will be populated now, or if the project should pivot to **Experiment E-4 (Model Capacity Comparison)** while human review is pending.
