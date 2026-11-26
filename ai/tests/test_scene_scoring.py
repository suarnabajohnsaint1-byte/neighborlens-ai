import pytest

from ai.inference.scene_scoring import SceneScore, cosine_similarity, score_scene


@pytest.mark.parametrize(("similarity", "ratio", "aligned", "common", "available", "expected"), [
    (0.45, 0.5, False, True, True, SceneScore(0.6975, False, "MISMATCH")),
    (0.46, 0.5, False, True, True, SceneScore(0.703, True, "MATCH")),
    (0.55, 0.1, True, True, True, SceneScore(0.5925, True, "MATCH")),
    (0.85, 0, False, True, True, SceneScore(0.7175, True, "MATCH")),
    (0.95, 0.5, True, False, True, SceneScore(0.7225, False, "MISMATCH")),
    (0.9, 0.5, True, True, False, SceneScore(0.945, True, "UNAVAILABLE")),
])
def test_advisory_scoring_thresholds(similarity, ratio, aligned, common, available, expected):
    result = score_scene(
        embedding_similarity=similarity,
        inlier_ratio=ratio,
        perspective_aligned=aligned,
        common_eligible_class=common,
        comparison_available=available,
    )
    assert result == expected


def test_cosine_similarity_preserves_missing_and_negative_score_behavior():
    assert cosine_similarity([1.0], [1.0]) == 1
    assert cosine_similarity([1.0], [-1.0]) == 0
    assert cosine_similarity([0.0], [1.0]) == 0
    assert cosine_similarity([], [1.0]) == 0
    assert cosine_similarity([1.0, 2.0], [1.0]) == 0
