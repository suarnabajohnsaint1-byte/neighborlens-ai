"""Serve trained NeighborLens YOLO detector with single-image inference and dual-image perspective verification."""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import hashlib
import uuid
from enum import Enum
from collections.abc import Callable
from io import BytesIO
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import cv2
from fastapi import FastAPI, File, HTTPException, UploadFile, status
import numpy as np
from PIL import Image, ImageOps
from pydantic import BaseModel
from ultralytics import YOLO

if __package__:
    from .damage_contract import (
        PRODUCTION_MANIFEST_NAME,
        ModelContractError,
        CANONICAL_CLASS_NAMES,
        DISPLAY_LABELS,
        decide,
        decide_pair,
        release_label,
    )
    from .yolo_detector import (
        DIAGNOSTIC_CONFIDENCE_FLOOR, BoundingBox, DetectionItem, YoloDetector,
        floor_confidence, run_yolo_detections,
    )
    from .scene_scoring import cosine_similarity, score_scene
    from .portrait_evidence import load_face_regions, portrait_candidates
    from .object_evidence import ObjectRegions, subject_candidates
    from .detection_preview import detection_hint, retry_pavement_hint
    from .severity_evidence import MeasurementProvider, attach_measurement, severity_status
    from .visual_extent import visual_observation
else:
    from damage_contract import (
        PRODUCTION_MANIFEST_NAME,
        ModelContractError,
        CANONICAL_CLASS_NAMES,
        DISPLAY_LABELS,
        decide,
        decide_pair,
        release_label,
    )
    from yolo_detector import (
        DIAGNOSTIC_CONFIDENCE_FLOOR, BoundingBox, DetectionItem, YoloDetector,
        floor_confidence, run_yolo_detections,
    )
    from scene_scoring import cosine_similarity, score_scene
    from portrait_evidence import load_face_regions, portrait_candidates
    from object_evidence import ObjectRegions, subject_candidates
    from detection_preview import detection_hint, retry_pavement_hint
    from severity_evidence import MeasurementProvider, attach_measurement, severity_status
    from visual_extent import visual_observation

LOGGER = logging.getLogger("neighborlens_inference_api")
logging.basicConfig(level=logging.INFO, format="%(levelname)s: %(message)s")

# --- Pydantic Data Models ---


class AlignmentDetails(BaseModel):
    perspective_aligned: bool
    good_matches_count: int
    inlier_ratio: float
    homography_matrix: Optional[List[List[float]]] = None


class VerificationSummary(BaseModel):
    is_valid_match: bool
    composite_similarity_score: float
    embedding_similarity: float
    damage_type_consensus: Optional[str] = None
    highest_severity: Optional[str] = None
    alignment: AlignmentDetails
    scene_status: str = "UNAVAILABLE"


class EvidenceRelevance(str, Enum):
    VERIFIED = "VERIFIED"
    UNVERIFIED = "UNVERIFIED"
    REJECTED = "REJECTED"
    UNAVAILABLE = "UNAVAILABLE"


class PredictionResponse(BaseModel, extra="allow"):
    # Preserve the detector payload while validating the independent relevance field.
    evidence_relevance: EvidenceRelevance
    evidence_screening: str | None = None
    severity_status: str
    severity_reason: str


class DualVerificationResponse(BaseModel):
    evidence_relevance: EvidenceRelevance
    evidence_screening: str | None = None
    severity_status: str
    severity_reason: str
    ok: bool
    request_id: str
    model: str
    detected: bool
    inconclusive: bool
    category: str
    canonical_category: Optional[str] = None
    display_category: str
    confidence: float
    agreement: bool
    is_valid_match: bool
    source: str
    summary: VerificationSummary
    image1_detections: List[DetectionItem]
    image2_detections: List[DetectionItem]
    status: str
    class_agreement: bool
    provisional_class_agreement: bool
    min_confidence: float
    candidate: Optional[Dict[str, Any]] = None
    image1_assessment: Dict[str, Any]
    image2_assessment: Dict[str, Any]


# --- Helper Computer Vision & Alignment Functions ---


def read_image_bytes(content: bytes) -> Tuple[Image.Image, np.ndarray]:
    """Load image bytes into PIL RGB (EXIF transposed) and OpenCV BGR."""
    if not content or len(content) > 4 * 1024 * 1024:
        raise HTTPException(status_code=413, detail="Image exceeds the 4 MB inference limit.")
    try:
        source = Image.open(BytesIO(content))
        if source.width * source.height > 16_000_000:
            raise HTTPException(status_code=413, detail="Image resolution exceeds the inference limit.")
        pil_img = ImageOps.exif_transpose(source).convert("RGB")
        cv_img = cv2.cvtColor(np.array(pil_img), cv2.COLOR_RGB2BGR)
        return pil_img, cv_img
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="The uploaded image is invalid.",
        ) from exc


def compute_homography_alignment(
    img1: np.ndarray, img2: np.ndarray, max_features: int = 1500
) -> Tuple[bool, float, int, Optional[np.ndarray]]:
    """Compute perspective alignment using ORB and RANSAC homography estimation."""
    gray1 = cv2.cvtColor(img1, cv2.COLOR_BGR2GRAY)
    gray2 = cv2.cvtColor(img2, cv2.COLOR_BGR2GRAY)

    orb = cv2.ORB_create(nfeatures=max_features)
    keypoints1, descriptors1 = orb.detectAndCompute(gray1, None)
    keypoints2, descriptors2 = orb.detectAndCompute(gray2, None)

    if descriptors1 is None or descriptors2 is None or len(keypoints1) < 4 or len(keypoints2) < 4:
        return False, 0.0, 0, None

    matcher = cv2.BFMatcher(cv2.NORM_HAMMING, crossCheck=False)
    matches = matcher.knnMatch(descriptors1, descriptors2, k=2)

    # Lowe's ratio test
    good_matches = []
    for pair in matches:
        if len(pair) == 2:
            m, n = pair
            if m.distance < 0.75 * n.distance:
                good_matches.append(m)

    if len(good_matches) < 8:
        return False, 0.0, len(good_matches), None

    src_pts = np.float32([keypoints1[m.queryIdx].pt for m in good_matches]).reshape(-1, 1, 2)
    dst_pts = np.float32([keypoints2[m.trainIdx].pt for m in good_matches]).reshape(-1, 1, 2)

    homography, mask = cv2.findHomography(src_pts, dst_pts, cv2.RANSAC, 5.0)
    if homography is None or mask is None:
        return False, 0.0, len(good_matches), None

    inliers_count = int(np.sum(mask))
    inlier_ratio = float(inliers_count / len(good_matches))
    is_aligned = inlier_ratio >= 0.35 and inliers_count >= 8

    return is_aligned, round(inlier_ratio, 4), inliers_count, homography


# --- FastAPI Application Factory ---

def architecture_name(model_yaml, train_args) -> Optional[str]:
    candidates = [(model_yaml or {}).get("yaml_file"), (train_args or {}).get("model")]
    for candidate in candidates:
        stem = Path(str(candidate or "")).stem.lower()
        if stem.startswith("yolo"):
            return "YOLO" + stem[4:]
    return None


PROJECT_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_PRODUCTION_WEIGHTS = PROJECT_ROOT / "models" / "production" / "best.pt"
DEFAULT_PORTRAIT_WEIGHTS = PROJECT_ROOT / "models/evidence/face_detection_yunet_2026may.onnx"
DEFAULT_OBJECT_WEIGHTS = PROJECT_ROOT / "models/checkpoints/yolo26n.pt"
EVIDENCE_SCREENING_VERSION = "region-v2"


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def read_json(path: Path) -> Optional[dict]:
    if not path.is_file():
        return None
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        raise ModelContractError(f"Unreadable model metadata at {path}: {error}") from error
    return value if isinstance(value, dict) else None


def production_manifest(weights_path: Path) -> Optional[dict]:
    manifest_path = weights_path.parent / PRODUCTION_MANIFEST_NAME
    if not manifest_path.exists():
        return None
    manifest = read_json(manifest_path)
    if manifest is None:
        raise ModelContractError(f"Expected a JSON object in {manifest_path}.")
    expected = manifest.get("production_sha256")
    if not expected or not weights_path.is_file() or file_sha256(weights_path) != expected:
        raise ModelContractError(
            f"{weights_path} does not match the production_sha256 recorded in {PRODUCTION_MANIFEST_NAME}; "
            "re-run the promotion or roll back before serving."
        )
    return manifest


def describe_model(weights: str, ckpt: Optional[dict], model_yaml: Optional[dict] = None) -> dict:
    weights_path = Path(weights)
    run_dir = weights_path.parent.parent
    train_args = (ckpt or {}).get("train_args") or {}
    architecture = architecture_name(model_yaml if isinstance(model_yaml, dict) else None, train_args)
    manifest = production_manifest(weights_path)
    if manifest is not None:
        version = str(manifest.get("version") or train_args.get("name") or "")
        value = manifest.get("target_eligible")
        target_eligible = value if isinstance(value, bool) else None
        label = str(manifest.get("release_label") or release_label(version, target_eligible))
        checkpoint = f"{weights_path.parent.name}/{weights_path.name}"
    else:
        config = read_json(run_dir / "train_config.json") or {}
        value = config.get("target_eligible")
        target_eligible = value if isinstance(value, bool) else None
        version = str(train_args.get("name") or run_dir.name)
        label = release_label(version, target_eligible)
        checkpoint = "/".join(part for part in (run_dir.name, weights_path.parent.name, weights_path.name) if part)
    return {
        "name": f"NeighborLens {architecture}" if architecture else "NeighborLens",
        "architecture": architecture,
        "version": version,
        "release_label": label,
        "checkpoint": checkpoint,
        "target_eligible": target_eligible,
        "classes": CANONICAL_CLASS_NAMES,
    }


def create_app(
    weights: str, confidence: float, image_size: int = 640, *,
    model_factory: Callable[[str], YOLO] | None = None,
    enable_portrait_filter: bool = False,
    portrait_model: str | Path | None = None,
    object_model: str | Path | None = None,
    measurement_provider: MeasurementProvider | None = None,
    measurement_timeout: float = 1.0,
) -> FastAPI:
    # Reject a mismatched manifest before Ultralytics deserializes the checkpoint.
    production_manifest(Path(weights))
    face_regions = load_face_regions(portrait_model) if enable_portrait_filter else None
    object_regions = ObjectRegions(object_model) if object_model is not None else None
    screening = EVIDENCE_SCREENING_VERSION if face_regions and object_regions else None
    detector = YoloDetector(weights, model_factory=model_factory if model_factory is not None else YOLO)
    model_info = describe_model(weights, detector.checkpoint, detector.model_yaml)
    model_identifier = f"{model_info['name']} {model_info['version']}".strip()

    app = FastAPI(
        title="NeighborLens YOLO & OpenCV Damage API",
        version="2.0.0",
        description="Dual-photo perspective alignment and YOLO damage verification",
    )

    def detect_supported(image, bgr, *, preview=False):
        detections, embedding = detector.detect(image, confidence, image_size)
        if not (face_regions or object_regions) or not (detections or preview):
            return detections, embedding, None, None
        try:
            faces = face_regions.detect(bgr) if face_regions else []
            retained = portrait_candidates(detections, faces)
            if len(retained) < len(detections) and not any(item.eligible for item in retained):
                return [], embedding, "face_overlap", None
            subjects = object_regions.detect(image) if object_regions else []
            screened = subject_candidates(retained, subjects)
            if len(screened) < len(retained) and not any(item.eligible for item in screened):
                return [], embedding, "unrelated_subject_overlap", None
        except (cv2.error, RuntimeError, ValueError):
            LOGGER.warning("Evidence screening unavailable for this image.", exc_info=True)
            return [], embedding, "evidence_screening_unavailable", None
        hint = None
        if preview:
            hint = detection_hint(screened)
            if not any(item.eligible for item in detections):
                try:
                    hint = retry_pavement_hint(
                        detector, image, confidence, image_size,
                        lambda items: subject_candidates(portrait_candidates(items, faces), subjects),
                    ) or hint
                except (cv2.error, RuntimeError, ValueError):
                    LOGGER.warning("Pavement preview retry unavailable for this image.", exc_info=True)
        return screened, embedding, None, hint

    def review_decision(reason):
        return {**decide([], confidence), "inference_status": "evidence_review_required", "reason": reason}

    @app.get("/health")
    @app.get("/api/health")
    async def health() -> dict:
        return {
            "ok": True,
            "service": "neighborlens-yolo-api",
            "status": "running",
            "classes": CANONICAL_CLASS_NAMES,
            "min_confidence": confidence,
            "model_info": model_info,
        }

    @app.post("/predict", response_model=PredictionResponse)
    async def predict(image: UploadFile = File(...)) -> dict:
        if image.content_type not in {"image/jpeg", "image/png", "image/webp"}:
            raise HTTPException(status_code=415, detail="Upload must be a JPEG, PNG, or WebP image.")
        content = await image.read()
        pil_image, bgr = read_image_bytes(content)

        detections, _, needs_review, preview_hint = detect_supported(pil_image, bgr, preview=bool(screening))
        raw_detections = [
            {
                "damage_id": d.damage_id,
                "class": d.damage_type,
                "confidence": d.confidence_score,
                "eligible": d.eligible,
                "severity_level": d.severity_level,
                "bounding_box": d.bounding_box.model_dump(),
            }
            for d in detections
        ]
        decision = review_decision(needs_review) if needs_review else decide(raw_detections, confidence)
        category = decision["canonical_category"]
        (measured, reason), extent = await asyncio.gather(
            attach_measurement(pil_image, detections, category, measurement_provider, measurement_timeout),
            visual_observation(bgr, detections, category),
        )
        for raw, item in zip(raw_detections, measured):
            if item.severity_measurement is not None:
                raw["severity_measurement"] = item.severity_measurement.model_dump()

        return {
            "ok": True,
            **decision,
            # This provider scores damage. It has no independent relevance verifier.
            "evidence_relevance": EvidenceRelevance.UNVERIFIED if needs_review else EvidenceRelevance.UNAVAILABLE,
            "evidence_screening": screening,
            **({"detection_preview": preview_hint} if preview_hint else {}),
            "severity_status": severity_status(reason),
            "severity_reason": reason,
            "visual_extent": extent,
            "model": model_identifier,
            "model_info": model_info,
            "task": "detect",
            "scan_scope": "full_image",
            "image_size": {"width": pil_image.width, "height": pil_image.height},
            "detections": raw_detections,
        }

    @app.post("/api/v1/damage/verify-pair", response_model=DualVerificationResponse)
    @app.post("/verify-pair", response_model=DualVerificationResponse)
    async def verify_pair(
        image1: UploadFile = File(..., description="First damage photo"),
        image2: UploadFile = File(..., description="Second damage photo from alternate angle"),
    ) -> DualVerificationResponse:
        for img in [image1, image2]:
            if img.content_type not in {"image/jpeg", "image/png", "image/webp"}:
                raise HTTPException(status_code=415, detail="Uploads must be JPEG, PNG, or WebP images.")

        content1 = await image1.read()
        content2 = await image2.read()

        pil1, cv1 = read_image_bytes(content1)
        if hashlib.sha256(content1).digest() == hashlib.sha256(content2).digest():
            raise HTTPException(status_code=422, detail={
                "code": "DUPLICATE_EVIDENCE",
                "message": "Retake the issue from two different angles.",
            })
        pil2, cv2 = read_image_bytes(content2)

        scene_available = True
        try:
            is_aligned, inlier_ratio, good_matches, homography = compute_homography_alignment(cv1, cv2)
        except Exception:
            LOGGER.warning("Scene alignment unavailable.")
            is_aligned, inlier_ratio, good_matches, homography = False, 0.0, 0, None
            scene_available = False

        # 2. YOLO detections and feature embeddings
        dets1, emb1, review1, _ = detect_supported(pil1, cv1)
        dets2, emb2, review2, _ = detect_supported(pil2, cv2)

        try:
            emb_sim = cosine_similarity(emb1, emb2)
            scene_available = scene_available and bool(emb1) and bool(emb2)
        except Exception:
            LOGGER.warning("Scene embedding comparison unavailable.")
            emb_sim = 0.0
            scene_available = False

        classes1 = {d.damage_type for d in dets1 if d.eligible}
        classes2 = {d.damage_type for d in dets2 if d.eligible}
        common_classes = classes1.intersection(classes2)
        pair = decide_pair(
            [{"class": d.damage_type, "confidence": d.confidence_score, "eligible": d.eligible} for d in dets1],
            [{"class": d.damage_type, "confidence": d.confidence_score, "eligible": d.eligible} for d in dets2],
            confidence,
        )
        if review1 or review2:
            pair.update(
                status="EVIDENCE_REVIEW_REQUIRED", detected=False, candidate=None,
                class_agreement=False, provisional_class_agreement=False,
            )
            for index, needs_review in enumerate((review1, review2)):
                if needs_review:
                    pair["photos"][index] = review_decision(needs_review)
        consensus_type = pair["candidate"]["canonical_category"] if pair["candidate"] else None
        measurement_class = consensus_type if pair["detected"] else None
        for photo, bgr, items in zip(pair["photos"], (cv1, cv2), (dets1, dets2)):
            photo["image_size"] = {"width": bgr.shape[1], "height": bgr.shape[0]}
            photo["visual_extent"] = await visual_observation(bgr, items, photo["canonical_category"])
        (dets1, reason1), (dets2, reason2) = await asyncio.gather(
            attach_measurement(pil1, dets1, measurement_class, measurement_provider, measurement_timeout),
            attach_measurement(pil2, dets2, measurement_class, measurement_provider, measurement_timeout),
        )
        reasons = sorted({reason1, reason2} - {"MEASUREMENTS_REQUIRE_POLICY"})
        reason = reasons[0] if reasons else "MEASUREMENTS_REQUIRE_POLICY"
        scene = score_scene(
            embedding_similarity=emb_sim,
            inlier_ratio=inlier_ratio,
            perspective_aligned=is_aligned,
            common_eligible_class=bool(common_classes),
            comparison_available=scene_available,
        )

        severity_order = {"critical": 4, "high": 3, "medium": 2, "low": 1}
        severities = [d.severity_level for d in (dets1 + dets2) if pair["detected"] and d.eligible and d.damage_type == consensus_type and d.severity_level in severity_order]
        highest_sev = max(severities, key= severity_order.get) if severities else None

        if pair["detected"] and consensus_type:
            detected = True
            inconclusive = False
            category = consensus_type
            display_category = DISPLAY_LABELS[consensus_type]
            source = "yolo_backend"
            agreement = True
        else:
            detected = False
            inconclusive = True
            category = "Inconclusive"
            display_category = "Inconclusive"
            source = "yolo_backend"
            agreement = False

        avg_conf = pair["candidate"]["confidence"] if pair["candidate"] else 0.0

        return DualVerificationResponse(
            evidence_relevance=EvidenceRelevance.UNVERIFIED if review1 or review2 else EvidenceRelevance.UNAVAILABLE,
            evidence_screening=screening,
            severity_status=severity_status(reason),
            severity_reason=reason,
            ok=True,
            request_id=str(uuid.uuid4()),
            model=model_identifier,
            detected=detected,
            inconclusive=inconclusive,
            category=category,
            canonical_category=category if detected else None,
            display_category=display_category,
            confidence=avg_conf,
            agreement=agreement,
            is_valid_match=scene.is_match,
            source=source,
            status=pair["status"],
            class_agreement=pair["class_agreement"],
            provisional_class_agreement=pair["provisional_class_agreement"],
            min_confidence=confidence,
            candidate=pair["candidate"],
            image1_assessment=pair["photos"][0],
            image2_assessment=pair["photos"][1],
            summary=VerificationSummary(
                is_valid_match=scene.is_match,
                composite_similarity_score=scene.composite,
                embedding_similarity=round(emb_sim, 4),
                damage_type_consensus=consensus_type,
                highest_severity=highest_sev,
                scene_status=scene.status,
                alignment=AlignmentDetails(
                    perspective_aligned=is_aligned,
                    good_matches_count=good_matches,
                    inlier_ratio=inlier_ratio,
                    homography_matrix=homography.tolist() if homography is not None else None,
                ),
            ),
            image1_detections=dets1,
            image2_detections=dets2,
        )

    return app


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--weights", default=str(DEFAULT_PRODUCTION_WEIGHTS))
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument("--confidence", type=float, default=0.30)
    parser.add_argument("--imgsz", type=int, default=640)
    parser.add_argument("--enable-portrait-filter", action="store_true", help=argparse.SUPPRESS)
    parser.add_argument("--portrait-model", default=DEFAULT_PORTRAIT_WEIGHTS, help="Path to the pinned YuNet model.")
    parser.add_argument("--object-model", default=DEFAULT_OBJECT_WEIGHTS, help="Path to the pinned COCO model.")
    args = parser.parse_args()

    import uvicorn

    app = create_app(args.weights, args.confidence, args.imgsz,
                     enable_portrait_filter=True, portrait_model=args.portrait_model, object_model=args.object_model)
    uvicorn.run(app, host=args.host, port=args.port)


if __name__ == "__main__":
    main()

