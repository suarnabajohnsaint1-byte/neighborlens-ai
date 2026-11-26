"""Prepare an unlabeled review inventory and validate adjudicated two-view cases."""
import argparse
import hashlib
import json
from pathlib import Path

import numpy as np
import yaml
from PIL import Image, ImageOps

CATEGORIES = {"road_crack", "pothole", "clogged_drainage", "broken_streetlight"}
LABELS = ("MINOR", "MAJOR", "INSUFFICIENT")


def digest(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def rows(path):
    return [json.loads(line) for line in path.read_text(encoding="utf-8-sig").splitlines() if line.strip()]


def site_split(site):
    bucket = int(hashlib.sha256(site.encode()).hexdigest()[:8], 16) % 10
    return "train" if bucket < 6 else "development" if bucket < 8 else "test"


def inventory(root):
    names = yaml.safe_load((root / "data.yaml").read_text())["names"]
    if isinstance(names, dict):
        names = [names[i] for i in range(len(names))]
    if set(names) != CATEGORIES:
        raise ValueError("Expected the four canonical class names in data.yaml")
    seen = set()
    for directory in sorted(root.glob("*/images")):
        for path in sorted(directory.iterdir()):
            if path.suffix.lower() not in {".jpg", ".jpeg", ".png", ".webp"}:
                continue
            fingerprint = digest(path)
            if fingerprint in seen:
                continue
            seen.add(fingerprint)
            label = directory.parent / "labels" / (path.stem + ".txt")
            ids = {int(s.split()[0]) for s in label.read_text().splitlines() if s.strip()} if label.exists() else set()
            if any(i < 0 or i >= len(names) for i in ids):
                raise ValueError(f"Invalid detector annotation in {label}")
            with Image.open(path) as image:
                small = np.asarray(ImageOps.exif_transpose(image).convert("L").resize((9, 8), Image.Resampling.LANCZOS))
            bits = np.packbits(small[:, 1:] > small[:, :-1]).tobytes().hex()
            yield {"sha256": fingerprint, "image": path.relative_to(root).as_posix(), "dhash": bits,
                   "source_family": path.stem.split(".rf.")[0], "detector_categories": sorted(names[i] for i in ids)}


def text_fields(record, keys):
    return all(isinstance(record.get(k), str) and record[k].strip() for k in keys)


def reviewed_cases(catalog, records, policy):
    if not records:
        raise ValueError("No adjudicated photo pairs. Training and evaluation require reviewed cases.")
    assets = {image["sha256"]: image for image in catalog}
    used, events, families, signatures = set(), set(), {}, []
    if not text_fields(policy, ["version", "approval_ref"]) or not policy.get("reviewers"):
        raise ValueError("Supply the approved rubric version, approval reference and qualified reviewer roster")
    for case in records:
        if not text_fields(case, ["site_id", "event_id", "inspection_ref", "evidence", "rubric_version", "capture_context"]):
            raise ValueError("Missing site, event, inspection record, evidence or rubric")
        site = case["site_id"].strip().casefold()
        event = case["event_id"].strip().casefold()
        votes = case.get("reviews", [])
        label = case.get("label")
        category = case.get("category")
        if case.get("inspection_class") not in (*LABELS[:2], "UNKNOWN"):
            raise ValueError("Record the independently inspected class or UNKNOWN")
        if label in LABELS[:2] and (case.get("inspection_class") != label or case.get("visually_supported") is not True):
            raise ValueError("A binary target needs matching inspection evidence and sufficient visible evidence")
        if label == "INSUFFICIENT" and case.get("visually_supported") is not False:
            raise ValueError("Mark insufficient images explicitly")
        if (category not in CATEGORIES or label not in LABELS or case["rubric_version"] != policy["version"]
                or category not in policy.get("rule_refs", {}) or not policy["rule_refs"][category]
                or len(votes) != 2 or len({v.get("reviewer") for v in votes}) != 2):
            raise ValueError("Expected a class-specific approved rule and two independent reviews")
        eligible = {name for name, classes in policy["reviewers"].items() if category in classes}
        if any(v.get("reviewer") not in eligible or v.get("label") not in LABELS
               or not text_fields(v, ["basis"]) for v in votes):
            raise ValueError("Invalid reviewer, judgement or basis")
        if any(v["label"] != label for v in votes):
            if case.get("adjudicator") not in eligible - {v["reviewer"] for v in votes} or not text_fields(case, ["resolution"]):
                raise ValueError("Disagreement requires independent adjudication")
        images = case["photos"]
        if len(images) != 2 or len(set(images)) != 2 or event in events or any(i in used or i not in assets for i in images):
            raise ValueError("Expected a unique event and two distinct unused source photos")
        events.add(event)
        used.update(images)
        split = site_split(site)
        pair_bits = []
        for i in images:
            photo = assets[i]
            if split == "test" and (case.get("independent_of_detector_training") is not True
                                    or Path(photo["image"]).parts[0] in {"train", "valid", "val"}):
                raise ValueError("Test sites need independently verified acquisition outside detector training/development")
            family, bits = photo["source_family"], int(photo["dhash"], 16)
            if families.setdefault(family, split) != split or any(s != split and (b ^ bits).bit_count() <= 4 for b, s in signatures):
                raise ValueError("Possible related photos cross site partitions. Reconcile site IDs before use.")
            pair_bits.append(bits)
            signatures.append((bits, split))
        if assets[images[0]]["source_family"] == assets[images[1]]["source_family"] or (pair_bits[0] ^ pair_bits[1]).bit_count() <= 4:
            raise ValueError("Pair resembles duplicate views or augmentations. Supply distinct captures.")
        yield {**case, "site_id": site, "split": split}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("dataset", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    data = list(inventory(args.dataset))
    if not data:
        parser.error("No images in dataset split directories")
    with args.output.open("x", encoding="utf-8", newline="\n") as stream:
        for item in data:
            stream.write(json.dumps(item, sort_keys=True) + "\n")
    print(f"{len(data)} unique images. No severity labels assigned.")


if __name__ == "__main__":
    main()
