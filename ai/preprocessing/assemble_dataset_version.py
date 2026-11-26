import argparse
import json
import shutil
from collections import defaultdict
from pathlib import Path

import yaml

from ai.preprocessing.annotation_quality import CANONICAL_NAMES
from ai.preprocessing.apply_annotation_review import split_report
from ai.preprocessing.build_neighborlens_v3_clean import stratified_group_split
from ai.preprocessing.import_original_candidates import ACCEPTED
from ai.preprocessing.scene_lineage import SPLITS

PROJECT_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_BASE = PROJECT_ROOT / "data" / "datasets" / "neighborlens_paper_aligned_v3_1_remediated"
DEFAULT_IMPORT = PROJECT_ROOT / "data" / "staging" / "original_candidates" / "reports" / "import_manifest.json"
DEFAULT_STAGING = PROJECT_ROOT / "data" / "staging" / "original_candidates"
DEFAULT_FRACTIONS = {"train": 0.6, "valid": 0.2, "test": 0.2}


def assemble(base, import_manifest, staging, output, fractions, seed, max_background_fraction=0.10):
    base, staging, output = Path(base), Path(staging), Path(output)
    if output.exists():
        raise SystemExit(f"Refusing to overwrite existing dataset: {output}")
    base_manifest = json.loads((base / "manifest.json").read_text(encoding="utf-8"))
    imported = json.loads(Path(import_manifest).read_text(encoding="utf-8"))
    accepted = [image for image in imported["images"] if image["status"] == ACCEPTED]

    base_scenes = {entry["scene_id"] for entry in base_manifest["images"]}
    clashes = sorted({image["scene_id"] for image in accepted} & base_scenes)
    if clashes:
        raise SystemExit(f"Imported scenes already active in base dataset: {clashes}")

    scenes = defaultdict(list)
    frozen = {}
    for entry in base_manifest["images"]:
        if entry.get("role") != "background":
            scenes[entry["scene_id"]].append({"classes": entry["classes"]})
            frozen[entry["scene_id"]] = entry["split"]
    new_positive = defaultdict(list)
    new_background = defaultdict(list)
    for image in accepted:
        target = new_background if image["role"] == "background" else new_positive
        target[image["scene_id"]].append(image)
    for scene_id, images in new_positive.items():
        scenes[scene_id] = [{"classes": image["class_ids"]} for image in images]

    assignment = stratified_group_split(scenes, fractions, seed, frozen=frozen)

    for split in SPLITS:
        (output / split / "images").mkdir(parents=True, exist_ok=True)
        (output / split / "labels").mkdir(parents=True, exist_ok=True)

    entries = []
    for entry in base_manifest["images"]:
        stem = Path(entry["file"]).stem
        shutil.copy2(base / entry["split"] / "images" / entry["file"], output / entry["split"] / "images" / entry["file"])
        shutil.copy2(base / entry["split"] / "labels" / f"{stem}.txt", output / entry["split"] / "labels" / f"{stem}.txt")
        entries.append(entry)

    def add(scene_id, images, split, role):
        for index, image in enumerate(sorted(images, key=lambda item: item["file"])):
            source = staging / "images" / image["file"]
            name = f"{scene_id}_{chr(ord('a') + index)}{source.suffix.lower()}"
            shutil.copy2(source, output / split / "images" / name)
            shutil.copy2(staging / "labels" / f"{source.stem}.txt", output / split / "labels" / f"{Path(name).stem}.txt")
            entries.append(
                {
                    "split": split,
                    "file": name,
                    "scene_id": scene_id,
                    "source_lineage_group": scene_id,
                    "source_file": image["file"],
                    "source_split": "staging",
                    "sha256": image["sha256"],
                    "classes": image["class_ids"],
                    "boxes": image["boxes"],
                    "origin": "original",
                    "role": role,
                    "provenance": image["provenance"],
                }
            )

    for scene_id, images in sorted(new_positive.items()):
        add(scene_id, images, assignment[scene_id], "positive")

    train_images = sum(1 for entry in entries if entry["split"] == "train")
    existing_backgrounds = sum(1 for entry in entries if entry.get("role") == "background")
    allowed = int(max_background_fraction * train_images / max(1e-9, 1 - max_background_fraction)) - existing_backgrounds
    skipped_backgrounds = []
    for scene_id, images in sorted(new_background.items()):
        if allowed <= 0:
            skipped_backgrounds.append(scene_id)
            continue
        add(scene_id, images, "train", "background")
        allowed -= 1

    (output / "data.yaml").write_text(
        yaml.safe_dump(
            {"train": "train/images", "val": "valid/images", "test": "test/images", "nc": len(CANONICAL_NAMES), "names": dict(CANONICAL_NAMES)},
            sort_keys=False,
        ),
        encoding="utf-8",
    )
    (output / "manifest.json").write_text(
        json.dumps({"source": base.name, "seed": seed, "frozen_base": base.name, "images": entries}, indent=2), encoding="utf-8"
    )
    review_status_path = base / "review_status.json"
    review_status = json.loads(review_status_path.read_text(encoding="utf-8")) if review_status_path.is_file() else {}
    review_status["assembled_from_import"] = str(import_manifest)
    review_status["background_scenes_skipped_by_cap"] = skipped_backgrounds
    (output / "review_status.json").write_text(json.dumps(review_status, indent=2), encoding="utf-8")
    report = {"seed": seed, "fractions": fractions, "frozen_base": base.name, "splits": split_report(output, entries)}
    (output / "split_report.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
    return report


def main():
    parser = argparse.ArgumentParser(description="Assemble a new dataset version: frozen base splits plus scene-level split of accepted imports")
    parser.add_argument("--base", type=Path, default=DEFAULT_BASE)
    parser.add_argument("--import-manifest", type=Path, default=DEFAULT_IMPORT)
    parser.add_argument("--staging", type=Path, default=DEFAULT_STAGING)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--train", type=float, default=DEFAULT_FRACTIONS["train"])
    parser.add_argument("--valid", type=float, default=DEFAULT_FRACTIONS["valid"])
    parser.add_argument("--test", type=float, default=DEFAULT_FRACTIONS["test"])
    parser.add_argument("--max-background-fraction", type=float, default=0.10)
    args = parser.parse_args()
    fractions = {"train": args.train, "valid": args.valid, "test": args.test}
    if abs(sum(fractions.values()) - 1.0) > 1e-6:
        raise SystemExit("Split fractions must sum to 1.0")
    report = assemble(args.base, args.import_manifest, args.staging, args.output, fractions, args.seed, args.max_background_fraction)
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
