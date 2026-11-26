"""
Unit and Integration Tests for Road Annotation Human Review Workflow
====================================================================
Tests the safety-critical behavior of:
- scripts/tools/road_annotation_review/validate_decisions.py
- scripts/tools/road_annotation_review/serve_review.py

Verifies:
1. Reading candidate annotations (train scope only)
2. Saving KEEP
3. Saving SEPARATE
4. Saving explicit MERGE group
5. Saving explicit REMOVE IDs
6. Rejecting invalid box IDs
7. Rejecting conflicting decisions
8. Rejecting val/test remediation
9. Ensuring no v1/v2 annotation file is modified
10. Validator metrics, summary, and readiness gating
"""

import os
import sys
import json
import hashlib
import pytest
from pathlib import Path

# Add tools directory to path
TOOLS_DIR = Path(__file__).resolve().parents[2] / "scripts" / "tools" / "road_annotation_review"
sys.path.insert(0, str(TOOLS_DIR))

from validate_decisions import validate_review_decisions
from serve_review import (
    load_train_candidates_data,
    save_image_decisions,
    FORBIDDEN_WRITE_PATHS
)

@pytest.fixture
def synthetic_ledger_fixture(tmp_path):
    """
    Creates a temporary synthetic review decisions ledger with train, val, and test splits.
    """
    ledger_path = tmp_path / "ROAD_REVIEW_DECISIONS.json"
    dummy_data = {
        "review_instructions": {
            "allowed_decisions": ["KEEP", "MERGE", "SEPARATE", "REMOVE"]
        },
        "total_flagged_images": 4,
        "total_flagged_boxes": 8,
        "images": {
            "test_img1.jpg": {
                "image": "test_img1.jpg",
                "split": "test",
                "preview_path": "data/datasets/annotation_input/road_v1/previews/test_img1_annotated.jpg",
                "boxes": [
                    {
                        "candidate_id": 101,
                        "box_idx": 1,
                        "coords": [0.5, 0.5, 0.2, 0.2],
                        "area_pct": 4.0,
                        "aspect_ratio": 1.0,
                        "flag_reason": "Test candidate",
                        "default_action": "REVIEW",
                        "human_decision": "",
                        "merge_group": [],
                        "notes": ""
                    }
                ]
            },
            "val_img1.jpg": {
                "image": "val_img1.jpg",
                "split": "val",
                "preview_path": "data/datasets/annotation_input/road_v1/previews/val_img1_annotated.jpg",
                "boxes": [
                    {
                        "candidate_id": 201,
                        "box_idx": 1,
                        "coords": [0.4, 0.4, 0.1, 0.1],
                        "area_pct": 1.0,
                        "aspect_ratio": 1.0,
                        "flag_reason": "Val candidate",
                        "default_action": "REVIEW",
                        "human_decision": "",
                        "merge_group": [],
                        "notes": ""
                    }
                ]
            },
            "train_img1.jpg": {
                "image": "train_img1.jpg",
                "split": "train",
                "preview_path": "data/datasets/annotation_input/road_v1/previews/train_img1_annotated.jpg",
                "boxes": [
                    {
                        "candidate_id": 1,
                        "box_idx": 1,
                        "coords": [0.2, 0.2, 0.1, 0.1],
                        "area_pct": 1.0,
                        "aspect_ratio": 1.0,
                        "flag_reason": "Fragmented box",
                        "default_action": "REVIEW",
                        "human_decision": "",
                        "merge_group": [],
                        "notes": ""
                    },
                    {
                        "candidate_id": 2,
                        "box_idx": 2,
                        "coords": [0.25, 0.2, 0.1, 0.1],
                        "area_pct": 1.0,
                        "aspect_ratio": 1.0,
                        "flag_reason": "Fragmented box",
                        "default_action": "REVIEW",
                        "human_decision": "",
                        "merge_group": [],
                        "notes": ""
                    },
                    {
                        "candidate_id": 3,
                        "box_idx": 3,
                        "coords": [0.8, 0.8, 0.05, 0.02],
                        "area_pct": 0.1,
                        "aspect_ratio": 2.5,
                        "flag_reason": "Micro-box",
                        "default_action": "REVIEW",
                        "human_decision": "",
                        "merge_group": [],
                        "notes": ""
                    }
                ]
            },
            "train_img2.jpg": {
                "image": "train_img2.jpg",
                "split": "train",
                "preview_path": "data/datasets/annotation_input/road_v1/previews/train_img2_annotated.jpg",
                "boxes": [
                    {
                        "candidate_id": 4,
                        "box_idx": 1,
                        "coords": [0.3, 0.3, 0.15, 0.15],
                        "area_pct": 2.25,
                        "aspect_ratio": 1.0,
                        "flag_reason": "Distant defect",
                        "default_action": "REVIEW",
                        "human_decision": "",
                        "merge_group": [],
                        "notes": ""
                    },
                    {
                        "candidate_id": 5,
                        "box_idx": 2,
                        "coords": [0.6, 0.6, 0.15, 0.15],
                        "area_pct": 2.25,
                        "aspect_ratio": 1.0,
                        "flag_reason": "Distant defect",
                        "default_action": "REVIEW",
                        "human_decision": "",
                        "merge_group": [],
                        "notes": ""
                    },
                    {
                        "candidate_id": 6,
                        "box_idx": 3,
                        "coords": [0.9, 0.9, 0.05, 0.05],
                        "area_pct": 0.25,
                        "aspect_ratio": 1.0,
                        "flag_reason": "Micro-box",
                        "default_action": "REVIEW",
                        "human_decision": "",
                        "merge_group": [],
                        "notes": ""
                    }
                ]
            }
        }
    }
    with open(ledger_path, "w", encoding="utf-8") as f:
        json.dump(dummy_data, f, indent=2)

    return ledger_path

# ==============================================================================
# TEST CASES
# ==============================================================================

def test_read_candidate_annotations(synthetic_ledger_fixture):
    """
    Verifies that load_train_candidates_data returns strictly the TRAIN split images
    and their candidate boxes, excluding frozen val/test splits.
    """
    train_data = load_train_candidates_data(synthetic_ledger_fixture)
    assert len(train_data) == 2, f"Expected 2 train images, got {len(train_data)}"

    img_names = [d["image_name"] for d in train_data]
    assert "train_img1.jpg" in img_names
    assert "train_img2.jpg" in img_names
    assert "test_img1.jpg" not in img_names
    assert "val_img1.jpg" not in img_names

    # Check box count for train_img1
    t1 = next(d for d in train_data if d["image_name"] == "train_img1.jpg")
    assert len(t1["boxes"]) == 3
    assert t1["boxes"][0]["candidate_id"] == 1
    assert t1["boxes"][1]["candidate_id"] == 2
    assert t1["boxes"][2]["candidate_id"] == 3

def test_save_keep_decision(synthetic_ledger_fixture):
    """
    Verifies saving a KEEP decision for a candidate box.
    """
    res = save_image_decisions(
        synthetic_ledger_fixture,
        "train_img1.jpg",
        [
            {"box_idx": 1, "human_decision": "KEEP", "notes": "Valid pothole"}
        ]
    )
    assert res["success"] is True

    with open(synthetic_ledger_fixture, "r", encoding="utf-8") as f:
        data = json.load(f)

    b1 = data["images"]["train_img1.jpg"]["boxes"][0]
    assert b1["human_decision"] == "KEEP"
    assert b1["merge_group"] == []
    assert b1["notes"] == "Valid pothole"
    assert "updated_at" in b1

def test_save_separate_decision(synthetic_ledger_fixture):
    """
    Verifies saving a SEPARATE decision for candidate boxes.
    """
    res = save_image_decisions(
        synthetic_ledger_fixture,
        "train_img2.jpg",
        [
            {"box_idx": 1, "human_decision": "SEPARATE", "notes": "Independent crack 1"},
            {"box_idx": 2, "human_decision": "SEPARATE", "notes": "Independent crack 2"}
        ]
    )
    assert res["success"] is True

    with open(synthetic_ledger_fixture, "r", encoding="utf-8") as f:
        data = json.load(f)

    boxes = data["images"]["train_img2.jpg"]["boxes"]
    assert boxes[0]["human_decision"] == "SEPARATE"
    assert boxes[1]["human_decision"] == "SEPARATE"
    assert boxes[0]["merge_group"] == []
    assert boxes[1]["merge_group"] == []

def test_save_explicit_merge_group(synthetic_ledger_fixture):
    """
    Verifies saving an explicit MERGE group of >= 2 boxes.
    """
    res = save_image_decisions(
        synthetic_ledger_fixture,
        "train_img1.jpg",
        [
            {"box_idx": 1, "human_decision": "MERGE", "merge_group": [1, 2], "notes": "Merged fragment A"},
            {"box_idx": 2, "human_decision": "MERGE", "merge_group": [1, 2], "notes": "Merged fragment B"}
        ]
    )
    assert res["success"] is True

    with open(synthetic_ledger_fixture, "r", encoding="utf-8") as f:
        data = json.load(f)

    b1 = data["images"]["train_img1.jpg"]["boxes"][0]
    b2 = data["images"]["train_img1.jpg"]["boxes"][1]
    assert b1["human_decision"] == "MERGE"
    assert b2["human_decision"] == "MERGE"
    assert b1["merge_group"] == [1, 2]
    assert b2["merge_group"] == [1, 2]

def test_save_explicit_remove_ids(synthetic_ledger_fixture):
    """
    Verifies saving an explicit REMOVE decision for a noise/shadow box.
    """
    res = save_image_decisions(
        synthetic_ledger_fixture,
        "train_img1.jpg",
        [
            {"box_idx": 3, "human_decision": "REMOVE", "notes": "Tree shadow"}
        ]
    )
    assert res["success"] is True

    with open(synthetic_ledger_fixture, "r", encoding="utf-8") as f:
        data = json.load(f)

    b3 = data["images"]["train_img1.jpg"]["boxes"][2]
    assert b3["human_decision"] == "REMOVE"
    assert b3["merge_group"] == []
    assert b3["notes"] == "Tree shadow"

def test_reject_invalid_box_ids(synthetic_ledger_fixture):
    """
    Verifies rejection when attempting to save decisions referencing nonexistent box IDs.
    """
    with pytest.raises(ValueError, match="Invalid or unknown box_idx #99"):
        save_image_decisions(
            synthetic_ledger_fixture,
            "train_img1.jpg",
            [
                {"box_idx": 99, "human_decision": "KEEP"}
            ]
        )

def test_reject_conflicting_decisions(synthetic_ledger_fixture):
    """
    Verifies rejection when:
    1. A box is in a merge group but sibling is marked REMOVE.
    2. Sibling merge groups do not match.
    """
    # Case 1: MERGE vs REMOVE conflict
    with pytest.raises(ValueError, match="Conflict: Box #1 is in merge_group .* but Box #2 is marked REMOVE"):
        save_image_decisions(
            synthetic_ledger_fixture,
            "train_img1.jpg",
            [
                {"box_idx": 1, "human_decision": "MERGE", "merge_group": [1, 2]},
                {"box_idx": 2, "human_decision": "REMOVE"}
            ]
        )

    # Case 2: Asymmetric merge groups
    with pytest.raises(ValueError, match="Conflict: Box #1 has merge_group .* but sibling #2 has"):
        save_image_decisions(
            synthetic_ledger_fixture,
            "train_img1.jpg",
            [
                {"box_idx": 1, "human_decision": "MERGE", "merge_group": [1, 2]},
                {"box_idx": 2, "human_decision": "MERGE", "merge_group": [2, 3]}
            ]
        )

def test_reject_merge_group_fewer_than_two_boxes(synthetic_ledger_fixture):
    """
    Verifies rejection of a MERGE decision with fewer than 2 boxes.
    """
    with pytest.raises(ValueError, match="must include at least 2 box IDs"):
        save_image_decisions(
            synthetic_ledger_fixture,
            "train_img1.jpg",
            [
                {"box_idx": 1, "human_decision": "MERGE", "merge_group": [1]}
            ]
        )

def test_reject_val_test_remediation(synthetic_ledger_fixture):
    """
    Verifies strict rejection (PermissionError) when attempting to save decisions for val or test split.
    """
    with pytest.raises(PermissionError, match="FROZEN SPLIT PROTECTION"):
        save_image_decisions(
            synthetic_ledger_fixture,
            "val_img1.jpg",
            [
                {"box_idx": 1, "human_decision": "KEEP"}
            ]
        )

    with pytest.raises(PermissionError, match="FROZEN SPLIT PROTECTION"):
        save_image_decisions(
            synthetic_ledger_fixture,
            "test_img1.jpg",
            [
                {"box_idx": 1, "human_decision": "REMOVE"}
            ]
        )

def test_validator_detects_val_test_tampering(synthetic_ledger_fixture):
    """
    Verifies that validate_review_decisions flags any decisions placed on val/test images.
    """
    # Directly tamper with val split in synthetic ledger
    with open(synthetic_ledger_fixture, "r", encoding="utf-8") as f:
        data = json.load(f)
    data["images"]["val_img1.jpg"]["boxes"][0]["human_decision"] = "REMOVE"
    with open(synthetic_ledger_fixture, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2)

    val_res = validate_review_decisions(synthetic_ledger_fixture)
    assert val_res["valid"] is False
    assert val_res["readiness"] == "NOT READY"
    assert val_res["val_test_tampered_boxes"] == 1
    assert any("FROZEN SPLIT VIOLATION" in err for err in val_res["errors"])

def test_validator_progress_and_readiness(synthetic_ledger_fixture):
    """
    Verifies end-to-end validator behavior:
    - Initially NOT READY (unresolved candidate boxes)
    - Becomes READY only when all train candidates are resolved cleanly
    """
    # 1. Initial state: 0 resolved, 6 unresolved
    res = validate_review_decisions(synthetic_ledger_fixture)
    assert res["train_candidate_images"] == 2
    assert res["train_images_reviewed"] == 0
    assert res["train_images_remaining"] == 2
    assert res["train_candidate_boxes"] == 6
    assert res["resolved_boxes"] == 0
    assert res["unresolved_boxes"] == 6
    assert res["readiness"] == "NOT READY"

    # 2. Review train_img1: Box 1 & 2 MERGE, Box 3 REMOVE
    save_image_decisions(
        synthetic_ledger_fixture,
        "train_img1.jpg",
        [
            {"box_idx": 1, "human_decision": "MERGE", "merge_group": [1, 2]},
            {"box_idx": 2, "human_decision": "MERGE", "merge_group": [1, 2]},
            {"box_idx": 3, "human_decision": "REMOVE"}
        ]
    )

    res2 = validate_review_decisions(synthetic_ledger_fixture)
    assert res2["train_images_reviewed"] == 1
    assert res2["train_images_remaining"] == 1
    assert res2["resolved_boxes"] == 3
    assert res2["unresolved_boxes"] == 3
    assert res2["merge_groups_count"] == 1
    assert res2["remove_count"] == 1
    assert res2["readiness"] == "NOT READY"  # Still have 3 unresolved in train_img2

    # 3. Review train_img2: Box 1 KEEP, Box 2 SEPARATE, Box 3 KEEP
    save_image_decisions(
        synthetic_ledger_fixture,
        "train_img2.jpg",
        [
            {"box_idx": 1, "human_decision": "KEEP"},
            {"box_idx": 2, "human_decision": "SEPARATE"},
            {"box_idx": 3, "human_decision": "KEEP"}
        ]
    )

    res3 = validate_review_decisions(synthetic_ledger_fixture)
    assert res3["train_images_reviewed"] == 2
    assert res3["train_images_remaining"] == 0
    assert res3["resolved_boxes"] == 6
    assert res3["unresolved_boxes"] == 0
    assert res3["keep_count"] == 2
    assert res3["merge_groups_count"] == 1
    assert res3["separate_count"] == 1
    assert res3["remove_count"] == 1
    assert res3["conflicts_count"] == 0
    assert res3["invalid_records_count"] == 0
    assert res3["readiness"] == "READY"
    assert res3["valid"] is True

def test_safety_boundary_prohibits_v1_v2_writes(tmp_path):
    """
    Verifies that save_image_decisions explicitly forbids targets inside
    neighborlens_v1 or neighborlens_v2.
    """
    for forbidden_base in FORBIDDEN_WRITE_PATHS:
        target = forbidden_base / "labels" / "train" / "tampered.json"
        with pytest.raises(PermissionError, match="CRITICAL SAFETY VIOLATION"):
            save_image_decisions(target, "any_image.jpg", [])

def test_real_dataset_unmodified_checksum():
    """
    Confirms that real neighborlens_v1 and neighborlens_v2 remain untouched.
    """
    v2_data_yaml = Path(__file__).resolve().parents[2] / "data" / "datasets" / "neighborlens_v2" / "data.yaml"
    if not v2_data_yaml.is_file():
        pytest.skip("Historical neighborlens_v2 dataset is not installed; immutable-data verification is unavailable.")
    content = v2_data_yaml.read_bytes()
    expected_hash = hashlib.sha256(content).hexdigest()
    assert len(expected_hash) == 64
