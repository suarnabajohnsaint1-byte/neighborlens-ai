"""Offline boundary checks. These never fit a model or provide accuracy evidence."""
import pytest

from ai.training.severity_classifier import evaluate
from ai.training.severity_dataset import reviewed_cases, site_split
from ai.training.severity_pairs import paired_features

POLICY = {"version": "test", "approval_ref": "test", "rule_refs": {"pothole": "test"},
          "reviewers": {"a": ["pothole"], "b": ["pothole"]}}
CATALOG = [{"sha256": key, "image": f"test/images/{key}.jpg", "source_family": key, "dhash": bits}
           for key, bits in [("one", "0"), ("two", "ffffffffffffffff")]]


def record():
    return {"photos": ["one", "two"], "site_id": "site", "event_id": "event", "inspection_ref": "test",
            "evidence": "protocol test", "capture_context": "test", "category": "pothole", "label": "MINOR",
            "inspection_class": "MINOR", "visually_supported": True, "independent_of_detector_training": True,
            "reviews": [{"reviewer": k, "label": "MINOR", "basis": "test"} for k in ("a", "b")],
            "rubric_version": "test"}


def test_review_gate():
    with pytest.raises(ValueError, match="No adjudicated"):
        list(reviewed_cases(CATALOG, [], POLICY))
    case = record()
    assert list(reviewed_cases(CATALOG, [case], POLICY))[0]["split"] == site_split("site")
    for change in ({"visually_supported": False}, {"inspection_class": "MAJOR"}, {"photos": ["one", "one"]},
                   {"reviews": [case["reviews"][0]] * 2}, {"label": "MAJOR", "inspection_class": "MAJOR"}):
        with pytest.raises(ValueError):
            list(reviewed_cases(CATALOG, [{**case, **change}], POLICY))
    with pytest.raises(ValueError):
        list(reviewed_cases(CATALOG, [case, case], POLICY))


def test_pair_feature_order_and_missing_view():
    def photo(count):
        return {"visual_extent": {"category": "broken_streetlight", "source": "opencv_visual_extent", "version": "1",
                "quality": "EXPERIMENTAL", "grid": [40, 30], "features": {"line_segments": count, "longest_line_px": 20}}}
    pair = {"detected": True, "class_agreement": True, "canonical_category": "broken_streetlight",
            "image1_assessment": photo(1), "image2_assessment": photo(3)}
    assert paired_features(pair) == paired_features({**pair, "image1_assessment": photo(3), "image2_assessment": photo(1)})
    assert paired_features({**pair, "image1_assessment": {}})[1] is None


def test_heldout_counts_include_abstentions_and_inspected_major_with_ambiguous_photos():
    cases = [{**record(), "site_id": label, "label": label, "inspection_class": truth,
              "features": feature, "detected_category": "pothole"} for label, truth, feature in
             [("MINOR", "MINOR", [-5]), ("MAJOR", "MAJOR", None), ("INSUFFICIENT", "MAJOR", [-5])]]
    result = evaluate({"mean": [0], "scale": [1], "weights": [0, 1]}, iter(cases), "pothole", [.2, .8])
    assert result["false_minor_rate_among_inspected_major"] == .5
    assert result["matrix_truth_by_prediction"]["MAJOR"]["INSUFFICIENT"] == 1
    assert result["sites"] == 3
