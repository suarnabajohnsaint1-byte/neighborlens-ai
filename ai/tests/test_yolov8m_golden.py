"""Replay the recorded v9 HTTP responses on the original local runtime."""

import hashlib
import json
import os
from pathlib import Path
from uuid import UUID

import pytest

from ai.inference.inference_api import create_app

ROOT = Path(__file__).resolve().parents[2]
PAIR_ROUTE = "/api/v1/damage/verify-pair"

pytestmark = pytest.mark.skipif(
    os.environ.get("NEIGHBORLENS_VERIFY_V9_GOLDEN") != "1",
    reason="Set NEIGHBORLENS_VERIFY_V9_GOLDEN=1 on the recorded v9 runtime with the audit assets",
)


def checked_path(record):
    path = ROOT / record["path"]
    with path.open("rb") as stream:
        assert hashlib.file_digest(stream, "sha256").hexdigest() == record["sha256"], path
    return path


@pytest.fixture(scope="module")
def recorded_app():
    from fastapi.testclient import TestClient

    baseline = json.loads((ROOT / "ai/ARCHITECTURE_BASELINE.json").read_text(encoding="utf-8"))
    weights = checked_path(baseline["checkpoints"]["production"])
    checked_path(baseline["checkpoints"]["manifest"])
    photos = {}
    for name, record in baseline["fixtures"].items():
        file = checked_path(record)
        photos[name] = (file.name, file.read_bytes(), "image/png" if file.suffix == ".png" else "image/jpeg")
    runtime = baseline["runtime"]
    with TestClient(create_app(str(weights), runtime["confidence"], runtime["image_size"])) as client:
        yield client, baseline, photos


def normalize_uuids(value):
    if isinstance(value, list):
        return [normalize_uuids(item) for item in value]
    if isinstance(value, dict):
        normalized = {}
        for key, item in value.items():
            if key in {"request_id", "damage_id"}:
                assert UUID(item).version == 4
            else:
                normalized[key] = normalize_uuids(item)
        return normalized
    return value


def test_health_matches_v9_baseline(recorded_app):
    client, baseline, _ = recorded_app
    for route in ("/health", "/api/health"):
        response = client.get(route)
        assert response.status_code == 200
        assert response.json() == baseline["health"]


def check_visual_extension(photo):
    extent = photo.pop("visual_extent")
    if photo["canonical_category"] is None:
        assert extent is None
    else:
        assert extent["category"] == photo["canonical_category"]
        assert extent["source"] == "opencv_visual_extent" and extent["version"] == "1"
        assert extent["quality"] in {"EXPERIMENTAL", "UNUSABLE"}
        assert "severity_level" not in extent


@pytest.mark.parametrize(("case", "route", "first", "second"), [
    ("single_B", "/predict", "B", None),
    ("single_A", "/predict", "A", None),
    ("single_Camo_raw", "/predict", "CAMO", None),
    ("pair_A_B", PAIR_ROUTE, "A", "B"),
    ("pair_C_D", PAIR_ROUTE, "C", "D"),
    ("pair_alias", "/verify-pair", "A", "B"),
    ("pair_duplicate", PAIR_ROUTE, "A", "A"),
    ("bad_bytes", "/predict", ("not.jpg", b"not an image", "image/jpeg"), None),
    ("bad_mime", "/predict", ("a.txt", b"not an image", "text/plain"), None),
    ("over_limit", "/predict", ("a.jpg", b"x" * (4 * 1024 * 1024 + 1), "image/jpeg"), None),
])
def test_inference_matches_v9_baseline(recorded_app, case, route, first, second):
    client, baseline, photos = recorded_app
    first_file = photos[first] if isinstance(first, str) else first
    files = {"image": first_file} if second is None else {"image1": first_file, "image2": photos[second]}
    response = client.post(route, files=files)
    expected = baseline["contract"][case]
    assert response.status_code == expected["http"]
    actual = normalize_uuids(response.json())
    if response.is_success:
        # The original detector contract is still checked byte-for-byte below.
        # Remove only the explicitly verified additive assessment fields.
        assert actual.pop("evidence_relevance") == "UNAVAILABLE"
        assert actual.pop("evidence_screening") is None
        assert actual.pop("severity_status") == "NOT_ASSESSED"
        reason = actual.pop("severity_reason")
        assert reason == ("SEVERITY_PROVIDER_UNAVAILABLE" if actual["detected"] else "NO_ELIGIBLE_DAMAGE")
        if route == "/predict":
            check_visual_extension(actual)
        else:
            for index in (1, 2):
                photo = actual[f"image{index}_assessment"]
                assert min(photo.pop("image_size").values()) > 0
                check_visual_extension(photo)
                for detection in actual[f"image{index}_detections"]:
                    assert detection.pop("severity_measurement") is None
    assert actual == expected["body"]
    assert hashlib.sha256(json.dumps(
        actual, sort_keys=True, separators=(",", ":"), ensure_ascii=True,
    ).encode("utf-8")).hexdigest() == expected["normalized_sha256"]
