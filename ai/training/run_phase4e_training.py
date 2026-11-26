"""
Neighborlens AI Phase 4E Controlled Retraining & Evaluation Runner
===================================================================
Controlled Experiment: YOLOv8m retraining on remediated neighborlens_v2.

Parameters (Strictly Identical to Phase 4B):
- Model: yolov8m.pt (pretrained COCO baseline)
- Dataset: data/datasets/neighborlens_v2/data.yaml
- Run Name: neighborlens_v8_phase4e
- imgsz: 800
- batch: 16
- device: 0 (NVIDIA RTX 3060)
- workers: 0
- optimizer: AdamW
- AMP: True
- epochs: 80
- patience: 50

Safety Gate:
- Checks that data/datasets/neighborlens_v2/data.yaml exists and is populated.
- Checks that no previous run artifacts are overwritten.
"""

import os
import sys
import json
import time
import argparse
from pathlib import Path

def check_phase4e_readiness():
    root_dir = Path(__file__).resolve().parents[2]
    v2_yaml = root_dir / "data" / "datasets" / "neighborlens_v2" / "data.yaml"
    v2_train = root_dir / "data" / "datasets" / "neighborlens_v2" / "images" / "train"
    
    print("=== Phase 4E Retraining Pre-Flight Check ===")
    
    # Check dataset availability
    if not v2_yaml.exists():
        print(f"[BLOCKED] {v2_yaml} does not exist.")
        return False
    if not v2_train.exists() or len(list(v2_train.glob("*.*"))) == 0:
        print(f"[BLOCKED] neighborlens_v2 image splits are not populated yet (human review pending).")
        return False
        
    print("[READY] neighborlens_v2 dataset verified.")
    return True

def run_phase4e():
    if not check_phase4e_readiness():
        print("[STATUS] Phase 4E training is staged and blocked until human review completes and v2 is built.")
        sys.exit(1)
        
    from ultralytics import YOLO
    
    root_dir = Path(__file__).resolve().parents[2]
    data_yaml = root_dir / "data" / "datasets" / "neighborlens_v2" / "data.yaml"
    output_dir = root_dir / "models" / "checkpoints" / "neighborlens_v8_phase4e"
    
    if output_dir.exists():
        print(f"[ERROR] Output directory {output_dir} already exists. Refusing to overwrite.")
        sys.exit(1)
        
    print("\n--- Starting Phase 4E Controlled YOLOv8m Retraining ---")
    start_time = time.time()
    
    model = YOLO(str(root_dir / "models" / "checkpoints" / "yolov8m.pt"))
    
    train_results = model.train(
        data=str(data_yaml),
        epochs=80,
        patience=50,
        imgsz=800,
        batch=16,
        device=0,
        workers=0,
        optimizer="AdamW",
        amp=True,
        project=str(root_dir / "models" / "checkpoints"),
        name="neighborlens_v8_phase4e",
        exist_ok=False,
        save=True,
        plots=True
    )
    
    duration = time.time() - start_time
    print(f"\nPhase 4E Training completed in {duration/60:.2f} minutes.")

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Phase 4E Runner")
    parser.add_argument("--check", action="store_true", help="Run pre-flight check only")
    parser.add_argument("--train", action="store_true", help="Execute Phase 4E training")
    
    # By default, do not execute training
    if len(sys.argv) == 1 or "--check" in sys.argv:
        ready = check_phase4e_readiness()
        if not ready:
            print("[INFO] Staged script ready for Phase 4E execution.")
    elif "--train" in sys.argv:
        run_phase4e()
