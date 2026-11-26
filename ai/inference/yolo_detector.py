"""Ultralytics model ownership and NeighborLens detection output."""

from __future__ import annotations

import math
import uuid
from collections.abc import Callable
from typing import Optional

from PIL import Image
from pydantic import BaseModel
from ultralytics import YOLO

if __package__:
    from .damage_contract import is_eligible, validate_model_names
    from .severity_evidence import SeverityMeasurement
else:
    from damage_contract import is_eligible, validate_model_names
    from severity_evidence import SeverityMeasurement

DIAGNOSTIC_CONFIDENCE_FLOOR = 0.05


class BoundingBox(BaseModel):
    x: float
    y: float
    width: float
    height: float


class DetectionItem(BaseModel):
    damage_id: str
    damage_type: str
    confidence_score: float
    severity_level: Optional[str] = None
    bounding_box: BoundingBox
    eligible: bool = False
    severity_measurement: SeverityMeasurement | None = None


class YoloDetector:
    def __init__(self, weights: str, *, model_factory: Callable[[str], YOLO] = YOLO) -> None:
        self._model = model_factory(weights)
        validate_model_names(self._model.names)

    @property
    def checkpoint(self) -> dict | None:
        return getattr(self._model, "ckpt", None)

    @property
    def model_yaml(self) -> dict | None:
        return getattr(getattr(self._model, "model", None), "yaml", None)

    def detect(
        self, pil_image: Image.Image, confidence: float, image_size: int = 800
    ) -> tuple[list[DetectionItem], list[float]]:
        return run_yolo_detections(pil_image, self._model, confidence, image_size)


def floor_confidence(score: float) -> float:
    return math.floor(score * 10000) / 10000


def run_yolo_detections(
    pil_image: Image.Image, model: YOLO, confidence: float, image_size: int = 800
) -> tuple[list[DetectionItem], list[float]]:
    """Run detection at the diagnostic floor and extract the existing image embedding."""
    prediction = model.predict(
        source=pil_image, imgsz=image_size, conf=min(confidence, DIAGNOSTIC_CONFIDENCE_FLOOR),
        rect=False, max_det=100, augment=True, verbose=False,
    )[0]

    detections = []
    names = prediction.names
    boxes = prediction.boxes
    if boxes is not None:
        for box in boxes:
            class_name = str(names[int(box.cls[0].item())])
            score = float(box.conf[0].item())
            x1, y1, x2, y2 = [float(val) for val in box.xyxy[0].tolist()]
            detections.append(
                DetectionItem(
                    damage_id=str(uuid.uuid4()),
                    damage_type=class_name,
                    confidence_score=floor_confidence(score),
                    severity_level=None,
                    eligible=is_eligible(class_name, score, confidence),
                    bounding_box=BoundingBox(
                        x=round(x1, 2),
                        y=round(y1, 2),
                        width=round(max(0.0, x2 - x1), 2),
                        height=round(max(0.0, y2 - y1), 2),
                    ),
                )
            )

    embedding = []
    try:
        embedding_tensor = model.embed(source=pil_image, imgsz=image_size, verbose=False)
        if embedding_tensor is not None and len(embedding_tensor) > 0:
            embedding = embedding_tensor[0].detach().cpu().flatten().tolist()
    except Exception:
        embedding = []

    return detections, embedding
