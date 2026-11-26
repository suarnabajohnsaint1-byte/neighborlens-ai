"""Build data/processed/neighborlens (images, labels, data.yaml) from audited raw images and verified labels.

Inputs:
  data/processed/audit/raw_manifest.csv      from audit_raw_images.py
  data/processed/audit/scope_review.csv      reviewer decisions (out_of_scope rows are excluded)
  data/processed/annotations/<folder>/...    human-verified YOLO labels, one .txt per raw image path
  data/processed/class_mapping.yaml

Images are copied, never moved. Splits are made at group level so exact duplicates, near
duplicates and reviewer-declared scene groups always land in the same split.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import random
import shutil
import sys
from collections import Counter, defaultdict
from pathlib import Path

import yaml
from PIL import Image, ImageOps

sys.path.insert(0, str(Path(__file__).resolve().parent))

from raw_images import (  # noqa: E402
    CLASS_MAPPING_PATH,
    NEW_DATASET_ROOT,
    RAW_ROOT,
    YOLO_READY_SUFFIXES,
    ClassMapping,
    hamming,
    load_class_mapping,
    sha256_file,
)

SPLITS = ("train", "val", "test")
COORD_TOLERANCE = 1e-6


class LabelError(ValueError):
    pass


def parse_label_file(path: Path, class_ids: set[int]) -> list[tuple[int, float, float, float, float]]:
    boxes = []
    for number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1):
        parts = line.split()
        if not parts:
            continue
        if len(parts) != 5:
            raise LabelError(f"{path}:{number}: expected 5 values, found {len(parts)}")
        try:
            class_id = int(parts[0])
            cx, cy, w, h = (float(p) for p in parts[1:])
        except ValueError as error:
            raise LabelError(f"{path}:{number}: {error}") from error
        if class_id not in class_ids:
            raise LabelError(f"{path}:{number}: class id {class_id} not in class mapping")
        if w <= 0 or h <= 0:
            raise LabelError(f"{path}:{number}: non-positive box size")
        if (cx - w / 2 < -COORD_TOLERANCE or cy - h / 2 < -COORD_TOLERANCE
                or cx + w / 2 > 1 + COORD_TOLERANCE or cy + h / 2 > 1 + COORD_TOLERANCE):
            raise LabelError(f"{path}:{number}: box extends outside the image")
        boxes.append((class_id, cx, cy, w, h))
    return boxes


class UnionFind:
    def __init__(self, items):
        self.parent = {item: item for item in items}

    def find(self, item):
        while self.parent[item] != item:
            self.parent[item] = self.parent[self.parent[item]]
            item = self.parent[item]
        return item

    def union(self, a, b):
        root_a, root_b = self.find(a), self.find(b)
        if root_a != root_b:
            self.parent[max(root_a, root_b)] = min(root_a, root_b)


def read_csv(path: Path) -> list[dict]:
    if not path.exists():
        return []
    with path.open(encoding="utf-8", newline="") as handle:
        return list(csv.DictReader(handle))


def collect_items(args, mapping: ClassMapping) -> tuple[list[dict], dict[str, list]]:
    manifest = read_csv(args.audit_dir / "raw_manifest.csv")
    if not manifest:
        raise SystemExit(f"{args.audit_dir / 'raw_manifest.csv'} not found or empty. Run audit_raw_images.py first.")
    scope = {row["relative_path"]: row["decision"].strip().lower() for row in read_csv(args.audit_dir / "scope_review.csv")}
    class_ids = set(mapping.names)

    excluded: dict[str, list] = defaultdict(list)
    items, label_errors = [], []
    for row in manifest:
        relative = row["relative_path"]
        folder = row["folder"]
        if row["readable"] != "True":
            excluded["unreadable"].append(relative)
            continue
        if scope.get(relative) == "out_of_scope":
            excluded["out_of_scope"].append(relative)
            continue
        label_path = args.annotations / Path(relative).with_suffix(".txt")
        if not label_path.exists():
            excluded["not_annotated"].append(relative)
            continue
        try:
            boxes = parse_label_file(label_path, class_ids)
        except LabelError as error:
            label_errors.append(str(error))
            continue
        items.append({
            "relative_path": relative,
            "folder": folder,
            "source_class": mapping.folder_to_class[folder],
            "sha256": row["sha256"],
            "dhash": int(row["dhash"], 16),
            "label_path": label_path,
            "boxes": boxes,
            "scope_decision": scope.get(relative, "pending"),
        })

    if label_errors:
        raise SystemExit("Invalid label files; fix them before building:\n" + "\n".join(label_errors))
    label_owners = defaultdict(list)
    for item in items:
        label_owners[item["label_path"]].append(item["relative_path"])
    shared = [paths for paths in label_owners.values() if len(paths) > 1]
    if shared:
        raise SystemExit("Images share one label path because their names differ only by extension: "
                         + "; ".join(", ".join(paths) for paths in shared))
    return items, excluded


def drop_exact_duplicates(items: list[dict], excluded: dict[str, list]) -> list[dict]:
    kept, seen = [], {}
    for item in sorted(items, key=lambda i: i["relative_path"]):
        if item["sha256"] in seen:
            excluded["exact_duplicate"].append({"relative_path": item["relative_path"], "kept": seen[item["sha256"]]})
            continue
        seen[item["sha256"]] = item["relative_path"]
        kept.append(item)
    return kept


def group_items(items: list[dict], threshold: int, scene_groups: dict[str, str]) -> list[list[dict]]:
    uf = UnionFind(range(len(items)))
    for i in range(len(items)):
        for j in range(i + 1, len(items)):
            if hamming(items[i]["dhash"], items[j]["dhash"]) <= threshold:
                uf.union(i, j)
    by_scene = defaultdict(list)
    for index, item in enumerate(items):
        if scene := scene_groups.get(item["relative_path"]):
            by_scene[scene].append(index)
    for members in by_scene.values():
        for other in members[1:]:
            uf.union(members[0], other)
    groups = defaultdict(list)
    for index, item in enumerate(items):
        groups[uf.find(index)].append(item)
    return [sorted(g, key=lambda i: i["relative_path"]) for _, g in sorted(groups.items())]


def assign_splits(groups: list[list[dict]], ratios: tuple[float, float, float], seed: int) -> dict[str, list[list[dict]]]:
    strata = defaultdict(list)
    for group in groups:
        counts = Counter(item["source_class"] for item in group)
        stratum = sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))[0][0]
        strata[stratum].append(group)

    rng = random.Random(seed)
    assignment = {split: [] for split in SPLITS}
    for stratum in sorted(strata):
        stratum_groups = strata[stratum]
        rng.shuffle(stratum_groups)
        total = sum(len(g) for g in stratum_groups)
        targets = {split: total * ratio for split, ratio in zip(SPLITS, ratios)}
        filled = {split: 0 for split in SPLITS}
        remaining = list(stratum_groups)
        # Seed val/test first so every class is represented in held-out data when it has enough groups.
        if len(remaining) >= 3:
            for split in ("test", "val"):
                group = remaining.pop()
                assignment[split].append(group)
                filled[split] += len(group)
        for group in remaining:
            split = max(SPLITS, key=lambda s: (targets[s] - filled[s], -SPLITS.index(s)))
            assignment[split].append(group)
            filled[split] += len(group)
    return assignment


def output_name(item: dict) -> str:
    stem = Path(item["relative_path"]).with_suffix("").as_posix().replace("/", "__")
    suffix = Path(item["relative_path"]).suffix.lower()
    return stem + (suffix if suffix in YOLO_READY_SUFFIXES else ".png")


def copy_image(source: Path, target: Path) -> None:
    if source.suffix.lower() in YOLO_READY_SUFFIXES:
        shutil.copy2(source, target)
        return
    # Labels are drawn on the EXIF-oriented view, so bake the orientation into the converted copy.
    with Image.open(source) as image:
        ImageOps.exif_transpose(image).convert("RGB").save(target, format="PNG")


def label_digest(boxes) -> str:
    text = "\n".join(f"{c} {x:.6f} {y:.6f} {w:.6f} {h:.6f}" for c, x, y, w, h in boxes)
    return hashlib.sha256(text.encode()).hexdigest()


def check_test_freeze(freeze_path: Path, test_items: list[dict], refreeze: bool) -> None:
    current = sorted((output_name(i), i["relative_path"], i["sha256"], label_digest(i["boxes"])) for i in test_items)
    if freeze_path.exists() and not refreeze:
        frozen = sorted(tuple(entry) for entry in json.loads(freeze_path.read_text(encoding="utf-8"))["items"])
        if frozen != current:
            raise SystemExit(
                f"Test split differs from the frozen test set in {freeze_path}. The test set must not change "
                "after it is frozen. Use --refreeze-test only if no model has been evaluated on it yet."
            )
    freeze_path.write_text(json.dumps({"items": current}, indent=1), encoding="utf-8")


def split_statistics(assignment, mapping: ClassMapping) -> dict:
    stats = {}
    for split in SPLITS:
        items = [item for group in assignment[split] for item in group]
        instances = Counter(mapping.names[c] for item in items for c, *_ in item["boxes"])
        images_with_class = Counter(
            mapping.names[c] for item in items for c in {box[0] for box in item["boxes"]}
        )
        stats[split] = {
            "images": len(items),
            "groups": len(assignment[split]),
            "background_images": sum(not item["boxes"] for item in items),
            "instances": {name: instances.get(name, 0) for name in mapping.names.values()},
            "images_containing": {name: images_with_class.get(name, 0) for name in mapping.names.values()},
            "images_by_source_folder": dict(Counter(item["folder"] for item in items)),
        }
    return stats


def write_dataset(args, mapping: ClassMapping, assignment) -> None:
    out = args.output
    for kind in ("images", "labels"):
        for split in SPLITS:
            target = out / kind / split
            if target.exists():
                shutil.rmtree(target)
            target.mkdir(parents=True)

    for split in SPLITS:
        for group in assignment[split]:
            for item in group:
                source = args.raw_root / item["relative_path"]
                if sha256_file(source) != item["sha256"]:
                    raise SystemExit(f"{source} changed since the audit. Re-run audit_raw_images.py --verify.")
                name = output_name(item)
                copy_image(source, out / "images" / split / name)
                (out / "labels" / split / name).with_suffix(".txt").write_text(
                    "".join(f"{c} {x:.6f} {y:.6f} {w:.6f} {h:.6f}\n" for c, x, y, w, h in item["boxes"]),
                    encoding="utf-8",
                )

    data = {
        "train": "images/train",
        "val": "images/val",
        "test": "images/test",
        "nc": len(mapping.names),
        "names": mapping.names,
    }
    (out / "data.yaml").write_text(
        f"# Generated by ai/preprocessing/build_dataset.py. Class mapping status: {mapping.status}\n"
        + yaml.safe_dump(data, sort_keys=False),
        encoding="utf-8",
    )


def render_summary(summary: dict) -> str:
    names = summary["class_names"]
    lines = [
        "# Split Summary",
        "",
        f"Seed: {summary['seed']}; target ratios train/val/test: {summary['target_ratios']}",
        f"Class mapping status: `{summary['class_mapping_status']}`",
        "",
        "| Split | Images | Groups | Background | " + " | ".join(f"{n} instances" for n in names) + " |",
        "| --- | ---: | ---: | ---: | " + " | ".join("---:" for _ in names) + " |",
    ]
    for split, s in summary["splits"].items():
        lines.append(
            f"| {split} | {s['images']} | {s['groups']} | {s['background_images']} | "
            + " | ".join(str(s["instances"][n]) for n in names) + " |"
        )
    lines += ["", "Excluded images:", ""]
    for reason, entries in summary["excluded"].items():
        lines.append(f"- {reason}: {len(entries)}")
    lines += [
        "",
        f"Images still pending scope review: {summary['scope_pending']}",
        "Augmentation is applied online during training to the train split only; no augmented files are stored.",
        "",
    ]
    return "\n".join(lines)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--raw-root", type=Path, default=RAW_ROOT)
    parser.add_argument("--audit-dir", type=Path, default=NEW_DATASET_ROOT / "audit")
    parser.add_argument("--annotations", type=Path, default=NEW_DATASET_ROOT / "annotations")
    parser.add_argument("--class-mapping", type=Path, default=CLASS_MAPPING_PATH)
    parser.add_argument("--scene-groups", type=Path, default=NEW_DATASET_ROOT / "scene_groups.csv",
                        help="optional CSV with relative_path,group columns for images of the same scene")
    parser.add_argument("--output", type=Path, default=NEW_DATASET_ROOT / "neighborlens")
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--ratios", type=float, nargs=3, default=(0.75, 0.125, 0.125), metavar=("TRAIN", "VAL", "TEST"))
    parser.add_argument("--near-duplicate-threshold", type=int, default=6)
    parser.add_argument("--allow-unreviewed-mapping", action="store_true",
                        help="build even though class_mapping.yaml is not approved; the status is recorded")
    parser.add_argument("--refreeze-test", action="store_true")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if abs(sum(args.ratios) - 1.0) > 1e-6:
        raise SystemExit("Split ratios must sum to 1.0")
    if args.output.resolve().is_relative_to(args.raw_root.resolve()):
        raise SystemExit("Output directory must be outside the raw image folders")

    mapping = load_class_mapping(args.class_mapping)
    if not mapping.approved and not args.allow_unreviewed_mapping:
        raise SystemExit(
            f"CLASS MAPPING REQUIRES RESEARCH-SCOPE REVIEW (status: {mapping.status}). "
            "See docs/yolo/CLASS_MAPPING_REVIEW.md, or pass --allow-unreviewed-mapping for a provisional build."
        )

    items, excluded = collect_items(args, mapping)
    items = drop_exact_duplicates(items, excluded)
    if not items:
        raise SystemExit("No annotated in-scope images available; nothing to build.")

    scene_groups = {row["relative_path"]: row["group"] for row in read_csv(args.scene_groups)}
    groups = group_items(items, args.near_duplicate_threshold, scene_groups)
    assignment = assign_splits(groups, tuple(args.ratios), args.seed)

    args.output.mkdir(parents=True, exist_ok=True)
    test_items = [item for group in assignment["test"] for item in group]
    check_test_freeze(args.output / "test_freeze.json", test_items, args.refreeze_test)
    write_dataset(args, mapping, assignment)

    summary = {
        "seed": args.seed,
        "target_ratios": list(args.ratios),
        "near_duplicate_threshold": args.near_duplicate_threshold,
        "class_mapping_status": mapping.status,
        "class_names": list(mapping.names.values()),
        "splits": split_statistics(assignment, mapping),
        "excluded": {reason: entries for reason, entries in sorted(excluded.items())},
        "scope_pending": sum(item["scope_decision"] == "pending" for item in items),
        "labels_without_source_folder_class": sorted(
            item["relative_path"] for item in items
            if mapping.class_id(item["source_class"]) not in {box[0] for box in item["boxes"]}
        ),
        "assignment": {
            split: [[output_name(item) for item in group] for group in assignment[split]] for split in SPLITS
        },
    }
    (args.output / "split_manifest.json").write_text(json.dumps(summary, indent=2), encoding="utf-8")
    (args.output / "SPLIT_SUMMARY.md").write_text(render_summary(summary), encoding="utf-8")

    for split, stats in summary["splits"].items():
        print(f"{split}: {stats['images']} images, instances {stats['instances']}")
    for reason, entries in summary["excluded"].items():
        print(f"excluded ({reason}): {len(entries)}")
    print(f"Dataset written to {args.output}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
