import json
from types import SimpleNamespace

import pytest

np = pytest.importorskip("numpy")
pytest.importorskip("ultralytics")

from ai.training import benchmark_region_relevance as experiment
from ai.training.benchmark_region_relevance import image_paths, load_pairs, read_labels, summarize_setting


def test_nested_images_accept_empty_and_missing_yolo_labels(tmp_path):
    images = tmp_path / "images"
    labels = tmp_path / "labels"
    (images / "mugs").mkdir(parents=True)
    (labels / "mugs").mkdir(parents=True)
    for name in ("mugs/view.jpg", "view.jpg", "road.jpg"):
        (images / name).touch()
    (images / "notes.txt").touch()
    (labels / "mugs/view.txt").write_text("\n")
    (labels / "road.txt").write_text("3 0.5 0.5 0.4 0.4\n")

    paths = image_paths(images)
    boxes, counts = read_labels(paths, labels)

    assert list(paths) == ["mugs/view.jpg", "road.jpg", "view.jpg"]
    assert counts == {"labeled": 1, "empty": 1, "missing": 1}
    assert boxes["mugs/view.jpg"].shape == boxes["view.jpg"].shape == (0, 5)
    assert boxes["road.jpg"][0, 0] == 3


def test_malformed_existing_label_is_not_silently_treated_as_background(tmp_path):
    (tmp_path / "road.txt").write_text("3 NaN 0.5 0.2 0.2\n")
    with pytest.raises(ValueError, match="Non-finite"):
        read_labels({"road.jpg": None}, tmp_path)


def test_pair_agreement_and_image_false_positive_rate_have_separate_denominators(tmp_path):
    predictions = {
        "cup/front.jpg": (np.array([[20, 20, 60, 60, 0.91, 2]], np.float32), (100, 100)),
        "cup/side.jpg": (np.array([[20, 20, 60, 60, 0.89, 2]], np.float32), (100, 100)),
        "floor.jpg": (np.empty((0, 6), np.float32), (100, 100)),
    }
    manifest = tmp_path / "pairs.json"
    manifest.write_text(json.dumps({"cup": ["cup/front.jpg", "cup/side.jpg"]}))
    pairs = load_pairs(manifest, predictions)
    labels = {key: np.empty((0, 5), np.float32) for key in predictions}
    subjects = {
        "cup/front.jpg": np.array([[20, 20, 60, 60]]),
        "cup/side.jpg": np.empty((0, 4)),
        "floor.jpg": np.empty((0, 4)),
    }

    baseline = summarize_setting(predictions, labels, subjects, None, 0.30, pairs)
    filtered = summarize_setting(predictions, labels, subjects, 0.60, 0.30, pairs)

    assert baseline["false_positive_image_rate"] == pytest.approx(2 / 3)
    assert filtered["false_positive_image_rate"] == pytest.approx(1 / 3)
    assert baseline["negative_pair_model_agreement"]["agreed"] == 1
    assert filtered["negative_pair_model_agreement"]["agreed"] == 0
    assert baseline["map50"] is None and filtered["map50"] is None


def test_mixed_scenes_distinguish_a_removed_true_positive_from_a_missed_defect():
    truth = np.array([[2, 0.4, 0.4, 0.4, 0.4]], np.float32)
    correct = [20, 20, 60, 60, 0.9, 2]
    alternative = [20, 20, 49, 60, 0.8, 2]
    predictions = {
        "person-next-to-defect.jpg": (np.array([correct], np.float32), (100, 100)),
        "person-overlaps-defect.jpg": (np.array([correct], np.float32), (100, 100)),
        "alternative-box.jpg": (np.array([correct, alternative], np.float32), (100, 100)),
        "low-score.jpg": (np.array([[20, 20, 60, 60, 0.2, 2]], np.float32), (100, 100)),
    }
    subjects = {
        "person-next-to-defect.jpg": np.array([[70, 20, 100, 60]]),
        "person-overlaps-defect.jpg": np.array([[35, 20, 60, 60]]),
        "alternative-box.jpg": np.array([[35, 20, 60, 60]]),
        "low-score.jpg": np.empty((0, 4)),
    }
    labels = dict.fromkeys(predictions, truth)

    baseline = summarize_setting(predictions, labels, subjects, None, 0.30, {})
    filtered = summarize_setting(predictions, labels, subjects, 0.60, 0.30, {})
    pothole = filtered["classes"]["pothole"]

    assert baseline["classes"]["pothole"]["recall_at_confidence"] == pytest.approx(3 / 4)
    assert pothole["recall_at_confidence"] == pytest.approx(2 / 4)
    assert pothole["suppressed_true_positive_predictions"] == 2
    assert pothole["legitimate_instances_lost"] == 1
    assert filtered["labeled_instances_in_images_with_verifier_objects"] == 3
    assert 0 < filtered["map50_95"] < baseline["map50_95"]


def test_pair_manifest_requires_two_distinct_known_paths(tmp_path):
    manifest = tmp_path / "pairs.json"
    manifest.write_text(json.dumps({"repeated": ["view.jpg", "view.jpg"]}))
    with pytest.raises(ValueError, match="two distinct paths"):
        load_pairs(manifest, {"view.jpg": None})


def test_only_configured_verifier_classes_contribute_boxes(monkeypatch):
    predictions = np.array([[1, 2, 3, 4, 0.9, 0], [11, 12, 13, 14, 0.8, 1]], np.float32)
    monkeypatch.setattr(experiment, "predict", lambda *args, **kwargs: {"view.jpg": (predictions, (100, 100))})
    verifier = SimpleNamespace(names={0: "person", 1: "bicycle"})
    args = SimpleNamespace(object_classes=["bicycle"], verifier_confidence=0.25)

    assert experiment.subject_boxes(verifier, {}, args)["view.jpg"].tolist() == [[11, 12, 13, 14]]
