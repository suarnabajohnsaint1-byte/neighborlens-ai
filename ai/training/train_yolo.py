from __future__ import annotations

import argparse
import csv
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[2]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from ai.preprocessing.dataset_integrity_gate import assert_dataset_ready
from ai.training.checkpoint_io import use_atomic_checkpoint_writes

DEFAULT_DATA = PROJECT_ROOT / "data" / "datasets" / "neighborlens_paper_aligned_v3_1_remediated" / "data.yaml"
DEFAULT_PROJECT = PROJECT_ROOT / "models" / "checkpoints"
DEFAULT_WEIGHTS_FILE = PROJECT_ROOT / "models" / "checkpoints" / "yolov8m.pt"
DEFAULT_RUN_NAME = "neighborlens_v3_clean_yolov8m"
SEED = 42

HARDWARE_PROFILE = {
    "gpu": "NVIDIA RTX 3060 12GB",
    "imgsz": 640,
    "batch": 8,
    "epochs": 150,
    "patience": 30,
    "workers_windows": 0,
    "workers_other": 4,
    "amp": True,
}

AUGMENTATION = {
    "hsv_h": 0.015,
    "hsv_s": 0.5,
    "hsv_v": 0.35,
    "degrees": 5.0,
    "translate": 0.1,
    "scale": 0.4,
    "shear": 0.0,
    "perspective": 0.0005,
    "flipud": 0.0,
    "fliplr": 0.5,
    "mosaic": 1.0,
    "mixup": 0.0,
    "copy_paste": 0.0,
    "close_mosaic": 15,
}


def parse_args(argv=None):
    parser = argparse.ArgumentParser(description="Train NeighborLens YOLOv8 on the scene-grouped clean dataset")
    parser.add_argument("--data", type=Path, default=DEFAULT_DATA)
    parser.add_argument("--model", default=None)
    parser.add_argument("--epochs", type=int, default=HARDWARE_PROFILE["epochs"])
    parser.add_argument("--patience", type=int, default=HARDWARE_PROFILE["patience"])
    parser.add_argument("--imgsz", type=int, default=HARDWARE_PROFILE["imgsz"])
    parser.add_argument("--batch", type=int, default=HARDWARE_PROFILE["batch"])
    parser.add_argument("--workers", type=int, default=None)
    parser.add_argument("--seed", type=int, default=SEED)
    parser.add_argument("--device", default="0")
    parser.add_argument("--project", type=Path, default=DEFAULT_PROJECT)
    parser.add_argument("--name", default=DEFAULT_RUN_NAME)
    parser.add_argument("--save-period", type=int, default=10)
    parser.add_argument("--resume", action="store_true")
    parser.add_argument("--check-only", action="store_true")
    parser.add_argument("--allow-cpu", action="store_true")
    parser.add_argument("--baseline-insufficient-support", action="store_true")
    return parser.parse_args(argv)


def resolve_workers(requested):
    if requested is not None:
        return requested
    return HARDWARE_PROFILE["workers_windows"] if os.name == "nt" else HARDWARE_PROFILE["workers_other"]


def resolve_model(requested):
    if requested:
        return requested
    if DEFAULT_WEIGHTS_FILE.is_file():
        return str(DEFAULT_WEIGHTS_FILE)
    return "yolov8m.pt"


def build_train_kwargs(args, data_path, device):
    kwargs = {
        "data": str(data_path),
        "epochs": args.epochs,
        "patience": args.patience,
        "imgsz": args.imgsz,
        "batch": args.batch,
        "device": device,
        "workers": resolve_workers(args.workers),
        "project": str(args.project),
        "name": args.name,
        "exist_ok": True,
        "pretrained": True,
        "optimizer": "AdamW",
        "lr0": 0.001,
        "cos_lr": True,
        "weight_decay": 0.0005,
        "warmup_epochs": 3.0,
        "amp": HARDWARE_PROFILE["amp"],
        "seed": args.seed,
        "deterministic": True,
        "val": True,
        "save": True,
        "save_period": args.save_period,
        "plots": True,
        "cache": False,
    }
    kwargs.update(AUGMENTATION)
    return kwargs


def summarise_results(results_csv):
    results_csv = Path(results_csv)
    if not results_csv.is_file():
        return None
    with results_csv.open("r", encoding="utf-8", newline="") as handle:
        rows = [{key.strip(): value.strip() for key, value in row.items()} for row in csv.DictReader(handle)]
    if not rows:
        return None

    def number(row, key):
        try:
            return float(row[key])
        except (KeyError, ValueError):
            return float("nan")

    best = max(rows, key=lambda row: 0.1 * number(row, "metrics/mAP50(B)") + 0.9 * number(row, "metrics/mAP50-95(B)"))
    keys = ("metrics/precision(B)", "metrics/recall(B)", "metrics/mAP50(B)", "metrics/mAP50-95(B)")
    return {
        "epochs_completed": len(rows),
        "best_epoch": int(float(best["epoch"])),
        "best_validation": {key: number(best, key) for key in keys},
        "last_validation": {key: number(rows[-1], key) for key in keys},
        "note": "Validation metrics only. Held-out test metrics are produced by the separate evaluation step.",
    }


def run_dataset_gates(dataset_root, baseline_insufficient_support=False):
    try:
        return assert_dataset_ready(dataset_root, readiness=True), True
    except SystemExit as failure:
        if not baseline_insufficient_support:
            raise
        print(f"{failure}\nContinuing as a BASELINE run: results are not eligible for the 0.75 mAP50 target claim.")
    return assert_dataset_ready(dataset_root, readiness=False), False


def relative_to_project(path):
    path = Path(path).resolve()
    try:
        return str(path.relative_to(PROJECT_ROOT))
    except ValueError:
        return path.name


def main():
    args = parse_args()
    data_path = args.data.resolve()
    if not data_path.is_file():
        raise SystemExit(f"Dataset YAML not found: {data_path}")

    gate_report, target_eligible = run_dataset_gates(data_path.parent, args.baseline_insufficient_support)
    print(f"Dataset {gate_report['mode']} gate: PASSED (target_eligible={target_eligible})")

    import torch

    cuda_available = torch.cuda.is_available()
    print(f"CUDA available: {cuda_available}")
    if cuda_available:
        print(f"GPU: {torch.cuda.get_device_name(0)}")
    if not cuda_available and not args.allow_cpu:
        raise SystemExit("CUDA is not available. Install a CUDA build of PyTorch or pass --allow-cpu.")
    device = args.device if cuda_available else "cpu"

    run_dir = args.project / args.name
    train_kwargs = build_train_kwargs(args, data_path, device)

    if args.check_only:
        print(json.dumps({key: value for key, value in train_kwargs.items() if key not in ("project",)}, indent=2))
        print("Check-only mode: training not started.")
        return

    from ultralytics import YOLO

    if args.resume:
        last = run_dir / "weights" / "last.pt"
        if not last.is_file():
            raise SystemExit(f"No checkpoint to resume at {last}")
        model = YOLO(str(last))
        model.add_callback("on_pretrain_routine_start", use_atomic_checkpoint_writes)
        model.train(resume=True)
    else:
        if run_dir.exists():
            raise SystemExit(f"Run directory already exists: {run_dir}. Use --resume or a new --name.")
        model = YOLO(resolve_model(args.model))
        run_dir.mkdir(parents=True, exist_ok=True)
        (run_dir / "train_config.json").write_text(
            json.dumps(
                {
                    "started_utc": datetime.now(timezone.utc).isoformat(),
                    "data": relative_to_project(data_path),
                    "model": relative_to_project(resolve_model(args.model)) if args.model is None else args.model,
                    "train_kwargs": {
                        key: (relative_to_project(value) if key in ("data", "project") else value)
                        for key, value in train_kwargs.items()
                    },
                    "dataset_gate": {
                        "mode": gate_report["mode"],
                        "passed": gate_report["passed"],
                        "overlap_counts": gate_report["overlap_counts"],
                    },
                    "target_eligible": target_eligible,
                },
                indent=2,
            ),
            encoding="utf-8",
        )
        model.add_callback("on_pretrain_routine_start", use_atomic_checkpoint_writes)
        model.train(**train_kwargs)

    summary = summarise_results(run_dir / "results.csv")
    if summary is not None:
        (run_dir / "validation_summary.json").write_text(json.dumps(summary, indent=2), encoding="utf-8")
        print(json.dumps(summary, indent=2))
    best = run_dir / "weights" / "best.pt"
    if not best.is_file():
        raise SystemExit(f"Training finished but best.pt not found at {best}")
    print(f"Best validation checkpoint: {best}")
    print("Held-out test evaluation has NOT been run. Run the Task 2 evaluation step once.")


if __name__ == "__main__":
    main()
