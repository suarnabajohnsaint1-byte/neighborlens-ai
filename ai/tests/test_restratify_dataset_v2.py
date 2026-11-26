import hashlib
import sys
from pathlib import Path

import cv2
import numpy as np
import pytest

SCRIPTS_DIR = Path(__file__).resolve().parents[1] / "preprocessing"
sys.path.insert(0, str(SCRIPTS_DIR))

import restratify_dataset_v2 as restratify


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


def compute_file_sha256(filepath: Path) -> str:
    h = hashlib.sha256()
    with open(filepath, "rb") as f:
        while chunk := f.read(65536):
            h.update(chunk)
    return h.hexdigest()


def count_dataset_stats(root: Path):
    total_images = 0
    total_labels = 0
    class_counts = {0: 0, 1: 0, 2: 0, 3: 0}
    total_objects = 0

    for split in ("train", "val", "test"):
        img_dir = root / "images" / split
        lbl_dir = root / "labels" / split

        imgs = list(img_dir.glob("*.jpg")) + list(img_dir.glob("*.png"))
        lbls = list(lbl_dir.glob("*.txt"))

        total_images += len(imgs)
        total_labels += len(lbls)

        for lf in lbls:
            with open(lf, "r", encoding="utf-8") as f:
                for line in f:
                    parts = line.strip().split()
                    if parts:
                        cid = int(parts[0])
                        class_counts[cid] += 1
                        total_objects += 1

    return {
        "images": total_images,
        "labels": total_labels,
        "objects": total_objects,
        "class_counts": class_counts,
    }


# Helper to build a representative mini source dataset
def build_mini_source_dataset(src: Path):
    create_dataset_structure(src)

    # Class 0: 3 images (in train, val, test)
    write_pair(src, "train", "road_1", "0 0.5 0.5 0.3 0.3\n", 10)
    write_pair(src, "val", "road_2", "0 0.4 0.4 0.2 0.2\n", 20)
    write_pair(src, "test", "road_3", "0 0.6 0.6 0.2 0.2\n", 30)

    # Class 1: 3 images (in train, val, test)
    write_pair(src, "train", "drain_1", "1 0.5 0.5 0.4 0.4\n", 40)
    write_pair(src, "val", "drain_2", "1 0.4 0.4 0.3 0.3\n", 50)
    write_pair(src, "test", "drain_3", "1 0.6 0.6 0.3 0.3\n", 60)

    # Class 2: 5 images initially all in train (representing the blindspot in v1)
    for i in range(1, 6):
        write_pair(src, "train", f"light_{i}", f"2 0.{i} 0.{i} 0.1 0.2\n", 70 + i * 5)

    # Class 3: 4 images initially all in train
    for i in range(1, 5):
        write_pair(src, "train", f"traffic_{i}", f"3 0.{i} 0.{i} 0.1 0.1\n", 100 + i * 5)


# ---------------------------------------------------------------------------
# Test A: Image / Label atomicity
# ---------------------------------------------------------------------------

def test_image_label_atomicity(tmp_path):
    src = tmp_path / "src"
    dst = tmp_path / "dst"
    build_mini_source_dataset(src)

    restratify.build_restratified_dataset(src, dst)

    for split in ("train", "val", "test"):
        img_stems = {f.stem for f in (dst / "images" / split).glob("*")}
        lbl_stems = {f.stem for f in (dst / "labels" / split).glob("*.txt")}
        assert img_stems == lbl_stems, f"Mismatch in split {split}: {img_stems} vs {lbl_stems}"


# ---------------------------------------------------------------------------
# Test B: Total image count preservation
# ---------------------------------------------------------------------------

def test_total_image_preservation(tmp_path):
    src = tmp_path / "src"
    dst = tmp_path / "dst"
    build_mini_source_dataset(src)

    before_stats = count_dataset_stats(src)
    restratify.build_restratified_dataset(src, dst)
    after_stats = count_dataset_stats(dst)

    assert before_stats["images"] == after_stats["images"]
    assert before_stats["labels"] == after_stats["labels"]


# ---------------------------------------------------------------------------
# Test C: Total object count preservation
# ---------------------------------------------------------------------------

def test_total_object_preservation(tmp_path):
    src = tmp_path / "src"
    dst = tmp_path / "dst"
    build_mini_source_dataset(src)

    before_stats = count_dataset_stats(src)
    restratify.build_restratified_dataset(src, dst)
    after_stats = count_dataset_stats(dst)

    assert before_stats["objects"] == after_stats["objects"]


# ---------------------------------------------------------------------------
# Test 13: Annotation immutability (Byte-for-byte SHA256 match)
# ---------------------------------------------------------------------------

def test_annotation_immutability(tmp_path):
    src = tmp_path / "src"
    dst = tmp_path / "dst"
    build_mini_source_dataset(src)

    before_hashes = {}
    for f in (src / "labels").rglob("*.txt"):
        before_hashes[f.name] = compute_file_sha256(f)

    restratify.build_restratified_dataset(src, dst)

    after_hashes = {}
    for f in (dst / "labels").rglob("*.txt"):
        after_hashes[f.name] = compute_file_sha256(f)

    assert set(before_hashes.keys()) == set(after_hashes.keys())
    for fname in before_hashes:
        assert before_hashes[fname] == after_hashes[fname], f"Label {fname} was modified!"


# ---------------------------------------------------------------------------
# Test 14: Per-class preservation
# ---------------------------------------------------------------------------

def test_class_preservation(tmp_path):
    src = tmp_path / "src"
    dst = tmp_path / "dst"
    build_mini_source_dataset(src)

    before_stats = count_dataset_stats(src)
    restratify.build_restratified_dataset(src, dst)
    after_stats = count_dataset_stats(dst)

    for cid in (0, 1, 2, 3):
        assert before_stats["class_counts"][cid] == after_stats["class_counts"][cid]


# ---------------------------------------------------------------------------
# Test 15: Determinism test
# ---------------------------------------------------------------------------

def test_determinism(tmp_path):
    src = tmp_path / "src"
    dst1 = tmp_path / "dst1"
    dst2 = tmp_path / "dst2"
    build_mini_source_dataset(src)

    restratify.build_restratified_dataset(src, dst1)
    restratify.build_restratified_dataset(src, dst2)

    for split in ("train", "val", "test"):
        imgs1 = sorted([f.name for f in (dst1 / "images" / split).glob("*")])
        imgs2 = sorted([f.name for f in (dst2 / "images" / split).glob("*")])
        assert imgs1 == imgs2, f"Split {split} images differ between runs"

        lbls1 = sorted([f.name for f in (dst1 / "labels" / split).glob("*.txt")])
        lbls2 = sorted([f.name for f in (dst2 / "labels" / split).glob("*.txt")])
        assert lbls1 == lbls2, f"Split {split} labels differ between runs"


# ---------------------------------------------------------------------------
# Test 16: Multi-class image integrity
# ---------------------------------------------------------------------------

def test_multi_class_image_integrity(tmp_path):
    src = tmp_path / "src"
    dst = tmp_path / "dst"
    create_dataset_structure(src)

    # Multi-class image with road and drainage
    write_pair(
        src, "train", "mixed_road_drain",
        "0 0.25 0.25 0.2 0.2\n1 0.75 0.75 0.2 0.2\n",
        50,
    )
    # Give single class sample for other classes to satisfy logic
    write_pair(src, "train", "street_1", "2 0.5 0.5 0.2 0.2\n", 70)
    write_pair(src, "train", "street_2", "2 0.5 0.5 0.2 0.2\n", 71)
    write_pair(src, "train", "traffic_1", "3 0.5 0.5 0.2 0.2\n", 90)
    write_pair(src, "train", "traffic_2", "3 0.5 0.5 0.2 0.2\n", 91)

    restratify.build_restratified_dataset(src, dst)

    found_img_splits = []
    found_lbl_splits = []
    for split in ("train", "val", "test"):
        if (dst / "images" / split / "mixed_road_drain.jpg").exists():
            found_img_splits.append(split)
        if (dst / "labels" / split / "mixed_road_drain.txt").exists():
            found_lbl_splits.append(split)

    assert len(found_img_splits) == 1, "Image found in multiple splits or missing"
    assert len(found_lbl_splits) == 1, "Label found in multiple splits or missing"
    assert found_img_splits == found_lbl_splits, "Image and label split mismatch"


# ---------------------------------------------------------------------------
# Test 17: Near-duplicate group integrity (atomic cluster in same split)
# ---------------------------------------------------------------------------

def test_near_duplicate_group_integrity(tmp_path):
    src = tmp_path / "src"
    dst = tmp_path / "dst"
    create_dataset_structure(src)

    # Create base geometric image for Class 2
    img = np.zeros((100, 100, 3), dtype=np.uint8)
    cv2.circle(img, (50, 50), 30, (255, 255, 255), -1)
    cv2.rectangle(img, (20, 20), (40, 40), (128, 128, 128), -1)

    # Save two compression levels (pHash near-duplicates) for Class 2
    p1 = src / "images" / "train" / "dup_a.jpg"
    p2 = src / "images" / "train" / "dup_b.jpg"
    cv2.imwrite(str(p1), img, [cv2.IMWRITE_JPEG_QUALITY, 95])
    cv2.imwrite(str(p2), img, [cv2.IMWRITE_JPEG_QUALITY, 90])

    (src / "labels" / "train" / "dup_a.txt").write_text("2 0.5 0.5 0.4 0.4\n")
    (src / "labels" / "train" / "dup_b.txt").write_text("2 0.5 0.5 0.4 0.4\n")

    # Add extra non-duplicate Class 2 images so stratification occurs
    for i in range(1, 6):
        extra_img = np.full((100, 100, 3), 30 + i * 20, dtype=np.uint8)
        cv2.imwrite(str(src / "images" / "train" / f"extra_{i}.jpg"), extra_img)
        (src / "labels" / "train" / f"extra_{i}.txt").write_text("2 0.5 0.5 0.3 0.3\n")

    # Add Class 3 samples
    for i in range(1, 4):
        c3_img = np.full((100, 100, 3), 150 + i * 20, dtype=np.uint8)
        cv2.imwrite(str(src / "images" / "train" / f"c3_{i}.jpg"), c3_img)
        (src / "labels" / "train" / f"c3_{i}.txt").write_text("3 0.5 0.5 0.2 0.2\n")

    restratify.build_restratified_dataset(src, dst)

    # Find which split dup_a and dup_b ended up in
    split_a = None
    split_b = None
    for split in ("train", "val", "test"):
        if (dst / "images" / split / "dup_a.jpg").exists():
            split_a = split
        if (dst / "images" / split / "dup_b.jpg").exists():
            split_b = split

    assert split_a is not None and split_b is not None
    assert split_a == split_b, f"Near-duplicates were split across: {split_a} != {split_b}"
