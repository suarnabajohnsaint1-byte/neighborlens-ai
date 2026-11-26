"""Compare the same YOLO predictions with and without local face-overlap filtering."""

import argparse
from collections import Counter
from hashlib import sha256
import json
from pathlib import Path
from types import SimpleNamespace

import cv2
import numpy as np
from ultralytics import YOLO

from ai.inference.damage_contract import CANONICAL_CLASS_NAMES, validate_model_names
from ai.inference.portrait_evidence import load_face_regions, on_face
from ai.training.benchmark_region_relevance import image_paths, load_pairs, predict, read_labels, summarize_setting
from ai.training.sweep_operating_points import DIAGNOSTIC_FLOOR, score_cutoff


def filter_predictions(images, raw, detector):
    filtered = {}
    audit = {}
    for name, path in images.items():
        boxes, shape = raw[name]
        image = cv2.imread(str(path))
        if image is None or image.shape[:2] != shape:
            raise ValueError(f"Image geometry differs between YOLO and OpenCV: {path}")
        faces = detector.detect(image)
        keep = []
        for x1, y1, x2, y2, *_ in boxes:
            region = SimpleNamespace(x=x1, y=y1, width=x2 - x1, height=y2 - y1)
            keep.append(not any(on_face(region, face) for face in faces))
        mask = np.asarray(keep, dtype=bool)
        filtered[name] = (boxes[mask], shape)
        audit[name] = {
            "face_count": len(faces),
            "raw_eligible": sorted(set(int(row[5]) for row in boxes if row[4] >= 0.30)),
            "filtered_eligible": sorted(set(int(row[5]) for row in boxes[mask] if row[4] >= 0.30)),
            "removed_eligible": dict(Counter(
                CANONICAL_CLASS_NAMES[int(row[5])] for row in boxes[~mask] if row[4] >= 0.30
            )),
        }
    return filtered, audit


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("images", "labels", "negatives", "pairs", "weights", "portrait-model", "out"):
        parser.add_argument(f"--{name}", required=True, type=Path)
    parser.add_argument("--device", default="0")
    args = parser.parse_args()
    detector = load_face_regions(args.portrait_model)
    positives = image_paths(args.images)
    negatives = image_paths(args.negatives)
    positives = {f"labeled/{name}": path for name, path in positives.items()}
    labels, label_counts = read_labels(
        {name.removeprefix("labeled/"): path for name, path in positives.items()}, args.labels
    )
    if label_counts["missing"]:
        parser.error("Every labeled-panel image must have a label file, even if empty.")
    labels = {f"labeled/{name}": values for name, values in labels.items()}
    labels.update({name: np.empty((0, 5), np.float32) for name in negatives})
    images = {**positives, **negatives}
    pairs = load_pairs(args.pairs, negatives)
    model = YOLO(str(args.weights))
    validate_model_names(model.names)
    raw = predict(model, images, DIAGNOSTIC_FLOOR,
                  SimpleNamespace(imgsz=640, batch=8, max_det=100, device=args.device), augment=True)
    filtered, audit = filter_predictions(images, raw, detector)

    scores = {}
    matches = {}
    for name, predictions in (("raw", raw), ("face_aware", filtered)):
        scores[name], matches[name] = score_cutoff(
            predictions, {key: predictions[key] for key in negatives}, labels, pairs, 0.30
        )
        ap = summarize_setting(predictions, labels, dict.fromkeys(images, ()), None, 0.30, None)
        scores[name]["map50"], scores[name]["map50_95"] = ap["map50"], ap["map50_95"]
        for label, values in ap["classes"].items():
            scores[name]["classes"][label]["ap50"] = values["map50"]

    case_groups = {}
    for name in negatives:
        group = name.split("/")[0]
        counts = case_groups.setdefault(group, Counter())
        counts["images"] += 1
        counts["faces_detected"] += bool(audit[name]["face_count"])
        counts["raw_false_positive"] += bool(audit[name]["raw_eligible"])
        counts["filtered_false_positive"] += bool(audit[name]["filtered_eligible"])
    lost = matches["raw"] - matches["face_aware"]
    report = {
        "checkpoint": str(args.weights),
        "checkpoint_sha256": sha256(args.weights.read_bytes()).hexdigest(),
        "opencv_version": cv2.__version__,
        "settings": {"cutoff": 0.30, "ap_floor": DIAGNOSTIC_FLOOR, "imgsz": 640, "max_det": 100, "augment": True},
        "labeled_images": label_counts,
        "negative_groups": case_groups,
        "negative_pairs": len(pairs),
        "scores": scores,
        "lost_genuine_matches": sorted(lost),
        "image_audit": audit,
    }
    with args.out.open("x", encoding="utf-8") as stream:
        json.dump(report, stream, indent=2, allow_nan=False)
        stream.write("\n")


if __name__ == "__main__":
    main()
