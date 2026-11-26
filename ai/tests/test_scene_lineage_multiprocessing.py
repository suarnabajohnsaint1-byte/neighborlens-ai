import json
import multiprocessing
import sys
from pathlib import Path

import cv2
import numpy as np
import pytest
import yaml

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from ai.preprocessing import dataset_integrity_gate as gate
from ai.preprocessing import scene_lineage

NAMES = {0: "broken_streetlight", 1: "clogged_drainage", 2: "pothole", 3: "road_crack"}


def structured_image(path, seed, size=480):
    rng = np.random.default_rng(seed)
    image = cv2.GaussianBlur(rng.integers(0, 255, (size, size, 3), dtype=np.uint8), (3, 3), 0)
    for _ in range(40):
        x1, y1, x2, y2 = (int(value) for value in rng.integers(0, size, 4))
        color = tuple(int(value) for value in rng.integers(0, 255, 3))
        if rng.random() < 0.5:
            cv2.rectangle(image, (x1, y1), (x2, y2), color, int(rng.integers(1, 4)))
        else:
            cv2.circle(image, (x1, y1), int(rng.integers(5, 60)), color, int(rng.integers(1, 4)))
    cv2.imwrite(str(path), image, [cv2.IMWRITE_JPEG_QUALITY, 95])


def reencoded_copy(source, target):
    image = cv2.imread(str(source))
    image = cv2.convertScaleAbs(image, alpha=1.08, beta=6)
    cv2.imwrite(str(target), image, [cv2.IMWRITE_JPEG_QUALITY, 70])


def simulate_platform_without_fork(monkeypatch):
    real_get_context = multiprocessing.get_context

    def get_context(method=None):
        if method == "fork":
            raise ValueError("cannot find context for 'fork'")
        return real_get_context(method)

    monkeypatch.setattr(multiprocessing, "get_all_start_methods", lambda: ["spawn"])
    monkeypatch.setattr(multiprocessing, "get_context", get_context)


def test_fork_is_selected_when_available(monkeypatch):
    requested = []
    context = object()
    def get_context(method):
        requested.append(method)
        return context
    monkeypatch.setattr(multiprocessing, "get_context", get_context)
    assert scene_lineage.select_mp_context(["fork", "spawn", "forkserver"]) is context
    assert requested == ["fork"]


def test_spawn_is_selected_when_fork_is_unavailable():
    assert scene_lineage.select_mp_context(["spawn"]).get_start_method() == "spawn"


def test_default_selection_uses_reported_start_methods(monkeypatch):
    monkeypatch.setattr(multiprocessing, "get_all_start_methods", lambda: ["spawn"])
    assert scene_lineage.select_mp_context().get_start_method() == "spawn"


@pytest.fixture()
def lineage_images(tmp_path):
    paths = []
    for seed in range(3):
        path = tmp_path / f"scene_{seed}.jpg"
        structured_image(path, seed)
        paths.append(path)
    duplicate = tmp_path / "scene_0_copy.jpg"
    reencoded_copy(paths[0], duplicate)
    paths.append(duplicate)
    return paths


def duplicate_pairs(results):
    return sorted((i, j) for i, j, inliers, _ in results if inliers >= scene_lineage.DUPLICATE_MIN_INLIERS)


def test_spawn_context_runs_sift_comparison_and_matches_fork(lineage_images):
    spawn_results = scene_lineage.sift_pair_scores(lineage_images, workers=2, context=multiprocessing.get_context("spawn"))
    assert duplicate_pairs(spawn_results) == [(0, 3)]
    if "fork" in multiprocessing.get_all_start_methods():
        fork_results = scene_lineage.sift_pair_scores(lineage_images, workers=2, context=multiprocessing.get_context("fork"))
        assert sorted(spawn_results) == sorted(fork_results)


def test_spawn_context_restricted_pairs_are_respected(lineage_images):
    results = scene_lineage.sift_pair_scores(
        lineage_images, workers=2, pairs=[(1, 2), (1, 3)], context=multiprocessing.get_context("spawn")
    )
    assert {(i, j) for i, j, *_ in results} <= {(1, 2), (1, 3)}
    assert duplicate_pairs(results) == []


def test_integrity_gate_still_detects_visual_overlap_without_fork(tmp_path, monkeypatch):
    simulate_platform_without_fork(monkeypatch)
    entries = []
    for split, scene, seed in (("train", "scene_0001", 11), ("valid", "scene_0002", 12), ("test", "scene_0003", 13)):
        (tmp_path / split / "images").mkdir(parents=True)
        (tmp_path / split / "labels").mkdir(parents=True)
        structured_image(tmp_path / split / "images" / f"{scene}_a.jpg", seed)
        (tmp_path / split / "labels" / f"{scene}_a.txt").write_text("2 0.5 0.5 0.3 0.3\n", encoding="utf-8")
        entries.append({"split": split, "file": f"{scene}_a.jpg", "scene_id": scene, "source_lineage_group": scene, "classes": [2], "origin": "original"})
    reencoded_copy(tmp_path / "train" / "images" / "scene_0001_a.jpg", tmp_path / "test" / "images" / "scene_0004_a.jpg")
    (tmp_path / "test" / "labels" / "scene_0004_a.txt").write_text("2 0.5 0.5 0.3 0.3\n", encoding="utf-8")
    entries.append({"split": "test", "file": "scene_0004_a.jpg", "scene_id": "scene_0004", "source_lineage_group": "scene_0004", "classes": [2], "origin": "original"})
    (tmp_path / "data.yaml").write_text(yaml.safe_dump({"nc": 4, "names": NAMES}), encoding="utf-8")
    (tmp_path / "manifest.json").write_text(json.dumps({"images": entries}), encoding="utf-8")

    output = gate.run_gate(tmp_path, workers=2)

    assert output["passed"] is False
    assert output["overlap_counts"]["train_test"] >= 1
    assert any(finding["type"] == "feature_match_duplicate" for finding in output["cross_split_findings"])
