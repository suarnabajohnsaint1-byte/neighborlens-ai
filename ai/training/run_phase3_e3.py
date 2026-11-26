"""
Neighborlens AI Phase 3B Experiment E-3: Human-Reviewed Road Annotation Remediation
====================================================================================
Objective:
Train and evaluate YOLOv8m on data/datasets/neighborlens_v3/data.yaml using the identical
hyperparameters and control settings as Phase 2 E-0 baseline (imgsz=800, epochs=80,
batch=-1, seed=0, deterministic=True).

Destination:
models/checkpoints/neighborlens_v8_phase3_e3_road_remediation/
"""

import os
import sys
import time
import json
import csv
import datetime
from pathlib import Path

import torch
import cv2
import numpy as np

WORKSPACE_ROOT = Path(__file__).resolve().parents[2]
DATA_YAML = WORKSPACE_ROOT / "data" / "datasets" / "neighborlens_v3" / "data.yaml"
OUTPUT_DIR = WORKSPACE_ROOT / "models" / "checkpoints" / "neighborlens_v8_phase3_e3_road_remediation"
E0_SUMMARY_PATH = WORKSPACE_ROOT / "models" / "checkpoints" / "neighborlens_v8_baseline_v2" / "baseline_results_summary.json"

CLASS_NAMES = {
    0: "damaged_road",
    1: "clogged_drainage",
    2: "damaged_street_light",
    3: "damaged_traffic_light"
}

def run_phase3_e3_experiment():
    print("=" * 80)
    print("Neighborlens AI Phase 3B: Experiment E-3 Controlled Training")
    print("=" * 80)

    # Pre-condition checks
    if OUTPUT_DIR.exists():
        print(f"[ERROR] Target run directory {OUTPUT_DIR} already exists. Refusing to overwrite.")
        sys.exit(1)

    if not DATA_YAML.exists():
        print(f"[ERROR] Dataset configuration {DATA_YAML} not found.")
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
        "data_yaml": str(DATA_YAML),
        "imgsz": 800,
        "epochs": 80,
        "patience": 80,
        "batch_configured": -1,
        "seed": 0,
        "deterministic": True
    }

    print("\n--- Environment & Hardware ---")
    for k, v in env_info.items():
        print(f"  {k}: {v}")

    print("\n--- Initializing Model ---")
    model = YOLO(str(WORKSPACE_ROOT / "models" / "checkpoints" / "yolov8m.pt"))

    start_train = time.time()
    print("\n--- Commencing Training Run (80 Epochs) ---")

    train_results = model.train(
        data=str(DATA_YAML),
        epochs=80,
        patience=80,
        imgsz=800,
        batch=-1,
        device=0 if torch.cuda.is_available() else "cpu",
        workers=0,
        project=str(WORKSPACE_ROOT / "models" / "checkpoints"),
        name="neighborlens_v8_phase3_e3_road_remediation",
        exist_ok=False,
        save=True,
        plots=True,
        seed=0,
        deterministic=True
    )
    train_duration = time.time() - start_train
    print(f"\n[TRAINING COMPLETE] Elapsed time: {train_duration/60:.2f} minutes ({train_duration:.1f}s).")

    # Locate best.pt
    best_weights = OUTPUT_DIR / "weights" / "best.pt"
    if not best_weights.exists():
        print(f"[WARNING] best.pt not found at {best_weights}. Checking last.pt...")
        best_weights = OUTPUT_DIR / "weights" / "last.pt"

    print(f"\n--- Loading Best Checkpoint: {best_weights} ---")
    eval_model = YOLO(str(best_weights))

    # 1. Evaluate on Validation Split
    print("\n--- Evaluating on Validation Split (val) ---")
    val_metrics = eval_model.val(
        data=str(DATA_YAML),
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
        data=str(DATA_YAML),
        split="test",
        imgsz=800,
        device=0 if torch.cuda.is_available() else "cpu",
        workers=0,
        plots=True,
        save_json=True
    )

    # 3. Analyze results.csv for epoch progression
    results_csv_path = OUTPUT_DIR / "results.csv"
    best_epoch_info = {}
    if results_csv_path.exists():
        with open(results_csv_path, "r", encoding="utf-8") as f:
            reader = csv.DictReader(f)
            rows = list(reader)

        # Strip whitespace from headers
        cleaned_rows = []
        for r in rows:
            cleaned_rows.append({k.strip(): float(v.strip()) if v.strip() else 0.0 for k, v in r.items()})

        # Find max val mAP50
        max_map50_row = max(cleaned_rows, key=lambda x: x.get("metrics/mAP50(B)", 0.0))
        max_map50_95_row = max(cleaned_rows, key=lambda x: x.get("metrics/mAP50-95(B)", 0.0))
        final_row = cleaned_rows[-1]

        best_epoch_info = {
            "max_val_mAP50_epoch": int(max_map50_row.get("epoch", 0)),
            "max_val_mAP50": max_map50_row.get("metrics/mAP50(B)", 0.0),
            "max_val_mAP50_95_epoch": int(max_map50_95_row.get("epoch", 0)),
            "max_val_mAP50_95": max_map50_95_row.get("metrics/mAP50-95(B)", 0.0),
            "final_epoch": int(final_row.get("epoch", 0)),
            "final_val_mAP50": final_row.get("metrics/mAP50(B)", 0.0),
            "final_val_mAP50_95": final_row.get("metrics/mAP50-95(B)", 0.0)
        }

    # Helper function to extract per-class metrics
    def extract_metrics(metrics_obj):
        p = float(metrics_obj.box.mp)
        r = float(metrics_obj.box.mr)
        map50 = float(metrics_obj.box.map50)
        map50_95 = float(metrics_obj.box.map)
        f1 = (2 * p * r / (p + r)) if (p + r) > 0 else 0.0

        per_class = {}
        for cid in sorted(CLASS_NAMES.keys()):
            cname = CLASS_NAMES[cid]
            cp = float(metrics_obj.box.p[cid]) if cid < len(metrics_obj.box.p) else 0.0
            cr = float(metrics_obj.box.r[cid]) if cid < len(metrics_obj.box.r) else 0.0
            cmap50 = float(metrics_obj.box.ap50[cid]) if cid < len(metrics_obj.box.ap50) else 0.0
            cmap = float(metrics_obj.box.ap[cid]) if cid < len(metrics_obj.box.ap) else 0.0
            cf1 = (2 * cp * cr / (cp + cr)) if (cp + cr) > 0 else 0.0

            per_class[cname] = {
                "precision": cp,
                "recall": cr,
                "f1": cf1,
                "mAP50": cmap50,
                "mAP50_95": cmap
            }

        return {
            "precision": p,
            "recall": r,
            "f1": f1,
            "mAP50": map50,
            "mAP50_95": map50_95,
            "class_metrics": per_class
        }

    val_summary = extract_metrics(val_metrics)
    test_summary = extract_metrics(test_metrics)

    # Load E-0 baseline for comparison
    e0_data = {}
    if E0_SUMMARY_PATH.exists():
        with open(E0_SUMMARY_PATH, "r", encoding="utf-8") as f:
            e0_data = json.load(f)

    # Compile Results Summary
    e3_results = {
        "experiment_name": "neighborlens_v8_phase3_e3_road_remediation",
        "description": "Phase 3B Experiment E-3: Human-Reviewed Road Annotation Remediation",
        "env_info": env_info,
        "train_duration_seconds": train_duration,
        "best_weights": str(best_weights),
        "best_epoch_info": best_epoch_info,
        "validation_results": val_summary,
        "test_results": test_summary,
        "e0_comparison": {
            "test_overall_delta": {},
            "test_per_class_delta": {}
        }
    }

    if "test_results" in e0_data:
        e0_test = e0_data["test_results"]
        e3_test = test_summary

        e0_p = e0_test["precision"]
        e0_r = e0_test["recall"]
        e0_f1 = e0_test.get("f1")
        if e0_f1 is None or e0_f1 == 0.0:
            e0_f1 = (2 * e0_p * e0_r / (e0_p + e0_r)) if (e0_p + e0_r) > 0 else 0.0

        e3_results["e0_comparison"]["test_overall_delta"] = {
            "precision": {"e0": e0_test["precision"], "e3": e3_test["precision"], "delta": e3_test["precision"] - e0_test["precision"]},
            "recall": {"e0": e0_test["recall"], "e3": e3_test["recall"], "delta": e3_test["recall"] - e0_test["recall"]},
            "f1": {"e0": e0_f1, "e3": e3_test["f1"], "delta": e3_test["f1"] - e0_f1},
            "mAP50": {"e0": e0_test["mAP50"], "e3": e3_test["mAP50"], "delta": e3_test["mAP50"] - e0_test["mAP50"]},
            "mAP50_95": {"e0": e0_test["mAP50_95"], "e3": e3_test["mAP50_95"], "delta": e3_test["mAP50_95"] - e0_test["mAP50_95"]}
        }

        for cname in CLASS_NAMES.values():
            e0_c = e0_test["class_metrics"].get(cname, {})
            e3_c = e3_test["class_metrics"].get(cname, {})
            e3_results["e0_comparison"]["test_per_class_delta"][cname] = {
                "precision": {"e0": e0_c.get("precision", 0.0), "e3": e3_c.get("precision", 0.0), "delta": e3_c.get("precision", 0.0) - e0_c.get("precision", 0.0)},
                "recall": {"e0": e0_c.get("recall", 0.0), "e3": e3_c.get("recall", 0.0), "delta": e3_c.get("recall", 0.0) - e0_c.get("recall", 0.0)},
                "f1": {"e0": e0_c.get("f1", 0.0), "e3": e3_c.get("f1", 0.0), "delta": e3_c.get("f1", 0.0) - e0_c.get("f1", 0.0)},
                "mAP50": {"e0": e0_c.get("mAP50", 0.0), "e3": e3_c.get("mAP50", 0.0), "delta": e3_c.get("mAP50", 0.0) - e0_c.get("mAP50", 0.0)},
                "mAP50_95": {"e0": e0_c.get("mAP50_95", 0.0), "e3": e3_c.get("mAP50_95", 0.0), "delta": e3_c.get("mAP50_95", 0.0) - e0_c.get("mAP50_95", 0.0)}
            }

    # Save to JSON
    json_path = WORKSPACE_ROOT / "scratch" / "phase3_e3_results_summary.json"
    with open(json_path, "w", encoding="utf-8") as f:
        json.dump(e3_results, f, indent=2)

    print("\n" + "=" * 80)
    print("PHASE 3B EXPERIMENT E-3 EXECUTION & EVALUATION COMPLETE")
    print("=" * 80)
    print(f"Results summary saved to: {json_path}")
    print("\nOverall TEST Metrics:")
    print(f"  Precision: {test_summary['precision']:.4f}")
    print(f"  Recall   : {test_summary['recall']:.4f}")
    print(f"  F1       : {test_summary['f1']:.4f}")
    print(f"  mAP50    : {test_summary['mAP50']:.4f}")
    print(f"  mAP50-95 : {test_summary['mAP50_95']:.4f}")

    print("\nPer-Class TEST mAP50:")
    for cname, cmetrics in test_summary["class_metrics"].items():
        print(f"  {cname:<22}: mAP50={cmetrics['mAP50']:.4f} (P={cmetrics['precision']:.4f}, R={cmetrics['recall']:.4f}, F1={cmetrics['f1']:.4f})")

    return e3_results

if __name__ == "__main__":
    run_phase3_e3_experiment()
