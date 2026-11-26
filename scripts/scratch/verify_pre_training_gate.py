import hashlib
from pathlib import Path
from collections import Counter

WORKSPACE_ROOT = Path(__file__).resolve().parents[2]
V2_DIR = WORKSPACE_ROOT / "data" / "datasets" / "neighborlens_v2"
V3_DIR = WORKSPACE_ROOT / "data" / "datasets" / "neighborlens_v3"
OUTPUT_DIR = WORKSPACE_ROOT / "models" / "checkpoints" / "neighborlens_v8_phase3_e3_road_remediation"

def sha256(p: Path) -> str:
    h = hashlib.sha256()
    with open(p, "rb") as f:
        while chunk := f.read(65536):
            h.update(chunk)
    return h.hexdigest()

print("=" * 80)
print("EXPERIMENT E-3 PRE-TRAINING GATE VERIFICATION")
print("=" * 80)

# 1. Output directory check
if OUTPUT_DIR.exists():
    raise FileExistsError(f"Target run directory {OUTPUT_DIR} already exists! Aborting.")
print(f"1. Target run directory: {OUTPUT_DIR} (Does not exist -> PASS)")

# 2. Image and Label counts
img_counts = {}
lbl_counts = {}
obj_counts = {}
train_class_counts = Counter()

for split in ("train", "val", "test"):
    imgs = list((V3_DIR / "images" / split).glob("*.jpg"))
    lbls = list((V3_DIR / "labels" / split).glob("*.txt"))
    img_counts[split] = len(imgs)
    lbl_counts[split] = len(lbls)
    assert len(imgs) == len(lbls), f"Mismatch in {split}: {len(imgs)} imgs != {len(lbls)} lbls"

    objs = 0
    for l in lbls:
        with open(l, "r") as fp:
            for line in fp:
                if line.strip():
                    parts = line.split()
                    cid = int(parts[0])
                    objs += 1
                    if split == "train":
                        train_class_counts[cid] += 1
    obj_counts[split] = objs

print("\n2. Dataset Split & Object Counts:")
print(f"   Images : Train={img_counts['train']} (171), Val={img_counts['val']} (40), Test={img_counts['test']} (31) | Total={sum(img_counts.values())} (242)")
print(f"   Labels : Train={lbl_counts['train']} (171), Val={lbl_counts['val']} (40), Test={lbl_counts['test']} (31) | Total={sum(lbl_counts.values())} (242)")
print(f"   Objects: Train={obj_counts['train']} (331), Val={obj_counts['val']} (112), Test={obj_counts['test']} (77) | Total={sum(obj_counts.values())} (520)")

assert img_counts == {"train": 171, "val": 40, "test": 31}
assert lbl_counts == {"train": 171, "val": 40, "test": 31}
assert obj_counts == {"train": 331, "val": 112, "test": 77}

print("\n3. TRAIN Split Class Distribution:")
for cid, name in [(0, "damaged_road"), (1, "clogged_drainage"), (2, "damaged_street_light"), (3, "damaged_traffic_light")]:
    cnt = train_class_counts[cid]
    print(f"   Class {cid} ({name:<22}): {cnt}")

assert train_class_counts[0] == 233
assert train_class_counts[1] == 50
assert train_class_counts[2] == 35
assert train_class_counts[3] == 13

# 3. Frozen Evaluation Verification (val/test SHA256 equality)
print("\n4. Frozen Evaluation Verification (v2 vs v3 byte-identity):")
sha_failures = []
for split in ("val", "test"):
    for sub in ("images", "labels"):
        ext = "*.jpg" if sub == "images" else "*.txt"
        v2_files = sorted((V2_DIR / sub / split).glob(ext))
        v3_files = sorted((V3_DIR / sub / split).glob(ext))
        assert len(v2_files) == len(v3_files), f"Count mismatch in {sub}/{split}"
        for f2, f3 in zip(v2_files, v3_files):
            assert f2.name == f3.name
            if sha256(f2) != sha256(f3):
                sha_failures.append(f"{sub}/{split}/{f2.name}")

print(f"   SHA-256 Differences in Frozen Evaluation Splits: {len(sha_failures)}")
assert len(sha_failures) == 0, f"Frozen split differences detected: {sha_failures}"
print("   [PASS] 100% byte-identical equality between v2 and v3 evaluation splits.")

print("\nPRE-TRAINING GATE: 100% PASS — READY TO LAUNCH E-3 TRAINING.")
print("=" * 80)
