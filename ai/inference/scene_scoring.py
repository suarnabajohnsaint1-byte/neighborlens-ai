"""Pure scoring for the advisory scene comparison."""

import math
from dataclasses import dataclass
from typing import Sequence


@dataclass(frozen=True)
class SceneScore:
    composite: float
    is_match: bool
    status: str


def cosine_similarity(first: Sequence[float], second: Sequence[float]) -> float:
    if not first or not second or len(first) != len(second):
        return 0.0
    dot = sum(a * b for a, b in zip(first, second))
    norm1 = math.sqrt(sum(a * a for a in first))
    norm2 = math.sqrt(sum(b * b for b in second))
    if norm1 == 0 or norm2 == 0:
        return 0.0
    return max(0.0, min(1.0, dot / (norm1 * norm2)))


def score_scene(
    *,
    embedding_similarity: float,
    inlier_ratio: float,
    perspective_aligned: bool,
    common_eligible_class: bool,
    comparison_available: bool,
) -> SceneScore:
    class_bonus = 0.25 if common_eligible_class else 0.0
    composite = round(
        (0.55 * embedding_similarity) + class_bonus + (0.20 * min(1.0, inlier_ratio * 2.0)), 4
    )
    is_match = common_eligible_class and (
        composite >= 0.70
        or (perspective_aligned and embedding_similarity >= 0.55)
        or embedding_similarity >= 0.85
    )
    status = ("MATCH" if is_match else "MISMATCH") if comparison_available else "UNAVAILABLE"
    return SceneScore(composite, is_match, status)
