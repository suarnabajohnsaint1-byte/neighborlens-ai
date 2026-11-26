import argparse
import hashlib
from collections import Counter
from pathlib import Path

import yaml


SPLITS = ("train", "valid", "test")
IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp"}


def parse_args():
    parser = argparse.ArgumentParser(
        description="Validate a YOLO object detection dataset."
    )
    parser.add_argument(
        "dataset",
        type=Path,
        help="Path to the YOLO dataset root.",
    )
    return parser.parse_args()


def load_dataset_config(dataset_root: Path):
    config_path = dataset_root / "data.yaml"

    if not config_path.is_file():
        raise ValueError(f"Missing data.yaml: {config_path}")

    with config_path.open("r", encoding="utf-8") as file:
        config = yaml.safe_load(file)

    if not isinstance(config, dict):
        raise ValueError("data.yaml must contain a YAML mapping.")

    names = config.get("names")
    nc = config.get("nc")

    if isinstance(names, list):
        class_names = {
            class_id: name
            for class_id, name in enumerate(names)
        }
    elif isinstance(names, dict):
        class_names = {
            int(class_id): name
            for class_id, name in names.items()
        }
    else:
        raise ValueError("data.yaml must define 'names'.")

    if nc is not None and nc != len(class_names):
        raise ValueError(
            f"data.yaml nc={nc} does not match "
            f"{len(class_names)} class names."
        )

    return class_names


def compute_sha256(file_path: Path):
    digest = hashlib.sha256()

    with file_path.open("rb") as file:
        for chunk in iter(lambda: file.read(65536), b""):
            digest.update(chunk)

    return digest.hexdigest()


def get_image_files(images_dir: Path):
    return sorted(
        path
        for path in images_dir.iterdir()
        if path.is_file()
        and path.suffix.lower() in IMAGE_EXTENSIONS
    )


def validate_dataset(dataset_root: Path) -> int:
    class_names = load_dataset_config(dataset_root)

    errors = []
    class_counts = Counter()
    split_summaries = {}
    image_hashes = {}

    total_images = 0
    total_labels = 0
    total_boxes = 0

    exact_duplicates = []
    cross_split_leakage = []

    print("=== YOLO DATASET VALIDATION ===")
    print(f"Dataset: {dataset_root.resolve()}")
    print()

    print("Classes:")
    for class_id, class_name in sorted(class_names.items()):
        print(f"  {class_id}: {class_name}")
    print()

    for split in SPLITS:
        images_dir = dataset_root / split / "images"
        labels_dir = dataset_root / split / "labels"

        if not images_dir.is_dir():
            errors.append(f"Missing directory: {images_dir}")
            continue

        if not labels_dir.is_dir():
            errors.append(f"Missing directory: {labels_dir}")
            continue

        image_files = get_image_files(images_dir)
        label_files = sorted(labels_dir.glob("*.txt"))

        image_stems = {path.stem for path in image_files}
        label_stems = {path.stem for path in label_files}

        missing_labels = sorted(image_stems - label_stems)
        orphan_labels = sorted(label_stems - image_stems)

        for stem in missing_labels:
            errors.append(
                f"{split}: image without label: {stem}"
            )

        for stem in orphan_labels:
            errors.append(
                f"{split}: label without image: {stem}"
            )

        split_class_counts = Counter()
        split_boxes = 0

        for label_file in label_files:
            lines = label_file.read_text(
                encoding="utf-8"
            ).splitlines()

            for line_number, line in enumerate(lines, start=1):
                if not line.strip():
                    continue

                parts = line.split()

                if len(parts) != 5:
                    errors.append(
                        f"{label_file}:{line_number} "
                        "invalid column count"
                    )
                    continue

                try:
                    class_id = int(parts[0])
                    x, y, width, height = map(
                        float,
                        parts[1:],
                    )
                except ValueError:
                    errors.append(
                        f"{label_file}:{line_number} "
                        "invalid numeric value"
                    )
                    continue

                if class_id not in class_names:
                    errors.append(
                        f"{label_file}:{line_number} "
                        f"invalid class ID {class_id}"
                    )
                    continue

                if not all(
                    0 <= value <= 1
                    for value in (x, y, width, height)
                ):
                    errors.append(
                        f"{label_file}:{line_number} "
                        "coordinates outside 0-1"
                    )

                if width <= 0 or height <= 0:
                    errors.append(
                        f"{label_file}:{line_number} "
                        "invalid box size"
                    )

                class_counts[class_id] += 1
                split_class_counts[class_id] += 1

                total_boxes += 1
                split_boxes += 1

        for image_file in image_files:
            digest = compute_sha256(image_file)

            previous = image_hashes.get(digest)

            if previous:
                previous_split, previous_file = previous

                duplicate = {
                    "first_split": previous_split,
                    "first_file": previous_file,
                    "second_split": split,
                    "second_file": image_file.name,
                }

                exact_duplicates.append(duplicate)

                if previous_split != split:
                    cross_split_leakage.append(duplicate)
            else:
                image_hashes[digest] = (
                    split,
                    image_file.name,
                )

        split_summaries[split] = {
            "images": len(image_files),
            "labels": len(label_files),
            "boxes": split_boxes,
            "class_counts": split_class_counts,
        }

        total_images += len(image_files)
        total_labels += len(label_files)

    print("=== SPLIT SUMMARY ===")

    for split in SPLITS:
        summary = split_summaries.get(split)

        if summary is None:
            print(f"\n{split.upper()}: unavailable")
            continue

        print(f"\n{split.upper()}:")
        print(f"  Images: {summary['images']}")
        print(f"  Labels: {summary['labels']}")
        print(f"  Bounding boxes: {summary['boxes']}")

        for class_id, class_name in sorted(
            class_names.items()
        ):
            count = summary["class_counts"][class_id]
            print(
                f"  {class_id} {class_name}: {count}"
            )

    print("\n=== DATASET SUMMARY ===")
    print(f"Images: {total_images}")
    print(f"Labels: {total_labels}")
    print(f"Bounding boxes: {total_boxes}")

    print("\nClass totals:")
    for class_id, class_name in sorted(
        class_names.items()
    ):
        print(
            f"  {class_id} {class_name}: "
            f"{class_counts[class_id]}"
        )

    print("\n=== DUPLICATE CHECK ===")
    print(
        f"Exact duplicate pairs: "
        f"{len(exact_duplicates)}"
    )
    print(
        f"Cross-split exact leakage: "
        f"{len(cross_split_leakage)}"
    )

    if exact_duplicates:
        print("\nExact duplicates:")

        for duplicate in exact_duplicates:
            print(
                "  "
                f"{duplicate['first_split']}/"
                f"{duplicate['first_file']} "
                "<-> "
                f"{duplicate['second_split']}/"
                f"{duplicate['second_file']}"
            )

    if cross_split_leakage:
        errors.append(
            "Exact duplicate images detected across "
            "train/valid/test splits."
        )

    print(f"\nErrors: {len(errors)}")

    for error in errors:
        print(f"  {error}")

    if errors:
        print("\nRESULT: REVIEW REQUIRED")
        return 1

    print("\nRESULT: DATASET VALIDATION PASSED")
    return 0


def main():
    args = parse_args()

    if not args.dataset.is_dir():
        raise SystemExit(
            f"Dataset not found: {args.dataset}"
        )

    try:
        result = validate_dataset(args.dataset)
    except (OSError, ValueError, yaml.YAMLError) as error:
        raise SystemExit(f"Validation failed: {error}")

    raise SystemExit(result)


if __name__ == "__main__":
    main()