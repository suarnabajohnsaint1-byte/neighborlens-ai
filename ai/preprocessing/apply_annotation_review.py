import argparse
import json
import shutil
from collections import Counter, defaultdict
from pathlib import Path

import yaml

from ai.preprocessing.annotation_quality import CANONICAL_NAMES, CRITICAL, audit_label_boxes, parse_label_file
from ai.preprocessing.scene_lineage import SPLITS

PROJECT_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_BASE = PROJECT_ROOT / "data" / "datasets" / "neighborlens_paper_aligned_v3_clean"
DEFAULT_OUTPUT = PROJECT_ROOT / "data" / "datasets" / "neighborlens_paper_aligned_v3_1_remediated"
DEFAULT_REVIEW_DIR = PROJECT_ROOT / "data" / "review" / "task1_5"
LEGACY_PROVENANCE = {
    "source_type": "roboflow_export",
    "dataset": "kenjan/neighborlens version 2 (neighborlens_paper_aligned_v2)",
    "license": "Private Roboflow workspace export; includes watermarked stock photographs",
}
EXCLUDING_DECISIONS = {"QUARANTINE_PENDING_HUMAN_REVIEW", "EXCLUDE"}
OPEN_DECISIONS = {"MANUAL_REVIEW_REQUIRED", "QUARANTINE_PENDING_HUMAN_REVIEW"}


def load_json(path):
    return json.loads(Path(path).read_text(encoding="utf-8"))


def scene_of(file_name):
    return Path(file_name).stem.rsplit("_", 1)[0]


def load_correction(corrections_dir, split, stem):
    if corrections_dir is None:
        return None
    path = Path(corrections_dir) / split / f"{stem}.txt"
    if not path.is_file():
        return None
    boxes, issues = parse_label_file(path)
    issues += [item for item in audit_label_boxes(boxes) if item["severity"] == CRITICAL]
    if issues:
        raise SystemExit(f"Correction {path} is invalid: {[item['kind'] for item in issues]}")
    if not boxes:
        raise SystemExit(f"Correction {path} is empty; remove the image through the review manifest instead.")
    return boxes


def write_label(path, boxes):
    lines = [f"{item['class_id']} " + " ".join(f"{value:.6f}" for value in item["box"]) for item in boxes]
    Path(path).write_text("\n".join(lines) + ("\n" if lines else ""), encoding="utf-8")


def select_backgrounds(quarantine_review, train_positive_images, max_fraction):
    approved = [
        item for item in quarantine_review["images"]
        if item["review_status"] == "TRUE_NEGATIVE" and item.get("approved_for_train_background") is True
    ]
    by_scene = {}
    for item in sorted(approved, key=lambda entry: entry["image_path"]):
        by_scene.setdefault(item["scene_id"], item)
    cap = int(max_fraction * train_positive_images / max(1e-9, 1 - max_fraction))
    return list(by_scene.values())[:cap], len(by_scene)


def apply_review(base, output, review_dir, corrections_dir=None, max_background_fraction=0.10):
    base, output, review_dir = Path(base), Path(output), Path(review_dir)
    if output.exists():
        raise SystemExit(f"Refusing to overwrite existing dataset: {output}")
    manifest = load_json(base / "manifest.json")
    annotation_review = load_json(review_dir / "annotation_review.json")
    quarantine_review = load_json(review_dir / "quarantine_review.json")

    excluded_scenes = set()
    open_items = []
    for item in annotation_review["items"]:
        if item["decision"] in EXCLUDING_DECISIONS:
            excluded_scenes.update(scene_of(file) for file in item["files"])
        if item["decision"] in OPEN_DECISIONS:
            open_items.append(item)

    for split in SPLITS:
        (output / split / "images").mkdir(parents=True, exist_ok=True)
        (output / split / "labels").mkdir(parents=True, exist_ok=True)

    images = []
    excluded = []
    corrected = []
    for entry in manifest["images"]:
        split, file = entry["split"], entry["file"]
        stem = Path(file).stem
        if entry["scene_id"] in excluded_scenes:
            excluded.append({"split": split, "file": file, "scene_id": entry["scene_id"], "reason": "annotation_review_quarantine"})
            continue
        shutil.copy2(base / split / "images" / file, output / split / "images" / file)
        boxes = load_correction(corrections_dir, split, stem)
        if boxes is None:
            shutil.copy2(base / split / "labels" / f"{stem}.txt", output / split / "labels" / f"{stem}.txt")
            boxes, _ = parse_label_file(output / split / "labels" / f"{stem}.txt")
        else:
            write_label(output / split / "labels" / f"{stem}.txt", boxes)
            corrected.append(f"{split}/{file}")
        updated = dict(entry)
        updated["classes"] = sorted({item["class_id"] for item in boxes})
        updated["boxes"] = len(boxes)
        updated["role"] = "positive"
        updated.setdefault("provenance", LEGACY_PROVENANCE)
        images.append(updated)

    train_positive = sum(1 for entry in images if entry["split"] == "train")
    backgrounds, approved_count = select_backgrounds(quarantine_review, train_positive, max_background_fraction)
    for item in backgrounds:
        source = PROJECT_ROOT / item["image_path"]
        name = f"{item['scene_id']}_bg{source.suffix.lower()}"
        shutil.copy2(source, output / "train" / "images" / name)
        (output / "train" / "labels" / f"{Path(name).stem}.txt").write_text("", encoding="utf-8")
        images.append(
            {
                "split": "train",
                "file": name,
                "scene_id": item["scene_id"],
                "source_lineage_group": item["scene_id"],
                "source_file": Path(item["image_path"]).name,
                "source_split": item["source"].split("/")[0],
                "classes": [],
                "boxes": 0,
                "origin": "original",
                "role": "background",
                "provenance": LEGACY_PROVENANCE,
            }
        )

    active_files = {f"{entry['split']}/{entry['file']}" for entry in images}
    unresolved = []
    for item in open_items:
        affected = [file for file in item["files"] if file in active_files and file not in corrected]
        if affected:
            unresolved.append({"id": item["id"], "issue": item["issue"], "blocking": item["blocking"], "files": affected})

    (output / "data.yaml").write_text(
        yaml.safe_dump(
            {"train": "train/images", "val": "valid/images", "test": "test/images", "nc": len(CANONICAL_NAMES), "names": dict(CANONICAL_NAMES)},
            sort_keys=False,
        ),
        encoding="utf-8",
    )
    (output / "manifest.json").write_text(
        json.dumps({"source": base.name, "seed": manifest.get("seed"), "images": images}, indent=2), encoding="utf-8"
    )
    review_status = {
        "base": base.name,
        "excluded_scenes": sorted(excluded_scenes),
        "excluded_images": excluded,
        "corrected_labels": corrected,
        "backgrounds_added": len(backgrounds),
        "backgrounds_approved": approved_count,
        "max_background_fraction": max_background_fraction,
        "unresolved_items": unresolved,
    }
    (output / "review_status.json").write_text(json.dumps(review_status, indent=2), encoding="utf-8")
    (output / "split_report.json").write_text(json.dumps(split_report(output, images), indent=2), encoding="utf-8")
    return review_status


def split_report(output, images):
    report = {}
    for split in SPLITS:
        entries = [entry for entry in images if entry["split"] == split]
        class_scenes = defaultdict(set)
        class_boxes = Counter()
        for entry in entries:
            for line in (output / split / "labels" / f"{Path(entry['file']).stem}.txt").read_text(encoding="utf-8").splitlines():
                if line.strip():
                    class_boxes[int(line.split()[0])] += 1
            for class_id in entry["classes"]:
                class_scenes[class_id].add(entry["scene_id"])
        report[split] = {
            "images": len(entries),
            "background_images": sum(1 for entry in entries if entry.get("role") == "background"),
            "independent_scenes": len({entry["scene_id"] for entry in entries}),
            "boxes": sum(class_boxes.values()),
            "per_class": {
                name: {"scenes": len(class_scenes[class_id]), "boxes": class_boxes[class_id]}
                for class_id, name in CANONICAL_NAMES.items()
            },
        }
    return report


def main():
    parser = argparse.ArgumentParser(description="Apply human annotation review decisions to a frozen dataset version")
    parser.add_argument("--base", type=Path, default=DEFAULT_BASE)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--review-dir", type=Path, default=DEFAULT_REVIEW_DIR)
    parser.add_argument("--corrections-dir", type=Path, default=None)
    parser.add_argument("--max-background-fraction", type=float, default=0.10)
    args = parser.parse_args()
    status = apply_review(args.base, args.output, args.review_dir, args.corrections_dir, args.max_background_fraction)
    print(json.dumps({key: value for key, value in status.items() if key != "excluded_images"}, indent=2))


if __name__ == "__main__":
    main()
