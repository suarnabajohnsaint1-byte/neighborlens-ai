"""Offline experiments on document cropping, print color, display moiré and edit residuals."""

import argparse
import csv
import hashlib
import io
import json
from collections import defaultdict
from pathlib import Path

import cv2
import numpy as np
from PIL import Image

from .benchmark_capture_cohorts import (
    browser_sized_capture, load_ai_preview, load_captures, metrics, preview_rgb, threshold_for_sharpness,
)
from .forensics import TruFor, decode_frame, spectral_peak
from .freuid import FreuidA31


PRINT = "printed_grayscale_copy"
COLOR_PRINT = "printed_color_copy"
SCREEN = "monitor_recapture"
ORIGINAL = "genuine_mock"
HANDCRAFTED = {PRINT: "low_document_chroma", SCREEN: "spectral_peak"}


def document_quad(annotation, member, byte_count):
    frame = next((frame for frame in annotation["_via_img_metadata"].values()
                  if frame["filename"] == member and frame["size"] == byte_count), None)
    if frame is None:
        raise ValueError(f"Annotation/frame mismatch for {member}")
    regions = [region["shape_attributes"] for region in frame["regions"]
               if region["region_attributes"].get("field_name") == "doc_quad"]
    if len(regions) != 1:
        raise ValueError(f"Expected one document region for {member}")
    region = regions[0]
    return np.array(list(zip(region["all_points_x"], region["all_points_y"], strict=True)), dtype=np.float32)


def rectify_document(rgb, quad):
    if quad.shape != (4, 2) or not cv2.isContourConvex(quad) or cv2.contourArea(quad) < 10_000:
        raise ValueError("Invalid document quadrilateral")
    extent = np.linalg.norm(np.roll(quad, -1, axis=0) - quad, axis=1)
    width, height = max(extent[0], extent[2]), max(extent[1], extent[3])
    scale = min(1.0, 1600 / max(width, height))
    width, height = round(width * scale), round(height * scale)
    target = np.array([[0, 0], [width - 1, 0], [width - 1, height - 1], [0, height - 1]], dtype=np.float32)
    return cv2.warpPerspective(rgb, cv2.getPerspectiveTransform(quad, target), (width, height),
                               borderMode=cv2.BORDER_REPLICATE)


def interior(image):
    height, width = image.shape[:2]
    return image[height // 10:height - height // 10, width // 10:width - width // 10]


def low_document_chroma(rgb):
    lab = interior(cv2.cvtColor(rgb, cv2.COLOR_RGB2LAB)).astype(np.float32)
    luma, chroma = lab[..., 0], lab[..., 1:]
    paper = np.median(chroma[luma >= np.percentile(luma, 70)], axis=0)
    return -float(np.percentile(np.linalg.norm(chroma - paper, axis=2), 75))


def noise_discontinuity(rgb):
    gray = cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY).astype(np.float32)
    scale = min(1, 1024 / max(gray.shape))
    if scale < 1:
        gray = cv2.resize(gray, None, fx=scale, fy=scale, interpolation=cv2.INTER_AREA)
    residual = np.abs(gray - cv2.GaussianBlur(gray, (0, 0), 1))
    noise = []
    for row in np.array_split(residual, 8, axis=0):
        for tile in np.array_split(row, 8, axis=1):
            noise.append(float(np.log1p(np.percentile(tile, 65))))
    return float(np.percentile(noise, 90) - np.percentile(noise, 10))


def sharpness(rgb):
    gray = cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY)
    return -float(cv2.Laplacian(gray, cv2.CV_64F).var())


def grouped_physical(samples, annotations, models):
    values = defaultdict(list)
    originals = defaultdict(dict)
    for (split, category, clip), rows in samples.items():
        doc = rows[0][0]["document"]
        annotation_file = annotations / (clip.replace("/", "-") + ".json")
        annotation = json.loads(annotation_file.read_text(encoding="utf-8-sig"))
        full = []
        crops = []
        for row, data in rows:
            with Image.open(io.BytesIO(data)) as image:
                rgb = np.asarray(image.convert("RGB"))
            quad = document_quad(annotation, row["member"].split("/")[-1], len(data))
            crops.append(rectify_document(rgb, quad))
            full.append(decode_frame(browser_sized_capture(data)))
        scores = {
            "low_sharpness": max(sharpness(np.asarray(frame)) for frame in full),
            "low_document_chroma": float(np.median([low_document_chroma(crop) for crop in crops])),
            "spectral_peak": float(np.median([spectral_peak(crop) for crop in crops])),
        }
        for name, model in models.items():
            paired = [model.score(frame.copy()) for frame in full]
            scores[name] = max(paired)
            scores[name + "_both_frames"] = min(paired)
            scores[name + "_document_only"] = max(model.score(Image.fromarray(crop)) for crop in crops)
        values[split, category].append((doc, scores))
        if category == ORIGINAL and split == "test":
            originals[rows[0][0]["condition"]][doc] = scores
    return values, originals


def physical_report(groups, test_groups, model_names):
    controls = dict(test_groups["test", ORIGINAL])
    report = {}
    for category in (PRINT, SCREEN, COLOR_PRINT):
        attacks = test_groups.get(("test", category))
        if not attacks:
            continue
        validation_category = PRINT if category == COLOR_PRINT else category
        comparisons = {}
        thresholds = {name + suffix: 0.50 for name in model_names
                      for suffix in ("", "_both_frames", "_document_only")}
        for method in ("low_sharpness", HANDCRAFTED[validation_category]):
            thresholds[method] = threshold_for_sharpness(
                [scores[method] for _, scores in groups["validation", ORIGINAL]],
                [scores[method] for _, scores in groups["validation", validation_category]],
            )
        for method, threshold in thresholds.items():
            negative = [controls[doc][method] for doc, _ in attacks]
            positive = [scores[method] for _, scores in attacks]
            comparisons[method] = {"threshold": threshold, **metrics(negative, positive, threshold)}
        count = len(attacks)
        comparisons["always_clear"] = metrics([0] * count, [0] * count, 0.5)
        report[category] = comparisons
    return report


def capture_conditions(samples, split):
    cameras, displays, lighting = set(), set(), set()
    for (group, category, _), frames in samples.items():
        if group != split:
            continue
        metadata = frames[0][0]
        cameras.add(metadata["camera"])
        (displays if category == SCREEN else lighting).add(metadata["condition"])
    return cameras, displays, lighting


def ai_screening_report(files, models):
    negative, positive = [[preview_rgb(file) for file in group] for group in files]
    return {
        name: metrics([model.score(image.copy()) for image in negative], [model.score(image.copy()) for image in positive], 0.50)
        for name, model in models.items()
    } | {"always_clear": metrics([0] * len(negative), [0] * len(positive), 0.50)}


def load_ai_cohorts(manifest):
    groups = defaultdict(list)
    countries = defaultdict(set)
    known_people = {}
    known_sources = {}
    digests = set()
    unresolved_people = defaultdict(int)
    with manifest.open(newline="", encoding="utf-8-sig") as stream:
        for row in csv.DictReader(stream):
            split, category = row["split"], row["category"]
            if split not in {"validation", "test"} or category not in {
                "positive", "fraud_inpaint_and_rewrite", "fraud_crop_and_replace",
            }:
                raise ValueError("Unknown AI preview group")
            if not row["source"] or known_sources.setdefault(row["source"], split) != split:
                raise ValueError("Source document leaks across AI preview splits")
            people = row["people"].split(";") if row["people"] else []
            if not people:
                unresolved_people[split, category] += 1
            if any(known_people.setdefault(person, split) != split for person in people):
                raise ValueError("Known portrait leaks across AI preview splits")
            countries[split].add(row["country"])
            file = (manifest.parent / row["path"].replace("\\", "/")).resolve()
            if not file.is_relative_to(manifest.parent.resolve()):
                raise ValueError("AI preview outside manifest directory")
            digest = hashlib.sha256(file.read_bytes()).hexdigest()
            if digest != row["sha256"] or digest in digests:
                raise ValueError("Modified or duplicated AI preview")
            digests.add(digest)
            groups[split, category].append(file)
    required = {("validation", "positive"), ("validation", "fraud_inpaint_and_rewrite"),
                ("test", "positive"), ("test", "fraud_inpaint_and_rewrite"), ("test", "fraud_crop_and_replace")}
    if countries["validation"] & countries["test"] or set(groups) != required:
        raise ValueError("Expected disjoint country groups and both held-out AI fraud categories")
    return groups, {"/".join(key): count for key, count in unresolved_people.items()}


def evaluate_ai_cohorts(groups, models):
    scores = defaultdict(dict)
    for key, paths in groups.items():
        images = [preview_rgb(path) for path in paths]
        scores[key]["residual_discontinuity"] = [noise_discontinuity(np.asarray(image)) for image in images]
        scores[key]["low_sharpness"] = [sharpness(np.asarray(image)) for image in images]
        if key[0] == "test":
            for name, model in models.items():
                scores[key][name] = [model.score(image.copy()) for image in images]
    thresholds = {name: 0.50 for name in models}
    for method in ("residual_discontinuity", "low_sharpness"):
        thresholds[method] = threshold_for_sharpness(
            scores["validation", "positive"][method], scores["validation", "fraud_inpaint_and_rewrite"][method],
        )
    report = {}
    for attack in ("fraud_inpaint_and_rewrite", "fraud_crop_and_replace"):
        negative, positive = scores["test", "positive"], scores["test", attack]
        report[attack] = {name: {"threshold": threshold, **metrics(negative[name], positive[name], threshold)}
                          for name, threshold in thresholds.items()}
        report[attack]["always_clear"] = metrics([0] * len(groups["test", "positive"]),
                                                  [0] * len(groups["test", attack]), 0.5)
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--assets", type=Path, required=True)
    parser.add_argument("--manifest", type=Path)
    parser.add_argument("--annotations", type=Path)
    parser.add_argument("--fresh-manifest", type=Path)
    parser.add_argument("--ai-manifest", type=Path)
    parser.add_argument("--device", default="cpu")
    args = parser.parse_args()
    if (not args.manifest and not args.ai_manifest) or (args.fresh_manifest and not args.manifest):
        parser.error("Supply a physical and/or AI manifest. Fresh physical data requires its baseline.")
    if args.manifest and not args.annotations:
        parser.error("Physical evaluations require published annotations.")
    baseline = load_captures(args.manifest) if args.manifest else {}
    fresh = load_captures(args.fresh_manifest, frozen_test=True) if args.fresh_manifest else {}
    source_docs = {clip.split(".")[0] for _, _, clip in baseline}
    fresh_docs = {clip.split(".")[0] for _, _, clip in fresh}
    if source_docs & fresh_docs:
        raise ValueError("Fresh test has overlapping source identities")
    old_digests = {row["sha256"] for frames in baseline.values() for row, _ in frames}
    fresh_digests = {row["sha256"] for frames in fresh.values() for row, _ in frames}
    if old_digests & fresh_digests:
        raise ValueError("Fresh test has overlapping frame bytes")
    if fresh and any(validation & test for validation, test in zip(
        capture_conditions(baseline, "validation"), capture_conditions(fresh, "test"), strict=True,
    )):
        raise ValueError("Fresh test shares a camera, display, or lighting condition with calibration")
    ai = load_ai_cohorts(args.ai_manifest) if args.ai_manifest else None
    models = {
        "trufor": TruFor(args.assets / "trufor-upstream/test_docker/src",
                        args.assets / "trufor/TruFor_range_verified.zip", args.device),
        "freuid_foreign_layout": FreuidA31(args.assets / "freuid-a31", "MAURITIUS/ID", args.device),
    }
    if baseline:
        grouped, originals = grouped_physical(baseline, args.annotations, models)
        print(json.dumps({"phase22_ablation": physical_report(grouped, grouped, models), "genuine_by_lighting": originals}), flush=True)
    if fresh:
        external, external_originals = grouped_physical(fresh, args.annotations, models)
        print(json.dumps({"fresh_physical": physical_report(grouped, external, models),
                          "genuine_by_lighting": external_originals}), flush=True)
    if ai:
        ai_groups, unresolved = ai
        print(json.dumps({"ai": evaluate_ai_cohorts(ai_groups, models), "unresolved_people": unresolved}), flush=True)
    else:
        files = load_ai_preview(args.assets / "idspace-scan-preview")
        print(json.dumps({"ai_inpaint_rewrite": ai_screening_report(files, models)}), flush=True)


if __name__ == "__main__":
    main()
