import json
import sys
from pathlib import Path

import cv2
import numpy as np
import pytest
import yaml

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from ai.preprocessing import annotation_quality as aq
from ai.preprocessing import dataset_integrity_gate as gate
from ai.preprocessing.build_neighborlens_v3_clean import apply_safe_fixes, stratified_group_split
from ai.preprocessing.scene_lineage import roboflow_stem
from ai.training import train_yolo

NAMES = {0: "broken_streetlight", 1: "clogged_drainage", 2: "pothole", 3: "road_crack"}


def textured_image(path, seed):
    rng = np.random.default_rng(seed)
    image = rng.integers(0, 255, (160, 160, 3), dtype=np.uint8)
    image = cv2.GaussianBlur(image, (5, 5), 0)
    cv2.imwrite(str(path), image)


def make_dataset(root, layout, names=NAMES, manifest=True):
    entries = []
    for split in ("train", "valid", "test"):
        (root / split / "images").mkdir(parents=True)
        (root / split / "labels").mkdir(parents=True)
    for index, (split, scene, label) in enumerate(layout):
        name = f"{scene}_a.jpg"
        textured_image(root / split / "images" / name, int(scene.split("_")[1]))
        (root / split / "labels" / f"{scene}_a.txt").write_text(label, encoding="utf-8")
        entries.append(
            {
                "split": split,
                "file": name,
                "scene_id": scene,
                "source_lineage_group": scene,
                "classes": sorted({int(line.split()[0]) for line in label.splitlines() if line.strip()}),
                "origin": "original",
            }
        )
    (root / "data.yaml").write_text(
        yaml.safe_dump({"train": "train/images", "val": "valid/images", "test": "test/images", "nc": len(names), "names": names}),
        encoding="utf-8",
    )
    if manifest:
        (root / "manifest.json").write_text(json.dumps({"images": entries}), encoding="utf-8")


GOOD = "2 0.5 0.5 0.3 0.3\n"


def test_roboflow_stem_strips_hash_suffix():
    assert roboflow_stem("13_jpg.rf.529f5fb649cb3638a1e037edc89204ad.jpg") == "13_jpg"


def test_gate_passes_on_clean_disjoint_dataset(tmp_path):
    make_dataset(tmp_path, [("train", "scene_1", GOOD), ("valid", "scene_2", GOOD), ("test", "scene_3", GOOD)])
    output = gate.run_gate(tmp_path, workers=1)
    assert output["passed"], [c for c in output["checks"] if not c["passed"] and c["critical"]]
    assert output["overlap_counts"] == {"train_valid": 0, "train_test": 0, "valid_test": 0}


def test_gate_fails_on_exact_duplicate_across_splits(tmp_path):
    make_dataset(tmp_path, [("train", "scene_1", GOOD), ("valid", "scene_2", GOOD), ("test", "scene_3", GOOD)])
    (tmp_path / "test" / "images" / "scene_3_a.jpg").write_bytes((tmp_path / "train" / "images" / "scene_1_a.jpg").read_bytes())
    output = gate.run_gate(tmp_path, workers=1)
    assert not output["passed"]
    assert output["overlap_counts"]["train_test"] >= 1


def test_gate_fails_on_wrong_class_mapping(tmp_path):
    wrong = {0: "damaged_road", 1: "clogged_drainage", 2: "damaged_street_light", 3: "damaged_traffic_light"}
    make_dataset(tmp_path, [("train", "scene_1", GOOD), ("valid", "scene_2", GOOD), ("test", "scene_3", GOOD)], names=wrong)
    assert not gate.run_gate(tmp_path, workers=1)["passed"]


def test_gate_fails_on_class_id_out_of_range(tmp_path):
    make_dataset(tmp_path, [("train", "scene_1", "7 0.5 0.5 0.3 0.3\n"), ("valid", "scene_2", GOOD), ("test", "scene_3", GOOD)])
    assert not gate.run_gate(tmp_path, workers=1)["passed"]


def test_gate_fails_on_scene_in_two_splits_in_manifest(tmp_path):
    make_dataset(tmp_path, [("train", "scene_1", GOOD), ("valid", "scene_2", GOOD), ("test", "scene_3", GOOD)])
    manifest = json.loads((tmp_path / "manifest.json").read_text())
    manifest["images"][1]["scene_id"] = "scene_1"
    manifest["images"][1]["source_lineage_group"] = "scene_1"
    (tmp_path / "manifest.json").write_text(json.dumps(manifest))
    assert not gate.run_gate(tmp_path, workers=1)["passed"]


def test_gate_fails_on_augmented_filename_in_eval_split(tmp_path):
    make_dataset(tmp_path, [("train", "scene_1", GOOD), ("valid", "scene_2", GOOD), ("test", "scene_3", GOOD)])
    old = tmp_path / "valid" / "images" / "scene_2_a.jpg"
    new = tmp_path / "valid" / "images" / "scene_2_aug1.jpg"
    old.rename(new)
    (tmp_path / "valid" / "labels" / "scene_2_a.txt").rename(tmp_path / "valid" / "labels" / "scene_2_aug1.txt")
    assert not gate.run_gate(tmp_path, workers=1)["passed"]


def test_gate_fails_on_missing_label(tmp_path):
    make_dataset(tmp_path, [("train", "scene_1", GOOD), ("valid", "scene_2", GOOD), ("test", "scene_3", GOOD)])
    (tmp_path / "train" / "labels" / "scene_1_a.txt").unlink()
    assert not gate.run_gate(tmp_path, workers=1)["passed"]


def test_assert_dataset_ready_blocks_training(tmp_path):
    make_dataset(tmp_path, [("train", "scene_1", GOOD), ("valid", "scene_2", GOOD), ("test", "scene_3", GOOD)])
    (tmp_path / "train" / "labels" / "scene_1_a.txt").write_text("9 0.5 0.5 0.3 0.3\n")
    with pytest.raises(SystemExit):
        gate.assert_dataset_ready(tmp_path, workers=1)


def test_annotation_audit_flags_expected_issues(tmp_path):
    label = tmp_path / "a.txt"
    label.write_text(
        "2 0.5 0.5 0.3 0.3\n"
        "2 0.5 0.5 0.3 0.3\n"
        "2 0.1 0.1 0.01 0.01\n"
        "2 0.5 0.5 0.3 0.31\n"
        "1 0.5 0.5 0 0.2\n"
        "5 0.5 0.5 0.2 0.2\n"
        "2 0.5 0.5\n",
        encoding="utf-8",
    )
    boxes, parse_issues = aq.parse_label_file(label)
    kinds = {item["kind"] for item in parse_issues + aq.audit_label_boxes(boxes)}
    assert {"malformed_line", "invalid_class_id", "non_positive_size", "exact_duplicate_box", "micro_box", "near_duplicate_box"} <= kinds


def test_exact_duplicate_is_safe_fix_and_micro_box_is_manual():
    boxes = [
        {"line": 1, "class_id": 2, "box": (0.5, 0.5, 0.3, 0.3), "raw": ""},
        {"line": 2, "class_id": 2, "box": (0.5, 0.5, 0.3, 0.3), "raw": ""},
        {"line": 3, "class_id": 3, "box": (0.1, 0.1, 0.01, 0.01), "raw": ""},
    ]
    issues = {item["kind"]: item["action"] for item in aq.audit_label_boxes(boxes)}
    assert issues["exact_duplicate_box"] == aq.SAFE_AUTOMATIC_FIX
    assert issues["micro_box"] == aq.MANUAL_REVIEW_REQUIRED


def test_fragmentation_flag_for_many_small_pothole_boxes():
    boxes = [
        {"line": index, "class_id": 2, "box": (0.1 + 0.05 * index, 0.5, 0.06, 0.06), "raw": ""}
        for index in range(1, 6)
    ]
    kinds = {item["kind"] for item in aq.audit_label_boxes(boxes)}
    assert "possible_fragmented_annotation" in kinds


def test_apply_safe_fixes_removes_duplicates_only():
    boxes = [
        {"class_id": 2, "box": (0.5, 0.5, 0.3, 0.3)},
        {"class_id": 2, "box": (0.5, 0.5, 0.3, 0.3)},
        {"class_id": 3, "box": (0.2, 0.2, 0.1, 0.1)},
    ]
    kept, fixes = apply_safe_fixes(boxes)
    assert len(kept) == 2 and fixes == ["removed_exact_duplicate"]


def test_stratified_group_split_keeps_scenes_whole_and_covers_classes():
    scenes = {}
    for index in range(40):
        class_id = index % 4
        scenes[f"scene_{index}"] = [{"classes": [class_id]}]
    assignment = stratified_group_split(scenes, {"train": 0.6, "valid": 0.2, "test": 0.2}, seed=1)
    assert set(assignment) == set(scenes)
    for class_id in range(4):
        per_split = {"train": 0, "valid": 0, "test": 0}
        for scene, images in scenes.items():
            if images[0]["classes"][0] == class_id:
                per_split[assignment[scene]] += 1
        assert per_split == {"train": 6, "valid": 2, "test": 2}


def test_stratified_group_split_is_deterministic():
    scenes = {f"s{index}": [{"classes": [index % 3]}] for index in range(30)}
    fractions = {"train": 0.6, "valid": 0.2, "test": 0.2}
    assert stratified_group_split(scenes, fractions, 5) == stratified_group_split(scenes, fractions, 5)


def test_train_kwargs_hardware_profile():
    args = train_yolo.parse_args([])
    kwargs = train_yolo.build_train_kwargs(args, Path("data.yaml"), "0")
    assert kwargs["seed"] == 42 and kwargs["deterministic"] is True
    assert kwargs["imgsz"] == 640 and kwargs["batch"] == 8 and kwargs["amp"] is True
    assert kwargs["patience"] == 30 and kwargs["pretrained"] is True and kwargs["val"] is True
    assert kwargs["flipud"] == 0.0 and kwargs["mixup"] == 0.0
    assert not Path(kwargs["data"]).is_absolute() or kwargs["data"] == str(Path("data.yaml"))


def test_default_dataset_is_remediated_v3_1():
    assert train_yolo.DEFAULT_DATA.parent.name == "neighborlens_paper_aligned_v3_1_remediated"


def test_summarise_results_picks_best_validation_epoch(tmp_path):
    csv_path = tmp_path / "results.csv"
    csv_path.write_text(
        "epoch,metrics/precision(B),metrics/recall(B),metrics/mAP50(B),metrics/mAP50-95(B)\n"
        "0,0.1,0.1,0.1,0.05\n"
        "1,0.5,0.5,0.6,0.3\n"
        "2,0.4,0.4,0.5,0.2\n",
        encoding="utf-8",
    )
    summary = train_yolo.summarise_results(csv_path)
    assert summary["best_epoch"] == 1 and summary["epochs_completed"] == 3
