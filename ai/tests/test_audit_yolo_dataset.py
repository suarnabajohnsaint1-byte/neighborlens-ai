import json
import sys
from pathlib import Path

import cv2
import numpy as np
import pytest

SCRIPTS_DIR = Path(__file__).resolve().parents[1] / "preprocessing"
sys.path.insert(0, str(SCRIPTS_DIR))

import audit_yolo_dataset as audit

CLASS_NAMES = {
    0: "damaged_road",
    1: "clogged_drainage",
    2: "damaged_street_light",
    3: "damaged_traffic_light",
}


def create_image(path: Path, value: int = 128):
    image = np.full((100, 100, 3), value, dtype=np.uint8)
    cv2.imwrite(str(path), image)


def create_dataset_structure(root: Path):
    for split in ("train", "val", "test"):
        (root / "images" / split).mkdir(parents=True, exist_ok=True)
        (root / "labels" / split).mkdir(parents=True, exist_ok=True)


def write_pair(
    root: Path,
    split: str,
    name: str,
    label_content: str,
    image_value: int = 128,
):
    create_image(root / "images" / split / f"{name}.jpg", image_value)
    (root / "labels" / split / f"{name}.txt").write_text(
        label_content,
        encoding="utf-8",
    )


# ---------------------------------------------------------------------------
# Unit tests for basic functions
# ---------------------------------------------------------------------------

def test_helper_functions():
    assert audit.hamming_dist("1010", "1000") == 1
    assert audit.hamming_dist("1010", "1010") == 0
    assert callable(audit.compute_sha256)
    assert callable(audit.compute_64phash)
    assert callable(audit.audit_dataset)


# ---------------------------------------------------------------------------
# Test A: Valid dataset
# ---------------------------------------------------------------------------

def test_valid_dataset(tmp_path):
    root = tmp_path / "dataset"
    create_dataset_structure(root)

    write_pair(root, "train", "road", "0 0.5 0.5 0.4 0.4\n", 50)
    write_pair(root, "val", "drainage", "1 0.5 0.5 0.4 0.4\n", 100)
    write_pair(root, "test", "streetlight", "2 0.5 0.5 0.4 0.4\n", 150)
    write_pair(root, "test", "trafficlight", "3 0.5 0.5 0.4 0.4\n", 200)

    result = audit.audit_dataset(root, CLASS_NAMES)

    assert result["totals"]["images"] == 4
    assert result["totals"]["labels"] == 4
    assert result["totals"]["objects"] == 4
    assert result["totals"]["empty_labels"] == 0
    assert result["totals"]["malformed_lines"] == 0
    assert result["totals"]["invalid_coords"] == 0
    assert result["totals"]["invalid_class_ids"] == 0
    assert result["totals"]["orphan_images"] == 0
    assert result["totals"]["orphan_labels"] == 0

    assert result["class_totals"] == {0: 1, 1: 1, 2: 1, 3: 1}


# ---------------------------------------------------------------------------
# Test B: Orphan image
# ---------------------------------------------------------------------------

def test_orphan_image(tmp_path):
    root = tmp_path / "dataset"
    create_dataset_structure(root)

    write_pair(root, "train", "road", "0 0.5 0.5 0.4 0.4\n", 50)
    create_image(root / "images" / "train" / "orphan.jpg", 80)

    result = audit.audit_dataset(root, CLASS_NAMES)

    assert result["totals"]["orphan_images"] == 1


# ---------------------------------------------------------------------------
# Test C: Orphan label
# ---------------------------------------------------------------------------

def test_orphan_label(tmp_path):
    root = tmp_path / "dataset"
    create_dataset_structure(root)

    write_pair(root, "train", "road", "0 0.5 0.5 0.4 0.4\n", 50)
    (root / "labels" / "train" / "orphan.txt").write_text(
        "0 0.5 0.5 0.4 0.4\n", encoding="utf-8"
    )

    result = audit.audit_dataset(root, CLASS_NAMES)

    assert result["totals"]["orphan_labels"] == 1


# ---------------------------------------------------------------------------
# Test D: Empty label
# ---------------------------------------------------------------------------

def test_empty_label(tmp_path):
    root = tmp_path / "dataset"
    create_dataset_structure(root)

    write_pair(root, "train", "empty", "", 50)

    result = audit.audit_dataset(root, CLASS_NAMES)

    assert result["totals"]["empty_labels"] == 1


# ---------------------------------------------------------------------------
# Test E: Malformed YOLO annotation (wrong number of tokens)
# ---------------------------------------------------------------------------

def test_malformed_annotation(tmp_path):
    root = tmp_path / "dataset"
    create_dataset_structure(root)

    write_pair(root, "train", "bad", "0 0.5 0.5\n", 50)

    result = audit.audit_dataset(root, CLASS_NAMES)

    assert result["totals"]["malformed_lines"] == 1


# ---------------------------------------------------------------------------
# Test F: Non-numeric annotation
# ---------------------------------------------------------------------------

def test_non_numeric_annotation(tmp_path):
    root = tmp_path / "dataset"
    create_dataset_structure(root)

    write_pair(root, "train", "bad", "0 0.5 ABC 0.4 0.4\n", 50)

    result = audit.audit_dataset(root, CLASS_NAMES)

    assert result["totals"]["malformed_lines"] == 1


# ---------------------------------------------------------------------------
# Test G: Invalid class ID
# ---------------------------------------------------------------------------

def test_invalid_class_id(tmp_path):
    root = tmp_path / "dataset"
    create_dataset_structure(root)

    write_pair(root, "train", "bad", "99 0.5 0.5 0.4 0.4\n", 50)

    result = audit.audit_dataset(root, CLASS_NAMES)

    assert result["totals"]["invalid_class_ids"] == 1


# ---------------------------------------------------------------------------
# Test H: Invalid coordinates
# ---------------------------------------------------------------------------

def test_invalid_coordinates_out_of_bounds(tmp_path):
    root = tmp_path / "dataset"
    create_dataset_structure(root)

    write_pair(root, "train", "bad1", "0 1.5 0.5 0.4 0.4\n", 50)
    write_pair(root, "train", "bad2", "0 -0.1 0.5 0.4 0.4\n", 60)

    result = audit.audit_dataset(root, CLASS_NAMES)

    assert result["totals"]["invalid_coords"] == 2


def test_invalid_coordinates_zero_dimensions(tmp_path):
    root = tmp_path / "dataset"
    create_dataset_structure(root)

    write_pair(root, "train", "zero_w", "0 0.5 0.5 0.0 0.4\n", 50)
    write_pair(root, "train", "zero_h", "0 0.5 0.5 0.4 0.0\n", 60)

    result = audit.audit_dataset(root, CLASS_NAMES)

    assert result["totals"]["invalid_coords"] == 2


# ---------------------------------------------------------------------------
# Test 6: Class distribution test (known counts)
# ---------------------------------------------------------------------------

def test_exact_class_distribution(tmp_path):
    root = tmp_path / "dataset"
    create_dataset_structure(root)

    # Class 0: 3 objects across 2 images
    write_pair(root, "train", "c0_a", "0 0.2 0.2 0.1 0.1\n0 0.8 0.8 0.1 0.1\n", 10)
    write_pair(root, "val", "c0_b", "0 0.5 0.5 0.2 0.2\n", 20)

    # Class 1: 2 objects
    write_pair(root, "train", "c1", "1 0.5 0.5 0.3 0.3\n1 0.2 0.2 0.1 0.1\n", 30)

    # Class 2: 4 objects
    write_pair(
        root, "test", "c2",
        "2 0.1 0.1 0.05 0.05\n2 0.2 0.2 0.05 0.05\n2 0.3 0.3 0.05 0.05\n2 0.4 0.4 0.05 0.05\n",
        40,
    )

    # Class 3: 1 object
    write_pair(root, "test", "c3", "3 0.5 0.5 0.1 0.1\n", 50)

    result = audit.audit_dataset(root, CLASS_NAMES)

    assert result["class_totals"][0] == 3
    assert result["class_totals"][1] == 2
    assert result["class_totals"][2] == 4
    assert result["class_totals"][3] == 1
    assert result["totals"]["objects"] == 10


# ---------------------------------------------------------------------------
# Test 7: Image composition test (single vs multi-class)
# ---------------------------------------------------------------------------

def test_image_composition(tmp_path):
    root = tmp_path / "dataset"
    create_dataset_structure(root)

    write_pair(root, "train", "only_0", "0 0.5 0.5 0.2 0.2\n", 10)
    write_pair(root, "train", "only_1", "1 0.5 0.5 0.2 0.2\n", 20)
    write_pair(root, "val", "only_2", "2 0.5 0.5 0.2 0.2\n", 30)
    write_pair(root, "test", "only_3", "3 0.5 0.5 0.2 0.2\n", 40)
    write_pair(
        root, "train", "mixed_0_1",
        "0 0.3 0.3 0.2 0.2\n1 0.7 0.7 0.2 0.2\n",
        50,
    )

    result = audit.audit_dataset(root, CLASS_NAMES)

    comp = result["image_composition"]
    assert comp["only_class_0"] == 1
    assert comp["only_class_1"] == 1
    assert comp["only_class_2"] == 1
    assert comp["only_class_3"] == 1
    assert comp["multi_class"] == 1
    assert len(comp["multi_class_files"]) == 1
    # Check that the multi-class file was recorded
    assert comp["multi_class_files"][0]["file"] == "mixed_0_1.txt"


# ---------------------------------------------------------------------------
# Test 8: Exact duplicate detection & cross-split leakage
# ---------------------------------------------------------------------------

def test_exact_duplicate_cross_split_leakage(tmp_path):
    root = tmp_path / "dataset"
    create_dataset_structure(root)

    # Identical image content in train and test
    write_pair(root, "train", "dup_train", "0 0.5 0.5 0.2 0.2\n", 77)
    write_pair(root, "test", "dup_test", "0 0.5 0.5 0.2 0.2\n", 77)

    result = audit.audit_dataset(root, CLASS_NAMES)

    assert len(result["exact_duplicates"]) >= 1
    assert len(result["split_leakage_sha256"]) >= 1


# ---------------------------------------------------------------------------
# Test 9: pHash near-duplicate detection
# ---------------------------------------------------------------------------

def test_phash_near_duplicate_detection(tmp_path):
    root = tmp_path / "dataset"
    create_dataset_structure(root)

    # Create base image with geometric shapes
    img = np.zeros((100, 100, 3), dtype=np.uint8)
    cv2.circle(img, (50, 50), 30, (255, 255, 255), -1)
    cv2.rectangle(img, (20, 20), (40, 40), (128, 128, 128), -1)

    # Near-duplicates: same physical scene saved at slightly different compression levels
    # This yields different SHA-256 hashes but low/zero Hamming distance in DCT pHash
    p1 = root / "images" / "train" / "base.jpg"
    p2 = root / "images" / "train" / "near.jpg"
    cv2.imwrite(str(p1), img, [cv2.IMWRITE_JPEG_QUALITY, 95])
    cv2.imwrite(str(p2), img, [cv2.IMWRITE_JPEG_QUALITY, 90])

    (root / "labels" / "train" / "base.txt").write_text("0 0.5 0.5 0.6 0.6\n")
    (root / "labels" / "train" / "near.txt").write_text("0 0.5 0.5 0.6 0.6\n")

    result = audit.audit_dataset(root, CLASS_NAMES)

    assert len(result["near_duplicate_pairs"]) >= 1
    pair = result["near_duplicate_pairs"][0]
    assert pair["hamming_distance"] <= 6


def test_phash_unit_functions(tmp_path):
    img1_p = tmp_path / "img1.png"
    img2_p = tmp_path / "img2.png"

    arr = np.zeros((64, 64, 3), dtype=np.uint8)
    arr[10:50, 10:50] = 200
    cv2.imwrite(str(img1_p), arr)
    cv2.imwrite(str(img2_p), arr)

    h1 = audit.compute_64phash(img1_p)
    h2 = audit.compute_64phash(img2_p)

    assert h1 is not None and len(h1) == 64
    assert audit.hamming_dist(h1, h2) == 0


# ---------------------------------------------------------------------------
# Test 10: Missing dataset path error handling
# ---------------------------------------------------------------------------

def test_missing_dataset_path(tmp_path):
    root = tmp_path / "nonexistent_dir"

    with pytest.raises(SystemExit):
        audit.audit_dataset(root, CLASS_NAMES)


# ---------------------------------------------------------------------------
# Test 11: JSON output structure
# ---------------------------------------------------------------------------

def test_json_output(tmp_path):
    root = tmp_path / "dataset"
    create_dataset_structure(root)

    write_pair(root, "train", "road", "0 0.5 0.5 0.4 0.4\n", 50)
    write_pair(root, "val", "drainage", "1 0.5 0.5 0.4 0.4\n", 100)
    write_pair(root, "test", "streetlight", "2 0.5 0.5 0.4 0.4\n", 150)

    result = audit.audit_dataset(root, CLASS_NAMES)

    json_path = tmp_path / "audit_out.json"
    clean_results = {k: v for k, v in result.items() if k != "sha256_hashes"}
    json_path.write_text(json.dumps(clean_results, indent=2), encoding="utf-8")

    loaded = json.loads(json_path.read_text(encoding="utf-8"))

    assert "totals" in loaded
    assert "splits" in loaded
    assert "class_totals" in loaded
    assert "image_composition" in loaded
    assert "sha256_hashes" not in loaded
    assert loaded["totals"]["images"] == 3
    assert loaded["totals"]["labels"] == 3
    assert loaded["totals"]["objects"] == 3
