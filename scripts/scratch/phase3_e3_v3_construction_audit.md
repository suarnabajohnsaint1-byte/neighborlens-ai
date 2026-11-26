# Phase 3B — Experiment E-3: Dataset v3 Construction & Integrity Audit Gate Report

**Date**: September 17, 2026  
**Status**: PASSED & AUDITED — READY FOR EXPERIMENT E-3 TRAINING GATE  
**Lineage**: `neighborlens_v1` (Frozen) $\to$ `neighborlens_v2` (Frozen Baseline) $\to$ `neighborlens_v3` (Remediated E-3 Dataset)  
**Safety Status**: Zero modifications to v1 or v2; Frozen evaluation benchmarks (val/test) 100% byte-identical; YOLO training not yet started  

---

## 1. E-3 Research Question & Objective

* **Research Question**: Does human-guided remediation of fragmented, noisy, and micro-box `damaged_road` (Class 0) annotations in the training set improve YOLOv8 detection accuracy (specifically mAP50 and recall on road defects), without inducing unintended collateral degradation on held-out evaluation splits or non-road classes?
* **Objective**: Construct `dataset/neighborlens_v3/` by applying only explicit human-reviewed decisions (`KEEP`, `SEPARATE`, `REMOVE`, `MERGE`) from [`dataset/annotation_input/road_v1/ROAD_REVIEW_DECISIONS.json`](file:///c:/Users/cleme/Documents/GitHub/Neighborlens-AI/dataset/annotation_input/road_v1/ROAD_REVIEW_DECISIONS.json) strictly to the `train` split of `neighborlens_v2`. Validation and test splits remain completely frozen.

---

## 2. Dataset Lineage & Governance

| Dataset | Role | Governance Rule | Integrity Check |
| :--- | :--- | :--- | :--- |
| **`neighborlens_v1`** | Original historical dataset | Permanently frozen. Read-only. | SHA-256 verified |
| **`neighborlens_v2`** | Phase 2 baseline benchmark dataset | Permanently frozen benchmark. Source for v3. | SHA-256 verified |
| **`neighborlens_v3`** | Phase 3B E-3 experimental dataset | Remediated strictly via human decision ledger. | Audited & Verified |

---

## 3. Final Human-Review Counts & Verification

The authoritative review ledger was audited directly using [`tools/road_annotation_review/validate_decisions.py`](file:///c:/Users/cleme/Documents/GitHub/Neighborlens-AI/tools/road_annotation_review/validate_decisions.py):

* **TRAIN Candidate Images**: 59
* **Reviewed TRAIN Images**: 59 (100%)
* **Remaining TRAIN Images**: 0
* **Total Candidate Boxes in TRAIN**: 227
* **Resolved Boxes**: 227 (100%)
* **Unresolved Boxes**: 0
* **Decision Breakdown**:
  - `KEEP`: **180 boxes**
  - `MERGE`: **15 boxes** (forming **5 distinct merge groups**)
  - `SEPARATE`: **1 box**
  - `REMOVE`: **31 boxes**
* **Conflicts**: 0
* **Invalid Records**: 0
* **Val/Test Tampering**: 0 (all 107 val/test candidate boxes remain unpopulated and frozen)
* **Readiness Status**: **`READY`**

---

## 4. Explanation of the REMOVE-Count Reconciliation

During review workflow operations, an intermediate console state showed `REMOVE: 32`, while the final authoritative ledger contains `REMOVE: 31`. A forensic timestamp and record audit revealed the exact sequence:

1. **Intermediate Reviewer Action**: During interactive visual review, Candidate #189 (Box #2 on image `C272BBCC-2FC9-40AB-93E1-046CF1BEC8F2`, a transverse crack with area 0.86% and aspect ratio 7.0:1) was initially marked as `REMOVE`. At that point, the count was `REMOVE: 32, KEEP: 174, Unresolved: 5`.
2. **Reviewer Re-Evaluation**: At timestamp `2026-09-16T21:47:20Z`, the human reviewer re-inspected `C272BBCC...` in the visual review tool, judged the transverse crack to be valid physical damage, and changed Box #2 from `REMOVE` to `KEEP`. This moved the counts to `KEEP: 175, REMOVE: 31, Unresolved: 5`.
3. **Review Completion Gate**: The final 5 unresolved candidate boxes (#58, #81, #100, #105, #174) were explicitly designated as `KEEP` per the human reviewer's instructions. This added +5 to `KEEP` (bringing `KEEP` to $175 + 5 = 180$), leaving `REMOVE` at exactly **31**.
4. **Mathematical Closure**: $180 \text{ (KEEP)} + 31 \text{ (REMOVE)} + 15 \text{ (MERGE)} + 1 \text{ (SEPARATE)} = 227 \text{ total candidate boxes}$. Zero unresolved. The authoritative count of **31 REMOVE** records is verified correct.

---

## 5. Exact REMOVE Operations (31 Boxes)

The following 31 Class 0 candidate boxes were human-approved as non-damage noise (tree shadows, tire skid marks, pavement aggregate grain) and excised from `neighborlens_v3`:

| # | Image Filename | Candidate ID | Box ID | Original Normalized YOLO Coordinates `[cx, cy, w, h]` | Flag Reason |
| :---: | :--- | :---: | :---: | :--- | :--- |
| 1 | `3CC54BC6-2116-433F-B0E8-BE98F0D27A8D...` | 70 | 4 | `[0.366406, 0.378125, 0.055469, 0.014063]` | Extreme aspect ratio (3.9:1) |
| 2 | `401E061B-790D-4684-965F-8156B1544F79...` | 73 | 2 | `[0.415625, 0.407813, 0.081250, 0.021094]` | Extreme aspect ratio (3.9:1) |
| 3 | `401E061B-790D-4684-965F-8156B1544F79...` | 74 | 3 | `[0.549219, 0.406250, 0.075781, 0.011719]` | Extreme aspect ratio (6.5:1) |
| 4 | `401E061B-790D-4684-965F-8156B1544F79...` | 75 | 4 | `[0.531250, 0.352344, 0.035938, 0.006250]` | Micro-box (0.022%), aspect 5.7:1 |
| 5 | `465F8729-1DF1-48A8-9099-8FFA25B95556...` | 82 | 2 | `[0.456250, 0.547656, 0.314063, 0.043750]` | Extreme aspect ratio (7.2:1) |
| 6 | `48BD1C88-09BB-45ED-9D6C-CE80479831AE...` | 83 | 1 | `[0.628906, 0.881250, 0.363281, 0.120313]` | Fragmented box |
| 7 | `48BD1C88-09BB-45ED-9D6C-CE80479831AE...` | 85 | 3 | `[0.582031, 0.378125, 0.073438, 0.016406]` | Micro-box (0.120%), aspect 4.5:1 |
| 8 | `5794565D-0383-4BAE-A72F-8F76CE539CF1...` | 87 | 1 | `[0.224219, 0.427344, 0.047656, 0.018750]` | Micro-box (0.089%) |
| 9 | `64B49336-BF5C-4F60-950C-7B5B5B517942...` | 94 | 2 | `[0.235938, 0.571094, 0.139844, 0.027344]` | Extreme aspect ratio (5.1:1) |
| 10 | `6659FFBA-5ED6-4A4E-8857-F0C7A4FBE991...` | 99 | 5 | `[0.523438, 0.846875, 0.106250, 0.134375]` | Fragmented box |
| 11 | `6A3286AD-5445-4C07-8BD5-C587BE9D3FEE...` | 112 | 6 | `[0.746094, 0.454688, 0.102344, 0.030469]` | Micro-box (0.312%), aspect 3.4:1 |
| 12 | `7CD819F4-B96A-4EF7-BC03-2D6912599DBC...` | 114 | 2 | `[0.265625, 0.441406, 0.097656, 0.021875]` | Micro-box (0.214%), aspect 4.5:1 |
| 13 | `7F3557AC-17BC-451A-9ED9-BBB0AADACBA7...` | 123 | 9 | `[0.492969, 0.361719, 0.052344, 0.007812]` | Micro-box (0.041%), aspect 6.7:1 |
| 14 | `8456A382-EAAD-4393-9C8E-6FE39F4246AB...` | 130 | 4 | `[0.525781, 0.644531, 0.263281, 0.080469]` | Fragmented box |
| 15 | `8456A382-EAAD-4393-9C8E-6FE39F4246AB...` | 133 | 7 | `[0.907031, 0.560938, 0.185938, 0.075000]` | Fragmented box |
| 16 | `8456A382-EAAD-4393-9C8E-6FE39F4246AB...` | 134 | 8 | `[0.898438, 0.475781, 0.088281, 0.028125]` | Micro-box (0.248%), aspect 3.1:1 |
| 17 | `8A97D971-2268-4DAE-9A2D-B12FDDC1DF01...` | 140 | 3 | `[0.668750, 0.478125, 0.120313, 0.079688]` | Fragmented box |
| 18 | `8A97D971-2268-4DAE-9A2D-B12FDDC1DF01...` | 141 | 4 | `[0.320313, 0.517969, 0.442188, 0.045313]` | Extreme aspect ratio (9.8:1) |
| 19 | `8A97D971-2268-4DAE-9A2D-B12FDDC1DF01...` | 143 | 6 | `[0.522656, 0.420313, 0.055469, 0.021094]` | Micro-box (0.117%), aspect 2.6:1 |
| 20 | `A547EF8F-28B1-4157-AF4B-0D42FEA27369...` | 149 | 4 | `[0.721875, 0.567188, 0.242188, 0.054688]` | Extreme aspect ratio (4.4:1) |
| 21 | `AB7DCAB2-700B-4369-9DFD-D61523207127...` | 152 | 2 | `[0.277344, 0.528906, 0.096094, 0.037500]` | Micro-box (0.360%), aspect 2.6:1 |
| 22 | `AC654FB7-1B94-4BB0-B2E8-E6196C269BF4...` | 154 | 1 | `[0.879687, 0.577344, 0.103125, 0.039062]` | Micro-box (0.403%), aspect 2.6:1 |
| 23 | `B16BC0DE-9E57-4849-B63E-D0A2F5859EE1...` | 164 | 2 | `[0.128906, 0.553906, 0.204688, 0.087500]` | Fragmented box |
| 24 | `B16BC0DE-9E57-4849-B63E-D0A2F5859EE1...` | 165 | 3 | `[0.214063, 0.430469, 0.098438, 0.032813]` | Micro-box (0.323%), aspect 3.0:1 |
| 25 | `B16BC0DE-9E57-4849-B63E-D0A2F5859EE1...` | 166 | 4 | `[0.801563, 0.530469, 0.225781, 0.046094]` | Extreme aspect ratio (4.9:1) |
| 26 | `B16BC0DE-9E57-4849-B63E-D0A2F5859EE1...` | 167 | 5 | `[0.514844, 0.409375, 0.085156, 0.032813]` | Micro-box (0.279%), aspect 2.6:1 |
| 27 | `C1E73495-58BE-4807-8A6A-C27907032EF3...` | 178 | 1 | `[0.612500, 0.469531, 0.114844, 0.035938]` | Micro-box (0.413%), aspect 3.2:1 |
| 28 | `C65421EA-C646-4EBE-AE1D-BE12B7F8881C...` | 199 | 2 | `[0.931250, 0.871875, 0.136719, 0.256250]` | Fragmented box |
| 29 | `E64F6653-CC5F-4772-AD6B-0AF2BBEB7D0C...` | 227 | 4 | `[0.434375, 0.363281, 0.093750, 0.023438]` | Micro-box (0.220%), aspect 4.0:1 |
| 30 | `EC42DA58-F90A-441C-9BE1-33F0F3952A39...` | 245 | 2 | `[0.325000, 0.828906, 0.305469, 0.115625]` | Fragmented box |
| 31 | `FD6FDA95-91DB-4B61-9767-EFCE7B0204EE...` | 263 | 2 | `[0.368750, 0.417188, 0.121875, 0.026563]` | Extreme aspect ratio (4.6:1) |

---

## 6. Exact MERGE Operations (5 Groups)

For each approved merge group, the resulting consolidated box was constructed using the minimum enclosing axis-aligned rectangle:
$$x_{\min} = \min(x_{\min}^i), \quad y_{\min} = \min(y_{\min}^i), \quad x_{\max} = \max(x_{\max}^i), \quad y_{\max} = \max(y_{\max}^i)$$

### Group 1
- **Image**: `66DE2B0C-10E5-4315-ADB8-61018D3372EF_1_105_c_jpeg.rf.153fe7b8ca3749c1387ac2ed50db6cb9.jpg`
- **Member Box IDs**: `[1, 6]` (Candidates #101, #106)
- **Original Boxes**:
  - Box #1: `[0.799219, 0.825781, 0.257812, 0.191406]` $\to$ XYXY: `[0.670313, 0.730078, 0.928125, 0.921484]`
  - Box #6: `[0.697656, 0.676562, 0.073438, 0.107813]` $\to$ XYXY: `[0.660937, 0.622656, 0.734375, 0.730468]`
- **Consolidated Enclosing Box**:
  - XYXY: `[0.660937, 0.622656, 0.928125, 0.921484]`
  - **Resulting YOLO**: `0 0.794531 0.772070 0.267188 0.298828`

### Group 2
- **Image**: `6A3286AD-5445-4C07-8BD5-C587BE9D3FEE_1_105_c_jpeg.rf.2684547c830db9e0276426457677d06e.jpg`
- **Member Box IDs**: `[4, 5]` (Candidates #110, #111)
- **Original Boxes**:
  - Box #4: `[0.272656, 0.670312, 0.499219, 0.042188]` $\to$ XYXY: `[0.023046, 0.649218, 0.522266, 0.691406]`
  - Box #5: `[0.515625, 0.842969, 0.044531, 0.314063]` $\to$ XYXY: `[0.493360, 0.685937, 0.537891, 1.000000]`
- **Consolidated Enclosing Box**:
  - XYXY: `[0.023046, 0.649218, 0.537891, 1.000000]`
  - **Resulting YOLO**: `0 0.280469 0.824609 0.514844 0.350782`

### Group 3
- **Image**: `7F3557AC-17BC-451A-9ED9-BBB0AADACBA7_1_105_c_jpeg.rf.be302e366e4904a85e8001ab8c275197.jpg`
- **Member Box IDs**: `[1, 2, 3, 4, 5, 6, 7]` (Candidates #115, #116, #117, #118, #119, #120, #121)
- **Original Boxes**:
  - Box #1: `[0.075781, 0.894531, 0.119531, 0.210938]` $\to$ XYXY: `[0.016016, 0.789062, 0.135547, 1.000000]`
  - Box #2: `[0.238281, 0.667188, 0.118750, 0.157031]` $\to$ XYXY: `[0.178906, 0.588673, 0.297656, 0.745703]`
  - Box #3: `[0.147656, 0.773438, 0.074219, 0.091406]` $\to$ XYXY: `[0.110547, 0.727735, 0.184765, 0.819141]`
  - Box #4: `[0.502344, 0.600000, 0.477344, 0.045312]` $\to$ XYXY: `[0.263672, 0.577344, 0.741016, 0.622656]`
  - Box #5: `[0.761719, 0.732812, 0.110937, 0.141406]` $\to$ XYXY: `[0.706251, 0.662109, 0.817188, 0.803515]`
  - Box #6: `[0.864062, 0.850000, 0.091406, 0.140625]` $\to$ XYXY: `[0.818359, 0.779687, 0.909765, 0.920312]`
  - Box #7: `[0.935937, 0.944531, 0.107031, 0.110156]` $\to$ XYXY: `[0.882421, 0.889453, 0.989453, 0.999609]`
- **Consolidated Enclosing Box**:
  - XYXY: `[0.016016, 0.577344, 0.989453, 1.000000]`
  - **Resulting YOLO**: `0 0.502734 0.788672 0.973437 0.422656`

### Group 4
- **Image**: `D6B7A5A3-5EDB-4264-9B74-1744E5DCA10C_1_105_c_jpeg.rf.a5ae4ec38859315b058582ac92e7dc43.jpg`
- **Member Box IDs**: `[1, 2]` (Candidates #219, #220)
- **Original Boxes**:
  - Box #1: `[0.181250, 0.841406, 0.109375, 0.228125]` $\to$ XYXY: `[0.126562, 0.727344, 0.235937, 0.955468]`
  - Box #2: `[0.337500, 0.817187, 0.280469, 0.103125]` $\to$ XYXY: `[0.197266, 0.765625, 0.477735, 0.868749]`
- **Consolidated Enclosing Box**:
  - XYXY: `[0.126562, 0.727344, 0.477735, 0.955468]`
  - **Resulting YOLO**: `0 0.302149 0.841406 0.351172 0.228125`

### Group 5
- **Image**: `E64F6653-CC5F-4772-AD6B-0AF2BBEB7D0C_1_105_c_jpeg.rf.f682edace65c17f674d3d70a26289148.jpg`
- **Member Box IDs**: `[2, 3]` (Candidates #225, #226)
- **Original Boxes**:
  - Box #2: `[0.322656, 0.557813, 0.172656, 0.053125]` $\to$ XYXY: `[0.236328, 0.531250, 0.408984, 0.584376]`
  - Box #3: `[0.459375, 0.551562, 0.104688, 0.040625]` $\to$ XYXY: `[0.407031, 0.531250, 0.511719, 0.571874]`
- **Consolidated Enclosing Box**:
  - XYXY: `[0.236328, 0.531250, 0.511719, 0.584376]`
  - **Resulting YOLO**: `0 0.374024 0.557813 0.275391 0.053126`

---

## 7. Box-ID Mapping Verification

Every candidate box in the decision ledger was verified against `dataset/neighborlens_v2/labels/train/`:

- **Total TRAIN candidate boxes checked**: 227
- **Exact coordinate matches**: 1
- **Sub-millimeter rounding matches** ($\Delta < 0.00005$ due to 4-decimal rounding in JSON): 226
- **Unmatched / Ambiguous records**: **0**
- **Uniqueness**: Every candidate box matched a distinct, unique line in the corresponding label file. Zero collisions or duplicate bindings.

---

## 8. Before & After Object Counts (v2 vs v3)

### TRAIN Split Object Comparison

| Class ID | Class Name | v2 TRAIN Count | Removals | Consolidations | v3 TRAIN Count | Net Change |
| :---: | :--- | :---: | :---: | :---: | :---: | :---: |
| **0** | `damaged_road` | **274** | **-31** | **-10** | **233** | **-41** |
| **1** | `clogged_drainage` | **50** | 0 | 0 | **50** | **0** |
| **2** | `damaged_street_light` | **35** | 0 | 0 | **35** | **0** |
| **3** | `damaged_traffic_light` | **13** | 0 | 0 | **13** | **0** |
| **TOTAL** | *All Classes* | **372** | **-31** | **-10** | **331** | **-41** |

### Arithmetic Breakdown:
$$\text{v3 Class 0} = \text{v2 Class 0} - \text{Removed} - (\text{Merged Consumed} - \text{Merged Produced})$$
$$233 = 274 - 31 - (15 - 5) = 274 - 31 - 10 = 233 \quad \checkmark$$

### Evaluation Splits (Permanently Frozen)

| Split | Class 0 | Class 1 | Class 2 | Class 3 | Total Objects | Change vs v2 |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: |
| **Validation** | 75 | 9 | 20 | 8 | **112** | **0 (Byte-Identical)** |
| **Test** | 52 | 9 | 9 | 7 | **77** | **0 (Byte-Identical)** |

---

## 9. Changed TRAIN Label Files (23 Files)

The remediation altered exactly 23 label files in `dataset/neighborlens_v3/labels/train/`:

1. `3CC54BC6-2116-433F-B0E8-BE98F0D27A8D_1_105_c_jpeg.rf.c38e56e079cc01891eecab48aa957312.txt` (REMOVE: 1 box)
2. `401E061B-790D-4684-965F-8156B1544F79_1_105_c_jpeg.rf.260b82d1176d0e13995b967253746611.txt` (REMOVE: 3 boxes)
3. `465F8729-1DF1-48A8-9099-8FFA25B95556_1_105_c_jpeg.rf.a7db4d3963173fe543c0ea886caed1bf.txt` (REMOVE: 1 box)
4. `48BD1C88-09BB-45ED-9D6C-CE80479831AE_1_105_c_jpeg.rf.78db464e3bdab856703ff9eab94f1c76.txt` (REMOVE: 2 boxes)
5. `5794565D-0383-4BAE-A72F-8F76CE539CF1_1_105_c_jpeg.rf.a159fac4c5eea5a2f7487dc88c339917.txt` (REMOVE: 1 box $\to$ becomes empty background image)
6. `64B49336-BF5C-4F60-950C-7B5B5B517942_1_105_c_jpeg.rf.c16d673a07e4640d26a61fd7d7ca2d05.txt` (REMOVE: 1 box)
7. `6659FFBA-5ED6-4A4E-8857-F0C7A4FBE991_1_105_c_jpeg.rf.f48cb2a2de8d7364d0d66f8a36458d29.txt` (REMOVE: 1 box)
8. `66DE2B0C-10E5-4315-ADB8-61018D3372EF_1_105_c_jpeg.rf.153fe7b8ca3749c1387ac2ed50db6cb9.txt` (MERGE: 2 boxes $\to$ 1)
9. `6A3286AD-5445-4C07-8BD5-C587BE9D3FEE_1_105_c_jpeg.rf.2684547c830db9e0276426457677d06e.txt` (REMOVE: 1 box, MERGE: 2 boxes $\to$ 1)
10. `7CD819F4-B96A-4EF7-BC03-2D6912599DBC_1_105_c_jpeg.rf.6704fcea621584f6ca963b3850d807d6.txt` (REMOVE: 1 box)
11. `7F3557AC-17BC-451A-9ED9-BBB0AADACBA7_1_105_c_jpeg.rf.be302e366e4904a85e8001ab8c275197.txt` (REMOVE: 1 box, MERGE: 7 boxes $\to$ 1)
12. `8456A382-EAAD-4393-9C8E-6FE39F4246AB_1_105_c_jpeg.rf.da67f0463cd1030705ae7483e2b2fd3d.txt` (REMOVE: 3 boxes)
13. `8A97D971-2268-4DAE-9A2D-B12FDDC1DF01_1_105_c_jpeg.rf.298f1e385106ea0c402f9a969395b8c3.txt` (REMOVE: 3 boxes)
14. `A547EF8F-28B1-4157-AF4B-0D42FEA27369_1_105_c_jpeg.rf.9c6ae5978b518dd1473e7e6500eac350.txt` (REMOVE: 1 box)
15. `AB7DCAB2-700B-4369-9DFD-D61523207127_1_105_c_jpeg.rf.59e25df0bf2953a605380a017195ef9d.txt` (REMOVE: 1 box)
16. `AC654FB7-1B94-4BB0-B2E8-E6196C269BF4_1_105_c_jpeg.rf.2c4944d495b051a3f01f2b0cce417a67.txt` (REMOVE: 1 box $\to$ becomes empty background image)
17. `B16BC0DE-9E57-4849-B63E-D0A2F5859EE1_1_105_c_jpeg.rf.ae41988a8f43d0133556c14f4aa7835a.txt` (REMOVE: 4 boxes)
18. `C1E73495-58BE-4807-8A6A-C27907032EF3_1_105_c_jpeg.rf.9f3d6d4a2403f543ad1a1963b99d6f98.txt` (REMOVE: 1 box)
19. `C65421EA-C646-4EBE-AE1D-BE12B7F8881C_1_105_c_jpeg.rf.4b7121cdadcedf6549b881ca64c6b878.txt` (REMOVE: 1 box)
20. `D6B7A5A3-5EDB-4264-9B74-1744E5DCA10C_1_105_c_jpeg.rf.a5ae4ec38859315b058582ac92e7dc43.txt` (MERGE: 2 boxes $\to$ 1)
21. `E64F6653-CC5F-4772-AD6B-0AF2BBEB7D0C_1_105_c_jpeg.rf.f682edace65c17f674d3d70a26289148.txt` (REMOVE: 1 box, MERGE: 2 boxes $\to$ 1)
22. `EC42DA58-F90A-441C-9BE1-33F0F3952A39_1_105_c_jpeg.rf.f8e3823f0aa4a5a8c60931747ecdefdc.txt` (REMOVE: 1 box)
23. `FD6FDA95-91DB-4B61-9767-EFCE7B0204EE_1_105_c_jpeg.rf.bf8b2af6b184a8b7d09fb8c1b5038d9d.txt` (REMOVE: 1 box)

---

## 10. Unchanged TRAIN Files (148 Files)

Exactly **148** of the 171 TRAIN label files remain **byte-for-byte identical** to `neighborlens_v2`. These include:
- 112 TRAIN images with non-candidate road damage or non-road defect classes.
- 36 TRAIN candidate images where the reviewer decided all candidate boxes should be retained via `KEEP` or `SEPARATE`.

---

## 11. Frozen Evaluation Split SHA Verification

SHA-256 hash comparison between `dataset/neighborlens_v2` and `dataset/neighborlens_v3`:

- **Images (Val: 40, Test: 31)**: **0 mismatches (100% byte-identical)**
- **Labels (Val: 40, Test: 31)**: **0 mismatches (100% byte-identical)**
- **Train Images (171 images)**: **0 mismatches (100% byte-identical)**

---

## 12. Class 1, 2, 3 Preservation Verification

A line-by-line programmatic diff of every non-road annotation across all 171 TRAIN label files confirmed:
- **Modified Class 1 (`clogged_drainage`) lines**: **0**
- **Modified Class 2 (`damaged_street_light`) lines**: **0**
- **Modified Class 3 (`damaged_traffic_light`) lines**: **0**
- **Total collateral differences**: **0**

---

## 13. Full Dataset Audit Results (`audit_yolo_dataset.py`)

Running the repository's auditor against `neighborlens_v3`:
```powershell
.\.venv-yolo\Scripts\python.exe scripts/audit_yolo_dataset.py --dataset dataset/neighborlens_v3
```

### Audit Findings:
1. **Total Images**: 242 (Train: 171, Val: 40, Test: 31) — 1:1 correspondence.
2. **Total Labels**: 242 (Train: 171, Val: 40, Test: 31) — 0 orphans.
3. **Total Objects**: 520 objects (v2 had 561; net reduction of 41 objects).
4. **Coordinate Health**: Zero malformed lines, zero invalid coordinates, zero invalid class IDs.
5. **Split Representation**: All 4 classes represented in Train, Val, and Test splits.
6. **Data Leakage**: Zero exact SHA-256 collisions, zero cross-split perceptual (pHash) leakage. The only 2 near-duplicate pairs are safely contained within the `val` split.
7. **Empty Label Notice**: 2 empty label files in `train`:
   - `5794565D-0383-4BAE-A72F-8F76CE539CF1...txt`
   - `AC654FB7-1B94-4BB0-B2E8-E6196C269BF4...txt`
   *Cause*: Human reviewer explicitly removed the single existing candidate box from each of these images as non-damage. These 2 images now serve as valid negative/background samples.

---

## 14. Ultralytics `data.yaml` Validation

Ultralytics dataset resolution check:
```powershell
.\.venv-yolo\Scripts\python.exe -c "from ultralytics.data.utils import check_det_dataset; print(check_det_dataset('dataset/neighborlens_v3/data.yaml'))"
```
* **Result**: **PASS**
* `nc`: 4
* `names`: `{0: 'damaged_road', 1: 'clogged_drainage', 2: 'damaged_street_light', 3: 'damaged_traffic_light'}`
* Recognized splits: `train` (171), `val` (40), `test` (31).

---

## 15. Differential Integrity Audit Summary

```text
================================================================================
DIFFERENTIAL INTEGRITY AUDIT: neighborlens_v2 vs neighborlens_v3
================================================================================
1. Image Byte-Identity Check:
   Train images identical : True (171 images)
   Val images identical   : True (40 images)
   Test images identical  : True (31 images)

2. Frozen Evaluation Labels Check:
   Val labels byte-identical : True (0 mismatches / 40 files)
   Test labels byte-identical: True (0 mismatches / 31 files)

3. TRAIN Label Differential Audit:
   Authorized changed files count : 23
   Actual changed files count     : 23
   Sets match exactly             : True (0 unauthorized changes)

4. Non-Road Class Preservation (Classes 1, 2, 3):
   Class 1/2/3 modifications in TRAIN: 0

DIFFERENTIAL INTEGRITY AUDIT: 100% PASS
================================================================================
```

---

## 16. Deviations, Observations & Gotchas

1. **2 Background Images in TRAIN**: In v2, all 171 train images had at least one object annotation. In v3, 2 images had their single box removed via reviewer decisions, resulting in 2 empty `.txt` files. In standard YOLOv8 training, background images are fully supported and naturally penalize background false positives.
2. **Deterministic Rounding Precision**: Coordinates in `ROAD_REVIEW_DECISIONS.json` were rounded to 4 decimals, whereas source annotations had 6 decimals. The construction script successfully resolved all boxes with sub-millimeter tolerances ($\Delta < 0.00005$), ensuring 100% unique deterministic binding.

---

## 17. Final PASS / FAIL Recommendation

* **Audit Verdict**: **PASS**
* **Readiness for Experiment E-3 YOLOv8 Training**: **APPROVED (GREEN LIGHT)**
* **Lineage & Dataset State**: `dataset/neighborlens_v3` is officially compiled, mathematically reconciled, and verified.
* **Stop Gate**: **STOP**. Training has NOT been launched and will await explicit user approval.
