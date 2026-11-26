"""
Neighborlens AI Phase 2: Controlled YOLOv8 Baseline Experiment Runner
=======================================================================
Objective:
Train and evaluate a reproducible, academically defensible YOLOv8m baseline
model using data/datasets/neighborlens_v2/data.yaml.

Constraints:
- Dataset: data/datasets/neighborlens_v2/data.yaml (Frozen)
- Model: yolov8m.pt (Standard COCO pretrained YOLOv8 medium)
- Destination: models/checkpoints/neighborlens_v8_baseline_v2/
- Epochs: 80
- Patience: 80
- Imgsz: 800
- Batch: -1 (autoBatch) with safe fallback to 16
- Device: 0 (CUDA NVIDIA GeForce RTX 3060)
- Workers: 0 (Windows multiprocessing stability)
"""

import os
import sys
import time
import json
import shutil
import datetime
from pathlib import Path

import torch
import cv2
import numpy as np

def run_phase2_baseline():
    root_dir = Path(__file__).resolve().parents[2]
    data_yaml = root_dir / "data" / "datasets" / "neighborlens_v2" / "data.yaml"
    output_dir = root_dir / "models" / "checkpoints" / "neighborlens_v8_baseline_v2"

    print("=" * 80)
    print("Neighborlens AI Phase 2: Controlled YOLOv8 Baseline Training")
    print("=" * 80)

    # Pre-condition check: output directory must not exist
    if output_dir.exists():
        print(f"[ERROR] Experiment directory {output_dir} already exists. Refusing to overwrite.")
        sys.exit(1)

    # Pre-condition check: dataset YAML must exist
    if not data_yaml.exists():
        print(f"[ERROR] Dataset configuration {data_yaml} does not exist.")
        sys.exit(1)

    import ultralytics
    from ultralytics import YOLO

    env_info = {
        "start_time": datetime.datetime.now().isoformat(),
        "python_version": sys.version,
        "torch_version": torch.__version__,
        "ultralytics_version": ultralytics.__version__,
        "cuda_available": torch.cuda.is_available(),
        "cuda_device_name": torch.cuda.get_device_name(0) if torch.cuda.is_available() else "CPU",
        "cuda_device_count": torch.cuda.device_count(),
        "total_vram_gb": torch.cuda.get_device_properties(0).total_memory / (1024**3) if torch.cuda.is_available() else 0,
        "model_file": "yolov8m.pt",
        "data_yaml": str(data_yaml),
        "imgsz": 800,
        "epochs": 80,
        "patience": 80,
        "seed": 0
    }
    print("\n--- Environment & Hardware ---")
    for k, v in env_info.items():
        print(f"  {k}: {v}")

    print("\n--- Initializing Model ---")
    model = YOLO(str(root_dir / "models" / "checkpoints" / "yolov8m.pt"))

    start_train = time.time()
    print("\n--- Commencing Training Run ---")
    
    # Run standard YOLOv8 training (batch=-1 triggers Ultralytics autoBatch)
    train_results = model.train(
        data=str(data_yaml),
        epochs=80,
        patience=80,
        imgsz=800,
        batch=-1,
        device=0 if torch.cuda.is_available() else "cpu",
        workers=0,
        project=str(root_dir / "models" / "checkpoints"),
        name="neighborlens_v8_baseline_v2",
        exist_ok=False,
        save=True,
        plots=True,
        seed=0,
        deterministic=True
    )
    train_duration = time.time() - start_train
    print(f"\n[TRAINING COMPLETE] Elapsed time: {train_duration/60:.2f} minutes.")

    # Locate best.pt
    best_weights = output_dir / "weights" / "best.pt"
    if not best_weights.exists():
        print(f"[WARNING] best.pt not found at {best_weights}. Checking last.pt...")
        best_weights = output_dir / "weights" / "last.pt"

    print(f"\n--- Loading Best Checkpoint: {best_weights} ---")
    eval_model = YOLO(str(best_weights))

    # 1. Evaluate on Validation Split
    print("\n--- Evaluating on Validation Split (val) ---")
    val_metrics = eval_model.val(
        data=str(data_yaml),
        split="val",
        imgsz=800,
        device=0 if torch.cuda.is_available() else "cpu",
        workers=0,
        plots=True,
        save_json=True
    )

    # 2. Evaluate on Test Split
    print("\n--- Evaluating on Test Split (test) ---")
    test_metrics = eval_model.val(
        data=str(data_yaml),
        split="test",
        imgsz=800,
        device=0 if torch.cuda.is_available() else "cpu",
        workers=0,
        plots=True,
        save_json=True
    )

    # Compile Evaluation Summary
    results_summary = {
        "env_info": env_info,
        "train_duration_seconds": train_duration,
        "best_weights": str(best_weights),
        "validation_results": {
            "precision": float(val_metrics.box.mp),
            "recall": float(val_metrics.box.mr),
            "mAP50": float(val_metrics.box.map50),
            "mAP50_95": float(val_metrics.box.map),
            "class_metrics": {}
        },
        "test_results": {
            "precision": float(test_metrics.box.mp),
            "recall": float(test_metrics.box.mr),
            "mAP50": float(test_metrics.box.map50),
            "mAP50_95": float(test_metrics.box.map),
            "class_metrics": {}
        }
    }

    class_names = {
        0: "damaged_road",
        1: "clogged_drainage",
        2: "damaged_street_light",
        3: "damaged_traffic_light"
    }

    # Per-class metrics for validation
    for i, cid in enumerate(val_metrics.box.ap_class_index):
        cname = class_names.get(int(cid), str(cid))
        results_summary["validation_results"]["class_metrics"][cname] = {
            "precision": float(val_metrics.box.p[i]),
            "recall": float(val_metrics.box.r[i]),
            "mAP50": float(val_metrics.box.ap50[i]),
            "mAP50_95": float(val_metrics.box.ap[i]),
            "f1": float(val_metrics.box.f1[i]) if hasattr(val_metrics.box, "f1") and len(val_metrics.box.f1) > i else None
        }

    # Per-class metrics for test
    for i, cid in enumerate(test_metrics.box.ap_class_index):
        cname = class_names.get(int(cid), str(cid))
        results_summary["test_results"]["class_metrics"][cname] = {
            "precision": float(test_metrics.box.p[i]),
            "recall": float(test_metrics.box.r[i]),
            "mAP50": float(test_metrics.box.ap50[i]),
            "mAP50_95": float(test_metrics.box.ap[i]),
            "f1": float(test_metrics.box.f1[i]) if hasattr(test_metrics.box, "f1") and len(test_metrics.box.f1) > i else None
        }

    summary_file = output_dir / "baseline_results_summary.json"
    with open(summary_file, "w", encoding="utf-8") as f:
        json.dump(results_summary, f, indent=2)
    print(f"\n[SUMMARY SAVED] Results written to {summary_file}")

    return results_summary

if __name__ == "__main__":
    run_phase2_baseline()
