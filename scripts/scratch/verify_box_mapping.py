import json
import math
from pathlib import Path

DECISIONS_PATH = Path("data/datasets/annotation_input/road_v1/ROAD_REVIEW_DECISIONS.json")
LABELS_DIR = Path("data/datasets/neighborlens_v2/labels/train")

with open(DECISIONS_PATH, "r", encoding="utf-8") as f:
    data = json.load(f)

print("=" * 80)
print("VERIFYING BOX-ID MAPPING: LEDGER vs v2 TRAIN LABELS")
print("=" * 80)

total_checked = 0
exact_matches = 0
close_matches = 0
unmatched = []

remove_merge_mapping = []

for img_name, img_data in data["images"].items():
    if img_data.get("split") != "train":
        continue

    stem = Path(img_name).stem
    label_file = LABELS_DIR / f"{stem}.txt"
    if not label_file.exists():
        print(f"[ERROR] Label file missing: {label_file}")
        unmatched.append((img_name, None, "File missing"))
        continue

    with open(label_file, "r", encoding="utf-8") as lf:
        lines = [line.strip() for line in lf if line.strip()]

    # Parse all class 0 annotations from the label file
    # Format: class_id cx cy w h
    class0_annotations = []
    for line_idx, line in enumerate(lines):
        parts = line.split()
        cid = int(parts[0])
        coords = [float(p) for p in parts[1:5]]
        if cid == 0:
            class0_annotations.append({
                "line_idx": line_idx,
                "coords": coords,
                "raw_line": line
            })

    # For each candidate box in the image
    for b in img_data.get("boxes", []):
        total_checked += 1
        cand_id = b["candidate_id"]
        box_idx = b["box_idx"]
        ledger_coords = b["coords"]
        dec = b.get("human_decision", "")

        # Match against class0_annotations
        best_match = None
        best_dist = float("inf")

        for ann in class0_annotations:
            # Calculate Euclidean distance between centers and size difference
            dcx = abs(ann["coords"][0] - ledger_coords[0])
            dcy = abs(ann["coords"][1] - ledger_coords[1])
            dw = abs(ann["coords"][2] - ledger_coords[2])
            dh = abs(ann["coords"][3] - ledger_coords[3])
            dist = max(dcx, dcy, dw, dh)

            if dist < best_dist:
                best_dist = dist
                best_match = ann

        # In YOLO/Roboflow, coords in ledger may have been formatted to 4 decimals
        # Check if max coordinate diff is <= 0.001
        match_status = "UNMATCHED"
        if best_match and best_dist < 1e-3:
            if best_dist < 1e-5:
                exact_matches += 1
                match_status = "EXACT_MATCH"
            else:
                close_matches += 1
                match_status = f"ROUNDING_MATCH(diff={best_dist:.6f})"
        else:
            unmatched.append((img_name, cand_id, box_idx, ledger_coords, best_dist))
            match_status = f"MISMATCH(diff={best_dist:.6f})"

        if dec in ("REMOVE", "MERGE"):
            remove_merge_mapping.append({
                "image_name": img_name,
                "label_filename": label_file.name,
                "candidate_id": cand_id,
                "box_idx": box_idx,
                "decision": dec,
                "merge_group": b.get("merge_group", []),
                "ledger_coords": ledger_coords,
                "matched_v2_coords": best_match["coords"] if best_match else None,
                "matched_line_idx": best_match["line_idx"] if best_match else None,
                "coord_diff": best_dist,
                "match_status": match_status
            })

print(f"Total TRAIN candidate boxes mapped: {total_checked}")
print(f"Exact matches: {exact_matches}")
print(f"Close rounding matches (< 0.001): {close_matches}")
print(f"Unmatched / Failed: {len(unmatched)}")
assert len(unmatched) == 0, f"Found {len(unmatched)} unmatched boxes!"

print(f"\nTotal REMOVE and MERGE boxes mapped: {len(remove_merge_mapping)} (31 REMOVE + 15 MERGE = 46)")
assert len(remove_merge_mapping) == 46, f"Expected 46 REMOVE/MERGE boxes, got {len(remove_merge_mapping)}"

# Verify uniqueness of matched lines per image
from collections import defaultdict
image_matched_lines = defaultdict(set)
for item in remove_merge_mapping:
    img = item["image_name"]
    line_idx = item["matched_line_idx"]
    assert line_idx not in image_matched_lines[img], f"Duplicate line match on {img} for line {line_idx}!"
    image_matched_lines[img].add(line_idx)

print("ALL 46 REMOVE/MERGE BOXES UNIQUELY AND DETERMINISTICALLY MAPPED TO v2 LABELS.")
