import os
import cv2
import numpy as np
from pathlib import Path
from ultralytics import YOLO

def generate_qualitative_diagnostics():
    dataset_dir = Path(__file__).resolve().parents[2] / "data" / "datasets" / "neighborlens_v1"
    best_model_path = Path(__file__).resolve().parents[2] / "models" / "checkpoints" / "neighborlens_v8_phase4b" / "weights" / "best.pt"
    out_dir = Path(__file__).resolve().parents[2] / "models" / "checkpoints" / "neighborlens_v8_phase4b" / "qualitative_inspection"
    out_dir.mkdir(parents=True, exist_ok=True)
    
    class_names = {
        0: "damaged_road",
        1: "clogged_drainage",
        2: "damaged_street_light",
        3: "damaged_traffic_light"
    }
    
    model = YOLO(str(best_model_path))
    
    # Analyze both val and test splits
    for split in ["val", "test"]:
        img_dir = dataset_dir / "images" / split
        lbl_dir = dataset_dir / "labels" / split
        split_out_dir = out_dir / split
        split_out_dir.mkdir(parents=True, exist_ok=True)
        
        img_paths = sorted(list(img_dir.glob("*.jpg")) + list(img_dir.glob("*.png")) + list(img_dir.glob("*.jpeg")))
        
        # Pick representative samples:
        # 1. Drainage sample
        # 2. Road sample (dense cracks)
        # 3. Road sample (single crack)
        # 4. Clean road / background sample
        
        for p in img_paths[:10]: # inspect first 10 per split
            img = cv2.imread(str(p))
            if img is None:
                continue
            h_img, w_img = img.shape[:2]
            
            # Ground truth
            lbl_file = lbl_dir / f"{p.stem}.txt"
            gt_img = img.copy()
            if lbl_file.exists():
                with open(lbl_file, "r") as f:
                    for line in f:
                        parts = line.strip().split()
                        if parts:
                            cid = int(parts[0])
                            cx, cy, w, h = map(float, parts[1:5])
                            x1 = int((cx - w/2) * w_img)
                            y1 = int((cy - h/2) * h_img)
                            x2 = int((cx + w/2) * w_img)
                            y2 = int((cy + h/2) * h_img)
                            cv2.rectangle(gt_img, (x1, y1), (x2, y2), (0, 255, 0), 2)
                            cv2.putText(gt_img, f"GT: {class_names.get(cid, str(cid))}", (x1, max(15, y1 - 5)),
                                        cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 255, 0), 1)
            
            # Predict with conf=0.002 (around median prediction confidence)
            res = model.predict(source=str(p), imgsz=800, conf=0.002, device=0, verbose=False)[0]
            pred_img = img.copy()
            if res.boxes is not None and len(res.boxes) > 0:
                boxes = res.boxes.xyxy.cpu().numpy()
                confs = res.boxes.conf.cpu().numpy()
                clss = res.boxes.cls.cpu().numpy().astype(int)
                
                # Take top 10 most confident predictions for clear visualization
                sorted_indices = np.argsort(-confs)[:10]
                for idx in sorted_indices:
                    x1, y1, x2, y2 = map(int, boxes[idx])
                    conf = confs[idx]
                    cid = clss[idx]
                    cname = class_names.get(cid, str(cid))
                    cv2.rectangle(pred_img, (x1, y1), (x2, y2), (0, 0, 255), 2)
                    cv2.putText(pred_img, f"{cname} {conf:.3f}", (x1, max(15, y1 - 5)),
                                cv2.FONT_HERSHEY_SIMPLEX, 0.45, (0, 0, 255), 1)
            
            # Side-by-side comparison
            combined = np.hstack([gt_img, pred_img])
            cv2.imwrite(str(split_out_dir / f"{p.stem}_diagnostic.jpg"), combined)

    print(f"Qualitative diagnostic images generated in {out_dir}")

if __name__ == "__main__":
    generate_qualitative_diagnostics()
