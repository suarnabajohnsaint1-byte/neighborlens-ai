"""Stage user-provided infrastructure images for later annotation."""

from __future__ import annotations

import argparse
import csv
import shutil
from pathlib import Path


IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".jfif", ".png", ".webp"}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Copy raw user images into an annotation staging area.")
    parser.add_argument("--road", type=Path, required=True)
    parser.add_argument("--drainage", type=Path, required=True)
    parser.add_argument("--street-light", type=Path, required=True)
    parser.add_argument(
        "--output",
        type=Path,
        default=Path(__file__).resolve().parents[2] / "data" / "datasets" / "incoming_images",
    )
    return parser.parse_args()


def stage_category(source: Path, output: Path, category: str, rows: list[dict[str, str]]) -> int:
    if not source.is_dir():
        raise FileNotFoundError(f"Image folder not found: {source}")

    count = 0
    destination = output / category
    destination.mkdir(parents=True, exist_ok=True)
    for source_file in sorted(source.iterdir()):
        if not source_file.is_file() or source_file.suffix.lower() not in IMAGE_EXTENSIONS:
            continue
        target = destination / source_file.name
        shutil.copy2(source_file, target)
        rows.append({"file": str(target.relative_to(output)), "category": category, "annotation_status": "pending"})
        count += 1
    return count


def main() -> None:
    args = parse_args()
    rows: list[dict[str, str]] = []
    counts = {
        "damaged_road": stage_category(args.road, args.output, "damaged_road", rows),
        "clogged_drainage": stage_category(args.drainage, args.output, "clogged_drainage", rows),
        "damaged_street_light": stage_category(args.street_light, args.output, "damaged_street_light", rows),
    }

    args.output.mkdir(parents=True, exist_ok=True)
    with (args.output / "manifest.csv").open("w", newline="", encoding="utf-8") as manifest:
        writer = csv.DictWriter(manifest, fieldnames=["file", "category", "annotation_status"])
        writer.writeheader()
        writer.writerows(rows)

    print(f"Staged {sum(counts.values())} images in {args.output}")
    for category, count in counts.items():
        print(f"{category}: {count}")
    print("Annotation status: pending; no YOLO labels were generated.")


if __name__ == "__main__":
    main()