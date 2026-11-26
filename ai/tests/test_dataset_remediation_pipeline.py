import csv
import json
import sys
from pathlib import Path

import cv2
import numpy as np
import pytest
import yaml

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from ai.preprocessing import dataset_integrity_gate as gate
from ai.preprocessing.apply_annotation_review import apply_review
from ai.preprocessing.assemble_dataset_version import assemble
from ai.preprocessing.build_neighborlens_v3_clean import stratified_group_split
from ai.preprocessing.import_original_candidates import ACCEPTED, REJECTED, PROVENANCE_COLUMNS, run_import
from ai.training import train_yolo

NAMES = {0: "broken_streetlight", 1: "clogged_drainage", 2: "pothole", 3: "road_crack"}


def textured(path, seed, size=400):
    rng = np.random.default_rng(seed)
    image = cv2.GaussianBlur(rng.integers(0, 255, (size, size, 3), dtype=np.uint8), (5, 5), 0)
    cv2.imwrite(str(path), image)


def write_dataset(root, entries, review_status=None):
    for split in ("train", "valid", "test"):
        (root / split / "images").mkdir(parents=True, exist_ok=True)
        (root / split / "labels").mkdir(parents=True, exist_ok=True)
    manifest = []
    for split, name, scene, label, seed, role in entries:
        textured(root / split / "images" / name, seed)
        (root / split / "labels" / f"{Path(name).stem}.txt").write_text(label, encoding="utf-8")
        manifest.append(
            {
                "split": split,
                "file": name,
                "scene_id": scene,
                "source_lineage_group": scene,
                "source_file": name,
                "source_split": split,
                "classes": sorted({int(line.split()[0]) for line in label.splitlines() if line.strip()}),
                "boxes": len([line for line in label.splitlines() if line.strip()]),
                "origin": "original",
                "role": role,
                "provenance": {"source_type": "test"},
            }
        )
    (root / "data.yaml").write_text(
        yaml.safe_dump({"train": "train/images", "val": "valid/images", "test": "test/images", "nc": 4, "names": NAMES}),
        encoding="utf-8",
    )
    (root / "manifest.json").write_text(json.dumps({"images": manifest}), encoding="utf-8")
    if review_status is not None:
        (root / "review_status.json").write_text(json.dumps(review_status), encoding="utf-8")


POTHOLE = "2 0.5 0.5 0.3 0.3\n"
CRACK = "3 0.5 0.5 0.3 0.3\n"


def basic_entries():
    return [
        ("train", "scene_0001_a.jpg", "scene_0001", POTHOLE, 1, "positive"),
        ("valid", "scene_0002_a.jpg", "scene_0002", POTHOLE, 2, "positive"),
        ("test", "scene_0003_a.jpg", "scene_0003", POTHOLE, 3, "positive"),
    ]


def critical_failures(output):
    return set(gate.failed_checks(output))


def test_gate_rejects_contradictory_labels_within_one_scene(tmp_path):
    entries = basic_entries() + [("train", "scene_0001_b.jpg", "scene_0001", CRACK, 4, "positive")]
    write_dataset(tmp_path, entries)
    assert "no_contradictory_labels_within_scene" in critical_failures(gate.run_gate(tmp_path, workers=1))


def test_gate_rejects_background_outside_train(tmp_path):
    entries = basic_entries() + [("test", "scene_0009_bg.jpg", "scene_0009", "", 9, "background")]
    write_dataset(tmp_path, entries)
    assert "backgrounds_train_only" in critical_failures(gate.run_gate(tmp_path, workers=1))


def test_gate_rejects_undeclared_empty_label(tmp_path):
    entries = basic_entries() + [("train", "scene_0009_a.jpg", "scene_0009", "", 9, "positive")]
    write_dataset(tmp_path, entries)
    assert "empty_labels_are_declared_backgrounds" in critical_failures(gate.run_gate(tmp_path, workers=1))


def test_gate_accepts_declared_train_background(tmp_path):
    entries = basic_entries() + [("train", "scene_0009_bg.jpg", "scene_0009", "", 9, "background")]
    write_dataset(tmp_path, entries)
    assert gate.run_gate(tmp_path, workers=1)["passed"]


def test_gate_blocks_unresolved_review_items(tmp_path):
    status = {"unresolved_items": [{"id": "AR-003", "blocking": True, "files": ["train/scene_0001_a.jpg"]}]}
    write_dataset(tmp_path, basic_entries(), review_status=status)
    assert "no_unresolved_blocking_review_items" in critical_failures(gate.run_gate(tmp_path, workers=1))


def test_readiness_requires_per_class_support_even_when_integrity_passes(tmp_path):
    write_dataset(tmp_path, basic_entries(), review_status={"unresolved_items": []})
    integrity = gate.run_gate(tmp_path, workers=1)
    readiness = gate.run_gate(tmp_path, workers=1, readiness=True)
    assert integrity["passed"] is True
    assert readiness["passed"] is False
    assert "coverage_pothole_test" in critical_failures(readiness)
    with pytest.raises(SystemExit):
        gate.assert_dataset_ready(tmp_path, workers=1)


def test_frozen_scenes_keep_their_split_and_new_scenes_fill_deficits():
    scenes = {f"old{index}": [{"classes": [0]}] for index in range(5)}
    frozen = {f"old{index}": "train" for index in range(5)}
    scenes.update({f"new{index}": [{"classes": [0]}] for index in range(5)})
    assignment = stratified_group_split(scenes, {"train": 0.6, "valid": 0.2, "test": 0.2}, 7, frozen=frozen)
    assert all(assignment[scene] == "train" for scene in frozen)
    new_splits = [assignment[f"new{index}"] for index in range(5)]
    assert new_splits.count("valid") == 2 and new_splits.count("test") == 2


def write_review(review_dir, items, quarantine):
    review_dir.mkdir(parents=True, exist_ok=True)
    (review_dir / "annotation_review.json").write_text(json.dumps({"items": items}), encoding="utf-8")
    (review_dir / "quarantine_review.json").write_text(json.dumps({"images": quarantine}), encoding="utf-8")


def test_apply_review_quarantines_conflicting_scene_and_records_open_items(tmp_path):
    base = tmp_path / "base"
    entries = basic_entries() + [
        ("train", "scene_0004_a.jpg", "scene_0004", CRACK, 5, "positive"),
        ("train", "scene_0004_b.jpg", "scene_0004", POTHOLE, 6, "positive"),
    ]
    write_dataset(base, entries)
    items = [
        {"id": "AR-001", "files": ["train/scene_0004_a.jpg", "train/scene_0004_b.jpg"], "issue": "CONTRADICTORY_LABEL",
         "decision": "QUARANTINE_PENDING_HUMAN_REVIEW", "blocking": True},
        {"id": "AR-004", "files": ["train/scene_0001_a.jpg"], "issue": "MICRO_BOXES", "decision": "MANUAL_REVIEW_REQUIRED", "blocking": True},
    ]
    write_review(tmp_path / "review", items, [])
    status = apply_review(base, tmp_path / "out", tmp_path / "review")
    assert status["excluded_scenes"] == ["scene_0004"]
    assert [item["id"] for item in status["unresolved_items"]] == ["AR-004"]
    assert not (tmp_path / "out" / "train" / "images" / "scene_0004_a.jpg").exists()
    assert "no_unresolved_blocking_review_items" in critical_failures(gate.run_gate(tmp_path / "out", workers=1))


def test_apply_review_uses_human_correction_and_resolves_item(tmp_path):
    base = tmp_path / "base"
    write_dataset(base, basic_entries())
    items = [{"id": "AR-004", "files": ["train/scene_0001_a.jpg"], "issue": "MICRO_BOXES", "decision": "MANUAL_REVIEW_REQUIRED", "blocking": True}]
    write_review(tmp_path / "review", items, [])
    corrections = tmp_path / "corrections" / "train"
    corrections.mkdir(parents=True)
    (corrections / "scene_0001_a.txt").write_text("2 0.4 0.4 0.2 0.2\n", encoding="utf-8")
    status = apply_review(base, tmp_path / "out", tmp_path / "review", tmp_path / "corrections")
    assert status["unresolved_items"] == []
    assert (tmp_path / "out" / "train" / "labels" / "scene_0001_a.txt").read_text().startswith("2 0.400000")


def test_apply_review_adds_only_approved_negatives_to_train_with_cap(tmp_path):
    base = tmp_path / "base"
    entries = basic_entries() + [("train", f"scene_01{index:02d}_a.jpg", f"scene_01{index:02d}", POTHOLE, 20 + index, "positive") for index in range(17)]
    write_dataset(base, entries)
    negatives = tmp_path / "negatives"
    negatives.mkdir()
    quarantine = []
    for index in range(4):
        textured(negatives / f"neg{index}.jpg", 50 + index)
        quarantine.append({
            "image_path": str(negatives / f"neg{index}.jpg"),
            "source": f"train/neg{index}.jpg", "scene_id": f"scene_09{index}", "review_status": "TRUE_NEGATIVE",
            "approved_for_train_background": index != 3,
        })
    write_review(tmp_path / "review", [], quarantine)
    status = apply_review(base, tmp_path / "out", tmp_path / "review", max_background_fraction=0.10)
    assert status["backgrounds_approved"] == 3
    assert status["backgrounds_added"] == 2
    backgrounds = list((tmp_path / "out" / "train" / "images").glob("*_bg.jpg"))
    assert len(backgrounds) == 2
    assert not list((tmp_path / "out" / "valid" / "images").glob("*_bg.jpg"))


def provenance_row(file, **overrides):
    row = {
        "file": file, "source_type": "own_capture", "captured_by": "field team", "capture_date": "2026-10-01",
        "location": "Bacolod", "license": "project-owned", "consent_or_permission": "yes", "role": "positive",
        "reentry_of_scene_id": "",
    }
    row.update(overrides)
    return row


def write_staging(staging, items):
    (staging / "images").mkdir(parents=True)
    (staging / "labels").mkdir(parents=True)
    rows = []
    for file, seed, label, row in items:
        if seed is None:
            (staging / "images" / file).write_bytes(b"not an image")
        elif isinstance(seed, Path):
            (staging / "images" / file).write_bytes(seed.read_bytes())
        else:
            textured(staging / "images" / file, seed)
        if label is not None:
            (staging / "labels" / f"{Path(file).stem}.txt").write_text(label, encoding="utf-8")
        if row is not None:
            rows.append(row)
    with (staging / "provenance.csv").open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=PROVENANCE_COLUMNS)
        writer.writeheader()
        writer.writerows(rows)


def reference_dataset(root):
    write_dataset(root, basic_entries())
    records = [{"split": split, "file": name, "scene_id": scene} for split, name, scene, *_ in basic_entries()]
    (root / "lineage.json").write_text(json.dumps({"records": records}), encoding="utf-8")
    return root


def statuses(report):
    return {image["file"]: image for image in report["images"]}


def test_import_pipeline_validates_and_deduplicates(tmp_path):
    reference = reference_dataset(tmp_path / "reference")
    staging = tmp_path / "staging"
    textured(tmp_path / "staging_copy_source.jpg", 100)
    write_staging(
        staging,
        [
            ("good.jpg", 100, POTHOLE, provenance_row("good.jpg")),
            ("good_copy.jpg", tmp_path / "staging_copy_source.jpg", POTHOLE, provenance_row("good_copy.jpg")),
            ("dup_of_reference.jpg", reference / "train" / "images" / "scene_0001_a.jpg", POTHOLE, provenance_row("dup_of_reference.jpg")),
            ("bad_class.jpg", 101, "7 0.5 0.5 0.2 0.2\n", provenance_row("bad_class.jpg")),
            ("bad_coords.jpg", 102, "2 1.5 0.5 0.2 0.2\n", provenance_row("bad_coords.jpg")),
            ("unreadable.jpg", None, POTHOLE, provenance_row("unreadable.jpg")),
            ("no_label.jpg", 103, None, provenance_row("no_label.jpg")),
            ("no_provenance.jpg", 104, POTHOLE, None),
            ("scraped.jpg", 105, POTHOLE, provenance_row("scraped.jpg", source_type="web_scrape")),
            ("negative.jpg", 106, "", provenance_row("negative.jpg", role="background")),
            ("empty_positive.jpg", 107, "", provenance_row("empty_positive.jpg")),
        ],
    )
    report = run_import(staging, reference, reference / "lineage.json", reference, workers=1)
    found = statuses(report)
    assert found["good.jpg"]["status"] == ACCEPTED
    assert found["negative.jpg"]["status"] == ACCEPTED
    assert found["good_copy.jpg"]["status"] == REJECTED
    assert any("exact duplicate" in error for error in found["good_copy.jpg"]["errors"])
    assert any("duplicate of existing scene scene_0001" in error for error in found["dup_of_reference.jpg"]["errors"])
    for file in ("bad_class.jpg", "bad_coords.jpg", "unreadable.jpg", "no_label.jpg", "no_provenance.jpg", "scraped.jpg", "empty_positive.jpg"):
        assert found[file]["status"] == REJECTED, file
    assert report["accepted_scenes_per_class"]["pothole"] == 1


def test_import_scene_ids_are_stable_across_runs(tmp_path):
    reference = reference_dataset(tmp_path / "reference")
    staging = tmp_path / "staging"
    write_staging(staging, [("a.jpg", 200, POTHOLE, provenance_row("a.jpg")), ("b.jpg", 201, CRACK, provenance_row("b.jpg"))])
    first = statuses(run_import(staging, reference, reference / "lineage.json", reference, workers=1))
    second = statuses(run_import(staging, reference, reference / "lineage.json", reference, workers=1))
    assert first["a.jpg"]["scene_id"] == second["a.jpg"]["scene_id"]
    assert first["a.jpg"]["scene_id"] != first["b.jpg"]["scene_id"]


def test_import_allows_declared_reentry_of_quarantined_scene_only(tmp_path):
    reference = tmp_path / "reference"
    write_dataset(reference, basic_entries() + [("train", "quarantined.jpg", "scene_0040", "", 40, "background")])
    records = [{"split": s, "file": n, "scene_id": sc} for s, n, sc, *_ in basic_entries()] + [
        {"split": "train", "file": "quarantined.jpg", "scene_id": "scene_0040"}
    ]
    (reference / "lineage.json").write_text(json.dumps({"records": records}), encoding="utf-8")
    base = tmp_path / "base"
    write_dataset(base, basic_entries())
    staging = tmp_path / "staging"
    write_staging(
        staging,
        [
            ("relabelled.jpg", reference / "train" / "images" / "quarantined.jpg", "0 0.5 0.5 0.3 0.3\n",
             provenance_row("relabelled.jpg", source_type="reannotated_existing", reentry_of_scene_id="scene_0040")),
            ("sneaky.jpg", reference / "valid" / "images" / "scene_0002_a.jpg", POTHOLE,
             provenance_row("sneaky.jpg", source_type="reannotated_existing", reentry_of_scene_id="scene_0002")),
        ],
    )
    found = statuses(run_import(staging, reference, reference / "lineage.json", base, workers=1))
    assert found["relabelled.jpg"]["status"] == ACCEPTED
    assert found["relabelled.jpg"]["scene_id"] == "scene_0040"
    assert found["sneaky.jpg"]["status"] == REJECTED


def test_assemble_keeps_base_splits_and_puts_backgrounds_in_train(tmp_path):
    base = tmp_path / "base"
    write_dataset(base, basic_entries(), review_status={"unresolved_items": []})
    reference = reference_dataset(tmp_path / "reference")
    staging = tmp_path / "staging"
    items = [(f"new{index}.jpg", 300 + index, POTHOLE, provenance_row(f"new{index}.jpg")) for index in range(7)]
    items.append(("bg.jpg", 400, "", provenance_row("bg.jpg", role="background")))
    write_staging(staging, items)
    report = run_import(staging, reference, reference / "lineage.json", base, workers=1)
    (staging / "reports").mkdir()
    (staging / "reports" / "import_manifest.json").write_text(json.dumps(report, default=str), encoding="utf-8")
    output = tmp_path / "v4"
    assemble(base, staging / "reports" / "import_manifest.json", staging, output, {"train": 0.6, "valid": 0.2, "test": 0.2}, 42, 0.5)
    manifest = json.loads((output / "manifest.json").read_text())["images"]
    by_scene = {entry["scene_id"]: entry["split"] for entry in manifest}
    assert by_scene["scene_0001"] == "train" and by_scene["scene_0002"] == "valid" and by_scene["scene_0003"] == "test"
    assert all(entry["split"] == "train" for entry in manifest if entry["role"] == "background")
    assert all(entry.get("provenance") for entry in manifest)
    assert gate.run_gate(output, workers=1)["passed"]


def test_train_script_defaults_to_remediated_dataset_and_requires_readiness():
    assert train_yolo.DEFAULT_DATA.parent.name == "neighborlens_paper_aligned_v3_1_remediated"
    assert train_yolo.parse_args([]).baseline_insufficient_support is False
