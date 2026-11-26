"""Provisional localization for the Citizen two-photo preview."""

from PIL import ImageOps

if __package__:
    from .damage_contract import CANONICAL_CLASSES
else:
    from damage_contract import CANONICAL_CLASSES

PAVEMENT_CLASSES = {"pothole", "road_crack"}


def detection_hint(detections, *, contrast=False):
    primary = max((item for item in detections if item.damage_type in CANONICAL_CLASSES),
                  key=lambda item: (item.eligible, item.confidence_score), default=None)
    if primary is None or (contrast and (not primary.eligible or primary.damage_type not in PAVEMENT_CLASSES)):
        return None
    return {
        "source": "contrast" if contrast else "original",
        "class": primary.damage_type,
        "confidence": primary.confidence_score,
        "bounding_box": primary.bounding_box.model_dump(),
    }


def retry_pavement_hint(detector, image, confidence, image_size, screen):
    # Contrast adjustment leaves bounding boxes in the original pixel space.
    retry = ImageOps.autocontrast(image, cutoff=1)
    detections, _ = detector.detect(retry, confidence, min(image_size, 512))
    hint = detection_hint(screen(detections), contrast=True)
    if hint and hint["class"] == "road_crack" and image_size > 512:
        detections, _ = detector.detect(retry, confidence, image_size)
        candidate = detection_hint(screen(detections), contrast=True)
        if candidate and candidate["class"] == "road_crack":
            hint["scale_agreement"] = boxes_overlap(hint["bounding_box"], candidate["bounding_box"])
    return hint


def boxes_overlap(a, b):
    width = max(0, min(a["x"] + a["width"], b["x"] + b["width"]) - max(a["x"], b["x"]))
    height = max(0, min(a["y"] + a["height"], b["y"] + b["height"]) - max(a["y"], b["y"]))
    intersection = width * height
    union = a["width"] * a["height"] + b["width"] * b["height"] - intersection
    return union > 0 and intersection / union >= 0.5
