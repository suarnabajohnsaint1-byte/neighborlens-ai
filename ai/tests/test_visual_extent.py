import asyncio
import hashlib
import math
import time
from pathlib import Path
from types import SimpleNamespace

import cv2
import numpy as np
import pytest

from ai.inference import visual_extent as extent
from ai.inference.mask_geometry import crack_geometry, reference_coverage, region_geometry


def patterned_crop():
    image = np.full((140, 180, 3), 180, np.uint8)
    cv2.line(image, (46, 35), (120, 95), (25, 25, 25), 4)
    cv2.line(image, (85, 65), (122, 39), (25, 25, 25), 4)
    return image


def test_pixel_graph_and_binary_mask_contract():
    cross = np.zeros((17, 17), np.uint8)
    cross[8, 2:15] = 1
    cross[2:15, 8] = 1
    assert region_geometry(cross)["candidate_area_px2"] == 25
    assert crack_geometry(cross)["branch_clusters"] == 1
    assert crack_geometry(cross)["skeleton_length_px"] == 24
    diagonal = np.eye(8, dtype=np.uint8)
    diagonal[0, 7] = 1
    assert region_geometry(diagonal)["components"] == 2
    assert crack_geometry(diagonal)["skeleton_length_px"] == pytest.approx(7 * math.sqrt(2), abs=.001)
    for invalid in (cross * 255, cross.astype(float), np.ones((2, 2, 2)), np.zeros_like(cross), np.ones_like(cross)):
        with pytest.raises(ValueError):
            region_geometry(invalid)


@pytest.mark.parametrize(("category", "metric"), [
    ("road_crack", "branch_clusters"), ("pothole", "largest_contour_circularity"),
    ("clogged_drainage", "threshold_stability_iou"), ("broken_streetlight", "line_segments")
])
def test_category_features_are_local_to_oriented_box(category, metric):
    image = patterned_crop()
    box = (30.2, 20.1, 102.5, 87.6)
    result = extent.analyze_region(image, category, box)
    assert result["region"] == [30, 20, 103, 88]
    assert result["grid"] == [103, 88]
    assert result["quality"] == "EXPERIMENTAL"
    assert metric in result["features"]
    assert extent.analyze_region(image[20:108, 30:133], category, (0, 0, 103, 88))["features"] == result["features"]
    assert not any(key.endswith(("_mm", "_m2")) or "severity" in key for key in result["features"])


def test_pixel_geometry_changes_with_framing_scale_and_warp():
    image = patterned_crop()
    def measure(view):
        return extent.analyze_region(view, "road_crack", (0, 0, view.shape[1], view.shape[0]))
    original = measure(image)
    enlarged = measure(cv2.resize(image, (270, 210)))
    perspective = cv2.getPerspectiveTransform(np.float32([[0,0],[179,0],[0,139],[179,139]]),
                                              np.float32([[30,0],[150,0],[0,139],[179,139]]))
    angled = measure(cv2.warpPerspective(image, perspective, (180, 140), borderMode=cv2.BORDER_REPLICATE))
    assert enlarged["features"]["skeleton_length_px"] > original["features"]["skeleton_length_px"]
    assert angled["features"] != original["features"]
    assert measure(cv2.resize(image, (720,560)))["grid"] == [320,249]
    assert measure(np.zeros_like(image))["reason"] == "INSUFFICIENT_CONTRAST"
    assert extent.analyze_region(image,"road_crack",(160,100,100,20))["reason"] == "INVALID_CROP"


def test_timeout_and_exception_preserve_detection(monkeypatch):
    detection = SimpleNamespace(eligible=True, damage_type="road_crack", confidence_score=.8,
                                bounding_box=SimpleNamespace(x=0, y=0, width=180, height=140))
    async def run(**kwargs):
        return await extent.visual_observation(patterned_crop(), [detection], "road_crack", **kwargs)
    monkeypatch.setattr(extent, "analyze_region", lambda *_: time.sleep(.08))
    assert asyncio.run(run(timeout=.001))["reason"] == "ANALYSIS_TIMEOUT"
    def exhausted(*_):
        raise MemoryError()
    monkeypatch.setattr(extent, "analyze_region", exhausted)
    assert asyncio.run(run())["reason"] == "ANALYSIS_UNAVAILABLE"
    assert detection.confidence_score == .8


def test_reference_coverage_requires_a_comparable_surface():
    drain = np.zeros((10, 10), np.uint8)
    drain[1:9, 1:9] = 1
    debris = drain.copy()
    debris[3:, :] = 0
    assert reference_coverage(debris, drain) == {"affected_area_px2": 16, "reference_area_px2": 64, "visible_fraction": .25}
    for invalid in (drain[:2], np.zeros_like(drain), 1 - drain):
        with pytest.raises(ValueError):
            reference_coverage(debris, invalid)


def test_local_production_checkpoint_preserved():
    path = Path(__file__).resolve().parents[2] / "models/production/best.pt"
    if not path.exists():
        pytest.skip("Local production checkpoint unavailable")
    with path.open("rb") as stream:
        assert hashlib.file_digest(stream, "sha256").hexdigest() == "6e55d6fec65531180e1655e1b3c5931101fbf96e23346dff272b29c5422cd3d2"
