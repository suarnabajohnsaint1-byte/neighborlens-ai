import os
import sys
import hashlib
from pathlib import Path
import yaml

ROOT = Path(__file__).resolve().parents[2]
EXP_DIR = ROOT / "data" / "datasets" / "neighborlens_v2_experimental"
YAML_PATH = EXP_DIR / "data.yaml"

print("="*70)
print("VALIDATING DATASET: data/datasets/neighborlens_v2_experimental")
print("="*70)

splits = ["train", "val", "test"]
class_names = {
    0: "damaged_road",
    1: "clogged_drainage",
    2: "damaged_street_light",
    3: "damaged_traffic_light"
}

errors = []
total_images = 0
total_labels = 0
total_objects = 0

split_img_counts = {}
split_lbl_counts = {}
split_obj_counts = {}
class_obj_counts = {cid: 0 for cid in class_names}
class_img_counts = {cid: 0 for cid in class_names}

seen_img_names = {}
seen_img_hashes = {}
orphan_images = []
orphan_labels = []
malformed_labels = []
invalid_coords = []
invalid_classes = []

for s in splits:
    img_dir = EXP_DIR / "images" / s
    lbl_dir = EXP_DIR / "labels" / s
    
    if not img_dir.exists():
        errors.append(f"Missing images directory: {img_dir}")
        continue
    if not lbl_dir.exists():
        errors.append(f"Missing labels directory: {lbl_dir}")
        continue
        
    img_files = sorted(list(img_dir.glob("*.jpg")) + list(img_dir.glob("*.png")) + list(img_dir.glob("*.jpeg")))
    lbl_files = sorted(list(lbl_dir.glob("*.txt")))
    
    split_img_counts[s] = len(img_files)
    split_lbl_counts[s] = len(lbl_files)
    split_obj_counts[s] = 0
    total_images += len(img_files)
    total_labels += len(lbl_files)
    
    img_stems = {f.stem: f for f in img_files}
    lbl_stems = {f.stem: f for f in lbl_files}
    
    for stem, img_path in img_stems.items():
        if stem not in lbl_stems:
            orphan_images.append(str(img_path))
            
    for stem, lbl_path in lbl_stems.items():
        if stem not in img_stems:
            orphan_labels.append(str(lbl_path))
            
    # Leakage check: Filename and Content Hash
    for f in img_files:
        if f.name in seen_img_names:
            errors.append(f"Duplicate filename '{f.name}' in splits {seen_img_names[f.name]} and {s}")
        seen_img_names[f.name] = s
        
        with open(f, "rb") as fp:
            h = hashlib.sha256(fp.read()).hexdigest()
        if h in seen_img_hashes:
            errors.append(f"Duplicate image content hash in splits {seen_img_hashes[h]} and {s}: {f.name}")
        seen_img_hashes[h] = s

    # Parse and validate labels
    for lf in lbl_files:
        with open(lf, "r", encoding="utf-8") as f:
            lines = [l.strip() for l in f if l.strip()]
            
        split_obj_counts[s] += len(lines)
        total_objects += len(lines)
        
        classes_in_file = set()
        for lidx, line in enumerate(lines):
            parts = line.split()
            if len(parts) != 5:
                malformed_labels.append((str(lf), lidx+1, line))
                continue
            try:
                cid = int(parts[0])
                cx, cy, w, h = map(float, parts[1:5])
            except ValueError:
                malformed_labels.append((str(lf), lidx+1, line))
                continue
                
            if cid not in class_names:
                invalid_classes.append((str(lf), lidx+1, cid))
                continue
                
            if not (0.0 <= cx <= 1.0 and 0.0 <= cy <= 1.0 and 0.0 <= w <= 1.0 and 0.0 <= h <= 1.0):
                invalid_coords.append((str(lf), lidx+1, (cx, cy, w, h)))
                continue
                
            class_obj_counts[cid] += 1
            classes_in_file.add(cid)
            
        for cid in classes_in_file:
            class_img_counts[cid] += 1

print("\n--- Split Breakdown ---")
for s in splits:
    print(f"  {s.upper():<6}: {split_img_counts.get(s, 0)} images, {split_lbl_counts.get(s, 0)} labels, {split_obj_counts.get(s, 0)} objects")

print("\n--- Per-Class Object Distribution ---")
for cid, cname in class_names.items():
    print(f"  Class {cid} ({cname:<22}): {class_obj_counts[cid]:>4} objects across {class_img_counts[cid]:>4} images")

print("\n--- Integrity Audit ---")
print(f"  Total Images          : {total_images}")
print(f"  Total Labels          : {total_labels}")
print(f"  Total Objects         : {total_objects}")
print(f"  Orphan Images         : {len(orphan_images)}")
print(f"  Orphan Labels         : {len(orphan_labels)}")
print(f"  Malformed Labels      : {len(malformed_labels)}")
print(f"  Invalid Coordinates   : {len(invalid_coords)}")
print(f"  Invalid Class IDs     : {len(invalid_classes)}")
print(f"  Cross-Split Collisions: {len(errors)}")

# YAML Validation
print("\n--- YAML Configuration Validation ---")
with open(YAML_PATH, "r", encoding="utf-8") as f:
    yaml_data = yaml.safe_load(f)

yaml_valid = True
if yaml_data.get("nc") != 4:
    print(f"  [FAIL] 'nc' is {yaml_data.get('nc')}, expected 4")
    yaml_valid = False
else:
    print("  [PASS] 'nc': 4 verified")

if yaml_data.get("names") != class_names:
    print(f"  [FAIL] 'names' mapping mismatch: {yaml_data.get('names')}")
    yaml_valid = False
else:
    print("  [PASS] Canonical 4-class taxonomy names verified")

# Ultralytics check_det_dataset
print("\n--- Ultralytics check_det_dataset Check ---")
try:
    from ultralytics.data.utils import check_det_dataset
    # check_det_dataset resolves paths relative to root or current working dir
    det_info = check_det_dataset(str(YAML_PATH))
    print(f"  [PASS] Ultralytics check_det_dataset passed. Resolved dataset: {det_info.get('dataset_dir', '')}")
except Exception as e:
    print(f"  [FAIL] Ultralytics check_det_dataset raised error: {e}")
    yaml_valid = False

passed = (
    len(errors) == 0 and
    len(orphan_images) == 0 and
    len(orphan_labels) == 0 and
    len(malformed_labels) == 0 and
    len(invalid_coords) == 0 and
    len(invalid_classes) == 0 and
    yaml_valid
)

if passed:
    print("\n" + "="*70)
    print("RESULT: [PASS] EXPERIMENTAL DATASET VALIDATION SUCCESSFUL")
    print("="*70)
    sys.exit(0)
else:
    print("\n" + "="*70)
    print("RESULT: [FAIL] EXPERIMENTAL DATASET VALIDATION FAILED")
    print("="*70)
    sys.exit(1)
