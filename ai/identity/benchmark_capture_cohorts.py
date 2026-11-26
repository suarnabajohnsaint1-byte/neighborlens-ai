"""Compare existing models and simple baselines on pinned local capture cohorts."""

import argparse
import csv
import hashlib
import io
import json
import math
from collections import defaultdict
from pathlib import Path

from PIL import Image

from .forensics import TruFor, assess_frames
from .freuid import CANONICAL_SIZES, FreuidA31


CATEGORIES = {"or": "genuine_mock", "re": "monitor_recapture", "cg": "printed_grayscale_copy", "cc": "printed_color_copy"}
REQUIRED_CATEGORIES = {CATEGORIES[code] for code in ("or", "re", "cg")}


def ratio(top, bottom):
    return top / bottom if bottom else None


def metrics(negative, positive, threshold):
    fp = sum(score >= threshold for score in negative)
    tp = sum(score >= threshold for score in positive)
    tn, fn = len(negative) - fp, len(positive) - tp
    return {
        "tn": tn, "fp": fp, "tp": tp, "fn": fn,
        "precision": ratio(tp, tp + fp),
        "recall": ratio(tp, tp + fn),
        "f1": ratio(2 * tp, 2 * tp + fp + fn),
        "false_positive_rate": ratio(fp, fp + tn),
        "false_negative_rate": ratio(fn, fn + tp),
    }


def threshold_for_sharpness(negative, positive):
    values = sorted(set(negative + positive))
    candidates = [values[0] - 1, *((a + b) / 2 for a, b in zip(values, values[1:])), values[-1] + 1]
    def rank(threshold):
        result = metrics(negative, positive, threshold)
        return result["recall"] - result["false_positive_rate"], threshold
    return max(candidates, key=rank)


def load_captures(manifest, frozen_test=False):
    samples = defaultdict(list)
    document_split = {}
    hash_owner = {}
    hardware = defaultdict(set)
    displays = defaultdict(set)
    lighting = defaultdict(set)
    with manifest.open(newline="", encoding="utf-8-sig") as stream:
        for row in csv.DictReader(stream):
            clip = row["clip"]
            document, suffix = clip.split(".", 1)
            split = row["split"]
            if document != row["document"] or split not in {"validation", "test"}:
                raise ValueError("Invalid document or split metadata")
            if document_split.setdefault(document, split) != split:
                raise ValueError("Document/person leaks across splits")
            category = CATEGORIES[suffix[:2]]
            file = (manifest.parent / row["path"].replace("\\", "/")).resolve()
            if not file.is_relative_to(manifest.parent.resolve()):
                raise ValueError("Capture outside manifest directory")
            data = file.read_bytes()
            digest = hashlib.sha256(data).hexdigest()
            if digest != row["sha256"] or digest in hash_owner:
                raise ValueError("Modified or duplicated capture")
            hash_owner[digest] = clip
            samples[split, category, clip].append((row, data))
            hardware[split].add(row["camera"])
            (displays if category == "monitor_recapture" else lighting)[split].add(row["condition"])
    for axis in (hardware, displays, lighting):
        if not axis["test"] or (not frozen_test and not axis["validation"]) or axis["validation"] & axis["test"]:
            raise ValueError("Missing or overlapping holdout conditions")
    groups = defaultdict(set)
    for (split, category, clip), frames in samples.items():
        if len(frames) != 2 or len({(row["camera"], row["condition"]) for row, _ in frames}) != 1:
            raise ValueError("A clip must have two distinct frames with matching capture metadata")
        groups[(split, clip.split(".")[0])].add(category)
    if any(not REQUIRED_CATEGORIES <= categories for categories in groups.values()):
        raise ValueError("Incomplete matched physical document group")
    return samples


def scores_by_group(samples, models, single_capture=False):
    grouped = defaultdict(lambda: defaultdict(list))
    for (split, category, _), frames in samples.items():
        encoded = [browser_sized_capture(data) for _, data in (frames[:1] if single_capture else frames)]
        for name, model in models.items():
            details = [assess_frames(model, [frame]) for frame in encoded]
            score = max(frame["documentFraudScores"][0] for frame in details)
            grouped[split, category][name].append(score)
            if category == "genuine_mock":
                grouped[split, "genuine_by_lighting", frames[0][0]["condition"]][name].append(score)
        grouped[split, category]["low_sharpness"].append(-min(frame["laplacianVariance"][0] for frame in details))
    return grouped


def browser_sized_capture(data):
    with Image.open(io.BytesIO(data)) as image:
        if image.format != "JPEG" or getattr(image, "n_frames", 1) != 1 or image.width * image.height > 12_000_000:
            raise ValueError("Unexpected DLC capture dimensions or format")
        image.thumbnail((1600, 1600), Image.Resampling.LANCZOS)
        output = io.BytesIO()
        image.convert("RGB").save(output, format="JPEG", quality=94)
        return output.getvalue()


def compare_capture_scores(grouped, model_names, frozen_test=False):
    comparison = {}
    for category in ("monitor_recapture", "printed_grayscale_copy"):
        neg, pos = grouped["test", "genuine_mock"], grouped["test", category]
        comparison[category] = {
            name: metrics(neg[name], pos[name], 0.5) for name in model_names
        }
        if not frozen_test:
            val_neg = grouped["validation", "genuine_mock"]["low_sharpness"]
            val_pos = grouped["validation", category]["low_sharpness"]
            threshold = threshold_for_sharpness(val_neg, val_pos)
            comparison[category]["low_sharpness"] = {
                **metrics(neg["low_sharpness"], pos["low_sharpness"], threshold), "threshold": threshold,
            }
        comparison[category]["always_clear"] = metrics([0] * len(neg["low_sharpness"]), [0] * len(pos["low_sharpness"]), 0.5)
    comparison["genuine_by_lighting"] = {
        key[2]: {name: metrics(scores, [], 0.5) for name, scores in results.items()}
        for key, results in grouped.items() if len(key) == 3 and key[:2] == ("test", "genuine_by_lighting")
    }
    return comparison


def load_ai_preview(directory):
    files = [sorted(directory.glob(pattern)) for pattern in ("positive-*.jpg", "fraud_inpaint_and_rewrite-*.jpg")]
    hashes = [hashlib.sha256(file.read_bytes()).digest() for group in files for file in group]
    if [len(group) for group in files] != [10, 10] or len(set(hashes)) != 20:
        raise ValueError("Expected the pinned 10/10 AI preview subset without duplicates")
    return files


def preview_rgb(file):
    # Public scanner previews are larger than images accepted by the live capture API.
    with Image.open(file) as image:
        if image.format not in ("JPEG", "PNG", "WEBP") or getattr(image, "n_frames", 1) != 1 or image.width * image.height > 12_000_000:
            raise ValueError("Unsupported preview image")
        return image.convert("RGB")


def evaluate_ai_preview(files, models):
    scores = {}
    for name, model in models.items():
        negative, positive = [[model.score(preview_rgb(file)) for file in group] for group in files]
        if not all(math.isfinite(score) for score in negative + positive):
            raise ValueError("Invalid model score")
        scores[name] = metrics(negative, positive, 0.5)
    scores["always_clear"] = metrics([0] * 10, [0] * 10, 0.5)
    return scores


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--assets", type=Path, required=True, help="Existing local identity-phase21 research assets")
    parser.add_argument("--physical-manifest", type=Path)
    parser.add_argument("--ai-preview", action="store_true")
    parser.add_argument("--frozen-test", action="store_true", help="Use fixed thresholds without fitting a sharpness baseline")
    parser.add_argument("--single-capture", action="store_true", help="Score only the first manifest frame of each clip")
    parser.add_argument("--freuid-layout", choices=CANONICAL_SIZES, default="MAURITIUS/ID",
                        help="Nominate a research crop layout, such as the configured live probe")
    parser.add_argument("--device", default="cpu")
    args = parser.parse_args()
    if not args.physical_manifest and not args.ai_preview:
        parser.error("Supply at least one dataset")
    # Validate available datasets before running inference.
    samples = load_captures(args.physical_manifest, args.frozen_test) if args.physical_manifest else None
    root = args.assets
    preview = load_ai_preview(root / "idspace-scan-preview") if args.ai_preview else None
    models = {
        "trufor": TruFor(root / "trufor-upstream/test_docker/src", root / "trufor/TruFor_range_verified.zip", args.device),
        "freuid_foreign_layout_probe": FreuidA31(root / "freuid-a31", args.freuid_layout, args.device),
    }
    if samples:
        scores = scores_by_group(samples, models, single_capture=args.single_capture)
        print(json.dumps({"physical": compare_capture_scores(scores, models, args.frozen_test)}), flush=True)
    if preview:
        print(json.dumps({"ai_preview": evaluate_ai_preview(preview, models)}), flush=True)


if __name__ == "__main__":
    main()
