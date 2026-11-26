"""Production-ready YOLOv8 training and infrastructure verification pipeline.

This script handles:
1. Auto-generation of a valid data.yaml configuration for the 3 required classes.
2. Dataset structure validation before training.
3. YOLOv8 training with optimized hyperparameters.
4. Robust cross-angle defect verification using ResNet-50 embeddings and cosine similarity.
5. Safe image loading, empty detection handling, and class-specific annotation drawing.
"""

from __future__ import annotations

import argparse
import json
import logging
import sys
from functools import lru_cache
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple

import cv2
import numpy as np
import torch
import torch.nn.functional as F
from torchvision import models
from torchvision.models import ResNet50_Weights
from ultralytics import YOLO

LOGGER = logging.getLogger("infrastructure_monitor")

TARGET_CLASSES = {
    0: "damaged_road",
    1: "clogged_drainage",
    2: "damaged_street_light",
    3: "damaged_traffic_light",
}

CLASS_METADATA = {
    "damaged_road": {
        "label": "Damaged Road",
        "specific_type": "Pothole / asphalt cracking / deteriorated road surface",
        "severity_map": {
            "high": "Deep pothole with asphalt cracking (High Severity)",
            "medium": "Surface deterioration with visible cracking (Medium Severity)",
            "low": "Minor road surface damage (Low Severity)",
        },
        "hazard": "Poses a risk to vehicles, pedestrians, and traffic flow.",
    },
    "clogged_drainage": {
        "label": "Clogged Drainage",
        "specific_type": "Blocked drainage channel with debris, mud, or garbage accumulation",
        "severity_map": {
            "high": "Severely blocked drainage causing immediate flood risk (High Severity)",
            "medium": "Drainage partially blocked with debris buildup (Medium Severity)",
            "low": "Minor debris accumulation in drainage channel (Low Severity)",
        },
        "hazard": "May cause standing water, flooding, and sanitation issues.",
    },
    "damaged_street_light": {
        "label": "Broken Street Light",
        "specific_type": "Damaged lamp fixture, faulty bulb, hanging electrical lines, or tilted pole",
        "severity_map": {
            "high": "Broken street light with safety and visibility hazards (High Severity)",
            "medium": "Partially damaged street light affecting illumination (Medium Severity)",
            "low": "Minor street light defect or flickering fixture (Low Severity)",
        },
        "hazard": "Reduces visibility at night and increases public safety risk.",
    },
    "damaged_traffic_light": {
        "label": "Damaged Traffic Light",
        "specific_type": "Broken signal head, missing visor, damaged housing, or hanging traffic signal fixture",
        "severity_map": {
            "high": "Completely nonfunctional or hanging traffic signal causing imminent intersection collision risk (High Severity)",
            "medium": "Damaged signal head or lens reducing signal visibility (Medium Severity)",
            "low": "Minor housing or bracket damage with signal fully operational (Low Severity)",
        },
        "hazard": "Poses high risk of vehicle collisions and pedestrian hazards at controlled intersections.",
    },
}

CLASS_COLORS = {
    "damaged_road": (0, 107, 255),
    "clogged_drainage": (166, 168, 0),
    "damaged_street_light": (63, 208, 244),
    "damaged_traffic_light": (220, 20, 60),
}

DEFAULT_DATASET_ROOT = Path(__file__).resolve().parents[2] / "data" / "datasets" / "infrastructure_v3"
DEFAULT_DATA_YAML = Path(__file__).resolve().parents[2] / "data" / "datasets" / "data.yaml"
DEFAULT_OUTPUT_DIR = Path(__file__).resolve().parents[2] / "storage" / "detections"
SIMILARITY_THRESHOLD = 0.82


def configure_logging() -> None:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s - %(levelname)s - %(message)s",
    )


def generate_data_yaml(data_yaml_path: Path = DEFAULT_DATA_YAML, dataset_root: Path = DEFAULT_DATASET_ROOT) -> Path:
    """Create a valid YOLOv8 data.yaml file with the required 4 infrastructure classes."""
    try:
        data_yaml_path.parent.mkdir(parents=True, exist_ok=True)
        dataset_root.mkdir(parents=True, exist_ok=True)
        yaml_content = (
            "path: ../datasets/infrastructure\n"
            "train: images/train\n"
            "val: images/val\n"
            "test: images/test\n\n"
            "nc: 4\n"
            "names:\n"
            "  0: damaged_road\n"
            "  1: clogged_drainage\n"
            "  2: damaged_street_light\n"
            "  3: damaged_traffic_light\n"
        )
        data_yaml_path.write_text(yaml_content, encoding="utf-8")
        LOGGER.info("Generated dataset config at %s", data_yaml_path)
        return data_yaml_path
    except Exception as exc:  # pragma: no cover - defensive
        raise RuntimeError(f"Unable to generate data.yaml at {data_yaml_path}: {exc}") from exc


def validate_dataset_layout(dataset_root: Path = DEFAULT_DATASET_ROOT) -> None:
    """Validate that image and label folders exist before any training is attempted."""
    required_dirs = [
        dataset_root / "images" / "train",
        dataset_root / "images" / "val",
        dataset_root / "images" / "test",
        dataset_root / "labels" / "train",
        dataset_root / "labels" / "val",
        dataset_root / "labels" / "test",
    ]
    missing = [str(path) for path in required_dirs if not path.exists()]
    if missing:
        raise FileNotFoundError(
            "Dataset structure is incomplete. Create these folders before training:\n"
            + "\n".join(missing)
        )
    LOGGER.info("Dataset layout validated successfully at %s", dataset_root)


def prepare_dataset_layout(dataset_root: Path = DEFAULT_DATASET_ROOT, create_missing: bool = False) -> Path:
    """Create the required dataset folders when requested, otherwise validate them."""
    required_dirs = [
        dataset_root / "images" / "train",
        dataset_root / "images" / "val",
        dataset_root / "images" / "test",
        dataset_root / "labels" / "train",
        dataset_root / "labels" / "val",
        dataset_root / "labels" / "test",
    ]
    try:
        for folder in required_dirs:
            if create_missing:
                folder.mkdir(parents=True, exist_ok=True)
            elif not folder.exists():
                raise FileNotFoundError(f"Missing required dataset folder: {folder}")
        return dataset_root
    except Exception as exc:  # pragma: no cover - defensive
        raise RuntimeError(f"Unable to prepare dataset layout at {dataset_root}: {exc}") from exc


@lru_cache(maxsize=1)
def get_resnet50_encoder(device: str = "cpu"):
    """Load a cached ResNet-50 encoder once for reuse during feature extraction."""
    try:
        model = models.resnet50(weights=ResNet50_Weights.DEFAULT)
        model.to(device)
        model.eval()
        for param in model.parameters():
            param.requires_grad_(False)
        return model
    except Exception as exc:
        raise RuntimeError(f"Unable to initialize ResNet-50 encoder: {exc}") from exc


def extract_resnet_embedding(crop_bgr: np.ndarray, device: Optional[str] = None) -> np.ndarray:
    """Return a 512-dimensional embedding vector for a defect crop."""
    if crop_bgr is None or crop_bgr.size == 0:
        return np.zeros(512, dtype=np.float32)

    target_device = device or ("cuda" if torch.cuda.is_available() else "cpu")
    try:
        crop_rgb = cv2.cvtColor(crop_bgr, cv2.COLOR_BGR2RGB)
        crop_rgb = cv2.resize(crop_rgb, (224, 224), interpolation=cv2.INTER_LINEAR)
        image_tensor = torch.from_numpy(crop_rgb.astype(np.float32) / 255.0)
        image_tensor = image_tensor.permute(2, 0, 1).unsqueeze(0).to(target_device)

        model = get_resnet50_encoder(target_device)
        with torch.no_grad():
            x = model.conv1(image_tensor)
            x = model.bn1(x)
            x = model.relu(x)
            x = model.maxpool(x)
            x = model.layer1(x)
            x = model.layer2(x)
            x = model.layer3(x)
            x = model.layer4(x)
            x = model.avgpool(x)
            embedding = torch.flatten(x, 1)
            embedding = model.fc(embedding) if hasattr(model, "fc") else embedding

        embedding_vector = embedding.squeeze(0).detach().cpu().numpy()
        if embedding_vector.size != 512:
            embedding_vector = np.resize(embedding_vector, 512).astype(np.float32)
        return embedding_vector.astype(np.float32)
    except Exception as exc:
        LOGGER.warning("Failed to extract embedding from defect crop: %s", exc)
        return np.zeros(512, dtype=np.float32)


def cosine_similarity(vector_a: np.ndarray, vector_b: np.ndarray) -> float:
    """Compute cosine similarity between two embedding vectors."""
    try:
        a = torch.from_numpy(np.asarray(vector_a, dtype=np.float32))
        b = torch.from_numpy(np.asarray(vector_b, dtype=np.float32))
        a_norm = F.normalize(a, dim=0)
        b_norm = F.normalize(b, dim=0)
        similarity = float(torch.dot(a_norm, b_norm).item())
        return max(0.0, min(1.0, similarity))
    except Exception as exc:
        LOGGER.warning("Cosine similarity failed: %s", exc)
        return 0.0


def load_yolo_model(weights_path: str = "best.pt") -> YOLO:
    """Load a YOLOv8 weights file with clear error handling."""
    path = Path(weights_path)
    if not path.exists():
        raise FileNotFoundError(f"YOLO weights not found: {weights_path}")
    try:
        return YOLO(str(path))
    except Exception as exc:
        raise RuntimeError(f"Failed to load YOLO model from {weights_path}: {exc}") from exc


def run_yolo_detection(image_path: str, model: YOLO, conf_threshold: float = 0.30) -> List[Dict[str, Any]]:
    """Run YOLOv8 inference and return supported crops with embeddings."""
    image_file = Path(image_path)
    if not image_file.exists():
        raise FileNotFoundError(f"Image file not found: {image_path}")

    image = cv2.imread(str(image_file))
    if image is None:
        raise ValueError(f"Unable to decode image: {image_path}")

    detections: List[Dict[str, Any]] = []
    try:
        results = model(str(image_file), imgsz=800, conf=conf_threshold, iou=0.45, verbose=False)
        if not results or all(getattr(result, "boxes", None) is None or len(result.boxes) == 0 for result in results):
            LOGGER.warning(
                "Zero bounding boxes at conf=%.2f for %s; retrying close-up fallback at conf=0.15, imgsz=1024.",
                conf_threshold,
                image_file,
            )
            results = model(str(image_file), imgsz=1024, conf=0.15, iou=0.45, verbose=False)
            fallback_used = True
        else:
            fallback_used = False
    except Exception as exc:
        raise RuntimeError(f"YOLO inference failed on {image_path}: {exc}") from exc

    for result in results:
        try:
            names = getattr(result, "names", {}) or {}
            boxes = getattr(result, "boxes", None)
            if boxes is None:
                continue

            for box in boxes:
                try:
                    class_id = int(box.cls[0].item())
                except (TypeError, ValueError, IndexError):
                    continue

                class_name = names.get(class_id, TARGET_CLASSES.get(class_id, "unknown"))
                if class_name not in set(TARGET_CLASSES.values()):
                    continue

                try:
                    x1, y1, x2, y2 = [float(v) for v in box.xyxy[0].tolist()]
                except (TypeError, ValueError, IndexError):
                    continue

                x1, y1, x2, y2 = max(0, int(x1)), max(0, int(y1)), min(image.shape[1], int(x2)), min(image.shape[0], int(y2))
                crop = image[y1:y2, x1:x2]
                if crop is None or crop.size == 0:
                    continue

                try:
                    confidence = float(box.conf[0].item())
                except (TypeError, ValueError, IndexError):
                    confidence = 0.0

                detections.append(
                    {
                        "class_name": class_name,
                        "confidence": confidence,
                        "bbox": [x1, y1, x2, y2],
                        "crop": crop,
                        "embedding": extract_resnet_embedding(crop),
                        "inference_status": "low_confidence_match" if fallback_used else "standard",
                    }
                )
        except Exception as exc:
            LOGGER.warning("Skipping a malformed YOLO result for %s: %s", image_path, exc)
            continue

    return detections


def summarize_detections(detections: Iterable[Dict[str, Any]]) -> Dict[str, Dict[str, float | int]]:
    counts: Dict[str, int] = {name: 0 for name in TARGET_CLASSES.values()}
    confidences: Dict[str, List[float]] = {name: [] for name in TARGET_CLASSES.values()}
    for detection in detections:
        class_name = str(detection.get("class_name", "unknown"))
        if class_name not in counts:
            continue
        counts[class_name] += 1
        confidences[class_name].append(float(detection.get("confidence", 0.0)))

    summary: Dict[str, Dict[str, float | int]] = {}
    for class_name in TARGET_CLASSES.values():
        values = confidences.get(class_name, [])
        avg_conf = sum(values) / len(values) if values else 0.0
        summary[class_name] = {
            "count": counts.get(class_name, 0),
            "average_confidence": round(avg_conf, 4),
        }
    return summary


def draw_annotations(image_path: str, detections: Iterable[Dict[str, Any]], output_path: str) -> None:
    image = cv2.imread(image_path)
    if image is None:
        raise FileNotFoundError(f"Could not read image: {image_path}")

    annotated = image.copy()
    for detection in detections:
        class_name = str(detection.get("class_name", "unknown"))
        bbox = detection.get("bbox")
        if not isinstance(bbox, (list, tuple)) or len(bbox) != 4:
            continue
        x1, y1, x2, y2 = [int(v) for v in bbox]
        color = CLASS_COLORS.get(class_name, (255, 255, 255))
        cv2.rectangle(annotated, (x1, y1), (x2, y2), color, 2)
        confidence = float(detection.get("confidence", 0.0))
        label = f"{class_name}: {confidence:.2f}"
        cv2.putText(
            annotated,
            label,
            (x1, max(0, y1 - 10)),
            cv2.FONT_HERSHEY_SIMPLEX,
            0.55,
            color,
            2,
        )

    output_file = Path(output_path)
    output_file.parent.mkdir(parents=True, exist_ok=True)
    success = cv2.imwrite(str(output_file), annotated)
    if not success:
        raise RuntimeError(f"Failed to write annotated output to {output_file}")


def train_yolov8(
    data_yaml_path: Path = DEFAULT_DATA_YAML,
    model_name: str = str(Path(__file__).resolve().parents[2] / "models" / "checkpoints" / "yolov8m.pt"),
    epochs: int = 80,
    imgsz: int = 800,
    batch: int = 16,
    patience: int = 15,
    multiscale: bool = True,
    project_dir: Path = Path(__file__).resolve().parents[2] / "models" / "checkpoints",
    model_dir_name: str = "infrastructure_v3",
    device: Optional[str] = None,
) -> Path:
    """Train a YOLOv8 model and save best weights to models/checkpoints/infrastructure_model/weights/best.pt."""
    if not data_yaml_path.exists():
        generate_data_yaml(data_yaml_path)

    validate_dataset_layout(DEFAULT_DATASET_ROOT)

    try:
        model = YOLO(model_name)
        training_device = device or ("0" if torch.cuda.is_available() else "cpu")
        project_dir = Path(project_dir)
        project_dir.mkdir(parents=True, exist_ok=True)

        LOGGER.info("Starting YOLOv8 training on %s", training_device)
        model.train(
            data=str(data_yaml_path),
            epochs=epochs,
            imgsz=imgsz,
            batch=batch,
            patience=patience,
            multi_scale=multiscale,
            project=str(project_dir),
            name=model_dir_name,
            pretrained=True,
            device=training_device,
            seed=42,
            scale=0.8,
            degrees=15.0,
            perspective=0.001,
            mosaic=1.0,
            mixup=0.1,
            verbose=True,
        )

        best_weights = project_dir / model_dir_name / "weights" / "best.pt"
        if not best_weights.exists():
            raise FileNotFoundError(f"Training finished but weights were not found at {best_weights}")
        LOGGER.info("Training complete. Best weights saved to %s", best_weights)
        return best_weights
    except Exception as exc:
        raise RuntimeError(f"YOLOv8 training failed: {exc}") from exc


def verify_same_defect(
    image_path_1: str,
    image_path_2: str,
    weights_path: str = "best.pt",
    conf_threshold: float = 0.5,
    similarity_threshold: float = SIMILARITY_THRESHOLD,
) -> Dict[str, Any]:
    """Verify if two images show the same physical defect from different angles."""
    try:
        model = load_yolo_model(weights_path)
    except FileNotFoundError:
        fallback = Path(__file__).resolve().parents[2] / "models" / "checkpoints" / "infrastructure_model" / "weights" / "best.pt"
        if not fallback.exists():
            raise FileNotFoundError(
                "No YOLO weights were found. Train the model first or pass a valid --weights path. "
                f"Expected weights at {fallback}"
            )
        model = load_yolo_model(str(fallback))

    detections_a = run_yolo_detection(image_path_1, model, conf_threshold)
    detections_b = run_yolo_detection(image_path_2, model, conf_threshold)

    if not detections_a or not detections_b:
        LOGGER.warning(
            "Cross-view rejection due to zero bounding boxes: image_a=%d, image_b=%d.",
            len(detections_a),
            len(detections_b),
        )
        result = {
            "status": "[DIFFERENT DEFECT]",
            "inference_status": "no_detections",
            "message": "No valid defect detections found in one or both images.",
            "best_similarity": 0.0,
            "threshold": similarity_threshold,
            "image_a_detections": len(detections_a),
            "image_b_detections": len(detections_b),
        }
        print(f"{result['status']} {result['message']}")
        return result

    candidate_scores: List[float] = []
    matching_class_name: Optional[str] = None
    for det_a in detections_a:
        for det_b in detections_b:
            if det_a.get("class_name") != det_b.get("class_name"):
                continue
            score = cosine_similarity(det_a["embedding"], det_b["embedding"])
            candidate_scores.append(score)
            matching_class_name = det_a.get("class_name")

    if not candidate_scores:
        LOGGER.warning("Cross-view rejection: detected classes do not match across the two images.")
        result = {
            "status": "[DIFFERENT DEFECT]",
            "message": "Detected classes do not match across the two images.",
            "best_similarity": 0.0,
            "threshold": similarity_threshold,
            "image_a_detections": len(detections_a),
            "image_b_detections": len(detections_b),
        }
        print(f"{result['status']} {result['message']}")
        return result

    best_similarity = max(candidate_scores)
    is_match = best_similarity >= similarity_threshold
    if not is_match:
        LOGGER.warning(
            "Cross-view rejection due to below-threshold similarity: %.4f < %.4f.",
            best_similarity,
            similarity_threshold,
        )
    status = "[MATCH CONFIRMED]" if is_match else "[DIFFERENT DEFECT]"
    fallback_used = any(
        detection.get("inference_status") == "low_confidence_match"
        for detection in detections_a + detections_b
    )
    message = (
        "Same physical defect detected from a different angle (Similarity >= 0.82)."
        if is_match
        else "Distinct infrastructure issues were detected across the two images."
    )
    print(f"{status} Similarity={best_similarity:.4f} threshold={similarity_threshold:.2f} :: {message}")
    return {
        "status": status,
        "message": message,
        "best_similarity": round(float(best_similarity), 4),
        "threshold": similarity_threshold,
        "image_a_detections": len(detections_a),
        "image_b_detections": len(detections_b),
        "detected_class": matching_class_name,
        "inference_status": "low_confidence_match" if fallback_used else "standard",
    }


def _estimate_damage_dimensions(bbox: Optional[List[int]]) -> str:
    """Approximate a human-readable size estimate from a YOLO bounding box."""
    if not bbox or len(bbox) != 4:
        return "Not estimated"
    x1, y1, x2, y2 = [int(v) for v in bbox]
    width = max(0, x2 - x1)
    height = max(0, y2 - y1)
    if width <= 0 or height <= 0:
        return "Not estimated"
    approx_meters_w = max(0.3, round(width / 180, 2))
    approx_meters_h = max(0.3, round(height / 180, 2))
    return f"{approx_meters_w} m x {approx_meters_h} m"


def build_damage_report(
    report_id: str,
    reporter_name: str,
    location: str,
    gps_coordinates: str,
    image_path_1: str,
    image_path_2: str,
    weights_path: str = "best.pt",
    conf_threshold: float = 0.5,
    similarity_threshold: float = SIMILARITY_THRESHOLD,
) -> Dict[str, Any]:
    """Return a full standard infrastructure report after dual-angle YOLO verification."""
    verification = verify_same_defect(
        image_path_1,
        image_path_2,
        weights_path=weights_path,
        conf_threshold=conf_threshold,
        similarity_threshold=similarity_threshold,
    )

    if verification.get("status") != "[MATCH CONFIRMED]":
        return {
            "report_id": report_id,
            "status": "Not verified as same defect",
            "category": "Unverified",
            "specific_type": "No confirmed same-damage match",
            "severity": "Unknown",
            "hazard_assessment": "Additional image validation is required before classification.",
            "estimated_area": "Not estimated",
            "visual_proof": {"angle_1": True, "angle_2": True},
            "similarity": verification.get("best_similarity", 0.0),
            "details": verification,
        }

    detected_class = verification.get("detected_class")
    if not detected_class:
        return {
            "report_id": report_id,
            "status": "Not verified as same defect",
            "category": "Unverified",
            "specific_type": "No matched class found",
            "severity": "Unknown",
            "hazard_assessment": "No matching infrastructure class could be confidently determined.",
            "estimated_area": "Not estimated",
            "visual_proof": {"angle_1": True, "angle_2": True},
            "similarity": verification.get("best_similarity", 0.0),
            "details": verification,
        }

    meta = CLASS_METADATA.get(detected_class, CLASS_METADATA["damaged_road"])
    match_score = float(verification.get("best_similarity", 0.0))
    if match_score >= 0.92:
        severity = "High Severity"
    elif match_score >= 0.85:
        severity = "Medium Severity"
    else:
        severity = "Low Severity"

    report = {
        "report_id": report_id,
        "date_time": "Auto-generated from image verification",
        "reporter_name": reporter_name,
        "location": location,
        "gps_coordinates": gps_coordinates,
        "category": meta["label"],
        "specific_type": meta["severity_map"].get("high" if "High" in severity else "medium" if "Medium" in severity else "low"),
        "severity": severity,
        "hazard_assessment": meta["hazard"],
        "estimated_area": _estimate_damage_dimensions(None),
        "visual_proof": {"angle_1": True, "angle_2": True},
        "similarity_score": round(match_score, 4),
        "status": "[MATCH CONFIRMED]",
        "damage_class": detected_class,
        "summary": f"YOLOv8 confirmed a same physical defect across both images ({match_score:.4f} similarity).",
    }
    return report


def generate_pair_summary(
    image_path_1: str,
    image_path_2: str,
    weights_path: str = "best.pt",
    location: str = "Bacolod City",
    reporter_name: str = "Field Inspector",
    gps_coordinates: str = "N/A",
    conf_threshold: float = 0.5,
    similarity_threshold: float = SIMILARITY_THRESHOLD,
) -> Dict[str, Any]:
    """Generate a structured report payload for a two-image cross-view inspection summary."""
    try:
        model = load_yolo_model(weights_path)
    except FileNotFoundError:
        fallback = Path(__file__).resolve().parents[2] / "models" / "checkpoints" / "infrastructure_model" / "weights" / "best.pt"
        if fallback.exists():
            model = load_yolo_model(str(fallback))
        else:
            raise FileNotFoundError(
                "No YOLO weights were found. Train the model first or pass a valid --weights path. "
                f"Expected weights at {fallback}"
            )

    detections_a = run_yolo_detection(image_path_1, model, conf_threshold=conf_threshold)
    detections_b = run_yolo_detection(image_path_2, model, conf_threshold=conf_threshold)

    summary_a = summarize_detections(detections_a)
    summary_b = summarize_detections(detections_b)

    verification = verify_same_defect(
        image_path_1,
        image_path_2,
        weights_path=str(model.ckpt_path if hasattr(model, "ckpt_path") else weights_path),
        conf_threshold=conf_threshold,
        similarity_threshold=similarity_threshold,
    )

    match_status = verification.get("status", "[DIFFERENT DEFECT]")
    same_instance = match_status == "[MATCH CONFIRMED]"

    image_1_total = sum(item["count"] for item in summary_a.values())
    image_2_total = sum(item["count"] for item in summary_b.values())

    pair_report = {
        "report_id": f"INF-{int(np.random.default_rng().integers(1000, 9999))}",
        "location": location,
        "reporter_name": reporter_name,
        "gps_coordinates": gps_coordinates,
        "inspection_summary": {
            "image_1": {
                "total_defects": image_1_total,
                "counts": summary_a,
                "match_status": "Detected" if image_1_total else "No defects detected",
            },
            "image_2": {
                "total_defects": image_2_total,
                "counts": summary_b,
                "match_status": "Detected" if image_2_total else "No defects detected",
            },
            "cross_angle_match": {
                "status": match_status,
                "same_instance": same_instance,
                "similarity": verification.get("best_similarity", 0.0),
                "threshold": similarity_threshold,
                "detected_class": verification.get("detected_class", "unknown"),
            },
        },
        "summary_text": (
            f"Image 1: {image_1_total} defects detected across roadway and drainage/street-light classes; "
            f"Image 2: {image_2_total} defects detected. "
            f"Cross-angle match status: {match_status}."
        ),
        "detection_details": {
            "image_1": summary_a,
            "image_2": summary_b,
            "verification": verification,
        },
    }

    return pair_report


def run_single_image_detection(image_path: str, weights_path: str = "best.pt", output_dir: str = str(DEFAULT_OUTPUT_DIR), conf_threshold: float = 0.5) -> Dict[str, Any]:
    """Run a single-image detection pass and save annotated output."""
    model = load_yolo_model(weights_path)
    detections = run_yolo_detection(image_path, model, conf_threshold=conf_threshold)
    summary = summarize_detections(detections)

    output_path = Path(output_dir) / f"{Path(image_path).stem}_annotated.jpg"
    output_path.parent.mkdir(parents=True, exist_ok=True)
    draw_annotations(image_path, detections, str(output_path))

    LOGGER.info("Single-image detection summary: %s", json.dumps(summary, indent=2))
    print(f"Saved annotated detection output: {output_path}")
    return {
        "detections": detections,
        "summary": summary,
        "output_image": str(output_path),
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Train and verify infrastructure defects with YOLOv8 + ResNet-50.")
    parser.add_argument("--train", action="store_true", help="Train the YOLOv8 infrastructure model.")
    parser.add_argument("--verify", action="store_true", help="Verify if two images show the same defect from different angles.")
    parser.add_argument("--report", action="store_true", help="Generate a shareable summary report for a two-image cross-angle inspection.")
    parser.add_argument("--image", type=str, help="Single image path for detection only.")
    parser.add_argument("--image-a", type=str, help="First image for same-defect verification.")
    parser.add_argument("--image-b", type=str, help="Second image for same-defect verification.")
    parser.add_argument("--location", type=str, default="Bacolod City", help="Inspection location used in summary reports.")
    parser.add_argument("--reporter", type=str, default="Field Inspector", help="Reporter or inspector name for the generated report.")
    parser.add_argument("--gps", type=str, default="N/A", help="GPS coordinates for the inspection site.")
    parser.add_argument("--weights", type=str, default="best.pt", help="YOLOv8 weights path to load for inference.")
    parser.add_argument("--dataset-root", type=str, default=str(DEFAULT_DATASET_ROOT), help="Dataset root used by the training config.")
    parser.add_argument("--data-yaml", type=str, default=str(DEFAULT_DATA_YAML), help="Path to the generated data.yaml file.")
    parser.add_argument("--epochs", type=int, default=80)
    parser.add_argument("--imgsz", type=int, default=800)
    parser.add_argument("--batch", type=int, default=16)
    parser.add_argument("--patience", type=int, default=15)
    parser.add_argument("--multiscale", action="store_true", default=True, help="Enable multiscale training.")
    parser.add_argument("--output-dir", type=str, default=str(DEFAULT_OUTPUT_DIR), help="Output folder for annotated images.")
    parser.add_argument("--conf-threshold", type=float, default=0.30, help="Minimum YOLO confidence threshold before close-up fallback.")
    parser.add_argument("--similarity-threshold", type=float, default=SIMILARITY_THRESHOLD, help="Cosine similarity threshold for same-defect match.")
    parser.add_argument("--prepare-dataset", action="store_true", help="Create the dataset directory structure required for training.")
    return parser.parse_args()


def main() -> None:
    configure_logging()
    args = parse_args()

    dataset_root = Path(args.dataset_root).resolve()
    data_yaml_path = Path(args.data_yaml).resolve()

    if args.prepare_dataset:
        prepare_dataset_layout(dataset_root, create_missing=True)
        generate_data_yaml(data_yaml_path, dataset_root)
        LOGGER.info("Dataset created successfully at %s", dataset_root)
        sys.exit(0)

    if args.train:
        generate_data_yaml(data_yaml_path, dataset_root)
        prepare_dataset_layout(dataset_root, create_missing=False)
        train_yolov8(
            data_yaml_path=data_yaml_path,
            model_name=str(Path(__file__).resolve().parents[2] / "models" / "checkpoints" / "yolov8m.pt"),
            epochs=args.epochs,
            imgsz=args.imgsz,
            batch=args.batch,
            patience=args.patience,
            multiscale=args.multiscale,
            project_dir=Path(__file__).resolve().parents[2] / "models" / "checkpoints",
            model_dir_name="infrastructure_v3",
        )
        sys.exit(0)

    if args.verify:
        if not args.image_a or not args.image_b:
            raise SystemExit("--verify requires both --image-a and --image-b.")
        verify_same_defect(
            args.image_a,
            args.image_b,
            weights_path=args.weights,
            conf_threshold=args.conf_threshold,
            similarity_threshold=args.similarity_threshold,
        )
        sys.exit(0)

    if args.report:
        if not args.image_a or not args.image_b:
            raise SystemExit("--report requires both --image-a and --image-b.")
        report = generate_pair_summary(
            args.image_a,
            args.image_b,
            weights_path=args.weights,
            location=args.location,
            reporter_name=args.reporter,
            gps_coordinates=args.gps,
            conf_threshold=args.conf_threshold,
            similarity_threshold=args.similarity_threshold,
        )
        print(json.dumps(report, indent=2))
        sys.exit(0)

    if args.image:
        run_single_image_detection(args.image, args.weights, args.output_dir, conf_threshold=args.conf_threshold)
        sys.exit(0)

    print(
        "No valid operation selected. Use --train, --verify with --image-a and --image-b, --report with --image-a and --image-b, or --image <path>."
    )
    sys.exit(1)


if __name__ == "__main__":
    main()
