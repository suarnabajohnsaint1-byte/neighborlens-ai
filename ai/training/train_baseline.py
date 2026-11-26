"""Train a reproducible YOLOv8 run on data/processed/neighborlens. Model selection uses the val split only."""

from __future__ import annotations

import argparse
import hashlib
import json
import platform
import subprocess
import sys
from pathlib import Path

import yaml

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "preprocessing"))

from raw_images import NEW_DATASET_ROOT, PROJECT_ROOT  # noqa: E402

DATASET_DIR = NEW_DATASET_ROOT / "neighborlens"
RESERVED_KEYS = {"data", "split", "project", "name", "exist_ok", "seed", "deterministic"}


def file_sha256(path: Path) -> str | None:
    return hashlib.sha256(path.read_bytes()).hexdigest() if path.exists() else None


def git_commit() -> str | None:
    try:
        return subprocess.run(
            ["git", "rev-parse", "HEAD"], cwd=PROJECT_ROOT, capture_output=True, text=True, check=True
        ).stdout.strip()
    except (OSError, subprocess.CalledProcessError):
        return None


def load_overrides(path: Path | None) -> dict:
    if path is None:
        return {}
    overrides = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    reserved = RESERVED_KEYS & set(overrides)
    if reserved:
        raise SystemExit(f"Overrides may not set {sorted(reserved)}")
    return overrides


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data", type=Path, default=DATASET_DIR / "data.yaml")
    parser.add_argument("--model", default=str(PROJECT_ROOT / "models" / "checkpoints" / "yolov8m.pt"))
    parser.add_argument("--epochs", type=int, default=100)
    parser.add_argument("--imgsz", type=int, default=640)
    parser.add_argument("--batch", type=int, default=16)
    parser.add_argument("--patience", type=int, default=25)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--device", default=None, help="CUDA index such as 0, or cpu")
    parser.add_argument("--project", type=Path, default=PROJECT_ROOT / "models" / "checkpoints")
    parser.add_argument("--name", default="neighborlens_3class_baseline")
    parser.add_argument("--overrides", type=Path, default=None,
                        help="YAML of extra Ultralytics train arguments for a controlled experiment")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if not args.data.exists():
        raise SystemExit(f"{args.data} not found. Run build_dataset.py first.")
    run_dir = args.project / args.name
    if run_dir.exists():
        raise SystemExit(f"{run_dir} already exists. Use a new --name so earlier evidence is kept.")

    import torch
    import ultralytics
    from ultralytics import YOLO

    device = args.device or ("0" if torch.cuda.is_available() else "cpu")
    overrides = load_overrides(args.overrides)
    train_args = {
        "data": str(args.data),
        "epochs": args.epochs,
        "imgsz": args.imgsz,
        "batch": args.batch,
        "patience": args.patience,
        "device": device,
        "project": str(args.project),
        "name": args.name,
        "exist_ok": False,
        "seed": args.seed,
        "deterministic": True,
        "pretrained": True,
        "plots": True,
        **overrides,
    }

    model = YOLO(args.model)
    model.train(**train_args)

    dataset_dir = args.data.parent
    record = {
        "model": args.model,
        "train_args": train_args,
        "overrides_file": str(args.overrides) if args.overrides else None,
        "data_yaml_sha256": file_sha256(args.data),
        "split_manifest_sha256": file_sha256(dataset_dir / "split_manifest.json"),
        "test_freeze_sha256": file_sha256(dataset_dir / "test_freeze.json"),
        "git_commit": git_commit(),
        "versions": {
            "python": platform.python_version(),
            "torch": torch.__version__,
            "ultralytics": ultralytics.__version__,
            "cuda": torch.version.cuda,
        },
    }
    (run_dir / "experiment.json").write_text(json.dumps(record, indent=2), encoding="utf-8")
    print(f"Run saved to {run_dir}. Evaluate on the test split with evaluate_test.py once model selection is final.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
