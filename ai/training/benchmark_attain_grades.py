"""External single-view research benchmark on Attain v1 (DOI 10.17632/nykrzdm74f.1).

Use expert boxes and original Low/High grades. These are not Citizen classifications.
Train on windshield v1, test on windshield v2, excluding visually similar source frames.
"""
import argparse
from collections import Counter, defaultdict
import hashlib
import json
from pathlib import Path
from xml.etree import ElementTree
from zipfile import ZipFile

import cv2
import numpy as np
from scipy.special import expit
from scipy.stats import rankdata
import yaml

from ai.inference.visual_extent import analyze_region
from ai.training.severity_classifier import fit
from ai.training.severity_dataset import digest
from ai.training.severity_pairs import view_features


def annotations(archive, name, classes, w, h):
    if name.endswith(".xml"):
        for obj in ElementTree.fromstring(archive.read(name)).findall("object"):
            x, y, r, b = [int(obj.findtext("bndbox/" + key)) for key in ("xmin", "ymin", "xmax", "ymax")]
            yield obj.findtext("name"), (x, y, r - x, b - y)
    else:
        for line in archive.read(name).decode().splitlines():
            c, *coords = map(float, line.split())
            if len(coords) == 4:
                cx, cy, bw, bh = coords
                x, y, right, bottom = cx-bw/2, cy-bh/2, cx+bw/2, cy+bh/2
            else:
                points = np.asarray(coords).reshape(-1, 2)
                x, y = points.min(axis=0)
                right, bottom = points.max(axis=0)
            x, y, right, bottom = np.clip([x, y, right, bottom], 0, 1)
            yield classes[int(c)], (x*w, y*h, (right-x)*w, (bottom-y)*h)


def collect(archive, version, previous):
    prefix = next(n.rsplit("/", 1)[0] for n in archive.namelist() if f"WS_V{version}.0_data.yaml" in n)
    yaml_name = next(n for n in archive.namelist() if n.startswith(prefix) and n.endswith(".yaml"))
    classes = yaml.safe_load(archive.read(yaml_name).decode("utf-8-sig"))["names"]
    frames, results = [], defaultdict(list)
    excluded = 0
    for name in sorted(n for n in archive.namelist() if n.startswith(prefix + "/Labels/")):
        image_name = name.replace("/Labels/", "/Images/").rsplit(".", 1)[0] + ".jpg"
        bgr = cv2.imdecode(np.frombuffer(archive.read(image_name), np.uint8), cv2.IMREAD_COLOR)
        gray = cv2.resize(cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY), (9, 8), interpolation=cv2.INTER_AREA)
        bits = int.from_bytes(np.packbits(gray[:, 1:] > gray[:, :-1]).tobytes(), "big")
        if any((bits ^ other).bit_count() <= 4 for other in previous + frames):
            excluded += 1
            continue
        frames.append(bits)
        candidates = defaultdict(list)
        for label, rect in annotations(archive, name, classes, bgr.shape[1], bgr.shape[0]):
            kind, _, grade = label.lower().rpartition(" - ")
            category = "road_crack" if kind.endswith("crack") else "pothole" if kind == "pothole" else None
            if category and grade in {"low", "high"}:
                candidates[category].append((rect, grade))
        for category, options in candidates.items():
            # Select one region per class per frame independently of the expert grade.
            rect, grade = min(options, key=lambda item: hashlib.sha256(str((name, item[0])).encode()).digest())
            result = analyze_region(bgr, category, rect)
            results[category].append({"features": view_features(result), "label": grade})
    return frames, results, excluded


def auc(y, scores):
    ranks = rankdata(scores)
    positives = int(y.sum())
    return float((ranks[y].sum() - positives*(positives+1)/2) / (positives*(len(y)-positives)))


def assess(training, heldout):
    model = fit([r for r in training if r["features"] is not None], positive_label="high")
    matrix = {grade: dict.fromkeys(("low", "high", "unusable"), 0) for grade in ("low", "high")}
    valid = [r for r in heldout if r["features"] is not None]
    x = np.array([r["features"] for r in valid])
    truth = np.array([r["label"] == "high" for r in valid])
    z = (x - model["mean"]) / model["scale"]
    scores = expit(z @ model["weights"][1:] + model["weights"][0])
    for row in heldout:
        if row["features"] is None:
            matrix[row["label"]]["unusable"] += 1
    for row, score in zip(valid, scores):
        matrix[row["label"]]["high" if score >= .5 else "low"] += 1
    return {"training_grade_counts": dict(Counter(r["label"] for r in training if r["features"] is not None)),
            "heldout_matrix": matrix, "auc_usable": auc(truth, scores),
            "feature_auc_in_view_features_order": [auc(truth, col) for col in x.T], "research_weights": model}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("archive", type=Path)
    parser.add_argument("results", type=Path)
    args = parser.parse_args()
    with ZipFile(args.archive) as archive:
        train_frames, training, skipped_train = collect(archive, 1, [])
        _, heldout, skipped_test = collect(archive, 2, train_frames)
    result = {"archive_sha256": digest(args.archive), "excluded_similar_frames": [skipped_train, skipped_test],
              "native_grades": {c: assess(training[c], heldout[c]) for c in ("road_crack", "pothole")}}
    with args.results.open("x", encoding="utf-8") as stream:
        json.dump(result, stream, indent=2, allow_nan=False)


if __name__ == "__main__":
    main()
