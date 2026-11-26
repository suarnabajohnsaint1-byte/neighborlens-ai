from __future__ import annotations

import re
from typing import Iterable, Mapping, Optional, Sequence

CANONICAL_CLASS_NAMES = {
    0: "broken_streetlight",
    1: "clogged_drainage",
    2: "pothole",
    3: "road_crack",
}

CANONICAL_CLASSES = frozenset(CANONICAL_CLASS_NAMES.values())

DISPLAY_LABELS = {
    "broken_streetlight": "Broken Streetlight",
    "clogged_drainage": "Clogged Drainage",
    "pothole": "Pothole",
    "road_crack": "Road Crack",
}

PRODUCTION_MANIFEST_NAME = "model_manifest.json"

ACCEPTED = "ACCEPTED"
LOW_CONFIDENCE = "LOW_CONFIDENCE"
NO_DETECTION = "NO_DETECTION"
UNSUPPORTED_CLASS = "UNSUPPORTED_CLASS"


class ModelContractError(RuntimeError):
    pass


def validate_model_names(names: Mapping[int, str]) -> None:
    actual = {int(key): str(value) for key, value in dict(names).items()}
    if actual != CANONICAL_CLASS_NAMES:
        raise ModelContractError(
            "Model class contract mismatch. "
            f"Expected {CANONICAL_CLASS_NAMES}, checkpoint exposes {actual}. "
            "Refusing to serve: predictions would not map to the NeighborLens research classes."
        )


def is_eligible(class_name: str, confidence: float, min_confidence: float) -> bool:
    return class_name in CANONICAL_CLASSES and confidence >= min_confidence


def decide(detections: Sequence[Mapping], min_confidence: float) -> dict:
    canonical = [item for item in detections if item["class"] in CANONICAL_CLASSES]
    eligible = [item for item in canonical if item["confidence"] >= min_confidence and item.get("eligible") is not False]

    if eligible:
        outcome, primary = ACCEPTED, _top(eligible)
    elif canonical:
        outcome, primary = LOW_CONFIDENCE, _top(canonical)
    elif detections:
        outcome, primary = UNSUPPORTED_CLASS, _top(detections)
    else:
        outcome, primary = NO_DETECTION, None

    detected = outcome == ACCEPTED
    category = primary["class"] if detected else None
    return {
        "detected": detected,
        "inconclusive": not detected,
        "reason": None if detected else outcome,
        "category": category or "Inconclusive",
        "canonical_category": category,
        "display_category": DISPLAY_LABELS[category] if category else "Inconclusive",
        "confidence": primary["confidence"] if primary else None,
        "source": "yolo_backend_unsupported" if outcome == UNSUPPORTED_CLASS else "yolo_backend",
        "inference_status": outcome.lower(),
        "min_confidence": min_confidence,
        "candidate": {
            "canonical_category": primary["class"],
            "display_category": DISPLAY_LABELS[primary["class"]],
            "confidence": primary["confidence"],
            "accepted": detected,
        } if primary and primary["class"] in CANONICAL_CLASSES else None,
    }


def decide_pair(first: Sequence[Mapping], second: Sequence[Mapping], min_confidence: float) -> dict:
    photos = [decide(first, min_confidence), decide(second, min_confidence)]
    candidates = [photo["candidate"] for photo in photos]
    same_class = bool(candidates[0] and candidates[1] and candidates[0]["canonical_category"] == candidates[1]["canonical_category"])
    detected = same_class and all(photo["detected"] for photo in photos)
    candidate = dict(candidates[0]) if same_class else None
    if candidate:
        candidate["confidence"] = round(sum(item["confidence"] for item in candidates) / 2.0, 4)
        candidate["accepted"] = detected
    if same_class:
        state = "DETECTED" if detected else LOW_CONFIDENCE
    elif any(candidates):
        state = "PAIR_MISMATCH"
    elif any(photo["reason"] == UNSUPPORTED_CLASS for photo in photos):
        state = "UNSUPPORTED"
    else:
        state = NO_DETECTION
    return {
        "status": state,
        "detected": detected,
        "class_agreement": same_class,
        "provisional_class_agreement": same_class and not detected,
        "candidate": candidate,
        "photos": photos,
    }


def _top(items: Iterable[Mapping]) -> Optional[Mapping]:
    return max(items, key=lambda item: item["confidence"], default=None)


def release_label(version: str, target_eligible: Optional[bool]) -> str:
    match = re.fullmatch(r"(?:neighborlens_)?v(\d+)(?:_(\d+))?(?:_(.+))?", version or "")
    if match:
        number = match.group(1) + (f".{match.group(2)}" if match.group(2) else "")
        words = " ".join(word.capitalize() for word in (match.group(3) or "").split("_") if word)
        label = f"v{number} {words}".strip()
    else:
        label = version or ""
    if target_eligible is False:
        label = f"{label} Baseline".strip()
    return label
