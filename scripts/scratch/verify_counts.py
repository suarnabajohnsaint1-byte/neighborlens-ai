import os
import glob
from pathlib import Path

def count_labels(dataset_path):
    dataset_dir = Path(dataset_path)
    splits = ["train", "val", "test"]
    class_names = {0: "damaged_road", 1: "clogged_drainage", 2: "damaged_street_light", 3: "damaged_traffic_light"}
    
    total_objs = 0
    split_counts = {}
    class_counts = {cid: 0 for cid in class_names}
    split_class_counts = {s: {cid: 0 for cid in class_names} for s in splits}
    img_counts = {}
    
    for s in splits:
        lbl_dir = dataset_dir / "labels" / s
        img_dir = dataset_dir / "images" / s
        
        lbl_files = sorted(list(lbl_dir.glob("*.txt"))) if lbl_dir.exists() else []
        img_files = sorted(list(img_dir.glob("*.*"))) if img_dir.exists() else []
        
        img_counts[s] = len(img_files)
        split_counts[s] = 0
        
        for lf in lbl_files:
            with open(lf, "r") as f:
                lines = [l.strip() for l in f if l.strip()]
            split_counts[s] += len(lines)
            total_objs += len(lines)
            
            for l in lines:
                parts = l.split()
                if parts:
                    cid = int(parts[0])
                    class_counts[cid] += 1
                    split_class_counts[s][cid] += 1
                    
    return {
        "dataset": str(dataset_dir),
        "total_objs": total_objs,
        "img_counts": img_counts,
        "split_counts": split_counts,
        "class_counts": class_counts,
        "split_class_counts": split_class_counts
    }

print("=== CHECKING data/datasets/neighborlens_v1 ===")
res_v1 = count_labels(str(__import__("pathlib").Path(__file__).resolve().parents[2] / "data" / "datasets" / "neighborlens_v1"))
print(f"Total Objects: {res_v1['total_objs']}")
print(f"Images per split: {res_v1['img_counts']} (Total = {sum(res_v1['img_counts'].values())})")
print(f"Objects per split: {res_v1['split_counts']} (Sum = {sum(res_v1['split_counts'].values())})")
print(f"Objects per class: {res_v1['class_counts']} (Sum = {sum(res_v1['class_counts'].values())})")
for s, cdata in res_v1['split_class_counts'].items():
    print(f"  Split [{s}]: {cdata} (Total = {sum(cdata.values())})")

print("\n=== CHECKING data/datasets/neighborlens_v2 ===")
res_v2 = count_labels(str(__import__("pathlib").Path(__file__).resolve().parents[2] / "data" / "datasets" / "neighborlens_v2"))
print(f"Total Objects: {res_v2['total_objs']}")
print(f"Images per split: {res_v2['img_counts']}")
print(f"Objects per split: {res_v2['split_counts']}")
print(f"Objects per class: {res_v2['class_counts']}")
