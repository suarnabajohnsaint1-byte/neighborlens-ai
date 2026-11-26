import json
from pathlib import Path
from ultralytics import YOLO

def main():
    workspace = Path(__file__).resolve().parents[2]
    best_weights = workspace / "models" / "checkpoints" / "neighborlens_v8_experimental" / "weights" / "best.pt"
    data_yaml = workspace / "data" / "datasets" / "neighborlens_v2_experimental" / "data.yaml"

    model = YOLO(str(best_weights))
    val_res = model.val(data=str(data_yaml), split="val", imgsz=800, device=0, workers=0, plots=False)
    test_res = model.val(data=str(data_yaml), split="test", imgsz=800, device=0, workers=0, plots=False)

    print("\n--- Val Confusion Matrix ---")
    if hasattr(val_res, "confusion_matrix"):
        print("Matrix classes:", val_res.names)
        print("Matrix raw values:\n", val_res.confusion_matrix.matrix.tolist())

    print("\n--- Test Confusion Matrix ---")
    if hasattr(test_res, "confusion_matrix"):
        print("Matrix classes:", test_res.names)
        print("Matrix raw values:\n", test_res.confusion_matrix.matrix.tolist())

if __name__ == "__main__":
    main()
