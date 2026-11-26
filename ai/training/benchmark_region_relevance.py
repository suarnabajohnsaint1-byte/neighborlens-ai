"""Evaluate an experimental COCO region veto offline against known negatives and labeled defects."""

import argparse
from collections import Counter
from hashlib import sha256
import json
from pathlib import Path
from tempfile import TemporaryDirectory

import numpy as np
import torch
from ultralytics import YOLO
from ultralytics.data.utils import IMG_FORMATS
from ultralytics.utils.metrics import ap_per_class, box_iou
from ultralytics.utils.ops import xywhn2xyxy

from ai.inference.damage_contract import CANONICAL_CLASS_NAMES, decide_pair, validate_model_names
from ai.preprocessing.build_dataset import parse_label_file

AP_IOUS = np.linspace(0.50, 0.95, 10)


def image_paths(root):
    paths = sorted(path for path in root.rglob("*") if path.is_file() and path.suffix[1:].lower() in IMG_FORMATS)
    if not paths:
        raise ValueError(f"No supported images in {root}")
    return {path.relative_to(root).as_posix(): path for path in paths}


def read_labels(images, labels_dir):
    labels = {}
    counts = Counter({"labeled": 0, "empty": 0, "missing": 0})
    for name in images:
        path = labels_dir / Path(name).with_suffix(".txt") if labels_dir is not None else None
        if path is not None and path.exists():
            rows = parse_label_file(path, set(CANONICAL_CLASS_NAMES))
            counts["labeled" if rows else "empty"] += 1
        else:
            rows = []
            counts["missing"] += 1
        values = np.asarray(rows, dtype=np.float32).reshape(-1, 5)
        if not np.isfinite(values).all():
            raise ValueError(f"Non-finite label coordinates in {path}")
        labels[name] = values
    return labels, dict(counts)


def load_pairs(path, images):
    if path is None:
        return {}
    pairs = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(pairs, dict):
        raise ValueError("The pair manifest must map pair IDs to two image paths.")
    for name, views in pairs.items():
        if (not isinstance(views, list) or len(views) != 2 or
                any(not isinstance(view, str) or view not in images for view in views) or views[0] == views[1]):
            raise ValueError(f"Pair {name!r} must contain two distinct paths from the negative panel.")
    return pairs


def predict(model, images, confidence, args, *, augment):
    by_path = {path.resolve(): name for name, path in images.items()}
    predictions = {}
    with TemporaryDirectory(prefix="neighborlens-benchmark-") as directory:
        manifest = Path(directory) / "images.txt"
        manifest.write_text("\n".join(str(path) for path in by_path) + "\n")
        results = model.predict(str(manifest), stream=True, imgsz=args.imgsz, conf=confidence, batch=args.batch,
                                max_det=args.max_det, rect=False, augment=augment, verbose=False, device=args.device)
        for result in results:
            name = by_path[Path(result.path).resolve()]
            if name in predictions:
                raise ValueError(f"Inference returned duplicate results for {name}")
            boxes = result.boxes.data.cpu().numpy()
            predictions[name] = (boxes[np.argsort(-boxes[:, 4], kind="stable")], result.orig_shape)
    if missing := images.keys() - predictions.keys():
        raise ValueError(f"Inference skipped {len(missing)} image(s): {', '.join(sorted(missing)[:5])}")
    return predictions


def subject_boxes(model, images, args):
    class_ids = [class_id for class_id, name in model.names.items() if name in args.object_classes]
    return {
        name: rows[np.isin(rows[:, 5], class_ids), :4]
        for name, (rows, _) in predict(model, images, args.verifier_confidence, args, augment=False).items()
    }


def overlap_fractions(boxes, subjects):
    """Return the largest fraction of each defect box covered by a verifier box."""
    if not len(boxes) or not len(subjects):
        return np.zeros(len(boxes))
    start = np.maximum(boxes[:, None, :2], subjects[None, :, :2])
    end = np.minimum(boxes[:, None, 2:], subjects[None, :, 2:])
    shared = np.clip(end - start, 0, None).prod(axis=2)
    areas = np.clip(boxes[:, 2:] - boxes[:, :2], 0, None).prod(axis=1)
    return shared.max(axis=1) / np.maximum(areas, 1e-9)


def matches_by_iou(detections, targets, target_boxes):
    """Match in descending confidence order and keep the identity of each matched label."""
    matches = np.full((len(detections), len(AP_IOUS)), -1, dtype=int)
    if not len(detections) or not len(targets):
        return matches
    overlaps = box_iou(torch.from_numpy(detections[:, :4]), torch.from_numpy(target_boxes)).numpy()
    overlaps[detections[:, 5, None] != targets[:, 0]] = 0
    for column, threshold in enumerate(AP_IOUS):
        available = overlaps.copy()
        for index, row in enumerate(available):
            target = row.argmax()
            if row[target] >= threshold:
                matches[index, column] = target
                available[:, target] = 0
    return matches


def as_decision_rows(boxes):
    return [{"class": CANONICAL_CLASS_NAMES[int(row[5])], "confidence": float(row[4])} for row in boxes]


def summarize_setting(predictions, labels, subjects, threshold, confidence, pairs):
    detections = {}
    target_classes = []
    all_boxes, all_matches = [], []
    hits, lost, suppressed = Counter(), Counter(), Counter()
    images_with_subjects = 0
    targets_with_subjects = 0
    for name, (boxes, shape) in predictions.items():
        targets = labels[name]
        target_classes.extend(targets[:, 0])
        at_cutoff = boxes[:, 4] >= confidence
        verifier_boxes = subjects[name]
        images_with_subjects += bool(len(verifier_boxes))
        targets_with_subjects += len(targets) if len(verifier_boxes) else 0
        keep = (np.ones(len(boxes), dtype=bool) if threshold is None else
                overlap_fractions(boxes[:, :4], verifier_boxes) < threshold)
        retained = boxes[keep]
        detections[name] = retained[retained[:, 4] >= confidence]
        height, width = shape
        target_boxes = xywhn2xyxy(targets[:, 1:], w=width, h=height)
        matches = matches_by_iou(retained, targets, target_boxes)
        true_labels = matches[at_cutoff[keep], 0]
        covered = set(true_labels[true_labels >= 0])
        hits.update(targets[list(covered), 0])
        if np.any(at_cutoff & ~keep) and len(targets):
            original_matches = matches_by_iou(boxes[at_cutoff], targets, target_boxes)[:, 0]
            original_covered = set(original_matches[original_matches >= 0])
            lost.update(targets[list(original_covered - covered), 0])
            removed_matches = original_matches[~keep[at_cutoff] & (original_matches >= 0)]
            suppressed.update(targets[removed_matches, 0])
        all_boxes.append(retained)
        all_matches.append(matches >= 0)

    truth = Counter(target_classes)
    negative_images = sum(not len(rows) for rows in labels.values())
    false_positive_images = sum(bool(len(rows)) and not len(labels[name]) for name, rows in detections.items())
    result = {
        "images": len(labels),
        "images_with_eligible_predictions": sum(bool(len(rows)) for rows in detections.values()),
        "negative_images": negative_images,
        "false_positive_images": false_positive_images,
        "false_positive_image_rate": false_positive_images / negative_images if negative_images else None,
        "images_with_verifier_objects": images_with_subjects,
        "labeled_instances_in_images_with_verifier_objects": targets_with_subjects,
        "suppressed_true_positive_predictions": sum(suppressed.values()),
        "legitimate_instances_lost": sum(lost.values()),
        "map50": None,
        "map50_95": None,
    }
    per_class = {
        name: {
            "instances": truth[class_id],
            "matched_at_confidence": hits[class_id],
            "missed_at_confidence": truth[class_id] - hits[class_id],
            "recall_at_confidence": hits[class_id] / truth[class_id] if truth[class_id] else None,
            "suppressed_true_positive_predictions": suppressed[class_id],
            "legitimate_instances_lost": lost[class_id],
            "map50": None,
            "map50_95": None,
        }
        for class_id, name in CANONICAL_CLASS_NAMES.items()
    }
    if target_classes:
        boxes = np.concatenate(all_boxes)
        ap, ap_classes = ap_per_class(np.concatenate(all_matches), boxes[:, 4], boxes[:, 5],
                                     np.asarray(target_classes), names=CANONICAL_CLASS_NAMES)[5:7]
        result["map50"] = float(ap[:, 0].mean())
        result["map50_95"] = float(ap.mean())
        for class_id, values in zip(ap_classes, ap):
            row = per_class[CANONICAL_CLASS_NAMES[int(class_id)]]
            row["map50"], row["map50_95"] = float(values[0]), float(values.mean())
    result["classes"] = per_class
    if pairs:
        pair_statuses = {
            name: decide_pair(as_decision_rows(detections[first]), as_decision_rows(detections[second]), confidence)["status"]
            for name, (first, second) in pairs.items()
        }
        agreed = sum(status == "DETECTED" for status in pair_statuses.values())
        result["negative_pair_model_agreement"] = {
            "pairs": len(pairs), "agreed": agreed, "rate": agreed / len(pairs), "statuses": pair_statuses,
        }
    return result


def benchmark(model, images, labels, subjects, args, pairs=None):
    predictions = predict(model, images, args.ap_confidence_floor, args, augment=True)
    return {
        "no_veto" if threshold is None else str(threshold):
            summarize_setting(predictions, labels, subjects, threshold, args.confidence, pairs)
        for threshold in (None, *args.overlap_thresholds)
    }


def unit_interval(value):
    number = float(value)
    if not 0 < number <= 1:
        raise argparse.ArgumentTypeError("must be in (0, 1]")
    return number


def positive_int(value):
    number = int(value)
    if number < 1:
        raise argparse.ArgumentTypeError("must be a positive integer")
    return number


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--weights", type=Path, required=True)
    parser.add_argument("--candidate", type=Path, required=True)
    parser.add_argument("--verifier", type=Path, required=True)
    parser.add_argument("--negatives", type=Path, required=True)
    parser.add_argument("--negative-labels", type=Path, help="Optional empty-label directory for the negative panel.")
    parser.add_argument("--negative-pairs", type=Path, help="JSON map of pair IDs to two relative paths. Measures model agreement only.")
    parser.add_argument("--test-images", type=Path, required=True)
    parser.add_argument("--test-labels", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--object-classes", nargs="+", required=True, help="Verifier labels to test, quoted when they contain spaces.")
    parser.add_argument("--overlap-thresholds", nargs="+", type=unit_interval, required=True)
    parser.add_argument("--confidence", type=unit_interval, default=0.30)
    parser.add_argument("--verifier-confidence", type=unit_interval, default=0.25)
    parser.add_argument("--ap-confidence-floor", type=unit_interval, default=0.001)
    parser.add_argument("--imgsz", type=positive_int, default=640)
    parser.add_argument("--max-det", type=positive_int, default=100)
    parser.add_argument("--batch", type=positive_int, default=8)
    parser.add_argument("--device", default="0")
    args = parser.parse_args()
    if args.ap_confidence_floor > args.confidence:
        parser.error("--ap-confidence-floor cannot exceed --confidence")
    if len(set(args.overlap_thresholds)) != len(args.overlap_thresholds):
        parser.error("--overlap-thresholds cannot contain duplicates")
    args.object_classes = sorted(set(args.object_classes))
    for directory in (args.test_labels, args.negative_labels):
        if directory is not None and not directory.is_dir():
            parser.error(f"Label directory does not exist: {directory}")
    if args.out.exists():
        parser.error(f"Output already exists: {args.out}")
    checkpoints = {
        role: {"path": str(path), "sha256": sha256(path.read_bytes()).hexdigest()}
        for role, path in ((role, getattr(args, role)) for role in ("weights", "candidate", "verifier"))
    }
    negatives = image_paths(args.negatives)
    test_images = image_paths(args.test_images)
    negative_labels, negative_counts = read_labels(negatives, args.negative_labels)
    test_labels, test_counts = read_labels(test_images, args.test_labels)
    if negative_counts["labeled"]:
        parser.error("The negative panel contains target annotations.")
    if not test_counts["labeled"]:
        parser.error("The protected test split contains no target annotations.")
    pairs = load_pairs(args.negative_pairs, negatives)
    verifier = YOLO(str(args.verifier))
    if unknown := sorted(set(args.object_classes) - set(verifier.names.values())):
        parser.error(f"Unknown verifier classes: {', '.join(unknown)}")
    subjects = subject_boxes(verifier, negatives, args)
    test_subjects = subject_boxes(verifier, test_images, args)
    baseline = YOLO(str(args.weights))
    candidate = YOLO(str(args.candidate))
    for model in (baseline, candidate):
        validate_model_names(model.names)
    parameters = ("object_classes", "overlap_thresholds", "confidence", "verifier_confidence", "ap_confidence_floor",
                  "imgsz", "max_det", "batch", "device")
    results = {
        "checkpoints": checkpoints,
        "parameters": {name: getattr(args, name) for name in parameters},
        "label_files": {"negatives": negative_counts, "labeled": test_counts},
        "negatives": benchmark(baseline, negatives, negative_labels, subjects, args, pairs),
        "candidate_negatives": benchmark(candidate, negatives, negative_labels, subjects, args, pairs),
        "labeled": benchmark(baseline, test_images, test_labels, test_subjects, args),
        "candidate_labeled": benchmark(candidate, test_images, test_labels, test_subjects, args),
    }
    with args.out.open("x", encoding="utf-8") as stream:
        json.dump(results, stream, indent=2, allow_nan=False)
        stream.write("\n")


if __name__ == "__main__":
    main()
