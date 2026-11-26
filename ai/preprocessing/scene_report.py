import argparse
import json
from collections import Counter, defaultdict
from pathlib import Path

from ai.preprocessing.annotation_quality import (
    CANONICAL_NAMES,
    audit_dataset_annotations,
    parse_label_file,
)
from ai.preprocessing.scene_lineage import SPLITS, build_scene_groups


def attach_labels(records, dataset_root):
    for record in records:
        label_path = Path(dataset_root) / record["split"] / "labels" / (Path(record["file"]).stem + ".txt")
        boxes, _ = parse_label_file(label_path) if label_path.is_file() else ([], [])
        record["boxes"] = boxes
        record["classes"] = sorted({item["class_id"] for item in boxes})
    return records


def representative_per_scene(records):
    chosen = {}
    for record in records:
        current = chosen.get(record["scene_id"])
        if current is None or (len(record["boxes"]), record["file"]) > (len(current["boxes"]), current["file"]):
            chosen[record["scene_id"]] = record
    return chosen


def stem_overlap(records):
    stem_splits = defaultdict(set)
    for record in records:
        stem_splits[record["stem"]].add(record["split"])
    train_stems = {stem for stem, splits in stem_splits.items() if "train" in splits}
    result = {}
    for split in ("valid", "test"):
        split_stems = {stem for stem, splits in stem_splits.items() if split in splits}
        shared = split_stems & train_stems
        result[split] = {
            "stems": len(split_stems),
            "shared_with_train": len(shared),
            "percent": round(100.0 * len(shared) / len(split_stems), 1) if split_stems else 0.0,
        }
    return result


def scene_overlap(records):
    scene_splits = defaultdict(set)
    for record in records:
        scene_splits[record["scene_id"]].add(record["split"])
    counts = {"train_valid": 0, "train_test": 0, "valid_test": 0}
    for splits in scene_splits.values():
        if {"train", "valid"} <= splits:
            counts["train_valid"] += 1
        if {"train", "test"} <= splits:
            counts["train_test"] += 1
        if {"valid", "test"} <= splits:
            counts["valid_test"] += 1
    per_split_scenes = {split: len({r["scene_id"] for r in records if r["split"] == split}) for split in SPLITS}
    leaked = {}
    for split in ("valid", "test"):
        split_scenes = {r["scene_id"] for r in records if r["split"] == split}
        train_scenes = {r["scene_id"] for r in records if r["split"] == "train"}
        shared = split_scenes & train_scenes
        leaked[split] = {
            "scenes": len(split_scenes),
            "shared_with_train": len(shared),
            "percent": round(100.0 * len(shared) / len(split_scenes), 1) if split_scenes else 0.0,
        }
    return counts, per_split_scenes, leaked


def per_class_report(records):
    representatives = representative_per_scene(records)
    report = {}
    for class_id, name in CANONICAL_NAMES.items():
        class_images = [r for r in records if class_id in r["classes"]]
        class_scenes = {r["scene_id"] for r in class_images}
        original_boxes = sum(
            1 for r in representatives.values() for item in r["boxes"] if item["class_id"] == class_id
        )
        total_boxes = sum(1 for r in class_images for item in r["boxes"] if item["class_id"] == class_id)
        by_split = {}
        for split in SPLITS:
            split_images = [r for r in class_images if r["split"] == split]
            by_split[split] = {
                "images": len(split_images),
                "scenes": len({r["scene_id"] for r in split_images}),
                "boxes": sum(1 for r in split_images for item in r["boxes"] if item["class_id"] == class_id),
            }
        report[name] = {
            "independent_scenes": len(class_scenes),
            "total_images": len(class_images),
            "augmented_derivatives": len(class_images) - len(class_scenes),
            "total_boxes": total_boxes,
            "original_boxes": original_boxes,
            "by_split": by_split,
        }
    return report


def summarise(dataset_root, workers=None):
    records, review_pairs, evidence = build_scene_groups(dataset_root, workers)
    attach_labels(records, dataset_root)
    overlap_counts, per_split_scenes, leaked = scene_overlap(records)
    annotation_report, annotation_summary = audit_dataset_annotations(dataset_root)
    empty_images = sorted(f"{r['split']}/{r['file']}" for r in records if not r["boxes"])
    scene_sizes = Counter(Counter(r["scene_id"] for r in records).values())
    return {
        "dataset": str(dataset_root),
        "total_images": len(records),
        "images_by_split": {split: sum(1 for r in records if r["split"] == split) for split in SPLITS},
        "independent_scenes": len({r["scene_id"] for r in records}),
        "augmented_derivatives": len(records) - len({r["scene_id"] for r in records}),
        "scene_size_histogram": {str(size): count for size, count in sorted(scene_sizes.items())},
        "total_boxes": sum(len(r["boxes"]) for r in records),
        "scenes_by_split": per_split_scenes,
        "scene_leakage_pairs": overlap_counts,
        "scene_leakage_percent_of_eval_split": leaked,
        "filename_stem_overlap_with_train": stem_overlap(records),
        "duplicate_evidence": evidence,
        "borderline_feature_matches_not_merged": review_pairs[:25],
        "per_class": per_class_report(records),
        "empty_label_images": empty_images,
        "annotation_summary": annotation_summary,
        "annotation_report": annotation_report,
        "records": [
            {
                "split": r["split"],
                "file": r["file"],
                "stem": r["stem"],
                "scene_id": r["scene_id"],
                "sha256": r["sha256"],
                "boxes": len(r["boxes"]),
                "classes": r["classes"],
            }
            for r in records
        ],
    }


def main():
    parser = argparse.ArgumentParser(description="Scene lineage and per-class report for a YOLO dataset")
    parser.add_argument("dataset", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--workers", type=int, default=None)
    args = parser.parse_args()
    summary = summarise(args.dataset, args.workers)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(summary, indent=2), encoding="utf-8")
    printable = {key: value for key, value in summary.items() if key not in ("records", "annotation_report", "duplicate_evidence")}
    print(json.dumps(printable, indent=2))


if __name__ == "__main__":
    main()
