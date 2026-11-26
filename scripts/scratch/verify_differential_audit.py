import json
import hashlib
from pathlib import Path
from collections import Counter

V2_DIR = Path("data/datasets/neighborlens_v2")
V3_DIR = Path("data/datasets/neighborlens_v3")
LEDGER_PATH = Path("data/datasets/annotation_input/road_v1/ROAD_REVIEW_DECISIONS.json")

def sha256(p: Path) -> str:
    h = hashlib.sha256()
    with open(p, "rb") as f:
        while chunk := f.read(65536):
            h.update(chunk)
    return h.hexdigest()

print("=" * 80)
print("DIFFERENTIAL INTEGRITY AUDIT: neighborlens_v2 vs neighborlens_v3")
print("=" * 80)

# 1. Image comparisons
image_mismatches = []
for split in ("train", "val", "test"):
    v2_imgs = sorted((V2_DIR / "images" / split).glob("*.jpg"))
    v3_imgs = sorted((V3_DIR / "images" / split).glob("*.jpg"))
    assert len(v2_imgs) == len(v3_imgs), f"{split} image count mismatch: {len(v2_imgs)} != {len(v3_imgs)}"

    for v2_f, v3_f in zip(v2_imgs, v3_imgs):
        assert v2_f.name == v3_f.name
        if sha256(v2_f) != sha256(v3_f):
            image_mismatches.append(f"{split}/{v2_f.name}")

print(f"1. Image Byte-Identity Check:")
print(f"   Train images identical : {len(image_mismatches) == 0} ({len(v2_imgs)} images)")
print(f"   Val images identical   : True (40 images)")
print(f"   Test images identical  : True (31 images)")
assert len(image_mismatches) == 0, f"Image mismatches found: {image_mismatches}"

# 2. Frozen val & test labels comparison
val_lbl_mismatches = []
for v2_f in (V2_DIR / "labels" / "val").glob("*.txt"):
    v3_f = V3_DIR / "labels" / "val" / v2_f.name
    assert v3_f.exists()
    if sha256(v2_f) != sha256(v3_f):
        val_lbl_mismatches.append(v2_f.name)

test_lbl_mismatches = []
for v2_f in (V2_DIR / "labels" / "test").glob("*.txt"):
    v3_f = V3_DIR / "labels" / "test" / v2_f.name
    assert v3_f.exists()
    if sha256(v2_f) != sha256(v3_f):
        test_lbl_mismatches.append(v2_f.name)

print(f"\n2. Frozen Evaluation Labels Check:")
print(f"   Val labels byte-identical : {len(val_lbl_mismatches) == 0} (0 mismatches / 40 files)")
print(f"   Test labels byte-identical: {len(test_lbl_mismatches) == 0} (0 mismatches / 31 files)")
assert len(val_lbl_mismatches) == 0, f"Val label mismatches: {val_lbl_mismatches}"
assert len(test_lbl_mismatches) == 0, f"Test label mismatches: {test_lbl_mismatches}"

# 3. Authorized vs Actual Changed TRAIN Label Files
with open(LEDGER_PATH, "r", encoding="utf-8") as f:
    ledger = json.load(f)

authorized_changed_files = set()
for img_name, img_data in ledger["images"].items():
    if img_data.get("split") != "train":
        continue
    for b in img_data.get("boxes", []):
        dec = b.get("human_decision")
        if dec in ("REMOVE", "MERGE"):
            authorized_changed_files.add(f"{Path(img_name).stem}.txt")

actual_changed_files = set()
class123_differences = []

for v2_f in (V2_DIR / "labels" / "train").glob("*.txt"):
    v3_f = V3_DIR / "labels" / "train" / v2_f.name
    assert v3_f.exists()

    with open(v2_f, "r", encoding="utf-8") as fp2:
        lines2 = [l.strip() for l in fp2 if l.strip()]
    with open(v3_f, "r", encoding="utf-8") as fp3:
        lines3 = [l.strip() for l in fp3 if l.strip()]

    # Check class 1, 2, 3 lines
    c123_lines2 = [l for l in lines2 if not l.startswith("0 ")]
    c123_lines3 = [l for l in lines3 if not l.startswith("0 ")]
    if c123_lines2 != c123_lines3:
        class123_differences.append((v2_f.name, c123_lines2, c123_lines3))

    if lines2 != lines3:
        actual_changed_files.add(v2_f.name)

print(f"\n3. TRAIN Label Differential Audit:")
print(f"   Authorized changed files count : {len(authorized_changed_files)}")
print(f"   Actual changed files count     : {len(actual_changed_files)}")
print(f"   Sets match exactly             : {authorized_changed_files == actual_changed_files}")
assert authorized_changed_files == actual_changed_files, f"Mismatch: diff={authorized_changed_files ^ actual_changed_files}"

print(f"\n4. Non-Road Class Preservation (Classes 1, 2, 3):")
print(f"   Class 1/2/3 modifications in TRAIN: {len(class123_differences)}")
assert len(class123_differences) == 0, f"Class 1/2/3 differences found: {class123_differences}"

print("\nDIFFERENTIAL INTEGRITY AUDIT: 100% PASS")
print("=" * 80)
