"""
Neighborlens AI Phase 3B: Experiment E-2 Runner
=================================================
Objective:
Evaluate high-resolution spatial scaling (imgsz=1024) with YOLOv8m on the
frozen data/datasets/neighborlens_v2/data.yaml.

Controlled Variable:
- imgsz: 800 -> 1024
- batch: 16 -> 8 (Necessary hardware resource constraint for 12GB VRAM headroom)

Frozen Baseline Controls:
- Model: yolov8m.pt (COCO pretrained)
- Dataset: data/datasets/neighborlens_v2/data.yaml (Frozen)
- Epochs: 80
- Patience: 80
- Seed: 0
- Deterministic: True
- Workers: 0
- Device: 0 (NVIDIA RTX 3060)
- Optimizer: auto (AdamW baseline)
- Augmentations: Exact Ultralytics defaults as baseline
"""

import os
import sys
import time
import json
import datetime
from pathlib import Path

import torch

def run_phase3_e2():
    root_dir = Path(__file__).resolve().parents[2]
    data_yaml = root_dir / "data" / "datasets" / "neighborlens_v2" / "data.yaml"
    output_dir = root_dir / "models" / "checkpoints" / "neighborlens_v8_phase3_e2_1024"

    print("=" * 80)
    print("Neighborlens AI Phase 3B: Experiment E-2 (High-Resolution 1024x1024)")
    print("=" * 80)

    if output_dir.exists():
        print(f"[ERROR] Experiment directory {output_dir} already exists. Refusing to overwrite.")
        sys.exit(1)

    if not data_yaml.exists():
        print(f"[ERROR] Dataset configuration {data_yaml} does not exist.")
        sys.exit(1)

    import ultralytics
    from ultralytics import YOLO

    env_info = {
        "experiment_id": "E-2",
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
        "imgsz": 1024,
        "batch": 8,
        "epochs": 80,
        "patience": 80,
        "seed": 0,
        "deterministic": True
    }
    print("\n--- Environment & Configuration ---")
    for k, v in env_info.items():
        print(f"  {k}: {v}")

    print("\n--- Loading Model: yolov8m.pt ---")
    model = YOLO(str(root_dir / "models" / "checkpoints" / "yolov8m.pt"))

    start_train = time.time()
    print("\n--- Commencing E-2 Training Run (imgsz=1024, batch=8, epochs=80) ---")
    
    train_results = model.train(
        data=str(data_yaml),
        epochs=80,
        patience=80,
        imgsz=1024,
        batch=8,
        device=0 if torch.cuda.is_available() else "cpu",
        workers=0,
        project=str(root_dir / "models" / "checkpoints"),
        name="neighborlens_v8_phase3_e2_1024",
        exist_ok=False,
        save=True,
        plots=True,
        seed=0,
        deterministic=True
    )
    train_duration = time.time() - start_train
    print(f"\n[TRAINING COMPLETE] Elapsed time: {train_duration/60:.2f} minutes.")

    best_weights = output_dir / "weights" / "best.pt"
    if not best_weights.exists():
        print(f"[WARNING] best.pt not found at {best_weights}. Checking last.pt...")
        best_weights = output_dir / "weights" / "last.pt"

    print(f"\n--- Loading Best Checkpoint: {best_weights} ---")
    eval_model = YOLO(str(best_weights))

    # 1. Validation Split Evaluation (standard confidence)
    print("\n--- Evaluating on Validation Split (val, imgsz=1024) ---")
    val_metrics = eval_model.val(
        data=str(data_yaml),
        split="val",
        imgsz=1024,
        device=0 if torch.cuda.is_available() else "cpu",
        workers=0,
        plots=True,
        save_json=True
    )

    # 2. Test Split Evaluation (standard confidence)
    print("\n--- Evaluating on Test Split (test, imgsz=1024) ---")
    test_metrics = eval_model.val(
        data=str(data_yaml),
        split="test",
        imgsz=1024,
        device=0 if torch.cuda.is_available() else "cpu",
        workers=0,
        plots=True,
        save_json=True
    )

    # 3. Test Split Evaluation at Calibrated Operating Point (conf=0.10)
    print("\n--- Evaluating on Test Split at Calibrated Conf 0.10 (test, imgsz=1024) ---")
    test_metrics_conf10 = eval_model.val(
        data=str(data_yaml),
        split="test",
        conf=0.10,
        imgsz=1024,
        device=0 if torch.cuda.is_available() else "cpu",
        workers=0,
        plots=False,
        save_json=False
    )

    class_names = {
        0: "damaged_road",
        1: "clogged_drainage",
        2: "damaged_street_light",
        3: "damaged_traffic_light"
    }

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
        },
        "test_results_conf10": {
            "precision": float(test_metrics_conf10.box.mp),
            "recall": float(test_metrics_conf10.box.mr),
            "mAP50": float(test_metrics_conf10.box.map50),
            "mAP50_95": float(test_metrics_conf10.box.map),
            "class_metrics": {}
        }
    }

    # Populate per-class for val
    for i, cid in enumerate(val_metrics.box.ap_class_index):
        cname = class_names.get(int(cid), str(cid))
        results_summary["validation_results"]["class_metrics"][cname] = {
            "precision": float(val_metrics.box.p[i]),
            "recall": float(val_metrics.box.r[i]),
            "mAP50": float(val_metrics.box.ap50[i]),
            "mAP50_95": float(val_metrics.box.ap[i]),
            "f1": float(val_metrics.box.f1[i]) if hasattr(val_metrics.box, "f1") and len(val_metrics.box.f1) > i else None
        }

    # Populate per-class for test
    for i, cid in enumerate(test_metrics.box.ap_class_index):
        cname = class_names.get(int(cid), str(cid))
        results_summary["test_results"]["class_metrics"][cname] = {
            "precision": float(test_metrics.box.p[i]),
            "recall": float(test_metrics.box.r[i]),
            "mAP50": float(test_metrics.box.ap50[i]),
            "mAP50_95": float(test_metrics.box.ap[i]),
            "f1": float(test_metrics.box.f1[i]) if hasattr(test_metrics.box, "f1") and len(test_metrics.box.f1) > i else None
        }

    # Populate per-class for test at conf 0.10
    for i, cid in enumerate(test_metrics_conf10.box.ap_class_index):
        cname = class_names.get(int(cid), str(cid))
        results_summary["test_results_conf10"]["class_metrics"][cname] = {
            "precision": float(test_metrics_conf10.box.p[i]),
            "recall": float(test_metrics_conf10.box.r[i]),
            "mAP50": float(test_metrics_conf10.box.ap50[i]),
            "mAP50_95": float(test_metrics_conf10.box.ap[i]),
            "f1": float(test_metrics_conf10.box.f1[i]) if hasattr(test_metrics_conf10.box, "f1") and len(test_metrics_conf10.box.f1) > i else None
        }

    summary_file = output_dir / "e2_results_summary.json"
    with open(summary_file, "w", encoding="utf-8") as f:
        json.dump(results_summary, f, indent=2)
    print(f"\n[SUMMARY SAVED] Results written to {summary_file}")

    return results_summary

if __name__ == "__main__":
    run_phase3_e2()
