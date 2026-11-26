import json
import sys
from copy import deepcopy
from pathlib import Path

import pytest

torch = pytest.importorskip("torch")
ultralytics = pytest.importorskip("ultralytics")

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

from ai.training import promote_production_model as promotion

CANONICAL = {0: "broken_streetlight", 1: "clogged_drainage", 2: "pothole", 3: "road_crack"}
LEGACY = {0: "damaged_road", 1: "clogged_drainage", 2: "damaged_street_light", 3: "damaged_traffic_light"}

_BASE = {}


def write_checkpoint(path: Path, names: dict, train_name: str) -> Path:
    if "model" not in _BASE:
        _BASE["model"] = ultralytics.YOLO("yolov8n.yaml").model
    model = deepcopy(_BASE["model"])
    model.names = dict(names)
    model.nc = len(names)
    path.parent.mkdir(parents=True, exist_ok=True)
    torch.save({"model": model.half(), "ema": None, "epoch": -1, "optimizer": None, "train_args": {"name": train_name, "model": "yolov8m.pt"}}, path)
    return path


@pytest.fixture()
def layout(tmp_path):
    run = tmp_path / "checkpoints" / "neighborlens_v3_1_interim"
    source = write_checkpoint(run / "weights" / "best.pt", CANONICAL, "neighborlens_v3_1_interim")
    (run / "train_config.json").write_text(json.dumps({"target_eligible": False}), encoding="utf-8")
    production = write_checkpoint(tmp_path / "production" / "best.pt", LEGACY, "infrastructure_v3")
    archive = tmp_path / "production" / "archive" / "best_legacy_pre_v3_1.pt"
    return source, production, archive


def test_promotion_archives_legacy_and_installs_byte_identical_canonical_model(layout):
    source, production, archive = layout
    legacy_sha = promotion.sha256(production)
    source_sha = promotion.sha256(source)

    result = promotion.promote(source, production, archive)

    assert promotion.sha256(archive) == legacy_sha
    assert promotion.sha256(production) == source_sha
    assert promotion.sha256(source) == source_sha
    assert result["production"]["names"] == CANONICAL
    assert result["legacy"]["names"] == LEGACY
    manifest = json.loads((production.parent / "model_manifest.json").read_text(encoding="utf-8"))
    assert manifest["version"] == "neighborlens_v3_1_interim"
    assert manifest["release_label"] == "v3.1 Interim Baseline"
    assert manifest["target_eligible"] is False
    assert manifest["research_target_achieved"] is False
    assert manifest["held_out_test_evaluated"] is False
    assert manifest["source_sha256"] == manifest["production_sha256"] == source_sha
    assert manifest["legacy_archive"]["sha256"] == legacy_sha
    assert not list(production.parent.glob("*.tmp"))


def test_promotion_is_idempotent(layout):
    source, production, archive = layout
    promotion.promote(source, production, archive)
    archive_sha = promotion.sha256(archive)
    again = promotion.promote(source, production, archive)
    assert promotion.sha256(archive) == archive_sha
    assert again["production"]["sha256"] == promotion.sha256(source)


def test_rollback_restores_the_legacy_bytes_and_removes_the_manifest(layout):
    source, production, archive = layout
    legacy_sha = promotion.sha256(production)
    promotion.promote(source, production, archive)
    promotion.rollback(production, archive)
    assert promotion.sha256(production) == legacy_sha
    assert promotion.sha256(archive) == legacy_sha
    assert not (production.parent / "model_manifest.json").exists()


def test_non_canonical_source_is_refused_and_production_is_untouched(layout, tmp_path):
    source, production, archive = layout
    write_checkpoint(source, {0: "pothole", 1: "road_crack", 2: "clogged_drainage", 3: "broken_streetlight"}, "neighborlens_v3_1_interim")
    before = promotion.sha256(production)
    with pytest.raises(promotion.PromotionError):
        promotion.promote(source, production, archive)
    assert promotion.sha256(production) == before
    assert not archive.exists()


def test_target_eligible_source_is_refused(layout):
    source, production, archive = layout
    (source.parent.parent / "train_config.json").write_text(json.dumps({"target_eligible": True}), encoding="utf-8")
    with pytest.raises(promotion.PromotionError):
        promotion.promote(source, production, archive)


def test_wrong_run_is_refused(layout):
    source, production, archive = layout
    write_checkpoint(source, CANONICAL, "neighborlens_v3_clean")
    with pytest.raises(promotion.PromotionError):
        promotion.promote(source, production, archive)


def test_a_different_existing_rollback_copy_is_never_overwritten(layout):
    source, production, archive = layout
    write_checkpoint(archive, LEGACY, "something_else")
    before = promotion.sha256(archive)
    with pytest.raises(promotion.PromotionError):
        promotion.promote(source, production, archive)
    assert promotion.sha256(archive) == before


def test_inference_api_serves_promoted_production_metadata(layout, monkeypatch):
    pytest.importorskip("fastapi")
    pytest.importorskip("cv2")
    from ai.inference import inference_api
    from ai.inference.damage_contract import ModelContractError

    source, production, archive = layout
    with pytest.raises(ModelContractError):
        inference_api.create_app(str(production), 0.30)

    promotion.promote(source, production, archive)
    from fastapi.testclient import TestClient

    health = TestClient(inference_api.create_app(str(production), 0.30)).get("/health").json()
    info = health["model_info"]
    assert info["name"] == "NeighborLens YOLOv8n"
    assert info["version"] == "neighborlens_v3_1_interim"
    assert info["release_label"] == "v3.1 Interim Baseline"
    assert info["target_eligible"] is False
    assert info["checkpoint"] == "production/best.pt"
    assert {int(key): value for key, value in health["classes"].items()} == CANONICAL

    write_checkpoint(production, CANONICAL, "neighborlens_v3_1_interim_tampered")
    with pytest.raises(ModelContractError):
        inference_api.create_app(str(production), 0.30)
