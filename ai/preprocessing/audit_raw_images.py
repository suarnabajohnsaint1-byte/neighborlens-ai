"""Read-only audit of data/raw/{damages_road,street_light,clogging_drainage}.

Writes data/processed/audit/{raw_audit.json,RAW_AUDIT.md,raw_manifest.csv} and, if absent,
scope_review.csv for manual in-scope/out-of-scope decisions. Source files are only opened
for reading. Run with --verify to confirm the raw folders still match raw_manifest.csv.
"""

from __future__ import annotations

import argparse
import csv
import json
import statistics
import sys
from collections import Counter, defaultdict
from pathlib import Path

from PIL import Image, ImageStat, UnidentifiedImageError

sys.path.insert(0, str(Path(__file__).resolve().parent))

from raw_images import (  # noqa: E402
    IMAGE_SUFFIXES,
    NEW_DATASET_ROOT,
    RAW_ROOT,
    SOURCE_FOLDERS,
    difference_hash,
    hamming,
    iter_files,
    sha256_file,
)

MANIFEST_FIELDS = ["relative_path", "folder", "sha256", "readable", "format", "width", "height", "exif_rotated", "dhash"]
SCOPE_FIELDS = ["relative_path", "folder", "decision", "reviewer", "notes"]
EXIF_ORIENTATION_TAG = 0x0112
MIN_SHORT_SIDE = 320
MAX_ASPECT_RATIO = 3.0
MIN_PIXEL_STDDEV = 8.0


def inspect_image(path: Path) -> dict:
    try:
        with Image.open(path) as image:
            image.verify()
        with Image.open(path) as image:
            image.load()
            orientation = image.getexif().get(EXIF_ORIENTATION_TAG, 1)
            rotated = orientation in (5, 6, 7, 8)
            width, height = (image.height, image.width) if rotated else image.size
            return {
                "readable": True,
                "format": image.format or "UNKNOWN",
                "width": width,
                "height": height,
                "exif_rotated": orientation not in (1, None),
                "dhash": difference_hash(image),
                "stddev": max(ImageStat.Stat(image.convert("L")).stddev),
            }
    except (UnidentifiedImageError, OSError, SyntaxError, ValueError) as error:
        return {"readable": False, "error": f"{type(error).__name__}: {error}"}


def near_duplicate_pairs(records: list[dict], threshold: int) -> list[tuple[dict, dict, int]]:
    pairs = []
    for i, first in enumerate(records):
        for second in records[i + 1 :]:
            if first["sha256"] == second["sha256"]:
                continue
            distance = hamming(first["dhash"], second["dhash"])
            if distance <= threshold:
                pairs.append((first, second, distance))
    return pairs


def summarise_resolution(records: list[dict]) -> dict:
    if not records:
        return {}
    widths = [r["width"] for r in records]
    heights = [r["height"] for r in records]
    megapixels = [r["width"] * r["height"] / 1e6 for r in records]
    return {
        "width": {"min": min(widths), "median": statistics.median(widths), "max": max(widths)},
        "height": {"min": min(heights), "median": statistics.median(heights), "max": max(heights)},
        "megapixels": {
            "min": round(min(megapixels), 3),
            "median": round(statistics.median(megapixels), 3),
            "max": round(max(megapixels), 3),
        },
        "short_side_below_640": sum(min(r["width"], r["height"]) < 640 for r in records),
    }


def questionable_reasons(record: dict) -> list[str]:
    reasons = []
    short_side = min(record["width"], record["height"])
    long_side = max(record["width"], record["height"])
    if short_side < MIN_SHORT_SIDE:
        reasons.append(f"short side {short_side}px < {MIN_SHORT_SIDE}px")
    if long_side / short_side > MAX_ASPECT_RATIO:
        reasons.append(f"aspect ratio {long_side / short_side:.1f} > {MAX_ASPECT_RATIO}")
    if record["stddev"] < MIN_PIXEL_STDDEV:
        reasons.append("near-uniform pixels (possible blank or placeholder)")
    return reasons


def audit_folder(folder: str, raw_root: Path, threshold: int) -> tuple[dict, list[dict]]:
    folder_root = raw_root / folder
    files = list(iter_files(folder_root))
    nested_dirs = sorted(
        p.relative_to(raw_root).as_posix() for p in folder_root.rglob("*") if p.is_dir()
    )

    records, unreadable, non_image = [], [], []
    for path in files:
        relative = str(path.relative_to(raw_root).as_posix())
        if path.suffix.lower() not in IMAGE_SUFFIXES:
            non_image.append(relative)
            continue
        info = inspect_image(path)
        sha = sha256_file(path)
        if not info["readable"]:
            unreadable.append({"relative_path": relative, "error": info["error"]})
            records.append({"relative_path": relative, "folder": folder, "sha256": sha, "readable": False})
            continue
        records.append({"relative_path": relative, "folder": folder, "sha256": sha, **info})

    valid = [r for r in records if r["readable"]]

    names = defaultdict(list)
    for r in records:
        names[Path(r["relative_path"]).stem.lower()].append(r["relative_path"])
    duplicate_filenames = {stem: paths for stem, paths in names.items() if len(paths) > 1}

    by_sha = defaultdict(list)
    for r in valid:
        by_sha[r["sha256"]].append(r["relative_path"])
    exact_groups = [sorted(paths) for paths in by_sha.values() if len(paths) > 1]

    near_pairs = [
        {"a": a["relative_path"], "b": b["relative_path"], "hamming": d}
        for a, b, d in near_duplicate_pairs(valid, threshold)
    ]

    questionable = []
    for r in valid:
        reasons = questionable_reasons(r)
        if reasons:
            questionable.append({"relative_path": r["relative_path"], "reasons": reasons})

    summary = {
        "folder": folder,
        "total_files": len(files),
        "valid_images": len(valid),
        "unreadable_images": unreadable,
        "non_image_files": non_image,
        "nested_directories": nested_dirs,
        "extensions": dict(Counter(Path(r["relative_path"]).suffix.lower() for r in records)),
        "formats": dict(Counter(r["format"] for r in valid)),
        "exif_rotated": sum(r["exif_rotated"] for r in valid),
        "resolution": summarise_resolution(valid),
        "duplicate_filenames": duplicate_filenames,
        "exact_duplicate_groups": exact_groups,
        "exact_duplicate_redundant_copies": sum(len(g) - 1 for g in exact_groups),
        "near_duplicate_pairs": near_pairs,
        "questionable_candidates": questionable,
    }
    return summary, records


def audit(raw_root: Path, threshold: int) -> tuple[dict, list[dict]]:
    missing = [f for f in SOURCE_FOLDERS if not (raw_root / f).is_dir()]
    if missing:
        raise SystemExit(
            f"Raw source folders not found under {raw_root}: {', '.join(missing)}. "
            "Nothing was audited."
        )

    folders, all_records = {}, []
    for folder in SOURCE_FOLDERS:
        summary, records = audit_folder(folder, raw_root, threshold)
        folders[folder] = summary
        all_records.extend(records)

    valid = [r for r in all_records if r["readable"]]
    by_sha = defaultdict(set)
    for r in valid:
        by_sha[r["sha256"]].add(r["folder"])
    cross_exact = [
        sorted(r["relative_path"] for r in valid if r["sha256"] == sha)
        for sha, owners in by_sha.items()
        if len(owners) > 1
    ]
    cross_near = [
        {"a": a["relative_path"], "b": b["relative_path"], "hamming": d}
        for a, b, d in near_duplicate_pairs(valid, threshold)
        if a["folder"] != b["folder"]
    ]
    names = defaultdict(set)
    for r in all_records:
        names[Path(r["relative_path"]).name.lower()].add(r["folder"])
    cross_names = sorted(name for name, owners in names.items() if len(owners) > 1)

    report = {
        "raw_root": str(raw_root),
        "near_duplicate_hamming_threshold": threshold,
        "folders": folders,
        "cross_folder": {
            "exact_duplicate_groups": cross_exact,
            "near_duplicate_pairs": cross_near,
            "duplicate_filenames": cross_names,
        },
        "totals": {
            "original_images_by_folder": {f: folders[f]["valid_images"] for f in SOURCE_FOLDERS},
            "total_original_images": sum(folders[f]["valid_images"] for f in SOURCE_FOLDERS),
            "total_files": sum(folders[f]["total_files"] for f in SOURCE_FOLDERS),
            "unique_image_contents": len(by_sha),
        },
    }
    return report, all_records


def write_manifest(records: list[dict], path: Path) -> None:
    with path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=MANIFEST_FIELDS, extrasaction="ignore")
        writer.writeheader()
        for r in records:
            row = dict(r)
            if "dhash" in row:
                row["dhash"] = f"{row['dhash']:016x}"
            writer.writerow(row)


def write_scope_review_template(records: list[dict], path: Path) -> None:
    if path.exists():
        return
    with path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=SCOPE_FIELDS)
        writer.writeheader()
        for r in records:
            if r["readable"]:
                writer.writerow({"relative_path": r["relative_path"], "folder": r["folder"], "decision": "pending"})


def render_markdown(report: dict) -> str:
    lines = ["# Raw Image Audit", "", f"Source: `{report['raw_root']}` (read-only)", ""]
    lines += [
        "| Folder | Files | Valid images | Unreadable | Non-image | Nested dirs | Exact dup copies | Near-dup pairs | Questionable |",
        "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
    ]
    for folder, s in report["folders"].items():
        lines.append(
            f"| `{folder}` | {s['total_files']} | {s['valid_images']} | {len(s['unreadable_images'])} | "
            f"{len(s['non_image_files'])} | {len(s['nested_directories'])} | "
            f"{s['exact_duplicate_redundant_copies']} | {len(s['near_duplicate_pairs'])} | "
            f"{len(s['questionable_candidates'])} |"
        )
    totals = report["totals"]
    by_folder = totals["original_images_by_folder"]
    lines += [
        "",
        f"ROAD DAMAGE ORIGINAL IMAGES: {by_folder['damages_road']}",
        f"STREET LIGHT ORIGINAL IMAGES: {by_folder['street_light']}",
        f"CLOGGED DRAINAGE ORIGINAL IMAGES: {by_folder['clogging_drainage']}",
        "",
        f"TOTAL ORIGINAL IMAGES: {totals['total_original_images']}",
        f"UNIQUE IMAGE CONTENTS (SHA-256): {totals['unique_image_contents']}",
        "",
        "Counts are readable files as supplied. They are not a measure of model performance.",
        "",
        "## Per-folder detail",
    ]
    for folder, s in report["folders"].items():
        res = s["resolution"]
        lines += ["", f"### `{folder}`", ""]
        lines.append(f"- Extensions: {s['extensions']}")
        lines.append(f"- Decoded formats: {s['formats']}")
        if res:
            lines.append(
                f"- Width min/median/max: {res['width']['min']}/{res['width']['median']}/{res['width']['max']} px; "
                f"height {res['height']['min']}/{res['height']['median']}/{res['height']['max']} px"
            )
            lines.append(f"- Short side below 640 px: {res['short_side_below_640']}")
        lines.append(f"- EXIF-rotated images: {s['exif_rotated']}")
        lines.append(f"- Duplicate filenames (same stem): {len(s['duplicate_filenames'])}")
        for label, key in (("Unreadable", "unreadable_images"), ("Non-image files", "non_image_files"),
                           ("Nested directories", "nested_directories")):
            if s[key]:
                lines.append(f"- {label}: " + ", ".join(
                    f"`{item['relative_path'] if isinstance(item, dict) else item}`" for item in s[key]))
        for group in s["exact_duplicate_groups"]:
            lines.append("- Exact duplicates: " + ", ".join(f"`{p}`" for p in group))
        for pair in s["near_duplicate_pairs"]:
            lines.append(f"- Possible near duplicate (Hamming {pair['hamming']}): `{pair['a']}` / `{pair['b']}`")
        for item in s["questionable_candidates"]:
            lines.append(f"- Needs scope review: `{item['relative_path']}` ({'; '.join(item['reasons'])})")
    cross = report["cross_folder"]
    lines += ["", "## Cross-folder findings", ""]
    lines.append(f"- Exact duplicates across folders: {len(cross['exact_duplicate_groups'])}")
    for group in cross["exact_duplicate_groups"]:
        lines.append("  - " + ", ".join(f"`{p}`" for p in group))
    lines.append(f"- Possible near duplicates across folders: {len(cross['near_duplicate_pairs'])}")
    for pair in cross["near_duplicate_pairs"]:
        lines.append(f"  - Hamming {pair['hamming']}: `{pair['a']}` / `{pair['b']}`")
    lines.append(f"- Filenames present in more than one folder: {len(cross['duplicate_filenames'])}")
    lines += [
        "",
        "Questionable candidates are heuristic flags only. Final in/out-of-scope decisions are recorded",
        "by a reviewer in `scope_review.csv`.",
        "",
    ]
    return "\n".join(lines)


def verify(raw_root: Path, manifest_path: Path) -> int:
    with manifest_path.open(encoding="utf-8") as handle:
        expected = {row["relative_path"]: row["sha256"] for row in csv.DictReader(handle)}
    current = {}
    for folder in SOURCE_FOLDERS:
        for path in iter_files(raw_root / folder):
            if path.suffix.lower() in IMAGE_SUFFIXES:
                current[path.relative_to(raw_root).as_posix()] = sha256_file(path)
    missing = sorted(set(expected) - set(current))
    added = sorted(set(current) - set(expected))
    changed = sorted(p for p in set(expected) & set(current) if expected[p] != current[p])
    print(f"Checked {len(current)} raw images against {manifest_path}")
    for label, items in (("MISSING", missing), ("CHANGED", changed), ("ADDED", added)):
        for item in items:
            print(f"{label}: {item}")
    if missing or changed:
        print("Raw source data no longer matches the audited manifest.")
        return 1
    print("Raw source data unchanged." + (" New files need auditing." if added else ""))
    return 0


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--raw-root", type=Path, default=RAW_ROOT)
    parser.add_argument("--output", type=Path, default=NEW_DATASET_ROOT / "audit")
    parser.add_argument("--near-duplicate-threshold", type=int, default=6)
    parser.add_argument("--verify", action="store_true", help="compare raw files with an existing raw_manifest.csv")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    manifest_path = args.output / "raw_manifest.csv"
    if args.verify:
        return verify(args.raw_root, manifest_path)

    report, records = audit(args.raw_root, args.near_duplicate_threshold)
    args.output.mkdir(parents=True, exist_ok=True)
    (args.output / "raw_audit.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
    (args.output / "RAW_AUDIT.md").write_text(render_markdown(report), encoding="utf-8")
    write_manifest(records, manifest_path)
    write_scope_review_template(records, args.output / "scope_review.csv")

    totals = report["totals"]
    for folder, count in totals["original_images_by_folder"].items():
        print(f"{folder}: {count} valid images")
    print(f"TOTAL ORIGINAL IMAGES: {totals['total_original_images']}")
    print(f"Report written to {args.output}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
