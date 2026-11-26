"""
Neighborlens AI Road Annotation Review Decision Validator
============================================================
Validates human review decisions in ROAD_REVIEW_DECISIONS.json without
modifying any dataset files.

Safety Rules Enforced:
1. Valid decision values only: KEEP, MERGE, SEPARATE, REMOVE.
2. Zero decisions permitted on frozen splits (val/test).
3. MERGE groups must contain >= 2 valid box IDs on the same image.
4. MERGE groups must be mutually consistent and non-overlapping.
5. No box may be simultaneously marked MERGE and REMOVE.
6. All referenced images and box IDs must exist.
7. Remediation readiness gate: Only READY when 100% of TRAIN candidates
   are resolved with zero conflicts or invalid records.
"""

import sys
import json
import argparse
from pathlib import Path
from typing import Dict, Any, List, Set, Tuple

ALLOWED_DECISIONS = {"KEEP", "MERGE", "SEPARATE", "REMOVE"}
WORKSPACE_ROOT = Path(__file__).resolve().parents[3]
DEFAULT_DECISIONS_PATH = WORKSPACE_ROOT / "data" / "datasets" / "annotation_input" / "road_v1" / "ROAD_REVIEW_DECISIONS.json"
DEFAULT_TRAIN_IMG_DIR = WORKSPACE_ROOT / "data" / "datasets" / "neighborlens_v2" / "images" / "train"

def validate_review_decisions(
    decisions_path: Path,
    train_images_dir: Path = None,
    allow_unresolved: bool = True
) -> Dict[str, Any]:
    """
    Validates ROAD_REVIEW_DECISIONS.json.
    Returns a dictionary of metrics, errors, and readiness status.
    """
    if not decisions_path.exists():
        return {
            "valid": False,
            "fatal_error": f"Decisions file not found: {decisions_path}",
            "readiness": "NOT READY"
        }

    with open(decisions_path, "r", encoding="utf-8") as f:
        try:
            data = json.load(f)
        except json.JSONDecodeError as e:
            return {
                "valid": False,
                "fatal_error": f"JSON decode error in {decisions_path}: {e}",
                "readiness": "NOT READY"
            }

    images = data.get("images", {})
    if not images:
        return {
            "valid": False,
            "fatal_error": "No 'images' object found in decisions file.",
            "readiness": "NOT READY"
        }

    errors: List[str] = []
    conflicts: List[str] = []

    train_images_count = 0
    train_images_reviewed = 0
    
    total_train_boxes = 0
    resolved_train_boxes = 0
    unresolved_train_boxes = 0

    keep_count = 0
    separate_count = 0
    remove_count = 0
    
    # Store unique merge groups: set of tuples (image_name, frozenset(box_ids))
    merge_groups_set: Set[Tuple[str, Tuple[int, ...]]] = set()

    val_test_tampered_boxes = 0

    for img_name, img_data in images.items():
        split = img_data.get("split", "")
        boxes = img_data.get("boxes", [])

        # 1. Enforce frozen split boundary
        if split in ("val", "test"):
            for b in boxes:
                dec = b.get("human_decision", "").strip().upper()
                if dec != "":
                    val_test_tampered_boxes += 1
                    errors.append(
                        f"FROZEN SPLIT VIOLATION: Image '{img_name}' is in split '{split}', "
                        f"but candidate box #{b.get('box_idx')} has human_decision='{dec}'. "
                        "Val/Test annotations must remain permanently untouched."
                    )
            continue  # Skip counting val/test in train metrics

        if split != "train":
            errors.append(f"Unknown split '{split}' for image '{img_name}'.")
            continue

        train_images_count += 1

        # Check if physical image exists if train_images_dir provided
        if train_images_dir and train_images_dir.exists():
            img_file = train_images_dir / img_name
            if not img_file.exists():
                errors.append(f"Nonexistent image reference: '{img_name}' not in {train_images_dir}")

        image_box_indices = {b.get("box_idx") for b in boxes if b.get("box_idx") is not None}
        img_resolved_boxes = 0
        img_merge_assignments: Dict[int, List[int]] = {}
        img_remove_boxes: Set[int] = set()

        for b in boxes:
            total_train_boxes += 1
            box_idx = b.get("box_idx")
            cand_id = b.get("candidate_id")
            dec = b.get("human_decision", "").strip().upper()
            merge_group = b.get("merge_group", [])

            if box_idx is None:
                errors.append(f"Missing 'box_idx' in candidate #{cand_id} on '{img_name}'.")
                continue

            if dec == "":
                unresolved_train_boxes += 1
                continue

            if dec not in ALLOWED_DECISIONS:
                errors.append(
                    f"Invalid decision '{dec}' for candidate #{cand_id} (box #{box_idx}) on '{img_name}'. "
                    f"Must be one of {sorted(list(ALLOWED_DECISIONS))}."
                )
                continue

            resolved_train_boxes += 1
            img_resolved_boxes += 1

            if dec == "KEEP":
                keep_count += 1
                if merge_group:
                    errors.append(f"Box #{box_idx} on '{img_name}' is KEEP but has non-empty merge_group: {merge_group}.")

            elif dec == "SEPARATE":
                separate_count += 1
                if merge_group:
                    errors.append(f"Box #{box_idx} on '{img_name}' is SEPARATE but has non-empty merge_group: {merge_group}.")

            elif dec == "REMOVE":
                remove_count += 1
                img_remove_boxes.add(box_idx)
                if merge_group:
                    errors.append(f"Box #{box_idx} on '{img_name}' is REMOVE but has non-empty merge_group: {merge_group}.")

            elif dec == "MERGE":
                if not isinstance(merge_group, list) or len(merge_group) < 2:
                    errors.append(
                        f"Invalid MERGE group for box #{box_idx} on '{img_name}': "
                        f"merge_group must contain at least 2 box IDs (got {merge_group})."
                    )
                else:
                    sorted_group = sorted(merge_group)
                    # Box must be member of its own merge group
                    if box_idx not in merge_group:
                        errors.append(
                            f"Box #{box_idx} on '{img_name}' declared MERGE with {merge_group}, "
                            f"but is not included in its own merge group."
                        )
                    # All box IDs in merge group must exist on this image
                    for mb in merge_group:
                        if mb not in image_box_indices:
                            errors.append(
                                f"Nonexistent box #{mb} referenced in merge_group of box #{box_idx} on '{img_name}'."
                            )

                    img_merge_assignments[box_idx] = sorted_group
                    merge_groups_set.add((img_name, tuple(sorted_group)))

        # Validate merge group consistency on this image
        for b_id, grp in img_merge_assignments.items():
            # Check overlap with REMOVE
            if b_id in img_remove_boxes:
                conflicts.append(
                    f"CONFLICT on '{img_name}': Box #{b_id} is marked both MERGE (group {grp}) and REMOVE."
                )
            # Check sibling symmetry: every other box in grp must also have human_decision='MERGE' and identical group
            for sibling_id in grp:
                sibling_box = next((b for b in boxes if b.get("box_idx") == sibling_id), None)
                if sibling_box is None:
                    continue  # already flagged as nonexistent
                sibling_dec = sibling_box.get("human_decision", "").strip().upper()
                sibling_grp = sorted(sibling_box.get("merge_group", []))
                if sibling_dec != "MERGE":
                    conflicts.append(
                        f"ASYMMETRIC MERGE on '{img_name}': Box #{b_id} declared MERGE with #{sibling_id}, "
                        f"but Box #{sibling_id} has decision='{sibling_dec}' (not MERGE)."
                    )
                elif sibling_grp != grp:
                    conflicts.append(
                        f"CONFLICTING MERGE on '{img_name}': Box #{b_id} merge_group is {grp} "
                        f"while sibling #{sibling_id} merge_group is {sibling_grp}."
                    )

        # Mark image as reviewed if all candidate boxes on this image have decisions
        if len(boxes) > 0 and img_resolved_boxes == len(boxes):
            train_images_reviewed += 1

    train_images_remaining = train_images_count - train_images_reviewed
    unique_merge_groups_count = len(merge_groups_set)

    is_ready = (
        len(errors) == 0
        and len(conflicts) == 0
        and val_test_tampered_boxes == 0
        and unresolved_train_boxes == 0
        and total_train_boxes > 0
    )

    readiness = "READY" if is_ready else "NOT READY"

    return {
        "valid": len(errors) == 0 and len(conflicts) == 0,
        "readiness": readiness,
        "train_candidate_images": train_images_count,
        "train_images_reviewed": train_images_reviewed,
        "train_images_remaining": train_images_remaining,
        "train_candidate_boxes": total_train_boxes,
        "resolved_boxes": resolved_train_boxes,
        "unresolved_boxes": unresolved_train_boxes,
        "keep_count": keep_count,
        "merge_groups_count": unique_merge_groups_count,
        "separate_count": separate_count,
        "remove_count": remove_count,
        "conflicts_count": len(conflicts),
        "invalid_records_count": len(errors),
        "val_test_tampered_boxes": val_test_tampered_boxes,
        "errors": errors,
        "conflicts": conflicts
    }

def print_summary(res: Dict[str, Any]):
    """Formats and prints validation results to stdout."""
    print("=" * 60)
    print("Neighborlens AI Human Review Progress Validator")
    print("=" * 60)
    print(f"TRAIN candidate images: {res.get('train_candidate_images', 0)}")
    print(f"Reviewed              : {res.get('train_images_reviewed', 0)}")
    print(f"Remaining             : {res.get('train_images_remaining', 0)}")
    print("-" * 60)
    print(f"Candidate boxes       : {res.get('train_candidate_boxes', 0)}")
    print(f"Resolved              : {res.get('resolved_boxes', 0)}")
    print(f"Unresolved            : {res.get('unresolved_boxes', 0)}")
    print("-" * 60)
    print(f"KEEP                  : {res.get('keep_count', 0)}")
    print(f"MERGE groups          : {res.get('merge_groups_count', 0)}")
    print(f"SEPARATE              : {res.get('separate_count', 0)}")
    print(f"REMOVE                : {res.get('remove_count', 0)}")
    print("-" * 60)
    print(f"Conflicts             : {res.get('conflicts_count', 0)}")
    print(f"Invalid records       : {res.get('invalid_records_count', 0)}")
    if res.get('val_test_tampered_boxes', 0) > 0:
        print(f"VAL/TEST VIOLATIONS   : {res.get('val_test_tampered_boxes')}")
    print("=" * 60)
    print(f"E-3 remediation readiness: {res.get('readiness')}")
    print("=" * 60)

    if res.get("errors"):
        print("\n[VALIDATION ERRORS]")
        for err in res["errors"][:15]:
            print(f"  - {err}")
        if len(res["errors"]) > 15:
            print(f"  ... and {len(res['errors']) - 15} more errors.")

    if res.get("conflicts"):
        print("\n[DECISION CONFLICTS]")
        for c in res["conflicts"][:15]:
            print(f"  - {c}")
        if len(res["conflicts"]) > 15:
            print(f"  ... and {len(res['conflicts']) - 15} more conflicts.")

def main():
    parser = argparse.ArgumentParser(description="Validate NeighborLens Road Annotation Human Decisions")
    parser.add_argument("--decisions", type=Path, default=DEFAULT_DECISIONS_PATH, help="Path to ROAD_REVIEW_DECISIONS.json")
    parser.add_argument("--train-dir", type=Path, default=DEFAULT_TRAIN_IMG_DIR, help="Path to neighborlens_v2/images/train")
    parser.add_argument("--strict", action="store_true", help="Exit with non-zero status if NOT READY")
    args = parser.parse_args()

    res = validate_review_decisions(args.decisions, args.train_dir)
    print_summary(res)

    if args.strict and res["readiness"] != "READY":
        sys.exit(1)
    if not res["valid"]:
        sys.exit(2)

if __name__ == "__main__":
    main()
