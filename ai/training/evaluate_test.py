"""Evaluate trained weights on the frozen test split and report overall and per-class metrics.

Every call is appended to the dataset's test_evaluations.jsonl so the number of
times the test set was consulted stays visible. Use the val split for model selection.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

import yaml

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "preprocessing"))

from build_dataset import label_digest, parse_label_file  # noqa: E402
from raw_images import NEW_DATASET_ROOT  # noqa: E402


DATASET_DIR = NEW_DATASET_ROOT / "neighborlens"
METRICS = ("precision", "recall", "f1", "map50", "map50_95")
IMAGE_SUFFIXES = {".jpg", ".jpeg", ".png", ".webp", ".bmp"}


def f1_score(precision: float, recall: float) -> float:
    return (
        2 * precision * recall / (precision + recall)
        if precision + recall > 0
        else 0.0
    )


def verify_roboflow_test(
    dataset_dir: Path,
    names: dict[int, str],
) -> tuple[dict[str, int], str, int]:
    image_dir = dataset_dir / "test" / "images"
    label_dir = dataset_dir / "test" / "labels"

    if not image_dir.is_dir() or not label_dir.is_dir():
        raise SystemExit(
            "Roboflow test/images or test/labels directory not found."
        )

    image_files = sorted(
        path
        for path in image_dir.iterdir()
        if path.is_file() and path.suffix.lower() in IMAGE_SUFFIXES
    )

    label_files = sorted(
        path
        for path in label_dir.iterdir()
        if path.is_file() and path.suffix.lower() == ".txt"
    )

    if not image_files:
        raise SystemExit("Roboflow test split contains no images.")

    image_stems = {path.stem for path in image_files}
    label_stems = {path.stem for path in label_files}

    missing_labels = image_stems - label_stems
    orphan_labels = label_stems - image_stems

    if missing_labels:
        raise SystemExit(
            f"Test images without label files: {sorted(missing_labels)}"
        )

    if orphan_labels:
        raise SystemExit(
            f"Test labels without images: {sorted(orphan_labels)}"
        )

    instances: dict[str, int] = {
        name: 0 for name in names.values()
    }

    digest = hashlib.sha256()

    for image_path in image_files:
        label_path = label_dir / f"{image_path.stem}.txt"

        boxes = parse_label_file(
            label_path,
            set(names),
        )

        for class_id, *_ in boxes:
            if class_id not in names:
                raise SystemExit(
                    f"Invalid class ID {class_id} in {label_path}"
                )

            instances[names[class_id]] += 1

        for path in (image_path, label_path):
            relative_path = path.relative_to(dataset_dir).as_posix()

            digest.update(relative_path.encode("utf-8"))
            digest.update(b"\0")
            digest.update(path.read_bytes())
            digest.update(b"\0")

    return instances, digest.hexdigest(), len(image_files)


def verify_test_freeze(
    dataset_dir: Path,
    names: dict[int, str],
) -> dict[str, int]:
    freeze_path = dataset_dir / "test_freeze.json"

    if not freeze_path.exists():
        raise SystemExit(
            f"{freeze_path} not found; "
            "the test split was not built by build_dataset.py."
        )

    frozen = {
        entry[0]: entry[3]
        for entry in json.loads(
            freeze_path.read_text(encoding="utf-8")
        )["items"]
    }

    image_dir = dataset_dir / "images" / "test"
    label_dir = dataset_dir / "labels" / "test"

    current_images = {
        path.name
        for path in image_dir.iterdir()
        if path.is_file()
    }

    if current_images != set(frozen):
        raise SystemExit(
            "images/test does not match test_freeze.json; "
            "the test split was modified."
        )

    instances = {
        name: 0 for name in names.values()
    }

    for image_name, digest in frozen.items():
        label_path = (
            label_dir / image_name
        ).with_suffix(".txt")

        boxes = parse_label_file(
            label_path,
            set(names),
        )

        if label_digest(boxes) != digest:
            raise SystemExit(
                f"Label for {image_name} differs from the frozen test labels."
            )

        for class_id, *_ in boxes:
            instances[names[class_id]] += 1

    return instances


def collect_metrics(
    box,
    names: dict[int, str],
    instances: dict[str, int],
) -> dict:
    per_class = {}

    for position, class_id in enumerate(box.ap_class_index):
        name = names[int(class_id)]

        precision = float(box.p[position])
        recall = float(box.r[position])

        per_class[name] = {
            "instances": instances[name],
            "precision": precision,
            "recall": recall,
            "f1": f1_score(precision, recall),
            "map50": float(box.ap50[position]),
            "map50_95": float(box.ap[position]),
        }

    for name, count in instances.items():
        per_class.setdefault(
            name,
            {
                "instances": count,
                "note": "no test instances; metrics undefined",
            },
        )

    overall = {
        "instances": sum(instances.values()),
        "precision": float(box.mp),
        "recall": float(box.mr),
        "f1": f1_score(
            float(box.mp),
            float(box.mr),
        ),
        "map50": float(box.map50),
        "map50_95": float(box.map),
    }

    return {
        "overall": overall,
        "per_class": per_class,
    }


def target_check(
    results: dict,
    criterion: str,
    target: float,
) -> dict:
    rows = {
        "overall": results["overall"],
        **results["per_class"],
    }

    return {
        name: (
            None
            if criterion not in row
            else row[criterion] >= target
        )
        for name, row in rows.items()
    }


def render_markdown(record: dict) -> str:
    results = record["results"]

    lines = [
        "# Test Split Evaluation",
        "",
        f"- Weights: `{record['weights']}`",
        f"- Evaluated: {record['timestamp']}",
        f"- Dataset source: `{record['dataset_source']}`",
        f"- Class mapping status: `{record['class_mapping_status']}`",
        f"- Test images: {record['test_images']}",
        f"- Test set SHA-256: `{record['test_set_sha256'] or 'legacy freeze manifest'}`",
        f"- conf={record['conf']}, iou={record['iou']}, imgsz={record['imgsz']}",
        "",
        "| Class | Instances | Precision | Recall | F1 | mAP@0.5 | mAP@0.5:0.95 |",
        "| --- | ---: | ---: | ---: | ---: | ---: | ---: |",
    ]

    rows = {
        "overall": results["overall"],
        **results["per_class"],
    }

    for name, row in rows.items():
        if "precision" in row:
            values = " | ".join(
                f"{row[metric]:.4f}"
                for metric in METRICS
            )
        else:
            values = " | ".join(
                "n/a"
                for _ in METRICS
            )

        lines.append(
            f"| {name} | {row['instances']} | {values} |"
        )

    criterion = record["criterion"]
    target = record["target"]

    lines += [
        "",
        (
            f"Target: {criterion} >= {target:.2f} "
            "(criterion must match the panel-approved definition)."
        ),
        "",
    ]

    for name, passed in record["target_met"].items():
        status = (
            "not measurable"
            if passed is None
            else "met"
            if passed
            else "not met"
        )

        lines.append(f"- {name}: {status}")

    lines += [
        "",
        (
            "Overall precision/recall are class means at the confidence "
            "that maximises mean F1; overall F1 is"
        ),
        (
            "their harmonic mean. These are detection metrics, "
            "not classification accuracy."
        ),
        "",
    ]

    return "\n".join(lines)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=__doc__.splitlines()[0]
    )

    parser.add_argument(
        "--weights",
        type=Path,
        required=True,
    )

    parser.add_argument(
        "--data",
        type=Path,
        default=DATASET_DIR / "data.yaml",
    )

    parser.add_argument(
        "--imgsz",
        type=int,
        default=640,
    )

    parser.add_argument(
        "--conf",
        type=float,
        default=0.001,
    )

    parser.add_argument(
        "--iou",
        type=float,
        default=0.7,
    )

    parser.add_argument(
        "--device",
        default=None,
    )

    parser.add_argument(
        "--criterion",
        choices=METRICS,
        default="map50",
    )

    parser.add_argument(
        "--target",
        type=float,
        default=0.75,
    )

    parser.add_argument(
        "--output",
        type=Path,
        default=None,
        help="defaults to <run>/test_evaluation",
    )

    return parser.parse_args()


def main() -> int:
    args = parse_args()

    args.data = args.data.resolve()
    args.weights = args.weights.resolve()

    if args.output is not None:
        args.output = args.output.resolve()

    if not args.data.exists():
        raise SystemExit(
            f"Dataset YAML not found: {args.data}"
        )

    if not args.weights.exists():
        raise SystemExit(
            f"Model weights not found: {args.weights}"
        )

    data = yaml.safe_load(
        args.data.read_text(encoding="utf-8")
    )

    raw_names = data["names"]

    if isinstance(raw_names, list):
        names = {
            class_id: name
            for class_id, name in enumerate(raw_names)
        }
    else:
        names = {
            int(class_id): name
            for class_id, name in raw_names.items()
        }

    dataset_dir = args.data.parent

    test_freeze = dataset_dir / "test_freeze.json"
    roboflow_test_dir = dataset_dir / "test" / "images"

    test_set_sha256 = None
    dataset_source = "legacy"
    roboflow_metadata = {}
    test_images = 0

    if test_freeze.exists():
        instances = verify_test_freeze(
            dataset_dir,
            names,
        )

        split_manifest_path = (
            dataset_dir / "split_manifest.json"
        )

        if not split_manifest_path.exists():
            raise SystemExit(
                f"{split_manifest_path} not found."
            )

        split_manifest = json.loads(
            split_manifest_path.read_text(
                encoding="utf-8"
            )
        )

        mapping_status = (
            split_manifest["class_mapping_status"]
        )

        test_image_dir = (
            dataset_dir / "images" / "test"
        )

        test_images = len(
            [
                path
                for path in test_image_dir.iterdir()
                if path.is_file()
            ]
        )

    elif roboflow_test_dir.is_dir():
        (
            instances,
            test_set_sha256,
            test_images,
        ) = verify_roboflow_test(
            dataset_dir,
            names,
        )

        mapping_status = "data_yaml_verified"
        dataset_source = "roboflow"

        roboflow = data.get("roboflow", {})

        roboflow_metadata = {
            "roboflow_workspace": roboflow.get(
                "workspace"
            ),
            "roboflow_project": roboflow.get(
                "project"
            ),
            "roboflow_version": roboflow.get(
                "version"
            ),
        }

    else:
        raise SystemExit(
            "No supported frozen test dataset layout found."
        )

    import torch
    from ultralytics import YOLO

    output = (
        args.output
        or args.weights.parent.parent / "test_evaluation"
    )

    if output.exists():
        raise SystemExit(
            f"{output} already exists; "
            "earlier test evaluations are kept. "
            "Pass a new --output."
        )

    device = args.device or (
        "0"
        if torch.cuda.is_available()
        else "cpu"
    )

    metrics = YOLO(
        str(args.weights)
    ).val(
        data=str(args.data),
        split="test",
        imgsz=args.imgsz,
        conf=args.conf,
        iou=args.iou,
        device=device,
        plots=True,
        project=str(output.parent),
        name=output.name,
        exist_ok=False,
    )

    results = collect_metrics(
        metrics.box,
        names,
        instances,
    )

    record = {
        "timestamp": datetime.now(
            timezone.utc
        ).isoformat(timespec="seconds"),
        "weights": str(args.weights),
        "data": str(args.data),
        "dataset_source": dataset_source,
        "class_mapping_status": mapping_status,
        "test_images": test_images,
        "test_set_sha256": test_set_sha256,
        **roboflow_metadata,
        "imgsz": args.imgsz,
        "conf": args.conf,
        "iou": args.iou,
        "criterion": args.criterion,
        "target": args.target,
        "results": results,
        "target_met": target_check(
            results,
            args.criterion,
            args.target,
        ),
    }

    output.mkdir(
        parents=True,
        exist_ok=True,
    )

    (output / "evaluation.json").write_text(
        json.dumps(
            record,
            indent=2,
        ),
        encoding="utf-8",
    )

    (output / "EVALUATION.md").write_text(
        render_markdown(record),
        encoding="utf-8",
    )

    with (
        dataset_dir / "test_evaluations.jsonl"
    ).open(
        "a",
        encoding="utf-8",
    ) as log:
        log.write(
            json.dumps(
                {
                    key: record[key]
                    for key in (
                        "timestamp",
                        "weights",
                        "criterion",
                        "target",
                    )
                }
                | {
                    "dataset_source": dataset_source,
                    "test_set_sha256": test_set_sha256,
                    "overall": results["overall"],
                }
            )
            + "\n"
        )

    print(
        render_markdown(record)
    )

    return 0


if __name__ == "__main__":
    sys.exit(main())
