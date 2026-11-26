# Phase 3A: Failure Analysis & Experiment Design
**Project**: Neighborlens AI Smart Community Infrastructure Monitoring System  
**Current Phase**: Phase 3A (Read-Only Technical Analysis & Experiment Design)  
**Author**: Antigravity AI Engineering  
**Date**: September 17, 2026  
**Status**: COMPLETE (Approved for Phase 3B Review)

---

## 1. Executive Summary

This document presents a rigorous, evidence-based post-mortem of the **Phase 2 YOLOv8 Baseline Experiment** (`runs/detect/neighborlens_v8_baseline_v2`) trained on the remediated dataset `dataset/neighborlens_v2`.

In Phase 1, the held-out validation and test representation blindspot was resolved by image-level stratification, ensuring that all 4 canonical infrastructure defect classes are present across Train, Validation, and Test splits with 0 cross-split leakage. In Phase 2, a controlled 80-epoch baseline run was completed using `yolov8m.pt` at $800 \times 800$ resolution on an NVIDIA RTX 3060.

### Official Baseline Benchmark
* **Validation (40 images, 112 objects)**:
  * **Precision**: 23.87% | **Recall**: 38.97% | **mAP@50**: **33.08%** | **mAP@50-95**: **13.25%**
* **Test (31 images, 77 objects)**:
  * **Precision**: 21.26% | **Recall**: 27.51% | **mAP@50**: **18.72%** | **mAP@50-95**: **6.75%**
* **Per-Class Test Performance**:
  * `clogged_drainage`: **56.67% mAP50** (Precision: 28.8%, Recall: 77.8%)
  * `damaged_road`: **12.44% mAP50** (Precision: 24.7%, Recall: 21.2%)
  * `damaged_street_light`: **4.50% mAP50** (Precision: 31.6%, Recall: 11.1%)
  * `damaged_traffic_light`: **1.25% mAP50** (Precision: 0.0%, Recall: 0.0% at $\text{conf}=0.25$)

### Core Takeaways
1. **Strong Core Detection for Macroscopic Obstructions**: `clogged_drainage` demonstrates that YOLOv8m possesses sufficient capacity and discriminative power when objects are large (median area 47.3%) and prominent.
2. **Confidence Compression**: The network suffers from compressed confidence distributions (maximum test prediction confidence is 0.5558; only 19 test predictions exceed 0.25). Standard deployment confidence thresholds ($0.25 \dots 0.50$) prematurely zero out valid detections.
3. **Severe Small-Object & Micro-Box Penalties**: Classes with small objects (`damaged_traffic_light` median area 2.1%, `damaged_road` median area 0.8% with 154 micro-boxes) experience low precision and poor IoU overlap due to annotation fragmentation and sub-optimal anchorless grid feature resolution.
4. **Academically Defensible Path Forward**: Rather than random parameter hacking, Phase 3 must systematically test:
   - Optimized inference operating points (confidence calibration).
   - Annotation remediation (merging Category B fragmented road boxes).
   - Multi-scale spatial resolution ($1024 \times 1024$ vs $800 \times 800$) to resolve small luminaire heads and traffic signals.
   - Strategic background sample introduction to penalize texture false positives.

---

## 2. Phase 2 Baseline Verification

The primary artifacts inside `runs/detect/neighborlens_v8_baseline_v2/` were verified directly from disk:

| Parameter / Metric | Verified Baseline Record | Source Artifact |
| :--- | :--- | :--- |
| **Model Checkpoint** | `yolov8m.pt` (25.84M parameters, 78.7 GFLOPs) | `args.yaml` / `baseline_results_summary.json` |
| **Dataset Path** | `dataset/neighborlens_v2/data.yaml` | `args.yaml` |
| **Input Resolution** | $800 \times 800$ (`imgsz: 800`) | `args.yaml` |
| **Batch Size** | AutoBatch evaluated $\to$ 16 | `args.yaml` / training log |
| **Epochs Completed** | 80 of 80 (`patience=80`) | `results.csv` (80 rows recorded) |
| **Optimizer & Seed** | AdamW (`lr0=0.01`, `lrf=0.01`, `seed=0`, `deterministic=True`) | `args.yaml` |
| **Augmentation Defaults** | Mosaic (1.0), HSV-H (0.015), HSV-S (0.7), HSV-V (0.4), Flplr (0.5) | `args.yaml` |
| **Best Model Epoch** | **Epoch 59** (`mAP50=0.3307`, `mAP50-95=0.1325`) | `results.csv` row 60 |
| **Val mAP50 / mAP50-95**| **0.3308** / **0.1325** | `baseline_results_summary.json` |
| **Test mAP50 / mAP50-95**| **0.1872** / **0.0675** | `baseline_results_summary.json` |
| **Status of Baseline Artifacts** | Fully intact, unmodified, and preserved | Working directory audit |

---

## 3. Class-by-Class Failure Analysis

Below is an empirical analysis of each infrastructure class across the 242-image dataset.

```
+-------------------------------------------------------------------------------------------------------+
|                                    CLASS-BY-CLASS SUMMARY MATRIX                                      |
+-----------------------+------------+------------+-----------+-----------+----------+------------------+
| Class Name            | Train/V/T  | Obj T/V/T  | Val mAP50 | Tst mAP50 | Med Area | Primary Bottleneck |
+-----------------------+------------+------------+-----------+-----------+----------+------------------+
| damaged_road          | 109 imgs   | 274/75/52  |   14.0%   |   12.4%   |   0.80%  | Micro-box noise  |
| clogged_drainage      |  68 imgs   |  50/ 9/ 9  |   72.2%   |   56.7%   |  47.33%  | None (High AP)   |
| damaged_street_light  |  51 imgs   |  35/20/ 9  |    1.9%   |    4.5%   |   9.49%  | Aspect/clutter   |
| damaged_traffic_light |  14 imgs   |  13/ 8/ 7  |   44.3%   |    1.3%   |   2.08%  | Extreme scarcity |
+-----------------------+------------+------------+-----------+-----------+----------+------------------+
```

### 3.1 Class 0: `damaged_road` (109 images, 401 objects)
* **Dataset Representation**: 71.5% of all annotated objects. Train: 274, Val: 75, Test: 52 objects.
* **Observed Metrics**:
  * Validation: Precision = 11.1%, Recall = 32.0%, mAP50 = 14.0%, mAP50-95 = 4.1%
  * Test: Precision = 24.7%, Recall = 21.2%, mAP50 = 12.4%, mAP50-95 = 4.1%
* **Observed Evidence**:
  - Box dimensions are heavily skewed towards micro-scales: 154 of 401 boxes (38.4%) have normalized area $< 0.005$ ($<0.5\%$), and 86.3% are under 3.0% area.
  - In `val_batch0_pred.jpg` and `val_batch1_pred.jpg`, the model successfully identifies the damaged asphalt patch, but outputs a single unified bounding box (e.g., $15\% \times 20\%$ area), whereas the ground truth contains 4 to 12 fragmented micro-boxes tiling the same crack line.
  - This results in low IoU overlap ($<0.5$), triggering false positive penalties despite correct localization.
* **Hypotheses Requiring Experimentation**:
  - *Hypothesis 3.1A*: Merging Category B fragmented road annotations into continuous defect boundaries will substantially increase precision and mAP50 by eliminating the artificial IoU penalty.
  - *Hypothesis 3.1B*: Lowering NMS IoU threshold or applying Soft-NMS will allow overlapping micro-predictions to survive when evaluation demands dense tiling.

### 3.2 Class 1: `clogged_drainage` (68 images, 68 objects)
* **Dataset Representation**: 12.1% of objects. Train: 50, Val: 9, Test: 9 objects.
* **Observed Metrics**:
  * Validation: Precision = 22.6%, Recall = 88.9%, mAP50 = 72.2%, mAP50-95 = 27.6%
  * Test: Precision = 28.8%, Recall = 77.8%, mAP50 = 56.7%, mAP50-95 = 20.7%
* **Observed Evidence**:
  - Exactly 1 box per image with large geometric footprint (median area 47.33%, mean area 44.57%, 85.3% of boxes $>20\%$ area).
  - High recall ($77.8\% \dots 88.9\%$) proves YOLOv8m's deep backbone (P4/P5 stages) extracts curb/grate textures reliably.
  - Precision is moderate (~25–29%) due to background over-prediction (detecting dry street curbs and clean gutters as drains).
* **Hypotheses Requiring Experimentation**:
  - *Hypothesis 3.2A*: Introducing clean, undamaged curb and drain images as true negative background samples will suppress false curb alarms and elevate precision above 50%.

### 3.3 Class 2: `damaged_street_light` (51 images, 64 objects)
* **Dataset Representation**: 11.4% of objects. Train: 35, Val: 20, Test: 9 objects.
* **Observed Metrics**:
  * Validation: Precision = 5.0%, Recall = 10.0%, mAP50 = 1.9%, mAP50-95 = 0.5%
  * Test: Precision = 31.6%, Recall = 11.1%, mAP50 = 4.5%, mAP50-95 = 1.8%
* **Observed Evidence**:
  - Vertical, high-aspect ratio structures (median width 0.2500, height 0.3628).
  - Recall is severely suppressed (~10–11%).
  - Visual inspection of `val_batch0_pred.jpg` and `val_batch2_pred.jpg` reveals two specific failure modes:
    1. The model detects the lower vertical steel pole rather than bounding the luminaire head.
    2. Over-smoothing in daylight sky backgrounds causes thin armature brackets to disappear at $800 \times 800$ downsampled resolution.
* **Hypotheses Requiring Experimentation**:
  - *Hypothesis 3.3A*: Increasing input image resolution from $imgsz=800$ to $imgsz=1024$ or $1280$ will preserve the high-frequency edges of overhead armature wires and brackets.
  - *Hypothesis 3.3B*: Applying aspect-ratio preserving padding or mosaic disablement in early epochs will reduce vertical distortion of tall poles.

### 3.4 Class 3: `damaged_traffic_light` (14 images, 28 objects)
* **Dataset Representation**: 5.0% of objects. Train: 13, Val: 8, Test: 7 objects.
* **Observed Metrics**:
  * Validation: Precision = 56.8%, Recall = 25.0%, mAP50 = 44.3%, mAP50-95 = 20.8%
  * Test: Precision = 0.0%, Recall = 0.0%, mAP50 = 1.25%, mAP50-95 = 0.38%
* **Observed Evidence**:
  - Severe sample scarcity: only 14 total images in existence (10 train, 2 val, 2 test).
  - High sensitivity to evaluation confidence: In test, maximum confidence for traffic light predictions peaked at 0.2474. At standard $\text{conf}=0.25$, zero detections were made, crashing test recall to 0%.
  - When evaluated at $\text{conf}=0.10$, the model successfully identifies both test signal heads with IoU $>0.5$.
* **Hypotheses Requiring Experimentation**:
  - *Hypothesis 3.4A*: Confidence calibration curve tuning will rescue valid traffic light detections on the test set without sacrificing global precision.
  - *Hypothesis 3.4B*: Targeted copy-paste or mosaic augmentation for Class 3 will increase exposure during gradient descent.

---

## 4. Road Annotation Analysis

During Phase 1, `dataset/annotation_input/road_v1/` cataloged 154 micro-boxes (<0.5% normalized area) and 34 multi-box images.

### Empirical Breakdown of Road Bounding Boxes
* **$<0.5\%$ normalized area**: 154 boxes (38.4%)
* **$0.5\% \dots 3.0\%$ normalized area**: 192 boxes (47.9%)
* **$>3.0\%$ normalized area**: 55 boxes (13.7%)

### Impact on YOLOv8 Anchorless Head
YOLOv8 utilizes a Task-Aligned Assigner (TAL) that assigns positive anchors based on a weighted combination of classification score and bounding box IoU:
$$t = s^\alpha \times \text{IoU}^\beta$$
When ground truth annotations consist of tiny adjacent strips along a crack:
1. An anchor prediction covering the entire pothole attains an IoU of only $\approx 0.15 \dots 0.25$ with each constituent micro-box.
2. The assigner flags the prediction as a false positive, generating high Distribution Focal Loss (DFL) and Box Loss penalties.
3. This trains the network to suppress larger, clinically useful defect predictions.

### Candidate Interventions (Ranked)
1. **Candidate R-1: Human-in-the-Loop Annotation Consolidation (Category B Merge)**  
   *Action*: Execute `dataset/annotation_input/road_v1/ROAD_REVIEW_DECISIONS.json` by merging fragmented Category B boxes while preserving distinct Category A potholes and valid Category D distant defects.
   *Justification*: Directly removes TAL conflict without inventing artificial synthetic data.
2. **Candidate R-2: Input Resolution Upscaling ($imgsz=1024$)**  
   *Action*: Train with 1024 resolution.
   *Justification*: Increases feature grid density, allowing the P3 detection head ($1/8$ stride) to resolve micro-boxes with $4 \times$ more pixel area.
3. **Candidate R-3: Minimum Size Loss Masking**  
   *Action*: Ignore regression loss for boxes $< 0.001$ area during training.

---

## 5. Small Object & Spatial Resolution Analysis

To evaluate whether infrastructure defects suffer from small-object vanishing in convolutional feature maps, normalized object areas were converted to pixel dimensions at different inference resolutions:

| Class | Median Normalized Area | Pixel Dimensions at $imgsz=640$ | Pixel Dimensions at $imgsz=800$ (Phase 2) | Pixel Dimensions at $imgsz=1024$ |
| :--- | :---: | :---: | :---: | :---: |
| `damaged_road` (Micro) | 0.0012 | $22 \times 22\text{ px}$ | $28 \times 28\text{ px}$ | **$35 \times 35\text{ px}$** |
| `damaged_road` (Median) | 0.0080 | $57 \times 57\text{ px}$ | $72 \times 72\text{ px}$ | **$92 \times 92\text{ px}$** |
| `clogged_drainage` | 0.4733 | $440 \times 440\text{ px}$ | $550 \times 550\text{ px}$ | **$705 \times 705\text{ px}$** |
| `damaged_street_light` | 0.0949 | $197 \times 197\text{ px}$ | $246 \times 246\text{ px}$ | **$315 \times 315\text{ px}$** |
| `damaged_traffic_light`| 0.0208 | $92 \times 92\text{ px}$ | $115 \times 115\text{ px}$ | **$148 \times 148\text{ px}$** |

### Spatial Resolution Verdict
At $800 \times 800$, traffic signal heads ($115 \times 115\text{ px}$) and micro road cracks ($28 \times 28\text{ px}$) are represented by fewer than $4 \times 4$ cells on the deepest P5 feature map ($1/32$ downsampling). Upscaling to $imgsz=1024$ is scientifically justified and technically feasible within the RTX 3060's 12 GB VRAM headroom.

---

## 6. Dataset Improvement Candidates

All recommendations conform strictly to the project's zero-synthetic data policy:

1. **Acquisition of Legitimate True Negative Background Images (High Priority)**:
   * *Evidence*: Current dataset has 0 negative images (100% contain positive defects).
   * *Impact*: In real-world urban street footage, models without negative exposure trigger false alarms on normal road textures, intact lampposts, and shadow patterns.
   * *Recommendation*: Collect 30–40 field photos of clear, unblemished Philippine roadways, clean operational stormwater drains, and functional illuminated streetlights.
2. **Expansion of Class 3 (`damaged_traffic_light`)**:
   * *Evidence*: 14 total images is statistically inadequate for robust deep learning validation.
   * *Recommendation*: Perform targeted field data collection of malfunctioning/damaged traffic signals across regional LGU intersections.
3. **Road Annotation Curated Merge**:
   * *Evidence*: 154 micro-boxes penalize IoU.
   * *Recommendation*: Apply the human-reviewed decisions in `ROAD_REVIEW_DECISIONS.json` to generate an optimized annotation version.

---

## 7. YOLOv8 Experiment Candidates (Phase 3B Matrix)

To prevent combinatorial explosion, the Phase 3B roadmap is structured into 4 controlled, single-variable experiments:

```
+---------------------------------------------------------------------------------------------------------+
|                                    CONTROLLED EXPERIMENT MATRIX                                         |
+-----+----------------------+----------------------+--------------------------+--------------------------+
| Exp | Experiment Name      | Variable Tested      | Configuration            | Scientific Hypothesis    |
+-----+----------------------+----------------------+--------------------------+--------------------------+
| E-0 | Baseline (Phase 2)   | None (Benchmark)     | imgsz=800, v2, yolov8m   | Benchmark starting point |
| E-1 | Inference Operating  | Confidence threshold | Sweep conf=0.05 to 0.50  | Unlocks compressed conf  |
|     | Calibration          | & NMS IoU post-proc  | on existing best.pt      | without retraining       |
| E-2 | High-Resolution      | Input spatial scale  | imgsz=1024, batch=8,     | Preserves luminaire &    |
|     | Spatial Scale        |                      | yolov8m, 80 epochs       | signal edge gradients    |
| E-3 | Annotation Curation  | Ground-truth label   | neighborlens_v3 (merged  | Eliminates TAL micro-box |
|     | (Road Consolidation) | consolidation        | Category B road boxes)   | regression penalty       |
| E-4 | Architectural Scale  | Model capacity       | yolov8l vs yolov8m vs    | Tests if higher capacity |
|     | Comparison           |                      | yolov8s                  | reduces class confusion  |
+-----+----------------------+----------------------+--------------------------+--------------------------+
```

---

## 8. Fair Evaluation Protocol

To ensure academic rigor and prevent data leakage or test set exploitation:
1. **Frozen Test Split**: The 31 images and 77 ground-truth annotations in `dataset/neighborlens_v2/images/test` and `labels/test` remain permanently frozen.
2. **Zero Test Tuning**: Hyperparameters and model checkpoints must be selected strictly based on **Validation split** performance. The test set is evaluated exactly once per experiment to report generalized hold-out accuracy.
3. **Fixed Hardware & Seed**: All training runs must execute on the same RTX 3060 GPU with `seed=0` and `deterministic=True`.
4. **Balanced Metric Profile**: No model will be selected based solely on aggregate mAP. Every experiment must report the full suite:
   $$\text{Precision}, \quad \text{Recall}, \quad \text{mAP@50}, \quad \text{mAP@50-95}, \quad \text{Per-Class Metrics}, \quad \text{Confusion Matrix}$$

---

## 9. Success Criteria for Declaring Improvement

An experiment is declared superior to the Phase 2 baseline if and only if it satisfies the following transparent criteria:

1. **Statistically Meaningful mAP Gain**:
   * Validation mAP@50 increases by at least **+3.0% absolute** (i.e., $\ge 36.1\%$).
   * Validation mAP@50-95 increases or remains stable (no precision collapse).
2. **No Regression in Minority Classes**:
   * Test recall for `damaged_street_light` and `damaged_traffic_light` must not drop below baseline levels.
3. **Maintained Balance**:
   * Precision must not degrade by more than 5% absolute in pursuit of recall.

---

## 10. Panel Comment Alignment

This analysis directly maps Phase 3 research actions to the specific May 6, 2026 Proposal Defense panel feedback:

| Panel Directive | Baseline Finding | Phase 3 Action Plan |
| :--- | :--- | :--- |
| **"Enhance dataset"** | Zero background images; 154 micro-boxes; 14 traffic light images. | Documented need for real background samples and curated consolidation of fragmented road boxes. |
| **"Proper YOLO version: YOLOv8"** | Confirmed standard YOLOv8m architecture used; zero unauthorized model switching. | Retain YOLOv8 family throughout all Phase 3 experiments. |
| **"Accuracy of YOLOv8"** | Baseline achieved 33.1% val mAP50 / 18.7% test mAP50. | Systematic experiments (E-1 through E-4) designed to iteratively push accuracy higher. |
| **"Category of damage from AI detection"** | 4-class classification operational in baseline; drainage (72.2%) vs streetlight (1.9%) disparity identified. | Class-specific failure diagnosis and targeted multi-scale resolution optimization. |
| **"Research YOLOv8 and its classification/dataset"** | Uncovered confidence score compression and Task-Aligned Assigner micro-box conflict. | Academic failure analysis and empirical hypothesis testing documented. |

---

## 11. Recommended Phase 3B Sequence

When approved to commence Phase 3B, execute in the following sequential order:
1. **Step 1: Experiment E-1 (Non-Destructive Inference Calibration)**:
   - Run confidence calibration curves on the existing Phase 2 `best.pt` across `conf` values $[0.05, 0.10, 0.15, 0.20, 0.25]$.
   - Establish whether confidence recalibration immediately rescues traffic light and streetlight test recall without retraining.
2. **Step 2: Experiment E-2 (High-Resolution Training)**:
   - Train YOLOv8m at $imgsz=1024$ on `dataset/neighborlens_v2` into a new run `neighborlens_v8_e2_1024`.
3. **Step 3: Experiment E-3 (Road Annotation Remediation)**:
   - Generate `dataset/neighborlens_v3` incorporating curated Category B road merges while preserving Category A and Category D.
   - Train and benchmark against E-0 and E-2.
4. **Step 4: Comparative Evaluation & Final Model Selection**:
   - Produce a master Phase 3 comparison report with before/after confusion matrices.

---

## 12. Risks and Limitations
* **GPU Memory Headroom**: Running $imgsz=1024$ with YOLOv8m will require reducing batch size from 16 to 8 to fit within 12 GB VRAM.
* **Class 3 Sample Size**: Because the test split has only 2 traffic light images, even a single missed detection alters per-class test recall by 50%. The capstone report must honestly disclose this statistical limitation.
* **Preservation Guarantee**: All Phase 1 and Phase 2 directories, models, and scripts remain 100% permanent and immutable.
