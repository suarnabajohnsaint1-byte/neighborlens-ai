"""Replay YOLOv8 detections at fixed cutoffs without any evidence veto."""

import argparse
from collections import Counter
from hashlib import sha256
import json
from pathlib import Path

import numpy as np
from ultralytics import YOLO
from ultralytics.utils.ops import xywhn2xyxy

from ai.inference.damage_contract import CANONICAL_CLASS_NAMES, decide_pair, validate_model_names
from ai.training.benchmark_region_relevance import (
    as_decision_rows, image_paths, load_pairs, matches_by_iou, predict, read_labels, summarize_setting,
)

CUTOFFS = (0.15, 0.20, 0.25, 0.30, 0.35, 0.40)
DIAGNOSTIC_FLOOR = 0.001


def score_cutoff(positives, negatives, labels, pairs, cutoff):
    predicted, matched = Counter(), Counter()
    matched_labels = set()
    for name, (rows, (height, width)) in positives.items():
        eligible = rows[rows[:, 4] >= cutoff]
        predicted.update(int(item[5]) for item in eligible)
        targets = labels[name]
        boxes = xywhn2xyxy(targets[:, 1:], w=width, h=height)
        for index in matches_by_iou(eligible, targets, boxes)[:, 0]:
            if index >= 0:
                cls = int(targets[index, 0])
                matched[cls] += 1
                matched_labels.add((name, int(index), cls))

    eligible_negatives = {name: as_decision_rows(rows[rows[:, 4] >= cutoff]) for name, (rows, _) in negatives.items()}
    accepted = {name: decide_pair(eligible_negatives[a], eligible_negatives[b], cutoff)["detected"]
                for name, (a, b) in pairs.items()}
    truth = Counter(int(row[0]) for values in labels.values() for row in values)
    false_positive_images = sum(bool(rows) for rows in eligible_negatives.values())
    return {
        "eligible_negative_images": false_positive_images,
        "false_positive_image_rate": false_positive_images / len(negatives),
        "negative_pairs_agreeing": sum(accepted.values()),
        "agreed_pairs": [name for name, agrees in accepted.items() if agrees],
        "classes": {
            label: {
                "instances": truth[cls],
                "matched": matched[cls],
                "missed": truth[cls] - matched[cls],
                "precision": matched[cls] / predicted[cls] if predicted[cls] else None,
                "recall": matched[cls] / truth[cls] if truth[cls] else None,
            } for cls, label in CANONICAL_CLASS_NAMES.items()
        },
    }, matched_labels


def diagnose_cutoff(labels, ground_hits, cutoff_hits):
    """Separate operating-point score loss from failure to produce a localized box."""
    floor = Counter(cls for _, _, cls in ground_hits)
    confidence_loss = Counter(cls for _, _, cls in ground_hits - cutoff_hits)
    diagnosis = {}
    for cls, name in CANONICAL_CLASS_NAMES.items():
        truth = sum(int(np.count_nonzero(rows[:, 0] == cls)) for rows in labels.values())
        diagnosis[name] = {
            "labels": truth,
            "matched_at_ap_floor": floor[cls],
            "lost_between_ap_floor_and_0.30": confidence_loss[cls],
            "unmatched_even_at_ap_floor": truth - floor[cls],
        }
    return diagnosis


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("images", "labels", "negatives", "pairs", "out"):
        parser.add_argument(f"--{name}", required=True, type=Path)
    parser.add_argument("--model", action="append", required=True, metavar="NAME=PATH")
    parser.add_argument("--imgsz", default=640, type=int)
    parser.add_argument("--batch", default=8, type=int)
    parser.add_argument("--max-det", default=100, type=int)
    parser.add_argument("--device", default="0")
    options = parser.parse_args()
    if options.out.exists():
        parser.error(f"Output already exists: {options.out}")
    if not options.labels.is_dir():
        parser.error(f"Label directory does not exist: {options.labels}")
    positive_paths, negative_paths = image_paths(options.images), image_paths(options.negatives)
    labels, label_counts = read_labels(positive_paths, options.labels)
    pairs = load_pairs(options.pairs, negative_paths)
    results = {
        "dataset": {"images": len(positive_paths), "labels": label_counts, "negatives": len(negative_paths), "pairs": len(pairs)},
        "settings": {"imgsz": options.imgsz, "batch": options.batch, "max_det": options.max_det, "ap_floor": DIAGNOSTIC_FLOOR, "augment": True},
        "models": {},
    }
    baseline = None
    checkpoint_names = set()
    for specification in options.model:
        name, separator, checkpoint = specification.partition("=")
        if not separator or not name or not checkpoint or name in checkpoint_names:
            parser.error("Each --model must have a unique NAME=PATH.")
        checkpoint_names.add(name)
        print(f"Scoring {name}", flush=True)
        model = YOLO(checkpoint)
        validate_model_names(model.names)
        positives = predict(model, positive_paths, DIAGNOSTIC_FLOOR, options, augment=True)
        negatives = predict(model, negative_paths, DIAGNOSTIC_FLOOR, options, augment=True)
        del model
        empty_subjects = dict.fromkeys(positives, np.empty((0, 4)))
        ap_metrics = summarize_setting(positives, labels, empty_subjects, None, 0.30, None)
        thresholds = {}
        _, floor_labels = score_cutoff(positives, negatives, labels, pairs, DIAGNOSTIC_FLOOR)
        current = {cutoff: score_cutoff(positives, negatives, labels, pairs, cutoff) for cutoff in CUTOFFS}
        if baseline is None:
            baseline = {cutoff: hits for cutoff, (_, hits) in current.items()}
        for cutoff, (row, hits) in current.items():
            missing = Counter(cls for _, _, cls in baseline[cutoff] - hits)
            new = Counter(cls for _, _, cls in hits - baseline[cutoff])
            for cls, label in CANONICAL_CLASS_NAMES.items():
                row["classes"][label]["lost_baseline_matches"] = missing[cls]
                row["classes"][label]["new_matches_vs_baseline"] = new[cls]
                row["classes"][label]["ap50"] = ap_metrics["classes"][label]["map50"]
            row["map50"], row["map50_95"] = ap_metrics["map50"], ap_metrics["map50_95"]
            thresholds[f"{cutoff:.2f}"] = row
        results["models"][name] = {
            "checkpoint": checkpoint, "sha256": sha256(Path(checkpoint).read_bytes()).hexdigest(),
            "thresholds": thresholds,
            "confidence_diagnosis": diagnose_cutoff(labels, floor_labels, current[0.30][1]),
        }
        with options.out.open("w", encoding="utf-8") as stream:
            json.dump(results, stream, indent=2, allow_nan=False)
            stream.write("\n")


if __name__ == "__main__":
    main()
