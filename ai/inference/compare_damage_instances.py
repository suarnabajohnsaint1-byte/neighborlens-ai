"""Compare two infrastructure images by detecting matching damage classes and computing
feature similarity between cropped object regions.

This utility uses:
- Ultralytics YOLOv8 for object detection
- OpenCV for crop extraction and image preprocessing
- PyTorch + ResNet-50 for embedding generation
- Cosine similarity to determine whether the same physical issue appears in both images
"""

from __future__ import annotations

from typing import Dict, List

import cv2
import numpy as np
import torch
import torch.nn.functional as F
from torchvision import models
from torchvision.models import ResNet50_Weights
from ultralytics import YOLO

TARGET_CLASSES = {"damaged_road", "clogged_drainage", "damaged_street_light"}

IMAGE_GUIDANCE = {
    "quality": [
        "Use a clear, well-lit image with visible damage details.",
        "Make sure the damaged area fills most of the frame.",
        "Avoid blurry, dark, overexposed, or heavily cropped images.",
        "Keep the issue centered and free from motion blur or glare.",
        "Use a straight-on view when possible for better detection accuracy.",
    ],
    "formats": [
        "Accepted formats: JPG, JPEG, PNG, or WEBP.",
        "File size should be reasonable and not corrupted.",
    ],
}


def image_quality_guidance() -> str:
    """Return user-friendly instructions for unacceptable image input."""
    return "\n".join([
        "Image not acceptable for damage detection.",
        "Please follow these instructions:",
        *[f"- {item}" for item in IMAGE_GUIDANCE["quality"] + IMAGE_GUIDANCE["formats"]],
    ])


def validate_image_for_detection(image_path: str) -> bool:
    """Check whether the image is likely usable for YOLO detection."""
    image = cv2.imread(image_path)
    if image is None:
        return False

    height, width = image.shape[:2]
    if width < 128 or height < 128:
        return False

    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    if gray.size == 0:
        return False

    variance = cv2.Laplacian(gray, cv2.CV_64F).var()
    if variance < 50:
        return False

    return True


def cosine_similarity(vector_a: np.ndarray, vector_b: np.ndarray) -> float:
    """Compute cosine similarity between two embedding vectors."""
    a = torch.from_numpy(np.asarray(vector_a, dtype=np.float32))
    b = torch.from_numpy(np.asarray(vector_b, dtype=np.float32))
    a = F.normalize(a, dim=0)
    b = F.normalize(b, dim=0)
    return float(torch.dot(a, b).item())


def extract_resnet_embedding(crop_bgr: np.ndarray) -> np.ndarray:
    """Return a 2048-dim embedding vector from a crop using ResNet-50."""
    crop_rgb = cv2.cvtColor(crop_bgr, cv2.COLOR_BGR2RGB)
    crop_rgb = cv2.resize(crop_rgb, (224, 224))

    image_tensor = torch.from_numpy(crop_rgb.astype(np.float32) / 255.0)
    image_tensor = image_tensor.permute(2, 0, 1).unsqueeze(0)

    model = models.resnet50(weights=ResNet50_Weights.IMAGENET1K_V1)
    model.eval()

    for parameter in model.parameters():
        parameter.requires_grad_(False)

    with torch.no_grad():
        output = model.conv1(image_tensor)
        output = model.bn1(output)
        output = model.relu(output)
        output = model.maxpool(output)

        output = model.layer1(output)
        output = model.layer2(output)
        output = model.layer3(output)
        output = model.layer4(output)

        output = model.avgpool(output)
        embedding = torch.flatten(output, 1)

    return embedding.squeeze(0).cpu().numpy()


def detect_crops_by_class(image_path: str, yolo_model: YOLO) -> Dict[str, List[np.ndarray]]:
    """Use YOLOv8 to crop only the supported infrastructure-damage classes."""
    image = cv2.imread(image_path)
    if image is None:
        raise FileNotFoundError(f"Could not read image: {image_path}")

    results = yolo_model(image_path, conf=0.25, imgsz=640, verbose=False)
    crops_by_class: Dict[str, List[np.ndarray]] = {name: [] for name in TARGET_CLASSES}

    for result in results:
        names = result.names
        boxes = result.boxes
        if boxes is None:
            continue

        for box in boxes:
            class_id = int(box.cls[0].item())
            class_name = names.get(class_id, "")
            if class_name not in TARGET_CLASSES:
                continue

            x1, y1, x2, y2 = map(int, box.xyxy[0].tolist())
            x1 = max(0, x1)
            y1 = max(0, y1)
            x2 = min(image.shape[1], x2)
            y2 = min(image.shape[0], y2)

            crop = image[y1:y2, x1:x2]
            if crop.size == 0:
                continue

            crops_by_class[class_name].append(crop)

    return crops_by_class


def compare_damage_images(image_a_path: str, image_b_path: str, weights: str = "best.pt", threshold: float = 0.85) -> bool:
    """Return True if Image A and Image B show the same physical damage instance.

    This function: 1) validates image quality, 2) detects the supported classes in both images,
    3) crops the relevant objects, 4) extracts ResNet-50 embeddings, 5) compares same-class
    crops via cosine similarity, and 6) prints a final declaration based on the threshold.
    """
    if not validate_image_for_detection(image_a_path):
        print(image_quality_guidance())
        return False

    if not validate_image_for_detection(image_b_path):
        print(image_quality_guidance())
        return False

    model = YOLO(weights)
    crops_a = detect_crops_by_class(image_a_path, model)
    crops_b = detect_crops_by_class(image_b_path, model)

    similarity_scores: List[float] = []
    for class_name in sorted(TARGET_CLASSES):
        if not crops_a.get(class_name) or not crops_b.get(class_name):
            continue

        for crop_a in crops_a[class_name]:
            emb_a = extract_resnet_embedding(crop_a)
            for crop_b in crops_b[class_name]:
                emb_b = extract_resnet_embedding(crop_b)
                similarity_scores.append(cosine_similarity(emb_a, emb_b))

    if not similarity_scores:
        print(
            "Declaration: Image A and Image B do NOT show the exact same physical damage instance. "
            "No matching damage-class crops were found for damaged_road, clogged_drainage, or damaged_street_light."
        )
        return False

    best_similarity = max(similarity_scores)
    matched = best_similarity >= threshold

    if matched:
        print(
            f"Declaration: Image A and Image B show the exact same physical damage instance. "
            f"Best cosine similarity = {best_similarity:.4f} (threshold: {threshold:.2f})."
        )
    else:
        print(
            f"Declaration: Image A and Image B do NOT show the exact same physical damage instance. "
            f"Best cosine similarity = {best_similarity:.4f} (threshold: {threshold:.2f})."
        )

    return matched


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="Compare infrastructure damage images using YOLOv8 + ResNet-50 embeddings.")
    parser.add_argument("image_a", help="Path to image A, e.g. image_a.jpg")
    parser.add_argument("image_b", help="Path to image B, e.g. image_b.jpg")
    parser.add_argument("--weights", default="best.pt", help="YOLOv8 weights file path")
    parser.add_argument("--threshold", type=float, default=0.85, help="Cosine similarity threshold")
    args = parser.parse_args()

    compare_damage_images(args.image_a, args.image_b, weights=args.weights, threshold=args.threshold)
