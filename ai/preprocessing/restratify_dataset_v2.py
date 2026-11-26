"""
Neighborlens AI Generalized Image-Level Dataset Restratification Tool (v1 -> v2)
==================================================================================
Compiles data/datasets/neighborlens_v2 from data/datasets/neighborlens_v1 using image-level
stratification with near-duplicate cluster preservation.

Principles:
1. Pure image-level integrity: images and label files move together as atomic units.
2. Multi-class awareness: evaluates image class composition before stratification.
3. Preserves legitimate existing Class 0 and Class 1 distributions (zero unnecessary moves).
4. Resolves zero-sample held-out blindspots for Class 2 and Class 3 across Val and Test.
5. Groups perceptual near-duplicate images (Hamming distance <= 6) into atomic clusters
   so near-duplicates are guaranteed to reside in the SAME split (no data leakage).
6. Target distribution is an optimization target (~70% train, ~15% val, ~15% test),
   not a hard-coded expectation; the actual resulting distribution is calculated and logged.
7. Baseline data/datasets/neighborlens_v1 remains 100% frozen and untouched.
"""

import sys
import shutil
from pathlib import Path
from collections import Counter, defaultdict

if __package__:
    from .dataset_hashes import compute_64phash, compute_sha256, hamming_dist
else:
    from dataset_hashes import compute_64phash, compute_sha256, hamming_dist

CANONICAL_CLASSES = {
    0: "damaged_road",
    1: "clogged_drainage",
    2: "damaged_street_light",
    3: "damaged_traffic_light"
}

def build_restratified_dataset(source_dir="data/datasets/neighborlens_v1", target_dir="data/datasets/neighborlens_v2", target_ratios=(0.70, 0.15, 0.15)):
    src = Path(source_dir)
    dst = Path(target_dir)
    
    print("=" * 80)
    print(f"Neighborlens AI Generalized Stratification: {src} -> {dst}")
    print("=" * 80)
    
    if not src.exists():
        print(f"[ERROR] Source dataset {src} does not exist.")
        sys.exit(1)
        
    splits = ["train", "val", "test"]
    all_items = {}
    
    # 1. Load all images and labels from source
    for split in splits:
        img_dir = src / "images" / split
        lbl_dir = src / "labels" / split
        
        imgs = sorted(list(img_dir.glob("*.jpg")) + list(img_dir.glob("*.png")) + list(img_dir.glob("*.jpeg")))
        for img_f in imgs:
            lbl_f = lbl_dir / f"{img_f.stem}.txt"
            if not lbl_f.exists():
                print(f"[ERROR] Missing label file for image: {img_f}")
                sys.exit(1)
                
            boxes = []
            with open(lbl_f, "r", encoding="utf-8") as f:
                for line in f:
                    parts = line.strip().split()
                    if parts:
                        cid = int(parts[0])
                        boxes.append({
                            "cid": cid,
                            "coords": [float(p) for p in parts[1:]]
                        })
                        
            cids = sorted(list(set(b["cid"] for b in boxes)))
            sha = compute_sha256(img_f)
            ph = compute_64phash(img_f)
            
            all_items[img_f.name] = {
                "name": img_f.name,
                "stem": img_f.stem,
                "img_path": img_f,
                "lbl_path": lbl_f,
                "original_split": split,
                "classes": cids,
                "primary_class": cids[0] if cids else -1,
                "box_count": len(boxes),
                "boxes": boxes,
                "sha256": sha,
                "phash": ph
            }
            
    print(f"Total source items cataloged: {len(all_items)} image/label pairs.")
    
    # 2. Check Multi-Class Composition
    single_class_counts = Counter()
    multi_class_items = []
    
    for name, item in all_items.items():
        if len(item["classes"]) > 1:
            multi_class_items.append(item)
        elif len(item["classes"]) == 1:
            single_class_counts[item["classes"][0]] += 1
            
    print("\n--- Pre-Stratification Class Composition ---")
    for cid, cname in CANONICAL_CLASSES.items():
        print(f"  Only Class {cid} ({cname:<22}): {single_class_counts[cid]:3d} images")
    print(f"  Multi-class images                    : {len(multi_class_items):3d} images")
    if multi_class_items:
        for m in multi_class_items:
            print(f"    - {m['name']}: classes {m['classes']}")
            
    # 3. Cluster Near-Duplicates by 64-bit DCT pHash Hamming Distance <= 6
    # Group images into connected components (clusters)
    names = sorted(list(all_items.keys()))
    parent = {n: n for n in names}
    
    def find(n):
        if parent[n] != n:
            parent[n] = find(parent[n])
        return parent[n]
        
    def union(n1, n2):
        r1, r2 = find(n1), find(n2)
        if r1 != r2:
            parent[r1] = r2
            
    cluster_pairs = []
    for i in range(len(names)):
        for j in range(i + 1, len(names)):
            n1, n2 = names[i], names[j]
            ph1, ph2 = all_items[n1]["phash"], all_items[n2]["phash"]
            if ph1 and ph2:
                d = hamming_dist(ph1, ph2)
                # Cluster near-duplicates that share perceptual features (dist <= 6 / 64)
                if d <= 6:
                    union(n1, n2)
                    cluster_pairs.append((n1, n2, d))
                    
    clusters = defaultdict(list)
    for n in names:
        clusters[find(n)].append(n)
        
    dup_clusters = [c for c in clusters.values() if len(c) > 1]
    print(f"\nPerceptual duplicate clusters identified (must stay in same split): {len(dup_clusters)}")
    for c in dup_clusters:
        print(f"  Cluster of {len(c)} items: {c}")

    # 4. Stratification Planning
    new_split = {}
    
    # Class 0: Keep original splits (approved ground truth, zero unnecessary moves)
    for name, item in all_items.items():
        if 0 in item["classes"]:
            new_split[name] = item["original_split"]
            
    # Class 1: Keep original splits (approved drainage human ground truth 50/9/9)
    for name, item in all_items.items():
        if 1 in item["classes"]:
            new_split[name] = item["original_split"]
            
    # Classes 2 & 3: Stratify clusters to meet target ratios (~70% train, ~15% val, ~15% test)
    # Target image counts for Class 2 (51 images total): target val ~8, target test ~8, train ~35
    # Target image counts for Class 3 (14 images total): target val ~2, target test ~2, train ~10
    for target_cid in [2, 3]:
        cid_clusters = [c for c in clusters.values() if any(all_items[n]["primary_class"] == target_cid for n in c)]
        # Sort clusters by object count descending to balance objects across splits
        cid_clusters.sort(key=lambda cl: sum(all_items[n]["box_count"] for n in cl), reverse=True)
        
        total_cid_imgs = sum(len(cl) for cl in cid_clusters)
        target_val_imgs = max(1, round(total_cid_imgs * target_ratios[1]))
        target_test_imgs = max(1, round(total_cid_imgs * target_ratios[2]))
        
        val_imgs = []
        test_imgs = []
        train_imgs = []
        
        val_objs = 0
        test_objs = 0
        train_objs = 0
        
        for cl in cid_clusters:
            cl_len = len(cl)
            cl_objs = sum(all_items[n]["box_count"] for n in cl)
            
            # Decide split allocation
            if len(val_imgs) < target_val_imgs and (len(val_imgs) + cl_len <= target_val_imgs + 1):
                val_imgs.extend(cl)
                val_objs += cl_objs
            elif len(test_imgs) < target_test_imgs and (len(test_imgs) + cl_len <= target_test_imgs + 1):
                test_imgs.extend(cl)
                test_objs += cl_objs
            else:
                train_imgs.extend(cl)
                train_objs += cl_objs
                
        # Safety fallback: ensure at least one sample in val and test
        if not val_imgs and train_imgs:
            cl = cid_clusters[-1]
            train_imgs = [x for x in train_imgs if x not in cl]
            val_imgs.extend(cl)
        if not test_imgs and len(train_imgs) > 1:
            cl = cid_clusters[-2]
            train_imgs = [x for x in train_imgs if x not in cl]
            test_imgs.extend(cl)
            
        for n in train_imgs: new_split[n] = "train"
        for n in val_imgs: new_split[n] = "val"
        for n in test_imgs: new_split[n] = "test"
        
        cname = CANONICAL_CLASSES[target_cid]
        print(f"\nStratification Result for Class {target_cid} ({cname}):")
        print(f"  Train : {len(train_imgs):2d} images ({train_objs:2d} objects) [{len(train_imgs)/total_cid_imgs*100:.1f}%]")
        print(f"  Val   : {len(val_imgs):2d} images ({val_objs:2d} objects) [{len(val_imgs)/total_cid_imgs*100:.1f}%]")
        print(f"  Test  : {len(test_imgs):2d} images ({test_objs:2d} objects) [{len(test_imgs)/total_cid_imgs*100:.1f}%]")
        print(f"  Total : {total_cid_imgs:2d} images ({train_objs+val_objs+test_objs:2d} objects)")

    # 5. Validate that all 242 images are accounted for
    assert len(new_split) == len(all_items), (f"Total image count mismatch: {len(new_split)} != {len(all_items)}")
    
    # 6. Verify zero cross-split leakage for clusters
    for c in dup_clusters:
        assigned_splits = {new_split[n] for n in c}
        assert len(assigned_splits) == 1, f"Cluster {c} was split across: {assigned_splits}"
    print("\n[VERIFIED] All near-duplicate clusters remain strictly within the same split.")

    # 7. Create Target Directory and Copy Files
    if dst.exists():
        # Clear existing images and labels safely
        for sub in ["images", "labels"]:
            sub_p = dst / sub
            if sub_p.exists():
                shutil.rmtree(sub_p)
                
    for s in splits:
        (dst / "images" / s).mkdir(parents=True, exist_ok=True)
        (dst / "labels" / s).mkdir(parents=True, exist_ok=True)
        
    copied = {"train": 0, "val": 0, "test": 0}
    for name, target_s in new_split.items():
        item = all_items[name]
        shutil.copy2(item["img_path"], dst / "images" / target_s / name)
        shutil.copy2(item["lbl_path"], dst / "labels" / target_s / f"{item['stem']}.txt")
        copied[target_s] += 1
        
    print(f"\nFiles successfully written to {dst}:")
    for s, cnt in copied.items():
        print(f"  Split {s:<5}: {cnt} image/label pairs")
        
    # 8. Write data.yaml
    yaml_text = f"""path: {dst.as_posix()}
train: images/train
val: images/val
test: images/test

nc: 4
names:
  0: damaged_road
  1: clogged_drainage
  2: damaged_street_light
  3: damaged_traffic_light
"""
    with open(dst / "data.yaml", "w", encoding="utf-8") as f:
        f.write(yaml_text)
    print(f"Generated {dst / 'data.yaml'}")
    print("\n[SUCCESS] neighborlens_v2 compiled successfully.")
    return True

if __name__ == "__main__":
    build_restratified_dataset()
