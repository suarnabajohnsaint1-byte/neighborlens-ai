"""Run YOLOv8 infrastructure detection on an input image or video and save annotated output."""

from __future__ import annotations

import os
import json
import logging
from collections import defaultdict
from pathlib import Path
from typing import Dict, Iterable, List

import cv2
from ultralytics import YOLO

DEFAULT_OUTPUT_DIR = Path(__file__).resolve().parents[2] / "storage" / "detections"
LOGGER = logging.getLogger("infrastructure_detector")
logging.basicConfig(level=logging.INFO, format="%(levelname)s: %(message)s")

TARGET_CLASSES = {
    "damaged_road": 0,
    "clogged_drainage": 1,
    "damaged_street_light": 2,
    "damaged_traffic_light": 3,
}

CLASS_COLORS = {
    "damaged_road": (0, 165, 255),
    "clogged_drainage": (0, 255, 255),
    "damaged_street_light": (255, 0, 0),
    "damaged_traffic_light": (0, 0, 255),
}


def build_summary(results: Iterable[dict]) -> Dict[str, Dict[str, float | int]]:
    counts = defaultdict(int)
    confidences = defaultdict(list)

    for result in results:
        if not result.get("class_name"):
            continue
        name = result["class_name"]
        counts[name] += 1
        confidences[name].append(float(result["confidence"]))

    summary: Dict[str, Dict[str, float | int]] = {}
    for class_name in TARGET_CLASSES:
        class_count = counts.get(class_name, 0)
        values = confidences.get(class_name, [])
        avg_conf = (sum(values) / len(values)) if values else 0.0
        summary[class_name] = {
            "count": class_count,
            "average_confidence": round(avg_conf, 4),
        }
    return summary


def process_file(model_path: str, input_path: str, output_dir: str = str(DEFAULT_OUTPUT_DIR)) -> dict:
    model = YOLO(model_path)
    input_file = Path(input_path)
    output_folder = Path(output_dir)
    output_folder.mkdir(parents=True, exist_ok=True)

    if not input_file.exists():
        raise FileNotFoundError(f"Input file not found: {input_file}")

    if not input_file.is_file():
        raise ValueError(f"Input path is not a file: {input_file}")

    inference_status = "standard"
    results = model(input_path, conf=0.30, iou=0.45, imgsz=800, verbose=False)
    if not results or all(getattr(result, "boxes", None) is None or len(result.boxes) == 0 for result in results):
        LOGGER.warning(
            "Zero bounding boxes at conf=0.30 for %s; retrying close-up fallback at conf=0.15, imgsz=1024.",
            input_file,
        )
        results = model(input_path, conf=0.15, iou=0.45, imgsz=1024, verbose=False)
        inference_status = "low_confidence_match" if any(
            getattr(result, "boxes", None) is not None and len(result.boxes) > 0 for result in results
        ) else "no_detections"

    detections: List[dict] = []
    annotated_frames = []
    for result in results:
        image = result.orig_img.copy()
        boxes = result.boxes
        for box in boxes:
            cls_id = int(box.cls[0].item())
            label = result.names[cls_id]
            if label not in TARGET_CLASSES:
                continue

            x1, y1, x2, y2 = [int(v) for v in box.xyxy[0].tolist()]
            conf = float(box.conf[0].item())
            color = CLASS_COLORS.get(label, (255, 255, 255))

            cv2.rectangle(image, (x1, y1), (x2, y2), color, 2)
            label_text = f"{label}: {conf:.2f}"
            cv2.putText(
                image,
                label_text,
                (x1, max(0, y1 - 10)),
                cv2.FONT_HERSHEY_SIMPLEX,
                0.5,
                color,
                2,
            )

            detections.append({
                "class_name": label,
                "confidence": round(conf, 4),
                "bounding_box": {"x1": x1, "y1": y1, "x2": x2, "y2": y2},
            })

        annotated_frames.append(image)

    if not annotated_frames:
        image = cv2.imread(str(input_file))
        if image is not None:
            annotated_frames.append(image)

    if input_file.suffix.lower() in {".mp4", ".avi", ".mov", ".mkv", ".wmv"}:
        output_file = output_folder / f"{input_file.stem}_annotated.mp4"
        height, width = annotated_frames[0].shape[:2]
        writer = cv2.VideoWriter(
            str(output_file),
            cv2.VideoWriter_fourcc(*"mp4v"),
            width,
            height,
            25,
        )
        for frame in annotated_frames:
            writer.write(frame)
        writer.release()
    else:
        image = annotated_frames[0]
        output_file = output_folder / f"{input_file.stem}_annotated.jpg"
        cv2.imwrite(str(output_file), image)

    summary = build_summary(detections)
    report = {
        "input_file": str(input_file),
        "output_file": str(output_file),
        "status": inference_status,
        "total_detections": len(detections),
        "summary": summary,
        "detections": detections,
    }

    print(json.dumps(report, indent=2))
    print("\nInfrastructure Detection Summary")
    print("-" * 40)
    for class_name in TARGET_CLASSES:
        item = summary[class_name]
        print(f"{class_name}: count={item['count']}, average_confidence={item['average_confidence']:.4f}")
    print("-" * 40)
    print(f"Total detections: {len(detections)}")
    print(f"Saved annotated output: {output_file}")
    return report


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="Detect damaged_road, clogged_drainage, damaged_street_light, and damaged_traffic_light instances with YOLOv8.")
    parser.add_argument("--model", default="best.pt", help="Path to the trained YOLOv8 weights file.")
    parser.add_argument("--input", required=True, help="Path to the input image or video file.")
    parser.add_argument("--output-dir", default=str(DEFAULT_OUTPUT_DIR), help="Directory where annotated output will be saved.")
    args = parser.parse_args()

    process_file(args.model, args.input, args.output_dir)
