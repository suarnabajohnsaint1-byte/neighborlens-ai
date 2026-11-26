"""Measure local ID image reuse signals on labeled, authorized capture pairs."""

import argparse
import csv
import json
from pathlib import Path

import cv2
import imagehash
import numpy as np
from PIL import Image, ImageOps


def describe_capture(path):
    with Image.open(path) as source:
        image = ImageOps.exif_transpose(source).convert("L")
        image.thumbnail((1024, 1024), Image.Resampling.LANCZOS)
        pixels = np.asarray(image)
        sharpness = float(cv2.Laplacian(pixels, cv2.CV_64F).var())
        return imagehash.phash(image), sharpness


def evaluate_pairs(manifest, max_distance):
    outcomes = {
        "correct_matches": 0,
        "missed_matches": 0,
        "false_matches": 0,
        "correct_nonmatches": 0,
    }
    sharpness_total = 0
    with manifest.open(newline="", encoding="utf-8-sig") as source:
        pairs = csv.DictReader(source)
        for index, row in enumerate(pairs, start=2):
            try:
                if row["same_source"] not in {"0", "1"}:
                    raise ValueError()
                reference, _ = describe_capture(manifest.parent / row["reference"])
                capture, sharpness = describe_capture(manifest.parent / row["capture"])
            except (KeyError, OSError, TypeError, ValueError):
                raise ValueError(f"Invalid fixture at manifest row {index}.") from None
            matches = reference - capture <= max_distance
            sharpness_total += sharpness
            if row["same_source"] == "1":
                outcomes["correct_matches" if matches else "missed_matches"] += 1
            else:
                outcomes["false_matches" if matches else "correct_nonmatches"] += 1
    count = sum(outcomes.values())
    if not count:
        raise ValueError("The manifest contains no labeled pairs.")
    return {**outcomes, "mean_capture_laplacian_variance": round(sharpness_total / count, 2)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("manifest", type=Path)
    parser.add_argument("--max-distance", required=True, type=int)
    args = parser.parse_args()
    if not 0 <= args.max_distance <= 64:
        parser.error("Maximum distance must be between 0 and 64.")
    try:
        outcomes = evaluate_pairs(args.manifest, args.max_distance)
    except (OSError, ValueError) as error:
        parser.exit(1, f"{error if isinstance(error, ValueError) else 'Could not read the manifest.'}\n")
    print(json.dumps(outcomes))


if __name__ == "__main__":
    main()
