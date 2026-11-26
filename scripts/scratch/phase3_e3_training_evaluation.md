# Phase 3B — Experiment E-3: Controlled Training & Evaluation Report

**Date**: September 17, 2026  
**Experiment**: Phase 3B E-3 (Human-Reviewed Road Annotation Remediation)  
**Model Architecture**: YOLOv8m (`yolov8m.pt` pretrained)  
**Target Dataset**: `dataset/neighborlens_v3/data.yaml`  
**Run Directory**: [`runs/detect/neighborlens_v8_phase3_e3_road_remediation/`](file:///c:/Users/cleme/Documents/GitHub/Neighborlens-AI/runs/detect/neighborlens_v8_phase3_e3_road_remediation/)  
**Verdict**: **POSITIVE ON ROAD DAMAGE REMEDIATION TARGET / PERSISTENT WEAK-CLASS MINORITY BOTTLENECK**  

---

## 1. Research Question

* **Research Question**: Does human-reviewed remediation of fragmented micro-boxes and non-damage noise in the `damaged_road` (Class 0) training split improve YOLOv8 detection performance on held-out benchmark evaluation splits, while keeping the evaluation dataset strictly frozen?
* **Panel Recommendation Addressed**: **“Enhance dataset.”**
* **Isolated Experimental Variable**: Human-reviewed Class 0 training annotation remediation (excising 31 non-damage annotations and consolidating 15 fragmented boxes into 5 enclosing defect rectangles).

---

## 2. Frozen Asset Verification

The following integrity constraints were enforced and verified prior to and throughout training:

1. **Historical Baseline Datasets**:
   - `dataset/neighborlens_v1/`: Permanently frozen (SHA-256 verified).
   - `dataset/neighborlens_v2/`: Permanently frozen (SHA-256 verified).
2. **Evaluation Ground Truth (Val & Test Splits)**:
   - `neighborlens_v3/images/val` $\equiv$ `neighborlens_v2/images/val` (100% byte-identical, 0 differences).
   - `neighborlens_v3/labels/val` $\equiv$ `neighborlens_v2/labels/val` (100% byte-identical, 0 differences).
   - `neighborlens_v3/images/test` $\equiv$ `neighborlens_v2/images/test` (100% byte-identical, 0 differences).
   - `neighborlens_v3/labels/test` $\equiv$ `neighborlens_v2/labels/test` (100% byte-identical, 0 differences).
3. **Prior Experimental Runs**:
   - `runs/detect/neighborlens_v8_baseline_v2/`: Untouched control baseline.
   - `runs/detect/neighborlens_v8_phase3_e2_1024/`: Untouched negative result run.

---

## 3. Dataset Summary (`dataset/neighborlens_v3`)

* **Images**: Train: 171, Val: 40, Test: 31 (Total: 242)
* **Labels**: Train: 171, Val: 40, Test: 31 (Total: 242)
* **Objects**: Train: 331, Val: 112, Test: 77 (Total: 520)
* **TRAIN Split Distribution**:
  - Class 0 (`damaged_road`): **233** (reduced from 274 in v2; 31 removed, 10 consolidated)
  - Class 1 (`clogged_drainage`): **50** (100% preserved)
  - Class 2 (`damaged_street_light`): **35** (100% preserved)
  - Class 3 (`damaged_traffic_light`): **13** (100% preserved)
* **Background/Negative Samples**: Exactly 2 training images (`5794565D...` and `AC654FB7...`) have empty label files due to human-approved removal of their sole candidate box. These serve as valid background samples.

---

## 4. Controlled Training Configuration & Environment

All intended training hyperparameters matched the Phase 2 E-0 baseline, with the notable exception of the resolved batch size:

| Parameter | Configuration | Matching E-0 Baseline |
| :--- | :--- | :---: |
| **Model** | `yolov8m.pt` (COCO pre-trained weights) | Yes |
| **Image Resolution (`imgsz`)** | 800 | Yes |
| **Epochs / Patience** | 80 / 80 | Yes |
| **Batch Size (`batch`)** | `-1` (AutoBatch resolved to batch=4; E-0 resolved to batch=16) | **No (AutoBatch discrepancy)** |
| **Seed / Determinism** | `seed=0`, `deterministic=True` | Yes |
| **Optimizer** | `auto` (resolved to SGD with momentum) | Yes |
| **Mixed Precision (`amp`)** | `True` | Yes |
| **Workers** | `0` (multiprocessing stability on Windows) | Yes |
| **Device** | `0` (CUDA GPU: NVIDIA GeForce RTX 3060 12GB) | Yes |

> [!IMPORTANT]
> **AutoBatch Limitation**: Both E-0 and E-3 requested Ultralytics AutoBatch (`batch=-1`), but the resolved batch size differed (E-0: 16; E-3: 4). Therefore, annotation remediation was the intended experimental intervention, but exact batch-size equivalence was not maintained.

* **Hardware & Runtime Environment**:
  - Python: `3.13.7`
  - PyTorch: `2.14.0+cu126`
  - Ultralytics: `8.4.152`
  - GPU VRAM: 12.0 GB
  - Training Duration: **18.20 minutes** (1,092.1 seconds)

---

## 5. Checkpoint & Convergence Analysis

* **Best Checkpoint**: Selected automatically by Ultralytics as `best.pt` based on validation performance.
* **Epoch of Max Validation mAP50**: **Epoch 72** (`val mAP50 = 0.2952`)
* **Epoch of Max Validation mAP50-95**: **Epoch 72** (`val mAP50-95 = 0.1074`)
* **Final Epoch (Epoch 80) Metrics**: `val mAP50 = 0.1846`, `val mAP50-95 = 0.0683`
* *Convergence Note*: Similar to E-0, close-mosaic augmentation disabled during the final 10 epochs caused minor boundary fluctuations, with peak checkpoint weights saved at Epoch 72.

---

## 6. Official Evaluation Results (Validation Split)

Evaluated using `best.pt` on the frozen validation split (`imgsz=800`):

| Class | Precision | Recall | F1-Score | mAP@50 | mAP@50-95 |
| :--- | :---: | :---: | :---: | :---: | :---: |
| **All Classes** | **0.2411** | **0.3947** | **0.2993** | **0.2953** | **0.1075** |
| `damaged_road` | 0.1870 | 0.2133 | 0.1993 | 0.1352 | 0.0393 |
| `clogged_drainage` | 0.2655 | 0.7778 | 0.3958 | 0.5856 | 0.1671 |
| `damaged_street_light` | 0.1020 | 0.1500 | 0.1215 | 0.0288 | 0.0062 |
| `damaged_traffic_light` | 0.4098 | 0.4376 | 0.4232 | 0.4314 | 0.2172 |

---

## 7. Official Evaluation Results (Held-Out Test Split)

Evaluated using `best.pt` on the frozen held-out test split (`imgsz=800`):

| Class | Precision | Recall | F1-Score | mAP@50 | mAP@50-95 |
| :--- | :---: | :---: | :---: | :---: | :---: |
| **All Classes** | **0.2137** | **0.2725** | **0.2396** | **0.2114** | **0.0856** |
| `damaged_road` | 0.3166 | 0.2494 | 0.2790 | 0.1634 | 0.0508 |
| `clogged_drainage` | 0.3819 | 0.6667 | 0.4857 | 0.5868 | 0.2445 |
| `damaged_street_light` | 0.0398 | 0.0309 | 0.0348 | 0.0229 | 0.0035 |
| `damaged_traffic_light` | 0.1167 | 0.1429 | 0.1285 | 0.0725 | 0.0435 |

---

## 8. Controlled Comparison: E-0 Baseline vs. E-3 Remediated

### Overall Held-Out Test Split Comparison

| Metric | E-0 Baseline (v2) | E-3 Remediated (v3) | Absolute Delta | Relative Change |
| :--- | :---: | :---: | :---: | :---: |
| **Test Precision** | 0.2126 | 0.2137 | **+0.0011** | +0.5% |
| **Test Recall** | 0.2751 | 0.2725 | **-0.0026** | -0.9% |
| **Test F1-Score** | 0.2398 | 0.2396 | **-0.0002** | -0.1% |
| **Test mAP@50** | **0.1872** | **0.2114** | **+0.0242** | **+12.9%** |
| **Test mAP@50-95** | **0.0675** | **0.0856** | **+0.0181** | **+26.8%** |

---

### Per-Class Test mAP@50 Comparison

| Class Name | E-0 Test mAP50 | E-3 Test mAP50 | Absolute Delta | Relative Change | Outcome Direction |
| :--- | :---: | :---: | :---: | :---: | :---: |
| **`damaged_road`** | **0.1244** | **0.1634** | **+0.0390** | **+31.3%** | **IMPROVED** |
| **`clogged_drainage`** | 0.5667 | 0.5868 | **+0.0201** | +3.5% | **IMPROVED** |
| **`damaged_street_light`** | 0.0450 | 0.0229 | **-0.0221** | -49.1% | DECLINED |
| **`damaged_traffic_light`** | 0.0125 | 0.0725 | **+0.0600** | **+480.0%** | **IMPROVED** |

*Note on `damaged_traffic_light`*: mAP50 increased from 0.0125 to 0.0725 (+0.0600 / +6.00 percentage points), but the test split contains only 7 traffic-light instances, so this result should be interpreted cautiously.

---

## 9. Road-Specific Detailed Comparison (Isolated Experimental Target)

Because human-reviewed road annotation remediation was the direct experimental intervention, road-specific performance on the frozen held-out test split is the primary test of hypothesis:

| Road Metric (Class 0) | E-0 Baseline (v2) | E-3 Remediated (v3) | Absolute Delta | Relative Gain |
| :--- | :---: | :---: | :---: | :---: |
| **Precision** | 0.2467 | 0.3166 | **+0.0699** | **+28.3%** |
| **Recall** | 0.2115 | 0.2494 | **+0.0379** | **+17.9%** |
| **F1-Score** | 0.2278 | 0.2790 | **+0.0512** | **+22.5%** |
| **mAP@50** | **0.1244** | **0.1634** | **+0.0390** | **+31.3%** |
| **mAP@50-95** | **0.0414** | **0.0508** | **+0.0094** | **+22.7%** |

Every single road detection metric improved on the frozen held-out test set under controlled conditions.

---

## 10. Scientific Interpretation of Results

Following scientific rigor, observed facts are distinguished from interpretations and unproven hypotheses:

### Directly Observed Results
1. **Target Class Improvement**: On the frozen held-out test split, `damaged_road` mAP50 rose from 12.44% to 16.34% (+3.90 percentage points; +31.3% relative improvement). Road precision increased by +7.0 percentage points, and road recall increased by +3.8 percentage points.
2. **Overall Generalization Improvement**: Overall test mAP50 increased from 18.72% to 21.14% (+2.42 percentage points), and test mAP50-95 increased from 6.75% to 8.56% (+1.81 percentage points).
3. **Weak-Class Persistence**: `damaged_street_light` declined on test mAP50 from 4.50% to 2.29%, while `damaged_traffic_light` gained from 1.25% to 7.25%. Both infrastructure classes remain severely resource-limited.

### Interpretations Supported by Data
1. **Remediation Benefit**: The observed improvement is consistent with the hypothesis that reducing annotation noise and consolidating fragmented road-defect annotations improved training supervision for the damaged-road class.
2. **Orthogonality of Road Quality and Minority Classes**: Improving road annotations benefits road detection and overall mAP, but does not solve the underlying extreme class imbalance (35 street lights and 13 traffic lights in train).

### Hypotheses (Unproven Explanations Requiring Independent Testing)
* *Hypothesis 1*: That street light test performance variation between E-0 and E-3 (-2.2% mAP50 on 9 test instances) reflects single-seed stochastic variance on an ultra-low-sample class rather than negative transfer from road cleaning.
* *Hypothesis 2*: That training with 2 background images contributed to the observed 7.0 percentage point increase in road precision by penalizing false-positive activations on clean asphalt.

---

## 11. Threats to Validity & Limitations

1. **Single Deterministic Run**: Due to resource limits, E-3 was conducted using a single fixed seed (`seed=0`). While deterministic, random initialization variance across multiple seeds has not been measured.
2. **Small Support for Minority Classes**: The test split contains only 9 street light and 7 traffic light instances. A single false negative causes large swings in per-class mAP.
3. **Annotation Scope**: Remediation was restricted strictly to TRAIN Class 0 boxes. Validation and test ground truth remained untouched, which protects benchmark comparability but means any label ambiguities in val/test road ground truth were not corrected.
4. **Batch-Size Equivalence**: Both E-0 and E-3 requested Ultralytics AutoBatch (`batch=-1`), but the resolved batch size differed (E-0: 16; E-3: 4). Therefore, annotation remediation was the intended experimental intervention, but exact batch-size equivalence was not maintained.

---

## 12. Experiment E-3 Verdict

### **VERDICT: POSITIVE TARGET-CLASS RESULT / QUALIFIED COMPARISON**

E-3 produced a positive target-class result: damaged-road metrics and overall held-out mAP improved. However, damaged-street-light performance declined, minority-class evaluation remains unstable due to limited support, and the batch-size difference prevents describing the experiment as perfectly single-variable.

* **Direct Evidence**:
  - `damaged_road` mAP50: **+31.3% relative gain** on held-out test (0.1244 to 0.1634).
  - `damaged_road` F1: **+22.5% relative gain** (0.2278 to 0.2790).
  - Overall Test mAP50: **+2.42 percentage points gain** (0.1872 to 0.2114).
  - Overall Test mAP50-95: **+1.81 percentage points gain** (0.0675 to 0.0856).
* The results provide empirical support for the dataset-enhancement work requested by the panel.

---

## 13. Recommendation for Next Phase 3 Experiment

With Experiment E-1 (Confidence Calibration: optimal $conf=0.10$), E-2 (Spatial Scaling: negative result), and E-3 (Road Remediation: positive result) complete, the remaining core technical bottleneck identified in Phase 3A is:

**Extreme Class Imbalance & Minority Infrastructure Degradation (`damaged_street_light`, `damaged_traffic_light`).**

* **Recommended Next Step**: **Experiment E-4 — Class-Imbalance Remediation & Targeted Minority Re-weighting / Re-sampling** using `dataset/neighborlens_v3` as the new superior baseline foundation.

---

## STOP GATE NOTICE

All deliverables for Phase 3B Experiment E-3 are complete:
- `runs/detect/neighborlens_v8_phase3_e3_road_remediation/` fully preserved.
- `scratch/phase3_e3_results_summary.json` generated.
- `scratch/phase3_e3_training_evaluation.md` generated.
- No application code, frontend, backend, or database modified.
- No automated commits or pushes executed.

Awaiting user review and directive before proceeding to Phase 3B Experiment E-4.
