import os
import sys
import json
import time
import csv
from pathlib import Path
import torch
from ultralytics import YOLO, settings

def main():
    workspace = Path(__file__).resolve().parents[2].resolve()
    data_yaml = workspace / "data" / "datasets" / "neighborlens_v2_experimental" / "data.yaml"
    model_path = workspace / "models" / "checkpoints" / "yolov8m.pt"
    project_dir = workspace / "models" / "checkpoints"
    run_name = "neighborlens_v8_experimental"
    run_dir = project_dir / run_name

    print("==================================================================")
    print("Neighborlens AI Phase 4E: Experimental Retraining (Provisional)")
    print("==================================================================")
    print(f"Python: {sys.executable}")
    print(f"PyTorch: {torch.__version__}")
    print(f"CUDA available: {torch.cuda.is_available()}")
    if torch.cuda.is_available():
        print(f"GPU: {torch.cuda.get_device_name(0)} ({torch.cuda.get_device_properties(0).total_memory / (1024**3):.2f} GB)")
    print(f"Base Pretrained Model: {model_path}")
    print(f"Dataset YAML: {data_yaml}")
    print(f"Output Directory: {run_dir}")
    print("Configuration: epochs=80, imgsz=800, batch=16, patience=50, workers=0, optimizer=AdamW, amp=True, device=0")

    assert torch.cuda.is_available(), "CUDA is required for GPU training!"
    assert data_yaml.exists(), f"Dataset YAML not found: {data_yaml}"
    assert model_path.exists(), f"Model checkpoint not found: {model_path}"

    settings.update({"datasets_dir": str(workspace)})

    model = YOLO(str(model_path))

    start_time = time.time()
    print("\nStarting experimental training run...")
    train_results = model.train(
        data=str(data_yaml),
        epochs=80,
        imgsz=800,
        batch=16,
        device=0,
        workers=0,
        optimizer="AdamW",
        amp=True,
        project=str(project_dir),
        name=run_name,
        pretrained=True,
        patience=50,
        plots=True,
        save=True,
        exist_ok=True
    )
    total_train_seconds = time.time() - start_time
    total_train_minutes = total_train_seconds / 60.0
    print(f"\nTraining completed in {total_train_minutes:.2f} minutes ({total_train_seconds:.1f}s)")

    best_weights = run_dir / "weights" / "best.pt"
    last_weights = run_dir / "weights" / "last.pt"
    print(f"Best weights: {best_weights} (exists: {best_weights.exists()})")
    print(f"Last weights: {last_weights} (exists: {last_weights.exists()})")
    assert best_weights.exists(), "best.pt not found!"

    # Read results.csv to find best epoch
    results_csv_path = run_dir / "results.csv"
    best_epoch = None
    if results_csv_path.exists():
        with open(results_csv_path, "r", encoding="utf-8") as f:
            reader = csv.reader(f)
            header = [h.strip() for h in next(reader, [])]
            if "metrics/mAP50(B)" in header and "epoch" in header:
                map_idx = header.index("metrics/mAP50(B)")
                ep_idx = header.index("epoch")
                max_map = -1.0
                for row in reader:
                    if row and len(row) > max(map_idx, ep_idx):
                        try:
                            m = float(row[map_idx].strip())
                            ep = int(row[ep_idx].strip())
                            if m > max_map:
                                max_map = m
                                best_epoch = ep
                        except ValueError:
                            pass
        print(f"Best epoch by mAP50: Epoch {best_epoch} (mAP50: {max_map})")

    # Evaluate on Validation Split
    print("\n" + "="*50)
    print("Evaluating Experimental best.pt on Validation Split")
    print("="*50)
    best_model = YOLO(str(best_weights))
    val_results = best_model.val(data=str(data_yaml), split="val", imgsz=800, device=0, plots=True, save_json=True)

    # Evaluate on Test Split
    print("\n" + "="*50)
    print("Evaluating Experimental best.pt on Test Split")
    print("="*50)
    test_results = best_model.val(data=str(data_yaml), split="test", imgsz=800, device=0, plots=True, save_json=True)

    # Helper function to extract per-class metrics
    def extract_metrics(res):
        rd = res.results_dict
        per_class = {}
        names = res.names
        if hasattr(res, "box"):
            box = res.box
            p_per_class = box.p.tolist() if hasattr(box, "p") and hasattr(box.p, "tolist") else []
            r_per_class = box.r.tolist() if hasattr(box, "r") and hasattr(box.r, "tolist") else []
            ap50_per_class = box.ap50.tolist() if hasattr(box, "ap50") and hasattr(box.ap50, "tolist") else []
            ap_per_class = box.ap.tolist() if hasattr(box, "ap") and hasattr(box.ap, "tolist") else []
            
            for idx, cname in names.items():
                per_class[cname] = {
                    "precision": p_per_class[idx] if idx < len(p_per_class) else 0.0,
                    "recall": r_per_class[idx] if idx < len(r_per_class) else 0.0,
                    "mAP50": ap50_per_class[idx] if idx < len(ap50_per_class) else 0.0,
                    "mAP50_95": ap_per_class[idx] if idx < len(ap_per_class) else 0.0,
                }
        return {
            "overall": {
                "precision": float(rd.get("metrics/precision(B)", 0)),
                "recall": float(rd.get("metrics/recall(B)", 0)),
                "mAP50": float(rd.get("metrics/mAP50(B)", 0)),
                "mAP50_95": float(rd.get("metrics/mAP50-95(B)", 0)),
            },
            "per_class": per_class
        }

    val_metrics = extract_metrics(val_results)
    test_metrics = extract_metrics(test_results)

    summary = {
        "run_name": run_name,
        "training_duration_seconds": total_train_seconds,
        "training_duration_minutes": total_train_minutes,
        "best_epoch": best_epoch,
        "best_weights": str(best_weights),
        "last_weights": str(last_weights),
        "val": val_metrics,
        "test": test_metrics
    }

    summary_file = run_dir / "evaluation_summary.json"
    with open(summary_file, "w", encoding="utf-8") as f:
        json.dump(summary, f, indent=2)
    print(f"\nSaved evaluation summary to: {summary_file}")

if __name__ == "__main__":
    main()
