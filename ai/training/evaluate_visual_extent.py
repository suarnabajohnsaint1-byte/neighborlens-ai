"""Export the inference-time features and compare candidate masks with reviewer masks.

Input JSONL rows specify image, scene_id, category, region=[x,y,w,h] in the
EXIF-oriented image. An optional mask is a matching oriented binary PNG (0/255).
An optional reviewer-supplied severity is copied verbatim into the offline record.
"""

import argparse
import json
import time
from pathlib import Path

import cv2
import numpy as np
from PIL import Image, ImageOps

from ai.inference.visual_extent import analyze_region
from ai.inference.mask_geometry import reference_coverage


def read_mask(path, shape):
    target = cv2.imread(str(path), cv2.IMREAD_GRAYSCALE)
    if target is None or target.shape != shape or not np.isin(target, [0, 255]).all():
        raise ValueError("Reference mask must be binary and match the oriented image dimensions")
    return target > 0


def evaluate(row, root):
    with Image.open(root / row["image"]) as image:
        view = cv2.cvtColor(np.array(ImageOps.exif_transpose(image).convert("RGB")), cv2.COLOR_RGB2BGR)
    masks = []
    start = time.perf_counter()
    observation = analyze_region(view, row["category"], row["region"], collect_mask=masks.append)
    record = {"scene_id": row["scene_id"], "image": row["image"], "visual_extent": observation,
              "analysis_ms": round((time.perf_counter() - start) * 1000, 3)}
    if "reviewed_severity" in row:
        if row["reviewed_severity"] not in ("MINOR", "MAJOR", "UNCERTAIN", None):
            raise ValueError("Unknown reviewer label")
        record["reviewed_severity"] = row["reviewed_severity"]
    if row.get("mask"):
        truth = read_mask(root / row["mask"], view.shape[:2])
        if row.get("reference_mask"):
            required = "drain_opening" if row["category"] == "clogged_drainage" else "road_surface"
            if row["category"] == "broken_streetlight" or row.get("reference_kind") != required:
                raise ValueError("Reference must identify the appropriate road surface or drain opening")
            ref = read_mask(root / row["reference_mask"], view.shape[:2])
            record["annotated_coverage"] = {**reference_coverage(truth, ref), "reference_kind": required}
        # Compare in the original image coordinates. Missed target pixels outside
        # the proposed region and abstentions remain false negatives.
        prediction = np.zeros_like(truth)
        if masks:
            x, y, w, h = observation["region"]
            prediction[y:y+h, x:x+w] = cv2.resize(masks[0], (w, h), interpolation=cv2.INTER_NEAREST_EXACT) > 0
        record["mask_counts"] = {"tp": int((prediction & truth).sum()), "fp": int((prediction & ~truth).sum()),
                                 "fn": int((~prediction & truth).sum())}
    return record


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("manifest", type=Path)
    args = parser.parse_args()
    with args.manifest.open(encoding="utf-8-sig") as rows:
        for line in rows:
            if line.strip():
                print(json.dumps(evaluate(json.loads(line), args.manifest.parent), allow_nan=False))


if __name__ == "__main__":
    main()
