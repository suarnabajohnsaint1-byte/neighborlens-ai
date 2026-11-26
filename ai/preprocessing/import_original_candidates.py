import argparse
import csv
import hashlib
import itertools
import json
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path

from PIL import Image, UnidentifiedImageError

from ai.preprocessing.annotation_quality import CANONICAL_NAMES, CRITICAL, audit_label_boxes, parse_label_file
from ai.preprocessing.scene_lineage import (
    DUPLICATE_MIN_INLIERS,
    IMAGE_EXTENSIONS,
    PHASH_DUPLICATE_DISTANCE,
    REVIEW_MIN_INLIERS,
    SPLITS,
    UnionFind,
    phash_pair,
    sha256_of,
    sift_pair_scores,
)

PROJECT_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_STAGING = PROJECT_ROOT / "data" / "staging" / "original_candidates"
DEFAULT_REFERENCE = PROJECT_ROOT / "data" / "datasets" / "neighborlens_paper_aligned_v2"
DEFAULT_LINEAGE = PROJECT_ROOT / "docs" / "dataset_audit" / "v2_lineage_report.json"
DEFAULT_BASE = PROJECT_ROOT / "data" / "datasets" / "neighborlens_paper_aligned_v3_1_remediated"
MIN_SHORT_SIDE = 320
PROVENANCE_COLUMNS = (
    "file",
    "source_type",
    "captured_by",
    "capture_date",
    "location",
    "license",
    "consent_or_permission",
    "role",
    "reentry_of_scene_id",
)
ALLOWED_SOURCE_TYPES = {"own_capture", "field_team_capture", "licensed", "public_dataset_with_license", "reannotated_existing"}
ALLOWED_ROLES = {"positive", "background"}
ACCEPTED = "ACCEPTED"
REJECTED = "REJECTED"
NEEDS_REVIEW = "NEEDS_REVIEW"


def read_provenance(staging):
    path = Path(staging) / "provenance.csv"
    if not path.is_file():
        return {}, [f"missing {path.name}"]
    with path.open("r", encoding="utf-8", newline="") as handle:
        reader = csv.DictReader(handle)
        missing_columns = [column for column in PROVENANCE_COLUMNS if column not in (reader.fieldnames or [])]
        rows = {row["file"].strip(): {key: (value or "").strip() for key, value in row.items()} for row in reader if row.get("file")}
    return rows, [f"provenance.csv missing columns {missing_columns}"] if missing_columns else []


def provenance_problems(row):
    if row is None:
        return ["no provenance row"]
    problems = []
    if row.get("source_type") not in ALLOWED_SOURCE_TYPES:
        problems.append(f"source_type must be one of {sorted(ALLOWED_SOURCE_TYPES)}")
    for column in ("captured_by", "capture_date", "location", "license", "consent_or_permission"):
        if not row.get(column):
            problems.append(f"{column} is empty")
    if (row.get("role") or "positive") not in ALLOWED_ROLES:
        problems.append(f"role must be one of {sorted(ALLOWED_ROLES)}")
    if row.get("source_type") == "reannotated_existing" and not row.get("reentry_of_scene_id"):
        problems.append("reannotated_existing requires reentry_of_scene_id")
    return problems


def readable_image(path):
    try:
        with Image.open(path) as image:
            image.verify()
        with Image.open(path) as image:
            image.load()
            width, height = image.size
    except (UnidentifiedImageError, OSError, ValueError) as error:
        return None, f"unreadable image: {error}"
    if min(width, height) < MIN_SHORT_SIDE:
        return (width, height), f"short side {min(width, height)}px below {MIN_SHORT_SIDE}px"
    return (width, height), None


def validate_label(label_path, role):
    if not label_path.is_file():
        return None, ["missing label file"], []
    boxes, parse_issues = parse_label_file(label_path)
    issues = parse_issues + audit_label_boxes(boxes)
    critical = [f"{item['kind']} line {item['line']}" for item in issues if item["severity"] == CRITICAL]
    warnings = [f"{item['kind']} {item['detail']}".strip() for item in issues if item["severity"] != CRITICAL]
    if role == "positive" and not boxes and not critical:
        critical.append("positive image has no boxes; set role=background if it is a true negative")
    if role == "background" and boxes:
        critical.append("background image must have an empty label file")
    return boxes, critical, warnings


def load_reference(reference_root, lineage_report, base_root):
    lineage = json.loads(Path(lineage_report).read_text(encoding="utf-8"))
    scene_by_file = {(record["split"], record["file"]): record["scene_id"] for record in lineage["records"]}
    references = []
    for split in SPLITS:
        images_dir = Path(reference_root) / split / "images"
        if not images_dir.is_dir():
            continue
        for path in sorted(images_dir.iterdir()):
            if path.suffix.lower() in IMAGE_EXTENSIONS:
                references.append({"path": path, "scene_id": scene_by_file.get((split, path.name)), "label": f"{split}/{path.name}"})
    active = set()
    manifest_path = Path(base_root) / "manifest.json"
    if manifest_path.is_file():
        active = {entry["scene_id"] for entry in json.loads(manifest_path.read_text(encoding="utf-8"))["images"]}
    return references, active


def stable_scene_id(member_hashes):
    return "scene_n" + hashlib.sha256("".join(sorted(member_hashes)).encode()).hexdigest()[:10]


def run_import(staging, reference_root, lineage_report, base_root, workers=None):
    staging = Path(staging)
    provenance, global_problems = read_provenance(staging)
    candidates = []
    for path in sorted((staging / "images").iterdir()) if (staging / "images").is_dir() else []:
        if path.suffix.lower() not in IMAGE_EXTENSIONS:
            continue
        row = provenance.get(path.name)
        role = (row or {}).get("role") or "positive"
        record = {"file": path.name, "path": path, "role": role, "errors": [], "warnings": [], "provenance": row}
        record["errors"] += provenance_problems(row)
        size, problem = readable_image(path)
        record["size"] = size
        if problem:
            record["errors"].append(problem)
        if size is not None and not problem:
            record["sha256"] = sha256_of(path)
            record["phash"], record["phash_flipped"] = phash_pair(path)
        boxes, critical, warnings = validate_label(staging / "labels" / f"{path.stem}.txt", role)
        record["errors"] += critical
        record["warnings"] += warnings
        record["classes"] = sorted({item["class_id"] for item in boxes or []})
        record["boxes"] = len(boxes or [])
        candidates.append(record)

    hashed = [record for record in candidates if "sha256" in record]
    references, active_scenes = load_reference(reference_root, lineage_report, base_root)
    for reference in references:
        reference["sha256"] = sha256_of(reference["path"])
        reference["phash"], reference["phash_flipped"] = phash_pair(reference["path"])

    seen_hash = {}
    unique = []
    for record in hashed:
        if record["sha256"] in seen_hash:
            record["errors"].append(f"exact duplicate of staged {seen_hash[record['sha256']]}")
        else:
            seen_hash[record["sha256"]] = record["file"]
            unique.append(record)
    hashed = unique
    union = UnionFind(len(hashed))

    reference_matches = defaultdict(list)
    for record in hashed:
        for reference in references:
            distance = min(record["phash"] - reference["phash"], record["phash"] - reference["phash_flipped"])
            if record["sha256"] == reference["sha256"] or distance <= PHASH_DUPLICATE_DISTANCE:
                reference_matches[record["file"]].append((reference, "sha256" if record["sha256"] == reference["sha256"] else f"phash<={distance}"))
    for i, j in itertools.combinations(range(len(hashed)), 2):
        distance = min(hashed[i]["phash"] - hashed[j]["phash"], hashed[i]["phash"] - hashed[j]["phash_flipped"])
        if distance <= PHASH_DUPLICATE_DISTANCE:
            union.union(i, j)

    all_paths = [record["path"] for record in hashed] + [reference["path"] for reference in references]
    count = len(hashed)
    pairs = [(i, j) for i in range(count) for j in range(i + 1, len(all_paths))]
    borderline = []
    for i, j, inliers, mirrored in sift_pair_scores(all_paths, workers, pairs) if hashed else []:
        if inliers >= DUPLICATE_MIN_INLIERS:
            if j < count:
                union.union(i, j)
            else:
                reference_matches[hashed[i]["file"]].append((references[j - count], f"sift_inliers={inliers}"))
        elif inliers >= REVIEW_MIN_INLIERS:
            other = hashed[j]["file"] if j < count else references[j - count]["label"]
            borderline.append({"candidate": hashed[i]["file"], "other": other, "inliers": inliers, "mirrored": mirrored})

    for record in hashed:
        matches = reference_matches.get(record["file"], [])
        declared = (record["provenance"] or {}).get("reentry_of_scene_id") or None
        for reference, evidence in matches:
            if declared and reference["scene_id"] == declared and declared not in active_scenes:
                record["reentry_scene_id"] = declared
                continue
            record["errors"].append(
                f"duplicate of existing scene {reference['scene_id']} ({reference['label']}, {evidence})"
            )
        if declared and record.get("reentry_scene_id") is None and not record["errors"]:
            record["errors"].append(f"declared reentry_of_scene_id {declared} not matched or already active")

    groups = defaultdict(list)
    for index, record in enumerate(hashed):
        groups[union.find(index)].append(record)
    for members in groups.values():
        reentry = {record.get("reentry_scene_id") for record in members} - {None}
        scene_id = next(iter(reentry)) if len(reentry) == 1 else stable_scene_id([record["sha256"] for record in members])
        if len(reentry) > 1:
            for record in members:
                record["errors"].append("near-duplicate group spans several existing scenes")
        class_sets = {tuple(record["classes"]) for record in members if record["role"] == "positive"}
        for record in members:
            record["scene_id"] = scene_id
            if len(members) > 1:
                record["warnings"].append(f"near-duplicate group of {len(members)} images counts as one independent scene")
            if len(class_sets) > 1:
                record["errors"].append("near-duplicate images in one scene carry contradictory labels")

    for record in candidates:
        if record["errors"]:
            record["status"] = REJECTED
        elif record["warnings"]:
            record["status"] = NEEDS_REVIEW
        else:
            record["status"] = ACCEPTED

    return build_report(staging, candidates, borderline, global_problems)


def build_report(staging, candidates, borderline, global_problems):
    accepted = [record for record in candidates if record["status"] == ACCEPTED]
    per_class = {
        name: len({record["scene_id"] for record in accepted if class_id in record["classes"]})
        for class_id, name in CANONICAL_NAMES.items()
    }
    return {
        "generated_utc": datetime.now(timezone.utc).isoformat(),
        "staging": str(staging),
        "global_problems": global_problems,
        "summary": dict(Counter(record["status"] for record in candidates)),
        "accepted_independent_scenes": len({record["scene_id"] for record in accepted}),
        "accepted_scenes_per_class": per_class,
        "accepted_background_scenes": len({record["scene_id"] for record in accepted if record["role"] == "background"}),
        "borderline_feature_matches": borderline,
        "images": [
            {
                "file": record["file"],
                "status": record["status"],
                "scene_id": record.get("scene_id"),
                "role": record["role"],
                "classes": [CANONICAL_NAMES[class_id] for class_id in record["classes"]],
                "class_ids": record["classes"],
                "boxes": record["boxes"],
                "sha256": record.get("sha256"),
                "size": record.get("size"),
                "errors": record["errors"],
                "warnings": record["warnings"],
                "provenance": record["provenance"],
            }
            for record in candidates
        ],
    }


def render_markdown(report):
    lines = [
        "# Original candidate import report",
        "",
        f"Generated: {report['generated_utc']}",
        "",
        f"Status counts: {report['summary']}",
        f"Accepted independent scenes: {report['accepted_independent_scenes']}",
        f"Accepted background scenes: {report['accepted_background_scenes']}",
        "",
        "| Class | Accepted independent scenes |",
        "|---|---|",
    ]
    lines += [f"| {name} | {count} |" for name, count in report["accepted_scenes_per_class"].items()]
    if report["global_problems"]:
        lines += ["", "## Global problems", ""] + [f"- {problem}" for problem in report["global_problems"]]
    lines += ["", "## Images", "", "| File | Status | Scene | Classes | Errors | Warnings |", "|---|---|---|---|---|---|"]
    for image in report["images"]:
        lines.append(
            f"| {image['file']} | {image['status']} | {image['scene_id'] or ''} | {', '.join(image['classes'])} | "
            f"{'; '.join(image['errors'])} | {'; '.join(image['warnings'])} |"
        )
    if report["borderline_feature_matches"]:
        lines += ["", "## Borderline visual matches for manual check", "", "| Candidate | Other | Inliers |", "|---|---|---|"]
        lines += [f"| {item['candidate']} | {item['other']} | {item['inliers']} |" for item in report["borderline_feature_matches"]]
    return "\n".join(lines) + "\n"


def main():
    parser = argparse.ArgumentParser(description="Validate and deduplicate staged original images before they enter a dataset version")
    parser.add_argument("--staging", type=Path, default=DEFAULT_STAGING)
    parser.add_argument("--reference", type=Path, default=DEFAULT_REFERENCE)
    parser.add_argument("--lineage-report", type=Path, default=DEFAULT_LINEAGE)
    parser.add_argument("--base", type=Path, default=DEFAULT_BASE)
    parser.add_argument("--workers", type=int, default=None)
    args = parser.parse_args()
    report = run_import(args.staging, args.reference, args.lineage_report, args.base, args.workers)
    reports_dir = args.staging / "reports"
    reports_dir.mkdir(parents=True, exist_ok=True)
    (reports_dir / "import_manifest.json").write_text(json.dumps(report, indent=2, default=str), encoding="utf-8")
    (reports_dir / "import_report.md").write_text(render_markdown(report), encoding="utf-8")
    print(json.dumps({key: report[key] for key in ("summary", "accepted_independent_scenes", "accepted_scenes_per_class", "global_problems")}, indent=2))


if __name__ == "__main__":
    main()
