"""Audit known negative examples with the same detector settings as local inference."""

import argparse
import csv
from hashlib import sha256
import json
from pathlib import Path

from ai.inference.damage_contract import decide, decide_pair
from ai.inference.inference_api import read_image_bytes
from ai.inference.portrait_evidence import load_face_regions, portrait_candidates
from ai.inference.yolo_detector import YoloDetector


def serialized(item):
    return {
        "class": item.damage_type,
        "confidence": item.confidence_score,
        "bounding_box": item.bounding_box.model_dump(),
        "eligible": item.eligible,
    }


def audit(images, weights, output, confidence, image_size, pair_manifest, portrait_model=None):
    paths = sorted(path for path in images.rglob("*") if path.suffix.lower() in {".jpg", ".jpeg", ".png", ".webp"})
    if not paths:
        raise ValueError(f"No supported audit images in {images}")
    if output.exists():
        raise FileExistsError(output)
    face_regions = load_face_regions(portrait_model) if portrait_model else None
    model = YoloDetector(str(weights))
    rows = {}
    filtered_rows = {}
    for path in paths:
        data = path.read_bytes()
        image, bgr = read_image_bytes(data)
        raw, _ = model.detect(image, confidence, image_size)
        filtered = portrait_candidates(raw, face_regions.detect(bgr)) if face_regions and raw else raw
        relative = path.relative_to(images).as_posix()
        detections = [serialized(item) for item in raw]
        filtered_rows[relative] = [serialized(item) for item in filtered]
        review = len(filtered) != len(raw) and not any(item.eligible for item in filtered)
        rows[relative] = {
            "sha256": sha256(data).hexdigest(),
            "decision": decide(detections, confidence),
            "after_portrait_check": "EVIDENCE_REVIEW_REQUIRED" if review else decide(filtered_rows[relative], confidence),
            "detections": detections,
        }
    pairs = {}
    if pair_manifest:
        for name, (first, second) in json.loads(pair_manifest.read_text(encoding="utf-8")).items():
            raw = decide_pair(rows[first]["detections"], rows[second]["detections"], confidence)
            review = any(rows[key]["after_portrait_check"] == "EVIDENCE_REVIEW_REQUIRED" for key in (first, second))
            pairs[name] = {
                "photos": [first, second],
                "raw": raw["status"],
                "after_portrait_check": "EVIDENCE_REVIEW_REQUIRED" if review else decide_pair(
                    filtered_rows[first], filtered_rows[second], confidence,
                )["status"],
            }
    raw_positives = sum(row["decision"]["detected"] for row in rows.values())
    portrait_positives = sum(
        isinstance(result, dict) and result["detected"]
        for row in rows.values() for result in [row["after_portrait_check"]]
    )
    summary = {
        "checkpoint": str(weights),
        "checkpoint_sha256": sha256(weights.read_bytes()).hexdigest(),
        "confidence": confidence,
        "image_size": image_size,
        "images": len(rows),
        "portrait_filter_enabled": face_regions is not None,
        "raw_false_acceptances": raw_positives,
        "false_positive_image_rate": raw_positives / len(rows),
        "after_portrait_check": portrait_positives,
        "pairs": len(pairs),
        "raw_pair_false_acceptances": sum(pair["raw"] == "DETECTED" for pair in pairs.values()),
        "pair_false_acceptances_after_portrait_check": sum(pair["after_portrait_check"] == "DETECTED" for pair in pairs.values()),
    }
    output.mkdir(parents=True)
    for name, result in (("summary", summary), ("all_detections", rows), ("pair_decisions", pairs)):
        (output / f"{name}.json").write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
    with (output / "negative_predictions.csv").open("w", newline="", encoding="utf-8") as stream:
        writer = csv.writer(stream)
        writer.writerow(("image", "sha256", "class", "confidence", "eligible", "x", "y", "width", "height", "decision"))
        for name, row in rows.items():
            for box in row["detections"] or [{}]:
                coords = box.get("bounding_box", {})
                writer.writerow((name, row["sha256"], box.get("class"), box.get("confidence"), box.get("eligible"),
                                 *(coords.get(key) for key in ("x", "y", "width", "height")), row["decision"]["inference_status"]))
    print(json.dumps(summary, indent=2))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--images", type=Path, required=True)
    parser.add_argument("--weights", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--pairs", type=Path, help="JSON object mapping pair IDs to two relative image paths")
    parser.add_argument("--portrait-model", type=Path, help="Pinned YuNet ONNX file for the optional comparison")
    parser.add_argument("--conf", type=float, default=0.30)
    parser.add_argument("--imgsz", type=int, default=640)
    args = parser.parse_args()
    audit(args.images, args.weights, args.out, args.conf, args.imgsz, args.pairs, args.portrait_model)


if __name__ == "__main__":
    main()
