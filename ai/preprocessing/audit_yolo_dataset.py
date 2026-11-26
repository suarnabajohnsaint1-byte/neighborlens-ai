"""
Neighborlens AI Reproducible YOLO Dataset Audit Tool
======================================================
Audit and validate any YOLO format object detection dataset.
Checks:
1. Split image & label file counts
2. 1:1 image-to-label correspondence, orphan images/labels
3. Empty label files, malformed lines, invalid class IDs
4. Coordinate ranges [0.0, 1.0], positive w/h
5. Exact SHA-256 collisions & perceptual hash near-duplicates (Hamming distance)
6. Cross-split data leakage
7. Bounding box size distributions (min, median, max, micro-boxes)
8. Per-class object counts by split
9. Image class composition (single-class vs multi-class)
"""

import sys
import json
import argparse
from pathlib import Path
from collections import Counter
import numpy as np

if __package__:
    from .dataset_hashes import compute_64phash, compute_sha256, hamming_dist
else:
    from dataset_hashes import compute_64phash, compute_sha256, hamming_dist

CANONICAL_CLASSES = {
    0: "damaged_road",
    1: "clogged_drainage",
    2: "damaged_street_light",
    3: "damaged_traffic_light"
}

def audit_dataset(dataset_path, class_names=None):
    if class_names is None:
        class_names = CANONICAL_CLASSES
        
    ds_root = Path(dataset_path)
    if not ds_root.exists():
        print(f"[ERROR] Dataset directory {ds_root} does not exist.")
        sys.exit(1)
        
    print("=" * 80)
    print(f"Neighborlens AI Dataset Audit: {ds_root.resolve()}")
    print("=" * 80)
    
    splits = ["train", "val", "test"]
    results = {
        "dataset_path": str(ds_root),
        "splits": {},
        "totals": {
            "images": 0,
            "labels": 0,
            "objects": 0,
            "empty_labels": 0,
            "malformed_lines": 0,
            "invalid_coords": 0,
            "invalid_class_ids": 0,
            "orphan_images": 0,
            "orphan_labels": 0
        },
        "class_totals": {cid: 0 for cid in class_names},
        "image_composition": {
            "only_class_0": 0,
            "only_class_1": 0,
            "only_class_2": 0,
            "only_class_3": 0,
            "multi_class": 0,
            "multi_class_files": []
        },
        "bbox_stats": {cid: [] for cid in class_names},
        "sha256_hashes": {},
        "phash_hashes": {},
        "exact_duplicates": [],
        "near_duplicate_pairs": [],
        "split_leakage_sha256": [],
        "split_leakage_phash": []
    }
    
    all_img_records = []
    
    for split in splits:
        img_dir = ds_root / "images" / split
        lbl_dir = ds_root / "labels" / split
        
        imgs = sorted(list(img_dir.glob("*.jpg")) + list(img_dir.glob("*.png")) + list(img_dir.glob("*.jpeg"))) if img_dir.exists() else []
        lbls = sorted(list(lbl_dir.glob("*.txt"))) if lbl_dir.exists() else []
        
        img_stems = {f.stem: f for f in imgs}
        lbl_stems = {f.stem: f for f in lbls}
        
        orphan_imgs = sorted(list(set(img_stems.keys()) - set(lbl_stems.keys())))
        orphan_lbls = sorted(list(set(lbl_stems.keys()) - set(img_stems.keys())))
        
        split_class_counts = Counter()
        split_empty_labels = 0
        split_malformed = 0
        split_invalid_coords = 0
        split_invalid_ids = 0
        split_objects = 0
        
        for lf in lbls:
            with open(lf, "r", encoding="utf-8") as f:
                lines = [l.strip() for l in f if l.strip()]
                
            if not lines:
                split_empty_labels += 1
                continue
                
            file_cids = set()
            for lidx, line in enumerate(lines):
                parts = line.split()
                if len(parts) != 5:
                    split_malformed += 1
                    continue
                try:
                    cid = int(parts[0])
                    coords = [float(p) for p in parts[1:]]
                except ValueError:
                    split_malformed += 1
                    continue
                    
                if cid not in class_names:
                    split_invalid_ids += 1
                    continue
                    
                cx, cy, w, h = coords
                if not (0.0 <= cx <= 1.0 and 0.0 <= cy <= 1.0 and 0.0 <= w <= 1.0 and 0.0 <= h <= 1.0) or w <= 0 or h <= 0:
                    split_invalid_coords += 1
                    continue
                    
                file_cids.add(cid)
                area = w * h
                split_class_counts[cid] += 1
                split_objects += 1
                results["class_totals"][cid] += 1
                results["bbox_stats"][cid].append({
                    "w": w, "h": h, "area": area, "split": split, "file": lf.name
                })
                
            # Composition check
            if len(file_cids) > 1:
                results["image_composition"]["multi_class"] += 1
                results["image_composition"]["multi_class_files"].append({
                    "file": lf.name, "split": split, "classes": [class_names[c] for c in sorted(file_cids)]
                })
            elif len(file_cids) == 1:
                single_c = next(iter(file_cids))
                results["image_composition"][f"only_class_{single_c}"] += 1
                
        # Hash tracking
        for img_f in imgs:
            sha = compute_sha256(img_f)
            ph = compute_64phash(img_f)
            
            all_img_records.append({
                "name": img_f.name, "split": split, "sha": sha, "phash": ph
            })
            
            if sha in results["sha256_hashes"]:
                prev_split, prev_file = results["sha256_hashes"][sha]
                results["exact_duplicates"].append({
                    "sha256": sha, "file1": f"{prev_split}/{prev_file}", "file2": f"{split}/{img_f.name}"
                })
                if prev_split != split:
                    results["split_leakage_sha256"].append({
                        "sha256": sha, "split1": prev_split, "file1": prev_file, "split2": split, "file2": img_f.name
                    })
            else:
                results["sha256_hashes"][sha] = (split, img_f.name)
                
        results["splits"][split] = {
            "images": len(imgs),
            "labels": len(lbls),
            "objects": split_objects,
            "classes": {class_names[cid]: split_class_counts[cid] for cid in sorted(class_names.keys())},
            "empty_labels": split_empty_labels,
            "malformed_lines": split_malformed,
            "invalid_coords": split_invalid_coords,
            "invalid_class_ids": split_invalid_ids,
            "orphan_images": len(orphan_imgs),
            "orphan_labels": len(orphan_lbls)
        }
        
        results["totals"]["images"] += len(imgs)
        results["totals"]["labels"] += len(lbls)
        results["totals"]["objects"] += split_objects
        results["totals"]["empty_labels"] += split_empty_labels
        results["totals"]["malformed_lines"] += split_malformed
        results["totals"]["invalid_coords"] += split_invalid_coords
        results["totals"]["invalid_class_ids"] += split_invalid_ids
        results["totals"]["orphan_images"] += len(orphan_imgs)
        results["totals"]["orphan_labels"] += len(orphan_lbls)

    # Perceptual hash pairwise analysis (DCT pHash 64-bit, dist <= 6 indicates near duplicates)
    for i in range(len(all_img_records)):
        for j in range(i + 1, len(all_img_records)):
            r1 = all_img_records[i]
            r2 = all_img_records[j]
            if r1["phash"] and r2["phash"]:
                dist = hamming_dist(r1["phash"], r2["phash"])
                if dist <= 6:  # Standard 64-bit DCT pHash threshold
                    entry = {
                        "file1": r1["name"], "split1": r1["split"],
                        "file2": r2["name"], "split2": r2["split"],
                        "hamming_distance": dist
                    }
                    results["near_duplicate_pairs"].append(entry)
                    if r1["split"] != r2["split"]:
                        results["split_leakage_phash"].append(entry)

    # Print Summary Table
    print("\n1. DATASET SPLIT & ANNOTATION BREAKDOWN:")
    print("-" * 80)
    print(f"{'Split':<8} | {'Images':<8} | {'Labels':<8} | {'Objects':<8} | {'Empty':<6} | {'Malformed':<10} | {'Orphans':<8}")
    print("-" * 80)
    for split in splits:
        s = results["splits"][split]
        orphans = s["orphan_images"] + s["orphan_labels"]
        print(f"{split:<8} | {s['images']:<8} | {s['labels']:<8} | {s['objects']:<8} | {s['empty_labels']:<6} | {s['malformed_lines']:<10} | {orphans:<8}")
    print("-" * 80)
    t = results["totals"]
    print(f"{'TOTAL':<8} | {t['images']:<8} | {t['labels']:<8} | {t['objects']:<8} | {t['empty_labels']:<6} | {t['malformed_lines']:<10} | {t['orphan_images']+t['orphan_labels']:<8}")

    print("\n2. PER-CLASS OBJECT DISTRIBUTION BY SPLIT:")
    print("-" * 80)
    header = f"{'Class ID':<10} | {'Class Name':<24} | {'Train':<8} | {'Val':<8} | {'Test':<8} | {'Total':<8} | {'% Total':<8}"
    print(header)
    print("-" * 80)
    total_objs = max(1, t["objects"])
    for cid in sorted(class_names.keys()):
        cname = class_names[cid]
        tr_c = results["splits"]["train"]["classes"].get(cname, 0)
        va_c = results["splits"]["val"]["classes"].get(cname, 0)
        te_c = results["splits"]["test"]["classes"].get(cname, 0)
        tot_c = results["class_totals"][cid]
        pct = (tot_c / total_objs) * 100.0
        print(f"{cid:<10} | {cname:<24} | {tr_c:<8} | {va_c:<8} | {te_c:<8} | {tot_c:<8} | {pct:>6.2f}%")
    print("-" * 80)

    print("\n3. IMAGE-LEVEL CLASS COMPOSITION:")
    print("-" * 80)
    comp = results["image_composition"]
    print(f"  Only Class 0 (damaged_road)        : {comp['only_class_0']:3d} images")
    print(f"  Only Class 1 (clogged_drainage)    : {comp['only_class_1']:3d} images")
    print(f"  Only Class 2 (damaged_street_light): {comp['only_class_2']:3d} images")
    print(f"  Only Class 3 (damaged_traffic_light): {comp['only_class_3']:3d} images")
    print(f"  Multiple Classes (mixed)           : {comp['multi_class']:3d} images")
    if comp["multi_class_files"]:
        for item in comp["multi_class_files"]:
            print(f"    - {item['file']} ({item['split']}): {item['classes']}")
    print("-" * 80)

    print("\n4. BOUNDING BOX SIZE & GEOMETRY METRICS:")
    print("-" * 80)
    print(f"{'Class Name':<24} | {'Count':<6} | {'Min Area':<10} | {'Median Area':<12} | {'Max Area':<10} | {'Micro (<0.5%)':<14}")
    print("-" * 80)
    for cid in sorted(class_names.keys()):
        cname = class_names[cid]
        boxes = results["bbox_stats"][cid]
        if boxes:
            areas = [b["area"] for b in boxes]
            min_a = np.min(areas)
            med_a = np.median(areas)
            max_a = np.max(areas)
            micro_cnt = sum(1 for a in areas if a < 0.005)
            micro_pct = (micro_cnt / len(areas)) * 100.0
            print(f"{cname:<24} | {len(boxes):<6} | {min_a:<10.6f} | {med_a:<12.4f} | {max_a:<10.4f} | {micro_cnt} ({micro_pct:.1f}%)")
        else:
            print(f"{cname:<24} | 0      | N/A        | N/A          | N/A        | N/A")
    print("-" * 80)

    print("\n5. DATA LEAKAGE & DUPLICATE AUDIT:")
    print("-" * 80)
    print(f"Exact SHA-256 Collisions Total         : {len(results['exact_duplicates'])}")
    print(f"Cross-Split SHA-256 Leakage Collisions : {len(results['split_leakage_sha256'])}")
    print(f"Perceptual (pHash) Near-Duplicate Pairs: {len(results['near_duplicate_pairs'])}")
    print(f"Cross-Split Perceptual Leakage Pairs   : {len(results['split_leakage_phash'])}")
    for pair in results["near_duplicate_pairs"]:
        print(f"  Near-dup (dist={pair['hamming_distance']}/256): {pair['file1']} ({pair['split1']}) <=> {pair['file2']} ({pair['split2']})")
    if results["split_leakage_sha256"]:
        for leak in results["split_leakage_sha256"]:
            print(f"  [CRITICAL LEAK] SHA256 {leak['sha256'][:12]}: {leak['split1']}/{leak['file1']} <=> {leak['split2']}/{leak['file2']}")
    if results["split_leakage_phash"]:
        for leak in results["split_leakage_phash"]:
            print(f"  [CRITICAL LEAK] pHash near-duplicate: {leak['split1']}/{leak['file1']} <=> {leak['split2']}/{leak['file2']} (dist={leak['hamming_distance']})")
    print("-" * 80)

    # Validation verdict
    has_orphans = t["orphan_images"] > 0 or t["orphan_labels"] > 0
    has_empty = t["empty_labels"] > 0
    has_malformed = t["malformed_lines"] > 0 or t["invalid_coords"] > 0 or t["invalid_class_ids"] > 0
    has_leakage = len(results["split_leakage_sha256"]) > 0 or len(results["split_leakage_phash"]) > 0
    classes_missing_val = [class_names[cid] for cid in class_names if results["splits"]["val"]["classes"].get(class_names[cid], 0) == 0]
    classes_missing_test = [class_names[cid] for cid in class_names if results["splits"]["test"]["classes"].get(class_names[cid], 0) == 0]

    print("\n6. AUDIT VERDICT & HEALTH STATUS:")
    print("-" * 80)
    if classes_missing_val or classes_missing_test:
        print(f"[FAIL] HELD-OUT REPRESENTATION BLINDSPOT DETECTED!")
        if classes_missing_val:
            print(f"  Classes missing in Validation split: {classes_missing_val}")
        if classes_missing_test:
            print(f"  Classes missing in Test split      : {classes_missing_test}")
    else:
        print("[PASS] All 4 canonical classes represented across Train, Val, and Test splits.")

    if has_leakage:
        print(f"[FAIL] Cross-split data leakage detected ({len(results['split_leakage_phash'])} instances).")
    else:
        print("[PASS] Zero cross-split data leakage (exact and perceptual).")

    if has_orphans or has_empty or has_malformed:
        print(f"[FAIL] Annotation integrity errors detected (orphans={has_orphans}, malformed={has_malformed}).")
    else:
        print("[PASS] 100% 1-to-1 image-label correspondence and coordinate validity.")

    print("=" * 80)
    return results

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Audit YOLO dataset integrity and statistics.")
    parser.add_argument("--dataset", required=True, help="Path to dataset root directory (e.g. data/datasets/neighborlens_v1)")
    parser.add_argument("--json", help="Optional path to output results JSON")
    args = parser.parse_args()
    
    audit_results = audit_dataset(args.dataset)
    if args.json:
        clean_results = audit_results.copy()
        clean_results.pop("sha256_hashes", None)
        with open(args.json, "w", encoding="utf-8") as f:
            json.dump(clean_results, f, indent=2)
        print(f"[INFO] Audit results written to {args.json}")
