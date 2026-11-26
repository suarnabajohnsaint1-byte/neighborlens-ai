import os
import sys
import glob
import json
import hashlib
from pathlib import Path
import cv2
import numpy as np

def analyze_dataset_stratification():
    dataset_v1 = Path(__file__).resolve().parents[2] / "data" / "datasets" / "neighborlens_v1"
    
    class_names = {
        0: "damaged_road",
        1: "clogged_drainage",
        2: "damaged_street_light",
        3: "damaged_traffic_light"
    }
    
    # 1. Collect all images and their annotations across the entire dataset
    all_images = {}
    splits = ["train", "val", "test"]
    
    for split in splits:
        img_dir = dataset_v1 / "images" / split
        lbl_dir = dataset_v1 / "labels" / split
        
        for img_path in sorted(list(img_dir.glob("*.jpg")) + list(img_dir.glob("*.png")) + list(img_dir.glob("*.jpeg"))):
            lbl_path = lbl_dir / f"{img_path.stem}.txt"
            boxes = []
            if lbl_path.exists():
                with open(lbl_path, "r") as f:
                    for line in f:
                        parts = line.strip().split()
                        if parts:
                            cid = int(parts[0])
                            cx, cy, w, h = map(float, parts[1:5])
                            boxes.append({"class_id": cid, "cx": cx, "cy": cy, "w": w, "h": h})
            
            # Compute image hash for duplicate detection
            img = cv2.imread(str(img_path))
            if img is not None:
                # Perceptual average hash
                resized = cv2.resize(img, (16, 16), interpolation=cv2.INTER_AREA)
                gray = cv2.cvtColor(resized, cv2.COLOR_BGR2GRAY)
                avg = gray.mean()
                phash = "".join(["1" if px > avg else "0" for px in gray.flatten()])
            else:
                phash = "invalid"
                
            classes_present = sorted(list(set(b["class_id"] for b in boxes)))
            
            all_images[img_path.name] = {
                "current_split": split,
                "img_path": img_path,
                "lbl_path": lbl_path,
                "stem": img_path.stem,
                "boxes": boxes,
                "classes_present": classes_present,
                "phash": phash,
                "num_boxes": len(boxes)
            }
            
    print(f"Total images in dataset: {len(all_images)}")
    
    # Check class distribution currently
    class_img_counts = {cid: [] for cid in class_names}
    for name, data in all_images.items():
        for cid in data["classes_present"]:
            class_img_counts[cid].append(name)
            
    for cid, cname in class_names.items():
        print(f"Class {cid} ({cname}): {len(class_img_counts[cid])} images, {sum(sum(1 for b in all_images[img]['boxes'] if b['class_id'] == cid) for img in class_img_counts[cid])} total objects")

    # Multi-label images check
    multi_label_imgs = [name for name, data in all_images.items() if len(data["classes_present"]) > 1]
    print(f"Images with multiple classes: {len(multi_label_imgs)}")
    for m in multi_label_imgs:
        print(f"  {m}: classes {[class_names[c] for c in all_images[m]['classes_present']]}")

    # Check for near duplicates
    hash_groups = {}
    for name, data in all_images.items():
        h = data["phash"]
        if h not in hash_groups:
            hash_groups[h] = []
        hash_groups[h].append(name)
        
    dup_groups = {h: imgs for h, imgs in hash_groups.items() if len(imgs) > 1}
    print(f"Perceptual duplicate / near-duplicate groups found: {len(dup_groups)}")
    for h, imgs in dup_groups.items():
        print(f"  Group: {imgs}")
    
    np.random.seed(42)
    
    # Categorize by dominant class
    class_groups = {cid: [] for cid in class_names}
    for name, data in all_images.items():
        # dominant class
        if data["classes_present"]:
            primary = data["classes_present"][0]
            class_groups[primary].append(name)
            
    proposed_split = {}
    
    # 1. Drainage: Preserve existing approved split (50 train, 9 val, 9 test)
    for name in class_groups[1]:
        proposed_split[name] = all_images[name]["current_split"]
        
    # 2. Street Light (51 images): partition into 35 train, 8 val, 8 test
    sl_imgs = sorted(class_groups[2])
    # Keep hash groups together
    assigned_sl = set()
    sl_train, sl_val, sl_test = [], [], []
    
    for img in sl_imgs:
        if img in assigned_sl:
            continue
        # find its hash group
        h = all_images[img]["phash"]
        group = [x for x in hash_groups[h] if x in class_groups[2]]
        
        # assign group to the split with lowest fill ratio
        if len(sl_val) < 8:
            sl_val.extend(group)
        elif len(sl_test) < 8:
            sl_test.extend(group)
        else:
            sl_train.extend(group)
            
        for g in group:
            assigned_sl.add(g)
            
    for img in sl_train: proposed_split[img] = "train"
    for img in sl_val: proposed_split[img] = "val"
    for img in sl_test: proposed_split[img] = "test"
    
    # 3. Traffic Light (14 images): partition into 10 train, 2 val, 2 test
    tl_imgs = sorted(class_groups[3])
    assigned_tl = set()
    tl_train, tl_val, tl_test = [], [], []
    for img in tl_imgs:
        if img in assigned_tl:
            continue
        h = all_images[img]["phash"]
        group = [x for x in hash_groups[h] if x in class_groups[3]]
        if len(tl_val) < 2:
            tl_val.extend(group)
        elif len(tl_test) < 2:
            tl_test.extend(group)
        else:
            tl_train.extend(group)
        for g in group:
            assigned_tl.add(g)
            
    for img in tl_train: proposed_split[img] = "train"
    for img in tl_val: proposed_split[img] = "val"
    for img in tl_test: proposed_split[img] = "test"
    
    # 4. Damaged Road (109 images):
    # Current allocation in v1: 74 train, 21 val, 14 test
    for img in class_groups[0]:
        proposed_split[img] = all_images[img]["current_split"]
        
    print("\n================ Proposed Stratified Split Summary ================")
    split_stats = {"train": {cid: 0 for cid in class_names},
                   "val": {cid: 0 for cid in class_names},
                   "test": {cid: 0 for cid in class_names}}
    split_img_counts = {"train": 0, "val": 0, "test": 0}
    
    for name, s in proposed_split.items():
        split_img_counts[s] += 1
        for b in all_images[name]["boxes"]:
            split_stats[s][b["class_id"]] += 1
            
    for s in ["train", "val", "test"]:
        print(f"\nSplit: {s.upper()} ({split_img_counts[s]} images, {sum(split_stats[s].values())} total objects):")
        for cid, cname in class_names.items():
            print(f"  Class {cid} ({cname}): {split_stats[s][cid]} objects")

    return proposed_split

if __name__ == "__main__":
    analyze_dataset_stratification()
