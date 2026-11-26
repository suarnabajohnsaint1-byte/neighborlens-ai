"""FastAPI endpoint for scanning infrastructure images with a fine-tuned YOLOv8 model."""

from __future__ import annotations

from pathlib import Path
from typing import Dict, List

from fastapi import FastAPI, File, HTTPException, UploadFile, status
from PIL import Image, ImageOps
from pydantic import BaseModel
from ultralytics import YOLO

TARGET_CLASSES = {"damaged_road", "clogged_drainage", "damaged_street_light"}
DEFAULT_WEIGHTS = "best.pt"


class BoundingBox(BaseModel):
    x1: float
    y1: float
    x2: float
    y2: float


class DetectedIssue(BaseModel):
    class_name: str
    confidence: float
    bounding_box: BoundingBox


class ScanInfrastructureResponse(BaseModel):
    has_issues: bool
    detected_issues: List[DetectedIssue]
    summary: Dict[str, int]


app = FastAPI(title="Infrastructure Scanner API", version="1.0.0")


def load_model(weights_path: str = DEFAULT_WEIGHTS) -> YOLO:
    model_file = Path(weights_path)
    if not model_file.exists():
        raise FileNotFoundError(f"Model weights not found: {weights_path}")
    return YOLO(str(model_file))


def validate_image(upload: UploadFile) -> Image.Image:
    if upload.content_type not in {"image/jpeg", "image/png", "image/webp"}:
        raise HTTPException(
            status_code=status.HTTP_415_UNSUPPORTED_MEDIA_TYPE,
            detail="Invalid image format. Please upload a JPEG, PNG, or WebP file.",
        )

    content = upload.file.read()
    try:
        image = ImageOps.exif_transpose(Image.open(__import__("io").BytesIO(content))).convert("RGB")
    except Exception as exc:  # pragma: no cover - defensive error path
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="The uploaded file is not a valid image.",
        ) from exc
    return image


@app.post("/api/v1/scan-infrastructure", response_model=ScanInfrastructureResponse)
async def scan_infrastructure(image: UploadFile = File(...)) -> ScanInfrastructureResponse:
    try:
        model = load_model(DEFAULT_WEIGHTS)
    except FileNotFoundError as exc:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Missing model weights: {DEFAULT_WEIGHTS}",
        ) from exc

    try:
        pil_image = validate_image(image)
    except HTTPException:
        raise

    results = model(pil_image, conf=0.25, imgsz=640, verbose=False)
    detections: List[DetectedIssue] = []
    summary = {"damaged_road": 0, "clogged_drainage": 0, "damaged_street_light": 0}

    for result in results:
        boxes = result.boxes
        if boxes is None:
            continue
        names = result.names
        for box in boxes:
            class_id = int(box.cls[0].item())
            class_name = str(names.get(class_id, ""))
            if class_name not in TARGET_CLASSES:
                continue

            confidence = float(box.conf[0].item())
            x1, y1, x2, y2 = [float(v) for v in box.xyxy[0].tolist()]

            summary[class_name] = summary.get(class_name, 0) + 1
            detections.append(
                DetectedIssue(
                    class_name=class_name,
                    confidence=round(confidence, 4),
                    bounding_box=BoundingBox(x1=x1, y1=y1, x2=x2, y2=y2),
                )
            )

    has_issues = bool(detections)
    return ScanInfrastructureResponse(has_issues=has_issues, detected_issues=detections, summary=summary)


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("ai.scan_infrastructure_api:app", host="127.0.0.1", port=8000, reload=False)
