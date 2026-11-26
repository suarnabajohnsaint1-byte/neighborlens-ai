"""Compare two damage photos using YOLO image embeddings.

This module checks whether two photos depict the same damage scene. It is a
pair-matching step, not a replacement for a trained damage-classification
model. The YOLO model must be supplied with weights that are available locally.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Sequence

from PIL import Image, ImageOps

try:
    import imagehash
except ImportError as error:  
    imagehash = None
    _imagehash_import_error = error

SUPPORTED_SUFFIXES = {".jpg", ".jpeg", ".png", ".webp"}
DEFAULT_THRESHOLD = 0.85
PHASH_THRESHOLD = 5
EMBED_SIZE = (640, 640)


class ImageSimilarityError(ValueError):
    """Raised when image comparison cannot be completed safely."""


@dataclass(frozen=True)
class SimilarityResult:
    """Stable JSON-compatible response for the pair comparison."""

    match: bool
    similarity_score: float
    threshold: float
    image_1: str
    image_2: str
    timestamp: str
    comparison_id: str
    model: str
    details: str

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


def validate_image_path(image_path: str | Path) -> Path:
    """Validate existence and supported format before loading a model."""

    path = Path(image_path)
    if not path.is_file():
        raise ImageSimilarityError(f"Image does not exist: {path}")
    if path.suffix.lower() not in SUPPORTED_SUFFIXES:
        raise ImageSimilarityError(
            f"Unsupported image format: {path.suffix}. "
            f"Use one of: {', '.join(sorted(SUPPORTED_SUFFIXES))}"
        )
    return path


def cosine_similarity(first: Sequence[float], second: Sequence[float]) -> float:
    """Return cosine similarity in the range [-1, 1]."""

    if not first or not second or len(first) != len(second):
        raise ImageSimilarityError("Embeddings must be non-empty and have equal dimensions.")

    try:
        import torch
        import torch.nn.functional as functional
        first_tensor = torch.tensor(list(first), dtype=torch.float32).reshape(1, -1)
        second_tensor = torch.tensor(list(second), dtype=torch.float32).reshape(1, -1)
        if not torch.isfinite(first_tensor).all() or not torch.isfinite(second_tensor).all():
            raise ImageSimilarityError("Embeddings contain non-finite values.")
        if torch.linalg.vector_norm(first_tensor) == 0 or torch.linalg.vector_norm(second_tensor) == 0:
            raise ImageSimilarityError("Cannot compare a zero-length embedding.")
        score = float(functional.cosine_similarity(
            functional.normalize(first_tensor, dim=1),
            functional.normalize(second_tensor, dim=1),
        ).item())
        return max(-1.0, min(1.0, score))
    except ImportError:
        # Keep this small helper usable in lightweight test environments. The
        # YOLO runtime still supplies torch for real embedding extraction.
        dot = sum(left * right for left, right in zip(first, second))
        first_norm = math.sqrt(sum(value * value for value in first))
        second_norm = math.sqrt(sum(value * value for value in second))
        if first_norm == 0 or second_norm == 0:
            raise ImageSimilarityError("Cannot compare a zero-length embedding.")
        return max(-1.0, min(1.0, dot / (first_norm * second_norm)))


def _open_image(image_path: Path) -> Image.Image:
    """Open an image safely and apply EXIF orientation before comparison."""

    try:
        with Image.open(image_path) as source:
            return ImageOps.exif_transpose(source).convert("RGB")
    except (OSError, ValueError) as error:
        raise ImageSimilarityError(f"Could not read image {image_path}: {error}") from error


def _letterbox(image: Image.Image, size: tuple[int, int] = EMBED_SIZE) -> Image.Image:
    """Resize without distortion and pad to the fixed YOLO input dimensions."""

    width, height = image.size
    if not width or not height:
        raise ImageSimilarityError("Image has no usable dimensions.")
    scale = min(size[0] / width, size[1] / height)
    resized = image.resize((max(1, round(width * scale)), max(1, round(height * scale))), Image.Resampling.LANCZOS)
    canvas = Image.new("RGB", size, (114, 114, 114))
    offset = ((size[0] - resized.width) // 2, (size[1] - resized.height) // 2)
    canvas.paste(resized, offset)
    return canvas


def _phash_difference(first: Image.Image, second: Image.Image) -> int:
    if imagehash is None:
        raise ImageSimilarityError(
            "imagehash is required for duplicate detection. Run: pip install -r ai/requirements.txt"
        ) from _imagehash_import_error
    try:
        return int(imagehash.phash(first) - imagehash.phash(second))
    except (OSError, ValueError, TypeError) as error:
        raise ImageSimilarityError(f"Could not compute perceptual hash: {error}") from error


def _embedding_from_model(model: Any, image_path: Path) -> list[float]:
    """Extract a stable embedding using Ultralytics' supported embed API."""

    image = _letterbox(_open_image(image_path))
    embeddings = model.embed(source=image, imgsz=640, verbose=False)
    if not embeddings:
        raise ImageSimilarityError(f"YOLO returned no embedding for {image_path.name}.")

    embedding = embeddings[0]
    if hasattr(embedding, "detach"):
        embedding = embedding.detach().cpu().flatten().tolist()
    elif hasattr(embedding, "flatten"):
        embedding = embedding.flatten().tolist()
    return [float(value) for value in embedding]


def check_image_match(
    img_path1: str | Path,
    img_path2: str | Path,
    *,
    model_path: str = "yolov8n.pt",
    threshold: float = DEFAULT_THRESHOLD,
    model: Any | None = None,
) -> dict[str, Any]:
    """Match two photos using pHash first, then a normalized YOLO embedding.

    Bounding boxes are deliberately not compared: their coordinates change with
    crop, camera angle, resolution, and detector jitter even when the scene is
    the same. Image-level features are the appropriate signal for pair matching.
    """

    if not 0 <= threshold <= 1:
        raise ImageSimilarityError("Similarity threshold must be between 0 and 1.")
    first_path = validate_image_path(img_path1)
    second_path = validate_image_path(img_path2)
    first_image = _open_image(first_path)
    second_image = _open_image(second_path)
    phash_difference = _phash_difference(first_image, second_image)

    if phash_difference <= PHASH_THRESHOLD:
        return {
            "is_match": True,
            "similarity_score": 1.0,
            "phash_difference": phash_difference,
            "match_reason": "Identical perceptual hash",
        }

    if model is None:
        try:
            from ultralytics import YOLO
        except ImportError as error:
            raise ImageSimilarityError(
                "ultralytics is not installed. Run: pip install -r ai/requirements.txt"
            ) from error
        model = YOLO(model_path)

    first_embedding = _embedding_from_model(model, first_path)
    second_embedding = _embedding_from_model(model, second_path)
    score = cosine_similarity(first_embedding, second_embedding)
    rounded_score = round(score, 3)
    return {
        "is_match": score >= threshold,
        "similarity_score": rounded_score,
        "phash_difference": phash_difference,
        "match_reason": "High feature vector similarity" if score >= threshold else "Photos are not similar enough",
    }


def compare_damage_images(
    image_1: str | Path,
    image_2: str | Path,
    *,
    model_path: str = "yolov8n.pt",
    threshold: float = DEFAULT_THRESHOLD,
    model: Any | None = None,
) -> SimilarityResult:
    """Compare two images and return a structured match decision.

    ``model`` is injectable for tests. In production, omit it and provide a
    YOLO weights path. The model's embedding API is used instead of slicing
    internal layers, which avoids invalid tensors from detection skip paths.
    """

    if not 0 <= threshold <= 1:
        raise ImageSimilarityError("Similarity threshold must be between 0 and 1.")

    first = validate_image_path(image_1)
    second = validate_image_path(image_2)

    result = check_image_match(first, second, model_path=model_path, threshold=threshold, model=model)
    score = result["similarity_score"]
    rounded_score = round(score, 4)
    comparison_id = hashlib.sha256(
        f"{first.resolve()}|{second.resolve()}|{rounded_score}".encode("utf-8")
    ).hexdigest()[:16]
    matched = result["is_match"]

    return SimilarityResult(
        match=matched,
        similarity_score=rounded_score,
        threshold=threshold,
        image_1=str(first),
        image_2=str(second),
        timestamp=datetime.now(timezone.utc).isoformat(),
        comparison_id=comparison_id,
        model=model_path,
        details=(
            "Both photos depict the same damage scene and can be sent for "
            "YOLO damage classification."
            if matched
            else "Photos are not similar enough; request two photos of the same damage."
        ),
    )


def main() -> None:
    parser = argparse.ArgumentParser(description="Compare two damage photos with YOLO embeddings.")
    parser.add_argument("image_1")
    parser.add_argument("image_2")
    parser.add_argument("--model", default="yolov8n.pt")
    parser.add_argument("--threshold", type=float, default=DEFAULT_THRESHOLD)
    args = parser.parse_args()
    result = compare_damage_images(
        args.image_1, args.image_2, model_path=args.model, threshold=args.threshold
    )
    print(json.dumps(result.to_dict(), indent=2))


if __name__ == "__main__":
    main()
