import ast
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

from ai.inference import damage_contract as contract

CANONICAL = ["broken_streetlight", "clogged_drainage", "pothole", "road_crack"]
LEGACY = {"damaged_road", "damaged_street_light", "damaged_traffic_light"}


def detection(name, confidence):
    return {"class": name, "confidence": confidence}


def test_contract_is_the_four_research_classes():
    assert contract.CANONICAL_CLASS_NAMES == {0: "broken_streetlight", 1: "clogged_drainage", 2: "pothole", 3: "road_crack"}
    assert not (contract.CANONICAL_CLASSES & LEGACY)


def test_paper_aligned_names_validate():
    contract.validate_model_names({0: "broken_streetlight", 1: "clogged_drainage", 2: "pothole", 3: "road_crack"})


@pytest.mark.parametrize(
    "names",
    [
        {0: "damaged_road", 1: "clogged_drainage", 2: "damaged_street_light", 3: "damaged_traffic_light"},
        {0: "broken_streetlight", 1: "clogged_drainage", 2: "pothole"},
        {0: "clogged_drainage", 1: "broken_streetlight", 2: "pothole", 3: "road_crack"},
        {0: "person", 1: "bicycle"},
    ],
)
def test_incompatible_checkpoint_is_refused(names):
    with pytest.raises(contract.ModelContractError):
        contract.validate_model_names(names)


@pytest.mark.parametrize("name", CANONICAL)
def test_each_canonical_class_passes_through_unchanged(name):
    decision = contract.decide([detection(name, 0.8)], 0.30)
    assert decision["detected"] is True
    assert decision["canonical_category"] == name
    assert decision["category"] == name
    assert decision["display_category"] == contract.DISPLAY_LABELS[name]
    assert decision["source"] == "yolo_backend"
    assert decision["reason"] is None


@pytest.mark.parametrize(
    "confidence, eligible",
    [(0.31, True), (0.30, True), (0.2999, False), (0.22, False), (0.15, False)],
)
def test_confidence_boundary(confidence, eligible):
    decision = contract.decide([detection("pothole", confidence)], 0.30)
    assert decision["detected"] is eligible
    assert decision["inconclusive"] is (not eligible)
    assert decision["confidence"] == confidence
    if not eligible:
        assert decision["canonical_category"] is None
        assert decision["reason"] == contract.LOW_CONFIDENCE
        assert decision["source"] == "yolo_backend"


def test_unknown_class_is_unsupported_and_not_remapped():
    decision = contract.decide([detection("damaged_road", 0.95)], 0.30)
    assert decision["detected"] is False
    assert decision["canonical_category"] is None
    assert decision["reason"] == contract.UNSUPPORTED_CLASS
    assert decision["source"] == "yolo_backend_unsupported"


def test_no_detection_reports_null_confidence():
    decision = contract.decide([], 0.30)
    assert decision["reason"] == contract.NO_DETECTION
    assert decision["confidence"] is None


def test_inference_api_has_no_legacy_aliases_or_hidden_fallback_threshold():
    source = "\n".join(
        (ROOT / "ai" / "inference" / filename).read_text(encoding="utf-8")
        for filename in ("inference_api.py", "yolo_detector.py")
    )
    tree = ast.parse(source)
    assigned = {target.id for node in ast.walk(tree) if isinstance(node, ast.Assign) for target in node.targets if isinstance(target, ast.Name)}
    assert not ({"CLASS_ALIASES", "CANONICAL_DAMAGE_CLASSES", "VALID_DAMAGE_CLASSES", "CATEGORY_DISPLAY_NAMES"} & assigned)
    strings = {node.value for node in ast.walk(tree) if isinstance(node, ast.Constant) and isinstance(node.value, str)}
    assert not (strings & LEGACY)
    assert "low_confidence_match" not in strings
    numbers = {node.value for node in ast.walk(tree) if isinstance(node, ast.Constant) and isinstance(node.value, float)}
    assert 0.15 not in numbers
