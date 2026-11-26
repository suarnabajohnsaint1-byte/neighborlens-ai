"""Assemble an isolated hard-negative experiment from a QA-filtered YOLO export."""

import argparse
from collections import Counter
from hashlib import sha256
import json
from pathlib import Path
import random
from shutil import copyfile

import yaml

from ai.inference.damage_contract import CANONICAL_CLASS_NAMES


def digest(path):
    return sha256(path.read_bytes()).hexdigest()


def scene_name(path):
    return path.stem.casefold().split(".rf.", 1)[0]


def labeled_subset(images, count_per_class, rng, excluded_scenes, excluded_hashes):
    images = sorted(images)
    rng.shuffle(images)
    counts = Counter()
    for image in images:
        scene = scene_name(image)
        if scene in excluded_scenes:
            continue
        label = image.parent.parent / "labels" / f"{image.stem}.txt"
        classes = {int(line.split()[0]) for line in label.read_text().splitlines() if line.strip()}
        if not classes or all(counts[class_id] >= count_per_class for class_id in classes):
            continue
        checksum = digest(image)
        if checksum in excluded_hashes:
            continue
        excluded_scenes.add(scene)
        excluded_hashes.add(checksum)
        counts.update(classes)
        yield image, label, checksum


def build(export, manifest, output, per_class, val_per_class):
    suffixes = {".jpg", ".jpeg", ".png", ".webp"}
    train = [Path(line) for line in (export / "train_images_qa_filtered.txt").read_text().splitlines() if line.strip()]
    validation = [p for p in (export / "valid/images").iterdir() if p.suffix.lower() in suffixes]
    test = sorted(p for p in (export / "test/images").iterdir() if p.suffix.lower() in suffixes)
    val_scenes = {scene_name(p) for p in validation}
    test_scenes = {scene_name(p) for p in test}
    test_hashes = {digest(p) for p in test}
    val_hashes = {digest(p) for p in validation}
    source_manifest = json.loads(manifest.read_text(encoding="utf-8"))
    rng = random.Random(42)
    if output.exists():
        raise FileExistsError(output)
    images_manifest = []
    used = set()
    for split, files, count, excluded_scenes, excluded_hashes in (
        ("train", train, per_class, test_scenes | val_scenes, test_hashes | val_hashes),
        ("val", validation, val_per_class, test_scenes.copy(), test_hashes.copy()),
    ):
        image_dir, label_dir = output / "images" / split, output / "labels" / split
        image_dir.mkdir(parents=True)
        label_dir.mkdir(parents=True)
        positive = list(labeled_subset(files, count, rng, excluded_scenes, excluded_hashes))
        if set(CANONICAL_CLASS_NAMES) != {int(line.split()[0]) for _, label, _ in positive for line in label.read_text().splitlines() if line.strip()}:
            raise ValueError(f"Missing canonical classes in {split} positives")
        for image, label, checksum in positive:
            used.add(checksum)
            name = f"positive_{checksum[:16]}"
            copyfile(image, image_dir / f"{name}{image.suffix.lower()}")
            copyfile(label, label_dir / f"{name}.txt")
            images_manifest.append({"split": split, "source": str(image), "sha256": checksum, "boxes": "canonical"})
        for entry in source_manifest[split]:
            source = (manifest.parent / entry["path"]).resolve(strict=True)
            checksum = digest(source)
            if checksum in used or checksum in test_hashes or checksum in val_hashes:
                raise ValueError(f"Duplicate or held-out image in negative manifest: {source}")
            used.add(checksum)
            name = f"background_{checksum[:16]}"
            copyfile(source, image_dir / f"{name}{source.suffix.lower()}")
            (label_dir / f"{name}.txt").touch()
            images_manifest.append({"split": split, "source": str(source), "sha256": checksum, "boxes": 0, "review": entry["review"]})

    (output / "data.yaml").write_text(yaml.safe_dump({
        "path": output.as_posix(), "train": "images/train", "val": "images/val",
        "nc": len(CANONICAL_CLASS_NAMES), "names": CANONICAL_CLASS_NAMES,
    }), encoding="utf-8")
    (output / "manifest.json").write_text(json.dumps(images_manifest, indent=2) + "\n", encoding="utf-8")
    print(Counter((item["split"], item["boxes"]) for item in images_manifest))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--export", type=Path, required=True)
    parser.add_argument("--negatives", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--train-per-class", type=int, default=128)
    parser.add_argument("--val-per-class", type=int, default=24)
    args = parser.parse_args()
    build(args.export, args.negatives, args.out.resolve(), args.train_per_class, args.val_per_class)


if __name__ == "__main__":
    main()
