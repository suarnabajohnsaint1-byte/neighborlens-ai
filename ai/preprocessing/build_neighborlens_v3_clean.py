import argparse
import json
import random
import shutil
from collections import Counter, defaultdict
from pathlib import Path

import yaml

from ai.preprocessing.annotation_quality import CANONICAL_NAMES, audit_label_boxes, to_corners
from ai.preprocessing.scene_lineage import SPLITS, build_scene_groups
from ai.preprocessing.scene_report import attach_labels

PROJECT_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_SOURCE = PROJECT_ROOT / "data" / "datasets" / "neighborlens_paper_aligned_v2"
DEFAULT_OUTPUT = PROJECT_ROOT / "data" / "datasets" / "neighborlens_paper_aligned_v3_clean"
DEFAULT_SEED = 42
DEFAULT_FRACTIONS = {"train": 0.6, "valid": 0.2, "test": 0.2}


def group_scenes(records):
    scenes = defaultdict(list)
    for record in records:
        scenes[record["scene_id"]].append(record)
    return scenes


def scene_classes(images):
    return sorted({class_id for image in images for class_id in image["classes"]})


def stratified_group_split(scenes, fractions, seed, frozen=None):
    frozen = dict(frozen or {})
    rng = random.Random(seed)
    class_totals = Counter()
    for images in scenes.values():
        for class_id in scene_classes(images):
            class_totals[class_id] += 1
    targets = {
        split: {class_id: class_totals[class_id] * fraction for class_id in class_totals}
        for split, fraction in fractions.items()
    }
    scene_total_target = {split: len(scenes) * fraction for split, fraction in fractions.items()}
    assigned = {split: Counter() for split in fractions}
    scene_counts = Counter()
    assignment = {}

    for scene_id, split in frozen.items():
        if scene_id not in scenes:
            continue
        assignment[scene_id] = split
        scene_counts[split] += 1
        for class_id in scene_classes(scenes[scene_id]):
            assigned[split][class_id] += 1

    ordered = [item for item in scenes.items() if item[0] not in assignment]
    rng.shuffle(ordered)
    ordered.sort(key=lambda item: min((class_totals[class_id] for class_id in scene_classes(item[1])), default=0))

    for scene_id, images in ordered:
        classes = scene_classes(images)
        best_split = None
        best_score = None
        for split in fractions:
            score = 0.0
            for class_id in classes:
                target = targets[split][class_id]
                score += (target - assigned[split][class_id]) / max(target, 1e-9)
            score += 0.25 * (scene_total_target[split] - scene_counts[split]) / max(scene_total_target[split], 1e-9)
            score += rng.random() * 1e-6
            if best_score is None or score > best_score:
                best_score = score
                best_split = split
        assignment[scene_id] = best_split
        scene_counts[best_split] += 1
        for class_id in classes:
            assigned[best_split][class_id] += 1
    return assignment


def apply_safe_fixes(boxes):
    kept = []
    seen = set()
    fixes = []
    for item in boxes:
        key = (item["class_id"], tuple(round(value, 6) for value in item["box"]))
        if key in seen:
            fixes.append("removed_exact_duplicate")
            continue
        seen.add(key)
        x_center, y_center, width, height = item["box"]
        x1, y1, x2, y2 = to_corners(item["box"])
        cx1, cy1, cx2, cy2 = max(x1, 0.0), max(y1, 0.0), min(x2, 1.0), min(y2, 1.0)
        if (cx1, cy1, cx2, cy2) != (x1, y1, x2, y2) and cx2 > cx1 and cy2 > cy1:
            width, height = cx2 - cx1, cy2 - cy1
            x_center, y_center = cx1 + width / 2, cy1 + height / 2
            fixes.append("clamped_box_to_image")
            kept.append((item["class_id"], (x_center, y_center, width, height)))
        else:
            kept.append((item["class_id"], item["box"]))
    return kept, fixes


def format_label(boxes):
    return "\n".join(
        f"{class_id} {x:.6f} {y:.6f} {w:.6f} {h:.6f}" for class_id, (x, y, w, h) in boxes
    ) + "\n"


def write_data_yaml(output_root):
    config = {
        "train": "train/images",
        "val": "valid/images",
        "test": "test/images",
        "nc": len(CANONICAL_NAMES),
        "names": {index: name for index, name in CANONICAL_NAMES.items()},
    }
    (output_root / "data.yaml").write_text(yaml.safe_dump(config, sort_keys=False), encoding="utf-8")


def build(source_root, output_root, fractions, seed, workers=None):
    source_root = Path(source_root)
    output_root = Path(output_root)
    if output_root.exists():
        raise SystemExit(f"Refusing to overwrite existing dataset: {output_root}")

    records, review_pairs, evidence = build_scene_groups(source_root, workers)
    attach_labels(records, source_root)

    quarantined = []
    usable = []
    for record in records:
        issues = audit_label_boxes(record["boxes"])
        if not record["boxes"]:
            quarantined.append(
                {
                    "source": f"{record['split']}/{record['file']}",
                    "scene_id": record["scene_id"],
                    "reason": "empty_label_unreviewed_possible_unlabeled_object",
                }
            )
        else:
            usable.append(record)

    scenes = group_scenes(usable)
    assignment = stratified_group_split(scenes, fractions, seed)

    for split in SPLITS:
        (output_root / split / "images").mkdir(parents=True, exist_ok=True)
        (output_root / split / "labels").mkdir(parents=True, exist_ok=True)

    manifest_images = []
    fix_log = []
    counters = Counter()
    for scene_id in sorted(scenes):
        split = assignment[scene_id]
        for index, record in enumerate(sorted(scenes[scene_id], key=lambda item: item["file"])):
            counters[scene_id] += 1
            suffix = Path(record["file"]).suffix.lower()
            new_name = f"{scene_id}_{chr(ord('a') + index)}{suffix}"
            shutil.copy2(record["path"], output_root / split / "images" / new_name)
            boxes, fixes = apply_safe_fixes(record["boxes"])
            if fixes:
                fix_log.append({"file": new_name, "source": record["file"], "fixes": fixes})
            (output_root / split / "labels" / f"{Path(new_name).stem}.txt").write_text(
                format_label(boxes), encoding="utf-8"
            )
            manifest_images.append(
                {
                    "split": split,
                    "file": new_name,
                    "scene_id": scene_id,
                    "source_lineage_group": scene_id,
                    "source_file": record["file"],
                    "source_split": record["split"],
                    "source_stem": record["stem"],
                    "sha256": record["sha256"],
                    "classes": scene_classes([record]),
                    "boxes": len(boxes),
                    "origin": "original",
                }
            )

    write_data_yaml(output_root)

    split_report = {"seed": seed, "fractions": fractions, "splits": {}}
    for split in SPLITS:
        entries = [entry for entry in manifest_images if entry["split"] == split]
        class_boxes = Counter()
        class_scenes = defaultdict(set)
        class_images = Counter()
        for entry in entries:
            label = output_root / split / "labels" / f"{Path(entry['file']).stem}.txt"
            for line in label.read_text(encoding="utf-8").splitlines():
                class_boxes[int(line.split()[0])] += 1
            for class_id in entry["classes"]:
                class_scenes[class_id].add(entry["scene_id"])
                class_images[class_id] += 1
        split_report["splits"][split] = {
            "images": len(entries),
            "independent_scenes": len({entry["scene_id"] for entry in entries}),
            "boxes": sum(class_boxes.values()),
            "per_class": {
                CANONICAL_NAMES[class_id]: {
                    "scenes": len(class_scenes[class_id]),
                    "images": class_images[class_id],
                    "boxes": class_boxes[class_id],
                }
                for class_id in CANONICAL_NAMES
            },
        }

    (output_root / "manifest.json").write_text(
        json.dumps({"source": source_root.name, "seed": seed, "images": manifest_images}, indent=2),
        encoding="utf-8",
    )
    (output_root / "quarantine_manual_review.json").write_text(
        json.dumps(
            {
                "policy": "Images with empty labels are excluded from every split until a human confirms they contain no in-scope object.",
                "count": len(quarantined),
                "images": quarantined,
            },
            indent=2,
        ),
        encoding="utf-8",
    )
    (output_root / "split_report.json").write_text(json.dumps(split_report, indent=2), encoding="utf-8")
    (output_root / "safe_fixes_applied.json").write_text(json.dumps(fix_log, indent=2), encoding="utf-8")
    (output_root / "lineage_borderline_pairs.json").write_text(json.dumps(review_pairs, indent=2), encoding="utf-8")
    return split_report, quarantined


def main():
    parser = argparse.ArgumentParser(description="Build the scene-grouped clean NeighborLens dataset")
    parser.add_argument("--source", type=Path, default=DEFAULT_SOURCE)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--seed", type=int, default=DEFAULT_SEED)
    parser.add_argument("--train", type=float, default=DEFAULT_FRACTIONS["train"])
    parser.add_argument("--valid", type=float, default=DEFAULT_FRACTIONS["valid"])
    parser.add_argument("--test", type=float, default=DEFAULT_FRACTIONS["test"])
    parser.add_argument("--workers", type=int, default=None)
    args = parser.parse_args()
    fractions = {"train": args.train, "valid": args.valid, "test": args.test}
    if abs(sum(fractions.values()) - 1.0) > 1e-6:
        raise SystemExit("Split fractions must sum to 1.0")
    report, quarantined = build(args.source, args.output, fractions, args.seed, args.workers)
    print(json.dumps(report, indent=2))
    print(f"Quarantined for manual review: {len(quarantined)}")


if __name__ == "__main__":
    main()
