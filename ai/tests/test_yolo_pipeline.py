import hashlib
import json
import random
import shutil
import subprocess
import sys
from pathlib import Path

import pytest
from PIL import Image, ImageDraw

SCRIPTS_DIR = Path(__file__).resolve().parents[1] / "preprocessing"
TRAINING_DIR = Path(__file__).resolve().parents[1] / "training"
sys.path.insert(0, str(SCRIPTS_DIR))
sys.path.insert(0, str(TRAINING_DIR))

import audit_raw_images as audit  # noqa: E402
import build_dataset as build  # noqa: E402
from evaluate_test import f1_score  # noqa: E402

FOLDER_CLASS = {"damages_road": 0, "clogging_drainage": 1, "street_light": 2}
MAPPING = """status: {status}
names:
  0: damaged_road
  1: clogged_drainage
  2: damaged_street_light
source_folders:
  damages_road: damaged_road
  clogging_drainage: clogged_drainage
  street_light: damaged_street_light
"""


def random_image(path: Path, seed: int) -> None:
    rng = random.Random(seed)
    image = Image.new("RGB", (400, 300), tuple(rng.randrange(256) for _ in range(3)))
    draw = ImageDraw.Draw(image)
    for _ in range(40):
        x, y = rng.randrange(400), rng.randrange(300)
        draw.rectangle([x, y, x + rng.randrange(5, 80), y + rng.randrange(5, 80)],
                       fill=tuple(rng.randrange(256) for _ in range(3)))
    path.parent.mkdir(parents=True, exist_ok=True)
    image.save(path, quality=95)


def tree_digest(root: Path) -> str:
    digest = hashlib.sha256()
    for path in sorted(root.rglob("*")):
        digest.update(str(path.relative_to(root)).encode())
        if path.is_file():
            digest.update(path.read_bytes())
    return digest.hexdigest()


@pytest.fixture
def workspace(tmp_path):
    raw, annotations = tmp_path / "raw", tmp_path / "annotations"
    seed = 0
    for folder, class_id in FOLDER_CLASS.items():
        for index in range(10):
            seed += 1
            relative = Path(folder) / f"img_{index:02d}.jpg"
            random_image(raw / relative, seed)
            label = annotations / relative.with_suffix(".txt")
            label.parent.mkdir(parents=True, exist_ok=True)
            label.write_text(f"{class_id} 0.5 0.5 0.3 0.3\n", encoding="utf-8")
    (tmp_path / "class_mapping.yaml").write_text(MAPPING.format(status="approved"), encoding="utf-8")
    return tmp_path


def run_audit(ws: Path) -> dict:
    report, records = audit.audit(ws / "raw", threshold=6)
    (ws / "audit").mkdir(exist_ok=True)
    audit.write_manifest(records, ws / "audit" / "raw_manifest.csv")
    audit.write_scope_review_template(records, ws / "audit" / "scope_review.csv")
    return report


def run_build(ws: Path, *extra: str) -> subprocess.CompletedProcess:
    return subprocess.run(
        [sys.executable, str(SCRIPTS_DIR / "build_dataset.py"),
         "--raw-root", str(ws / "raw"), "--audit-dir", str(ws / "audit"),
         "--annotations", str(ws / "annotations"), "--class-mapping", str(ws / "class_mapping.yaml"),
         "--scene-groups", str(ws / "scene_groups.csv"), "--output", str(ws / "out"), *extra],
        capture_output=True, text=True,
    )


def split_of(ws: Path, output_name: str) -> str:
    manifest = json.loads((ws / "out" / "split_manifest.json").read_text())
    for split, groups in manifest["assignment"].items():
        if any(output_name in group for group in groups):
            return split
    raise AssertionError(f"{output_name} not assigned")


def test_audit_reports_per_folder_findings_without_touching_raw(workspace):
    raw = workspace / "raw"
    shutil.copy(raw / "damages_road" / "img_00.jpg", raw / "damages_road" / "copy.jpg")
    (raw / "street_light" / "broken.jpg").write_bytes(b"not an image")
    (raw / "clogging_drainage" / "readme.txt").write_text("notes")
    random_image(raw / "clogging_drainage" / "nested" / "img_00.jpg", 999)
    before = tree_digest(raw)

    report = run_audit(workspace)

    road, light, drain = (report["folders"][f] for f in ("damages_road", "street_light", "clogging_drainage"))
    assert road["valid_images"] == 11
    assert road["exact_duplicate_redundant_copies"] == 1
    assert [u["relative_path"] for u in light["unreadable_images"]] == ["street_light/broken.jpg"]
    assert drain["non_image_files"] == ["clogging_drainage/readme.txt"]
    assert drain["nested_directories"] == ["clogging_drainage/nested"]
    assert "img_00" in drain["duplicate_filenames"]
    assert report["totals"]["total_original_images"] == 32
    assert tree_digest(raw) == before


def test_audit_fails_when_a_source_folder_is_missing(workspace):
    shutil.rmtree(workspace / "raw" / "street_light")
    with pytest.raises(SystemExit, match="street_light"):
        audit.audit(workspace / "raw", threshold=6)


def test_verify_detects_modified_raw_file(workspace, capsys):
    run_audit(workspace)
    assert audit.verify(workspace / "raw", workspace / "audit" / "raw_manifest.csv") == 0
    random_image(workspace / "raw" / "damages_road" / "img_03.jpg", 12345)
    assert audit.verify(workspace / "raw", workspace / "audit" / "raw_manifest.csv") == 1
    assert "CHANGED: damages_road/img_03.jpg" in capsys.readouterr().out


def test_build_refuses_unreviewed_mapping_without_flag(workspace):
    (workspace / "class_mapping.yaml").write_text(
        MAPPING.format(status="requires_research_scope_review"), encoding="utf-8")
    run_audit(workspace)
    result = run_build(workspace)
    assert result.returncode != 0
    assert "CLASS MAPPING REQUIRES RESEARCH-SCOPE REVIEW" in result.stderr
    assert run_build(workspace, "--allow-unreviewed-mapping").returncode == 0


def test_build_is_deterministic_and_covers_every_class_in_held_out_splits(workspace):
    run_audit(workspace)
    assert run_build(workspace).returncode == 0
    first = (workspace / "out" / "split_manifest.json").read_text()
    shutil.rmtree(workspace / "out")
    assert run_build(workspace).returncode == 0
    assert (workspace / "out" / "split_manifest.json").read_text() == first

    splits = json.loads(first)["splits"]
    for split in ("val", "test"):
        assert all(count > 0 for count in splits[split]["instances"].values())
    assert sum(s["images"] for s in splits.values()) == 30


def test_near_duplicates_and_scene_groups_stay_in_one_split(workspace):
    raw, annotations = workspace / "raw", workspace / "annotations"
    with Image.open(raw / "damages_road" / "img_00.jpg") as image:
        image.resize((380, 285)).save(raw / "damages_road" / "img_00_resized.jpg", quality=80)
    shutil.copy(annotations / "damages_road" / "img_00.txt", annotations / "damages_road" / "img_00_resized.txt")
    (workspace / "scene_groups.csv").write_text(
        "relative_path,group\nstreet_light/img_01.jpg,pole7\nstreet_light/img_02.jpg,pole7\n", encoding="utf-8")
    run_audit(workspace)
    assert run_build(workspace).returncode == 0

    assert split_of(workspace, "damages_road__img_00.jpg") == split_of(workspace, "damages_road__img_00_resized.jpg")
    assert split_of(workspace, "street_light__img_01.jpg") == split_of(workspace, "street_light__img_02.jpg")


def test_unannotated_images_are_excluded_and_invalid_labels_abort(workspace):
    (workspace / "annotations" / "damages_road" / "img_05.txt").unlink()
    run_audit(workspace)
    assert run_build(workspace).returncode == 0
    manifest = json.loads((workspace / "out" / "split_manifest.json").read_text())
    assert manifest["excluded"]["not_annotated"] == ["damages_road/img_05.jpg"]

    shutil.rmtree(workspace / "out")
    (workspace / "annotations" / "street_light" / "img_00.txt").write_text("2 0.95 0.5 0.3 0.3\n")
    result = run_build(workspace)
    assert result.returncode != 0
    assert "outside the image" in result.stderr


def test_out_of_scope_decisions_are_excluded(workspace):
    run_audit(workspace)
    scope = workspace / "audit" / "scope_review.csv"
    scope.write_text(scope.read_text().replace(
        "clogging_drainage/img_04.jpg,clogging_drainage,pending", "clogging_drainage/img_04.jpg,clogging_drainage,out_of_scope"))
    assert run_build(workspace).returncode == 0
    manifest = json.loads((workspace / "out" / "split_manifest.json").read_text())
    assert manifest["excluded"]["out_of_scope"] == ["clogging_drainage/img_04.jpg"]


def test_frozen_test_split_cannot_change(workspace):
    run_audit(workspace)
    assert run_build(workspace).returncode == 0
    result = run_build(workspace, "--seed", "7")
    assert result.returncode != 0
    assert "frozen test set" in result.stderr


def test_images_differing_only_by_extension_abort_the_build(workspace):
    with Image.open(workspace / "raw" / "street_light" / "img_03.jpg") as image:
        image.rotate(90).save(workspace / "raw" / "street_light" / "img_03.png")
    run_audit(workspace)
    result = run_build(workspace)
    assert result.returncode != 0
    assert "share one label path" in result.stderr


def test_label_parser_rejects_unknown_class(tmp_path):
    label = tmp_path / "a.txt"
    label.write_text("3 0.5 0.5 0.2 0.2\n")
    with pytest.raises(build.LabelError, match="class id 3"):
        build.parse_label_file(label, {0, 1, 2})


def test_f1_score():
    assert f1_score(0.8, 0.6) == pytest.approx(0.685714, rel=1e-5)
    assert f1_score(0.0, 0.0) == 0.0
