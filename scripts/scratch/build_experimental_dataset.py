import os
import shutil
from pathlib import Path
import hashlib
import yaml

ROOT = Path(__file__).resolve().parents[2]
SRC_DIR = ROOT / "data" / "datasets" / "neighborlens_v1"
EXP_DIR = ROOT / "data" / "datasets" / "neighborlens_v2_experimental"

print(f"Building experimental dataset at: {EXP_DIR}")

if EXP_DIR.exists():
    shutil.rmtree(EXP_DIR)

EXP_DIR.mkdir(parents=True, exist_ok=True)

# Copy images and labels
for folder in ["images", "labels"]:
    src_folder = SRC_DIR / folder
    dst_folder = EXP_DIR / folder
    shutil.copytree(src_folder, dst_folder)
    print(f"Copied {src_folder} -> {dst_folder}")

# Create data.yaml
data_yaml_content = {
    "path": "data/datasets/neighborlens_v2_experimental",
    "train": "images/train",
    "val": "images/val",
    "test": "images/test",
    "nc": 4,
    "names": {
        0: "damaged_road",
        1: "clogged_drainage",
        2: "damaged_street_light",
        3: "damaged_traffic_light"
    }
}

with open(EXP_DIR / "data.yaml", "w", encoding="utf-8") as f:
    yaml.dump(data_yaml_content, f, default_flow_style=False, sort_keys=False)

print("Created data.yaml")

# Create EXPERIMENTAL_DATASET_README.md
readme_content = """# Neighborlens AI Provisional Experimental Dataset (v2-Experimental)

> [!WARNING]
> **This is a provisional development dataset. The road annotations have not been human-reviewed. It must not be described as the final enhanced or human-validated dataset.**

---

## 1. Overview & Purpose
- **Dataset Location**: `data/datasets/neighborlens_v2_experimental/`
- **Purpose**: Development/training experiment only, to evaluate pipeline capability and model baseline behavior.
- **Human Review Status**: **UNRESOLVED (0/334 human decisions recorded)**.
- **Safety Guarantee**: No human decisions were fabricated, inferred, or auto-filled. The 334 flagged candidate road damage boxes from the Phase 4C diagnosis remain pending official human review.

---

## 2. Canonical Taxonomy (4 Classes)
- `0`: `damaged_road`
- `1`: `clogged_drainage`
- `2`: `damaged_street_light`
- `3`: `damaged_traffic_light`

---

## 3. Dataset Composition & Split Metrics

| Split | Images | Labels | Class 0 (`damaged_road`) | Class 1 (`clogged_drainage`) | Class 2 (`damaged_street_light`) | Class 3 (`damaged_traffic_light`) | Total Objects |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| **Train** | 191 | 191 | 274 | 50 | 64 | 28 | 416 |
| **Val** | 30 | 30 | 75 | 9 | 0 | 0 | 84 |
| **Test** | 21 | 21 | 52 | 9 | 0 | 0 | 61 |
| **Total** | **242** | **242** | **401** | **68** | **64** | **28** | **561** |

---

## 4. Known Limitations
1. **Unresolved Road Annotations**: Contains the legacy unreviewed road annotations, including potential multi-box fragmentation or candidate noise identified during diagnostic audits.
2. **Class Imbalance in Classes 2 & 3**: Classes 2 (`damaged_street_light`) and 3 (`damaged_traffic_light`) are currently present only in the Train split.
3. **Non-Production Artifact**: This dataset is strictly internal for development benchmarking and must not be cited as the final capstone deliverable.
"""

with open(EXP_DIR / "EXPERIMENTAL_DATASET_README.md", "w", encoding="utf-8") as f:
    f.write(readme_content)

print("Created EXPERIMENTAL_DATASET_README.md")
