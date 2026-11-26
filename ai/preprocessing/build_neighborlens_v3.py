"""
Neighborlens AI Build Experiment E-3 Remediated Dataset (neighborlens_v3)
==========================================================================
Constructs data/datasets/neighborlens_v3 strictly from data/datasets/neighborlens_v2
by applying the validated human decisions in data/datasets/annotation_input/road_v1/ROAD_REVIEW_DECISIONS.json.

Strict Safety Rules:
1. NEVER modifies neighborlens_v1 or neighborlens_v2.
2. byte-for-byte identical images across train, val, test.
3. byte-for-byte identical labels across val and test (frozen ground truth).
4. Class 1, 2, 3 annotations in TRAIN are 100% untouched.
5. Applies only explicit human KEEP, SEPARATE, REMOVE, and MERGE decisions.
6. Enforces minimum enclosing axis-aligned rectangle for MERGE groups.
7. Refuses to proceed if review ledger is not READY or contains any ambiguity.
8. Refuses to overwrite unless --force is explicitly specified.
"""

import os
import sys
import json
import shutil
import hashlib
import argparse
from pathlib import Path
from collections import Counter, defaultdict
from typing import Dict, Any, List, Tuple, Set

WORKSPACE_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(WORKSPACE_ROOT / "scripts" / "tools" / "road_annotation_review"))
from validate_decisions import validate_review_decisions

V2_DIR = WORKSPACE_ROOT / "data" / "datasets" / "neighborlens_v2"
V3_DIR = WORKSPACE_ROOT / "data" / "datasets" / "neighborlens_v3"
LEDGER_PATH = WORKSPACE_ROOT / "data" / "datasets" / "annotation_input" / "road_v1" / "ROAD_REVIEW_DECISIONS.json"

def compute_sha256(filepath: Path) -> str:
    """Computes SHA-256 checksum of a file."""
    h = hashlib.sha256()
    with open(filepath, "rb") as f:
        while chunk := f.read(65536):
            h.update(chunk)
    return h.hexdigest()

def match_candidate_to_line(
    cand_coords: List[float],
    class0_annotations: List[Dict[str, Any]],
    tolerance: float = 0.001
) -> Dict[str, Any]:
    """
    Finds the unique Class 0 annotation matching candidate coordinates.
    """
    best_match = None
    best_dist = float("inf")

    for ann in class0_annotations:
        dcx = abs(ann["coords"][0] - cand_coords[0])
        dcy = abs(ann["coords"][1] - cand_coords[1])
        dw = abs(ann["coords"][2] - cand_coords[2])
        dh = abs(ann["coords"][3] - cand_coords[3])
        dist = max(dcx, dcy, dw, dh)

        if dist < best_dist:
            best_dist = dist
            best_match = ann

    if best_match and best_dist <= tolerance:
        return best_match
    return None

def compute_merged_box(member_boxes_coords: List[List[float]]) -> List[float]:
    """
    Computes the minimum enclosing axis-aligned bounding box in YOLO format [cx, cy, w, h].
    """
    x_mins = []
    y_mins = []
    x_maxs = []
    y_maxs = []

    for cx, cy, w, h in member_boxes_coords:
        x_mins.append(cx - w / 2.0)
        y_mins.append(cy - h / 2.0)
        x_maxs.append(cx + w / 2.0)
        y_maxs.append(cy + h / 2.0)

    m_xmin = max(0.0, min(x_mins))
    m_ymin = max(0.0, min(y_mins))
    m_xmax = min(1.0, max(x_maxs))
    m_ymax = min(1.0, max(y_maxs))

    m_cx = (m_xmin + m_xmax) / 2.0
    m_cy = (m_ymin + m_ymax) / 2.0
    m_w = m_xmax - m_xmin
    m_h = m_ymax - m_ymin

    return [round(m_cx, 6), round(m_cy, 6), round(m_w, 6), round(m_h, 6)]

def build_v3_dataset(
    v2_dir: Path = V2_DIR,
    v3_dir: Path = V3_DIR,
    ledger_path: Path = LEDGER_PATH,
    force: bool = False
) -> Dict[str, Any]:
    """
    Builds neighborlens_v3 dataset with full audit trail.
    """
    print("=" * 75)
    print("Neighborlens AI Phase 3B Experiment E-3: Building neighborlens_v3")
    print("=" * 75)

    # 1. Pre-condition checks
    if not v2_dir.exists():
        raise FileNotFoundError(f"Source dataset neighborlens_v2 not found at {v2_dir}")

    if v3_dir.exists():
        if not force:
            raise FileExistsError(
                f"Destination directory {v3_dir} already exists! Use --force to overwrite safely."
            )
        print(f"[WARN] Destination {v3_dir} exists. Removing existing directory for clean build...")
        shutil.rmtree(v3_dir)

    print("\n1. Validating Authoritative Human Review Ledger...")
    val_res = validate_review_decisions(ledger_path, v2_dir / "images" / "train")
    if not val_res["valid"] or val_res["readiness"] != "READY":
        raise ValueError(
            f"Pre-construction check FAILED! Ledger readiness is '{val_res['readiness']}'. "
            f"Errors: {val_res['errors']}, Conflicts: {val_res['conflicts']}"
        )

    print("   [PASS] Authoritative ledger is 100% READY with zero conflicts or unresolved records.")
    print(f"   - Candidate boxes: {val_res['train_candidate_boxes']} (KEEP: {val_res['keep_count']}, "
          f"MERGE groups: {val_res['merge_groups_count']}, SEPARATE: {val_res['separate_count']}, "
          f"REMOVE: {val_res['remove_count']})")

    # Load ledger
    with open(ledger_path, "r", encoding="utf-8") as f:
        ledger_data = json.load(f)

    # 2. Create directory structure
    print("\n2. Initializing neighborlens_v3 Directory Structure...")
    for split in ("train", "val", "test"):
        (v3_dir / "images" / split).mkdir(parents=True, exist_ok=True)
        (v3_dir / "labels" / split).mkdir(parents=True, exist_ok=True)

    # 3. Copy all images byte-for-byte and compute checksums
    print("\n3. Copying Images Byte-for-Byte...")
    image_counts = {}
    image_sha_mismatches = []

    for split in ("train", "val", "test"):
        src_img_dir = v2_dir / "images" / split
        dst_img_dir = v3_dir / "images" / split
        img_files = sorted(src_img_dir.glob("*.jpg"))
        image_counts[split] = len(img_files)

        for img_path in img_files:
            dst_path = dst_img_dir / img_path.name
            shutil.copy2(img_path, dst_path)

            # Checksum verification
            src_sha = compute_sha256(img_path)
            dst_sha = compute_sha256(dst_path)
            if src_sha != dst_sha:
                image_sha_mismatches.append((str(img_path), str(dst_path)))

    assert len(image_sha_mismatches) == 0, f"Image SHA-256 mismatch detected: {image_sha_mismatches}"
    print(f"   [PASS] All {sum(image_counts.values())} images copied with identical SHA-256 checksums:")
    print(f"          Train: {image_counts['train']}, Val: {image_counts['val']}, Test: {image_counts['test']}")

    # 4. Copy frozen val and test labels byte-for-byte
    print("\n4. Copying Frozen Evaluation Labels (val/test)...")
    val_test_sha_mismatches = []
    val_test_counts = {}

    for split in ("val", "test"):
        src_lbl_dir = v2_dir / "labels" / split
        dst_lbl_dir = v3_dir / "labels" / split
        lbl_files = sorted(src_lbl_dir.glob("*.txt"))
        val_test_counts[split] = len(lbl_files)

        for lbl_path in lbl_files:
            dst_path = dst_lbl_dir / lbl_path.name
            shutil.copy2(lbl_path, dst_path)

            src_sha = compute_sha256(lbl_path)
            dst_sha = compute_sha256(dst_path)
            if src_sha != dst_sha:
                val_test_sha_mismatches.append((str(lbl_path), str(dst_path)))

    assert len(val_test_sha_mismatches) == 0, f"Val/Test label SHA mismatch: {val_test_sha_mismatches}"
    print(f"   [PASS] Frozen evaluation labels byte-identical to v2 (Val: {val_test_counts['val']}, Test: {val_test_counts['test']})")

    # 5. Process TRAIN labels with Class 0 remediation
    print("\n5. Applying Explicit Remediation to TRAIN Split...")
    src_train_lbl_dir = v2_dir / "labels" / "train"
    dst_train_lbl_dir = v3_dir / "labels" / "train"

    train_label_files = sorted((v2_dir / "labels" / "train").glob("*.txt"))

    # Tracking metrics
    v2_class_counts = Counter()
    v3_class_counts = Counter()

    changed_files = []
    unchanged_files = []

    remove_operations = []
    merge_operations = []

    class123_mismatches = []

    for lbl_path in train_label_files:
        stem = lbl_path.stem
        # Corresponding image filename
        img_name = f"{stem}.jpg"

        with open(lbl_path, "r", encoding="utf-8") as f:
            raw_lines = [l.strip() for l in f if l.strip()]

        parsed_lines = []
        class0_anns = []

        for line_idx, line in enumerate(raw_lines):
            parts = line.split()
            cid = int(parts[0])
            coords = [float(p) for p in parts[1:5]]
            v2_class_counts[cid] += 1
            parsed_lines.append({"line_idx": line_idx, "cid": cid, "coords": coords, "raw": line})
            if cid == 0:
                class0_anns.append({"line_idx": line_idx, "coords": coords, "raw": line})

        # Check if this image has review candidates
        img_data = ledger_data.get("images", {}).get(img_name)

        if not img_data or img_data.get("split") != "train":
            # Image not in review ledger: copy unchanged
            dst_path = dst_train_lbl_dir / lbl_path.name
            shutil.copy2(lbl_path, dst_path)
            unchanged_files.append(lbl_path.name)
            for item in parsed_lines:
                v3_class_counts[item["cid"]] += 1
            continue

        # Match candidate boxes
        boxes = img_data.get("boxes", [])
        matched_lines_by_box: Dict[int, Dict[str, Any]] = {}
        matched_line_indices: Set[int] = set()

        for b in boxes:
            b_idx = b["box_idx"]
            matched_ann = match_candidate_to_line(b["coords"], class0_anns)
            if not matched_ann:
                raise ValueError(
                    f"FATAL: Candidate box #{b_idx} on '{img_name}' could not be matched to a Class 0 line!"
                )
            if matched_ann["line_idx"] in matched_line_indices:
                raise ValueError(
                    f"FATAL: Ambiguous match: Line {matched_ann['line_idx']} on '{img_name}' matched multiple boxes!"
                )
            matched_lines_by_box[b_idx] = matched_ann
            matched_line_indices.add(matched_ann["line_idx"])

        # Determine line outcomes
        lines_to_remove: Set[int] = set()
        merge_groups_processed: Set[Tuple[int, ...]] = set()
        new_merged_lines: List[str] = []

        for b in boxes:
            b_idx = b["box_idx"]
            cand_id = b["candidate_id"]
            dec = b.get("human_decision", "").strip().upper()
            ann = matched_lines_by_box[b_idx]

            if dec == "REMOVE":
                lines_to_remove.add(ann["line_idx"])
                remove_operations.append({
                    "image_name": img_name,
                    "label_file": lbl_path.name,
                    "candidate_id": cand_id,
                    "box_idx": b_idx,
                    "removed_coords": ann["coords"]
                })

            elif dec == "MERGE":
                lines_to_remove.add(ann["line_idx"])  # remove individual member box
                grp = tuple(sorted(b.get("merge_group", [])))
                if grp not in merge_groups_processed:
                    merge_groups_processed.add(grp)
                    # Gather member boxes
                    member_coords = []
                    member_cand_ids = []
                    for mb_id in grp:
                        m_box = next((x for x in boxes if x["box_idx"] == mb_id), None)
                        if not m_box:
                            raise ValueError(f"Member box #{mb_id} missing in merge group {grp} on {img_name}")
                        m_ann = matched_lines_by_box[mb_id]
                        member_coords.append(m_ann["coords"])
                        member_cand_ids.append(m_box["candidate_id"])

                    merged_box = compute_merged_box(member_coords)
                    new_merged_lines.append(
                        f"0 {merged_box[0]:.6f} {merged_box[1]:.6f} {merged_box[2]:.6f} {merged_box[3]:.6f}"
                    )
                    merge_operations.append({
                        "image_name": img_name,
                        "label_file": lbl_path.name,
                        "merge_group_box_ids": list(grp),
                        "member_candidate_ids": member_cand_ids,
                        "original_boxes": member_coords,
                        "resulting_merged_box": merged_box
                    })

            elif dec in ("KEEP", "SEPARATE"):
                # Retain line as-is
                pass

        # Construct final v3 label lines for this image
        final_lines = []
        for item in parsed_lines:
            if item["cid"] != 0:
                final_lines.append(item["raw"])
                v3_class_counts[item["cid"]] += 1
            else:
                if item["line_idx"] not in lines_to_remove:
                    final_lines.append(item["raw"])
                    v3_class_counts[0] += 1

        # Append newly created merged boxes
        for ml in new_merged_lines:
            final_lines.append(ml)
            v3_class_counts[0] += 1

        # Check if file changed
        dst_path = dst_train_lbl_dir / lbl_path.name
        with open(dst_path, "w", encoding="utf-8") as f:
            for line in final_lines:
                f.write(f"{line}\n")

        # Verify Class 1, 2, 3 annotations remained identical
        v2_non_road = [p["raw"] for p in parsed_lines if p["cid"] != 0]
        v3_non_road = [line for line in final_lines if not line.startswith("0 ")]
        if v2_non_road != v3_non_road:
            class123_mismatches.append(lbl_path.name)

        if raw_lines != final_lines:
            changed_files.append(lbl_path.name)
        else:
            unchanged_files.append(lbl_path.name)

    assert len(class123_mismatches) == 0, f"Class 1/2/3 modified in: {class123_mismatches}"
    print("   [PASS] Class 1, 2, and 3 annotations in TRAIN are 100% preserved.")
    print(f"   - Changed TRAIN label files  : {len(changed_files)}")
    print(f"   - Unchanged TRAIN label files: {len(unchanged_files)} (Total: {len(train_label_files)})")
    print(f"   - Class 0 boxes removed      : {len(remove_operations)}")
    print(f"   - Merge groups applied       : {len(merge_operations)}")

    # 6. Write data.yaml for v3
    print("\n6. Creating data/datasets/neighborlens_v3/data.yaml...")
    data_yaml_content = (
        "path: data/datasets/neighborlens_v3\n"
        "train: images/train\n"
        "val: images/val\n"
        "test: images/test\n\n"
        "nc: 4\n"
        "names:\n"
        "  0: damaged_road\n"
        "  1: clogged_drainage\n"
        "  2: damaged_street_light\n"
        "  3: damaged_traffic_light\n"
    )
    v3_yaml_path = v3_dir / "data.yaml"
    with open(v3_yaml_path, "w", encoding="utf-8") as f:
        f.write(data_yaml_content)

    print("   [PASS] data/datasets/neighborlens_v3/data.yaml written.")

    # 7. Validate with Ultralytics
    print("\n7. Validating with Ultralytics check_det_dataset...")
    from ultralytics.data.utils import check_det_dataset
    ultralytics_info = check_det_dataset(str(v3_yaml_path))
    print(f"   [PASS] Ultralytics check_det_dataset PASS: nc={ultralytics_info.get('nc')}, names={ultralytics_info.get('names')}")

    # 8. Summary of Object Counts
    boxes_consumed_by_merges = sum(len(m["merge_group_box_ids"]) for m in merge_operations)
    merged_boxes_produced = len(merge_operations)
    consolidation_reduction = boxes_consumed_by_merges - merged_boxes_produced
    net_class0_change = -(len(remove_operations) + consolidation_reduction)

    assert v3_class_counts[0] == v2_class_counts[0] + net_class0_change, "Class 0 count arithmetic mismatch!"
    assert v3_class_counts[1] == v2_class_counts[1], "Class 1 count modified!"
    assert v3_class_counts[2] == v2_class_counts[2], "Class 2 count modified!"
    assert v3_class_counts[3] == v2_class_counts[3], "Class 3 count modified!"

    audit_summary = {
        "dataset_name": "neighborlens_v3",
        "source_dataset": "neighborlens_v2",
        "lineage": "neighborlens_v1 -> neighborlens_v2 -> neighborlens_v3",
        "total_images": sum(image_counts.values()),
        "image_split_counts": image_counts,
        "val_test_labels_identical": len(val_test_sha_mismatches) == 0,
        "class123_preserved": len(class123_mismatches) == 0,
        "train_label_files_total": len(train_label_files),
        "train_label_files_changed": len(changed_files),
        "train_label_files_unchanged": len(unchanged_files),
        "changed_files_list": sorted(changed_files),
        "class0_removals_count": len(remove_operations),
        "merge_groups_count": len(merge_operations),
        "boxes_consumed_by_merges": boxes_consumed_by_merges,
        "merged_boxes_produced": merged_boxes_produced,
        "consolidation_reduction": consolidation_reduction,
        "net_class0_change": net_class0_change,
        "v2_train_counts": dict(v2_class_counts),
        "v3_train_counts": dict(v3_class_counts),
        "remove_operations": remove_operations,
        "merge_operations": merge_operations
    }

    print("\n" + "=" * 75)
    print("EXPERIMENT E-3 DATASET CONSTRUCTION COMPLETE & AUDITED")
    print("=" * 75)
    print(f"v2 TRAIN Class 0 count: {v2_class_counts[0]}")
    print(f"  - Removed boxes     : {len(remove_operations)}")
    print(f"  - Consolidated boxes: {consolidation_reduction} ({boxes_consumed_by_merges} consumed -> {merged_boxes_produced} produced)")
    print(f"v3 TRAIN Class 0 count: {v3_class_counts[0]} (Net change: {net_class0_change})")
    print("-" * 75)
    print(f"v2 TRAIN Total Objects: {sum(v2_class_counts.values())}")
    print(f"v3 TRAIN Total Objects: {sum(v3_class_counts.values())} (Net change: {net_class0_change})")
    print("=" * 75)

    return audit_summary

def main():
    parser = argparse.ArgumentParser(description="Build neighborlens_v3 dataset from v2 and review ledger")
    parser.add_argument("--v2-dir", type=Path, default=V2_DIR, help="Path to neighborlens_v2")
    parser.add_argument("--v3-dir", type=Path, default=V3_DIR, help="Path to neighborlens_v3")
    parser.add_argument("--ledger", type=Path, default=LEDGER_PATH, help="Path to ROAD_REVIEW_DECISIONS.json")
    parser.add_argument("--force", action="store_true", help="Force overwrite of existing v3 directory")
    args = parser.parse_args()

    audit = build_v3_dataset(args.v2_dir, args.v3_dir, args.ledger, args.force)

    # Save machine-readable audit report
    audit_json_path = WORKSPACE_ROOT / "scratch" / "phase3_e3_v3_construction_audit.json"
    with open(audit_json_path, "w", encoding="utf-8") as f:
        json.dump(audit, f, indent=2)

    print(f"\nAudit manifest saved to: {audit_json_path}")

if __name__ == "__main__":
    main()
