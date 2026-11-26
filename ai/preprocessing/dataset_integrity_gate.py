import argparse
import itertools
import json
import re
import sys
from collections import defaultdict
from pathlib import Path

import yaml

from ai.preprocessing.annotation_quality import (
    CANONICAL_NAMES,
    CRITICAL,
    audit_dataset_annotations,
)
from ai.preprocessing.scene_lineage import (
    DUPLICATE_MIN_INLIERS,
    PHASH_DUPLICATE_DISTANCE,
    SPLITS,
    collect_images,
    phash_pair,
    roboflow_stem,
    sha256_of,
    sift_pair_scores,
)

AUGMENTATION_MARKERS = re.compile(r"(\.rf\.[0-9a-f]{32}|_aug\d*|-aug\d*|_augmented|_flip|_rot\d+|_bright|_blur|_noise)", re.IGNORECASE)
REQUIRED_NAMES = {index: name for index, name in CANONICAL_NAMES.items()}
MIN_SCENES_PER_CLASS_PER_EVAL_SPLIT = 5
READINESS_MIN_SCENES = {"train": 45, "valid": 15, "test": 15}


class GateResult:
    def __init__(self):
        self.checks = []

    def add(self, name, passed, detail, critical=True):
        self.checks.append({"name": name, "passed": bool(passed), "critical": critical, "detail": detail})

    @property
    def passed(self):
        return all(check["passed"] for check in self.checks if check["critical"])

    def to_dict(self):
        return {"passed": self.passed, "checks": self.checks}


def load_names(dataset_root):
    config = yaml.safe_load((Path(dataset_root) / "data.yaml").read_text(encoding="utf-8"))
    names = config.get("names")
    if isinstance(names, list):
        names = dict(enumerate(names))
    return {int(key): value for key, value in names.items()}, config


def read_manifest(dataset_root):
    manifest_path = Path(dataset_root) / "manifest.json"
    if not manifest_path.is_file():
        return None
    return json.loads(manifest_path.read_text(encoding="utf-8"))


def cross_split_visual_overlap(records, workers=None):
    findings = []
    hashes = {}
    for index, record in enumerate(records):
        record["sha256"] = sha256_of(record["path"])
        record["phash"], record["phash_flipped"] = phash_pair(record["path"])
        hashes.setdefault(record["sha256"], []).append(index)
    sha_pairs = 0
    for members in hashes.values():
        splits = {records[index]["split"] for index in members}
        if len(splits) > 1:
            sha_pairs += 1
            findings.append(
                {
                    "type": "exact_duplicate",
                    "files": [records[index]["file"] for index in members],
                    "splits": sorted(splits),
                }
            )
    phash_pairs = 0
    for i, j in itertools.combinations(range(len(records)), 2):
        if records[i]["split"] == records[j]["split"]:
            continue
        distance = min(
            records[i]["phash"] - records[j]["phash"],
            records[i]["phash"] - records[j]["phash_flipped"],
        )
        if distance <= PHASH_DUPLICATE_DISTANCE:
            phash_pairs += 1
            findings.append(
                {
                    "type": "perceptual_duplicate",
                    "distance": int(distance),
                    "files": [records[i]["file"], records[j]["file"]],
                    "splits": sorted({records[i]["split"], records[j]["split"]}),
                }
            )
    sift_pairs = 0
    for i, j, inliers, mirrored in sift_pair_scores([record["path"] for record in records], workers):
        if records[i]["split"] == records[j]["split"] or inliers < DUPLICATE_MIN_INLIERS:
            continue
        sift_pairs += 1
        findings.append(
            {
                "type": "feature_match_duplicate",
                "inliers": inliers,
                "mirrored": mirrored,
                "files": [records[i]["file"], records[j]["file"]],
                "splits": sorted({records[i]["split"], records[j]["split"]}),
            }
        )
    return findings, {"exact": sha_pairs, "perceptual": phash_pairs, "feature": sift_pairs}


def read_review_status(dataset_root):
    path = Path(dataset_root) / "review_status.json"
    if not path.is_file():
        return None
    return json.loads(path.read_text(encoding="utf-8"))


def label_class_sets(dataset_root, entries):
    result = {}
    for entry in entries:
        label = Path(dataset_root) / entry["split"] / "labels" / f"{Path(entry['file']).stem}.txt"
        lines = label.read_text(encoding="utf-8").splitlines() if label.is_file() else []
        result[(entry["split"], entry["file"])] = frozenset(int(float(line.split()[0])) for line in lines if line.strip())
    return result


def run_gate(dataset_root, workers=None, skip_visual=False, readiness=False):
    dataset_root = Path(dataset_root)
    result = GateResult()

    names, config = load_names(dataset_root)
    result.add("data_yaml_class_mapping", names == REQUIRED_NAMES, f"names={names}")
    result.add("data_yaml_nc", config.get("nc", len(names)) == len(REQUIRED_NAMES), f"nc={config.get('nc')}")

    records = collect_images(dataset_root)
    counts = {split: sum(1 for record in records if record["split"] == split) for split in SPLITS}
    result.add("splits_non_empty", all(counts.values()), f"image_counts={counts}")

    report, summary = audit_dataset_annotations(dataset_root)
    critical_files = {
        file: [item for item in issues if item["severity"] == CRITICAL]
        for file, issues in report.items()
    }
    critical_files = {file: issues for file, issues in critical_files.items() if issues}
    result.add(
        "image_label_pairs_and_yolo_validity",
        not critical_files,
        f"critical_annotation_files={len(critical_files)} sample={list(critical_files)[:5]}",
    )
    empty_labels = [file for file, issues in report.items() if any(item["kind"] == "empty_label" for item in issues)]

    class_ids = set()
    for split in SPLITS:
        for label in (dataset_root / split / "labels").glob("*.txt"):
            for line in label.read_text(encoding="utf-8").splitlines():
                if line.strip():
                    class_ids.add(int(float(line.split()[0])))
    result.add("class_ids_within_0_3", class_ids <= set(REQUIRED_NAMES), f"class_ids_seen={sorted(class_ids)}")

    eval_augmented = [
        record["file"]
        for record in records
        if record["split"] in ("valid", "test") and AUGMENTATION_MARKERS.search(record["file"])
    ]
    result.add("no_augmented_files_in_valid_or_test", not eval_augmented, f"offenders={eval_augmented[:5]}")

    manifest = read_manifest(dataset_root)
    if manifest is not None:
        scene_splits = defaultdict(set)
        for entry in manifest["images"]:
            scene_splits[entry["scene_id"]].add(entry["split"])
        leaking = {scene: sorted(splits) for scene, splits in scene_splits.items() if len(splits) > 1}
        result.add("manifest_scene_in_single_split", not leaking, f"scenes_in_multiple_splits={len(leaking)}")
        generated = [entry["file"] for entry in manifest["images"] if entry.get("origin") != "original"]
        result.add("manifest_only_original_images", not generated, f"non_original_entries={len(generated)}")
        manifest_files = {(entry["split"], entry["file"]) for entry in manifest["images"]}
        disk_files = {(record["split"], record["file"]) for record in records}
        result.add(
            "manifest_matches_disk",
            manifest_files == disk_files,
            f"only_in_manifest={len(manifest_files - disk_files)} only_on_disk={len(disk_files - manifest_files)}",
        )
        stems = defaultdict(set)
        for entry in manifest["images"]:
            stems[entry["source_lineage_group"]].add(entry["split"])
        family_leaks = {group: sorted(splits) for group, splits in stems.items() if len(splits) > 1}
        result.add("augmentation_family_overlap", not family_leaks, f"families_in_multiple_splits={len(family_leaks)}")

        backgrounds = {
            f"{entry['split']}/{Path(entry['file']).stem}.txt"
            for entry in manifest["images"]
            if entry.get("role") == "background"
        }
        undeclared_empty = sorted(set(empty_labels) - backgrounds)
        result.add(
            "empty_labels_are_declared_backgrounds",
            not undeclared_empty,
            f"undeclared_empty_labels={len(undeclared_empty)} sample={undeclared_empty[:5]}",
        )
        eval_backgrounds = sorted(file for file in backgrounds if not file.startswith("train/"))
        result.add("backgrounds_train_only", not eval_backgrounds, f"backgrounds_outside_train={eval_backgrounds[:5]}")

        class_sets = label_class_sets(dataset_root, manifest["images"])
        scene_sets = defaultdict(set)
        for entry in manifest["images"]:
            if entry.get("role") != "background":
                scene_sets[entry["scene_id"]].add(class_sets[(entry["split"], entry["file"])])
        contradictory = sorted(scene for scene, sets in scene_sets.items() if len(sets) > 1)
        result.add(
            "no_contradictory_labels_within_scene",
            not contradictory,
            f"scenes_with_conflicting_labels={contradictory[:10]}",
        )
    else:
        result.add("manifest_present", False, "manifest.json missing")

    review_status = read_review_status(dataset_root)
    if review_status is not None:
        blocking = [item for item in review_status.get("unresolved_items", []) if item.get("blocking")]
        result.add(
            "no_unresolved_blocking_review_items",
            not blocking,
            f"unresolved_blocking={[item['id'] for item in blocking]}",
        )

    pair_counts = {"train_valid": 0, "train_test": 0, "valid_test": 0}
    findings = []
    if skip_visual:
        result.add("visual_cross_split_overlap", False, "visual check skipped; gate cannot certify leakage")
    else:
        findings, counters = cross_split_visual_overlap(records, workers)
        split_pair_keys = {
            ("train", "valid"): "train_valid",
            ("train", "test"): "train_test",
            ("test", "valid"): "valid_test",
        }
        for finding in findings:
            for pair, key in split_pair_keys.items():
                if set(pair) <= set(finding["splits"]):
                    pair_counts[key] += 1
        result.add("train_valid_overlap_zero", pair_counts["train_valid"] == 0, f"overlap={pair_counts['train_valid']}")
        result.add("train_test_overlap_zero", pair_counts["train_test"] == 0, f"overlap={pair_counts['train_test']}")
        result.add("valid_test_overlap_zero", pair_counts["valid_test"] == 0, f"overlap={pair_counts['valid_test']}")
        result.add(
            "exact_duplicate_overlap_zero",
            counters["exact"] == 0,
            f"cross_split_exact_duplicates={counters['exact']}",
        )
        result.add(
            "perceptual_and_feature_duplicate_overlap_zero",
            counters["perceptual"] == 0 and counters["feature"] == 0,
            f"perceptual={counters['perceptual']} feature={counters['feature']}",
        )

    class_scene_counts = {split: defaultdict(set) for split in SPLITS}
    if manifest is not None:
        by_file = {(entry["split"], entry["file"]): entry for entry in manifest["images"]}
        for (split, file), entry in by_file.items():
            for class_id in entry["classes"]:
                class_scene_counts[split][class_id].add(entry["scene_id"])
        for class_id, name in REQUIRED_NAMES.items():
            for split in SPLITS:
                have = len(class_scene_counts[split][class_id])
                minimum = READINESS_MIN_SCENES[split] if readiness else (
                    MIN_SCENES_PER_CLASS_PER_EVAL_SPLIT if split != "train" else 1
                )
                result.add(
                    f"coverage_{name}_{split}",
                    have >= minimum,
                    f"independent_scenes={have} minimum={minimum}",
                    critical=readiness,
                )
        if readiness:
            missing = [entry["file"] for entry in manifest["images"] if not entry.get("provenance")]
            result.add("provenance_documented", not missing, f"images_without_provenance={len(missing)}")
            result.add("review_status_present", review_status is not None, "review_status.json records annotation review outcome")

    output = result.to_dict()
    output["mode"] = "readiness" if readiness else "integrity"
    output["overlap_counts"] = pair_counts
    output["cross_split_findings"] = findings
    output["image_counts"] = counts
    return output


def failed_checks(output):
    return [check["name"] for check in output["checks"] if check["critical"] and not check["passed"]]


def assert_dataset_ready(dataset_root, workers=None, readiness=True):
    output = run_gate(dataset_root, workers, readiness=readiness)
    if not output["passed"]:
        mode = "readiness" if readiness else "integrity"
        raise SystemExit(f"Dataset {mode} gate FAILED: {failed_checks(output)}. Training must not proceed.")
    return output


def main():
    parser = argparse.ArgumentParser(description="Dataset integrity gate for NeighborLens YOLO datasets")
    parser.add_argument("dataset", type=Path)
    parser.add_argument("--report", type=Path, default=None)
    parser.add_argument("--workers", type=int, default=None)
    parser.add_argument("--skip-visual", action="store_true")
    parser.add_argument("--readiness", action="store_true")
    args = parser.parse_args()
    output = run_gate(args.dataset, args.workers, args.skip_visual, args.readiness)
    for check in output["checks"]:
        status = "PASS" if check["passed"] else ("FAIL" if check["critical"] else "WARN")
        print(f"[{status}] {check['name']}: {check['detail']}")
    print(
        f"Train<->Valid: {output['overlap_counts']['train_valid']}  "
        f"Train<->Test: {output['overlap_counts']['train_test']}  "
        f"Valid<->Test: {output['overlap_counts']['valid_test']}"
    )
    if args.report:
        args.report.write_text(json.dumps(output, indent=2), encoding="utf-8")
    label = "READINESS" if args.readiness else "INTEGRITY"
    print(f"{label} GATE PASSED" if output["passed"] else f"{label} GATE FAILED")
    sys.exit(0 if output["passed"] else 1)


if __name__ == "__main__":
    main()
