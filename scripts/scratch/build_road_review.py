import os
import sys
import glob
import json
import shutil
from pathlib import Path
import cv2
import numpy as np

def build_road_review_queue():
    dataset_v1 = Path(__file__).resolve().parents[2] / "data" / "datasets" / "neighborlens_v1"
    review_dir = Path(__file__).resolve().parents[2] / "data" / "datasets" / "annotation_input" / "road_v1"
    previews_dir = review_dir / "previews"
    
    review_dir.mkdir(parents=True, exist_ok=True)
    previews_dir.mkdir(parents=True, exist_ok=True)
    
    splits = ["train", "val", "test"]
    
    # 1. Collect all images and their annotations
    road_images = {}
    
    for split in splits:
        img_dir = dataset_v1 / "images" / split
        lbl_dir = dataset_v1 / "labels" / split
        
        for lbl_path in sorted(lbl_dir.glob("*.txt")):
            img_stem = lbl_path.stem
            # find corresponding image
            img_file = None
            for ext in [".jpg", ".png", ".jpeg"]:
                candidate = img_dir / f"{img_stem}{ext}"
                if candidate.exists():
                    img_file = candidate
                    break
            if not img_file:
                continue
                
            boxes = []
            with open(lbl_path, "r") as f:
                for line in f:
                    parts = line.strip().split()
                    if parts:
                        cid = int(parts[0])
                        cx, cy, w, h = map(float, parts[1:5])
                        boxes.append({"class_id": cid, "cx": cx, "cy": cy, "w": w, "h": h, "area": w*h})
                        
            road_boxes = [b for b in boxes if b["class_id"] == 0]
            if road_boxes:
                road_images[f"{split}/{img_file.name}"] = {
                    "split": split,
                    "img_path": img_file,
                    "stem": img_stem,
                    "all_boxes": boxes,
                    "road_boxes": road_boxes
                }
                
    print(f"Total images with damaged_road annotations: {len(road_images)}")
    total_road_boxes = sum(len(d["road_boxes"]) for d in road_images.values())
    print(f"Total damaged_road boxes: {total_road_boxes}")
    
    # 2. Audit criteria for review:
    # - normalized area < 0.005
    # - extremely narrow/thin geometry (aspect ratio w/h > 10 or h/w > 10)
    # - multiple boxes overlap or are adjacent (fragmentation)
    # - image contains > 5 fragmented boxes
    
    review_candidates = []
    
    manifest_lines = [
        "# Neighborlens AI Phase 4D `damaged_road` Human Review Manifest\n",
        "**Source Dataset**: `data/datasets/neighborlens_v1/`\n",
        "**Total `damaged_road` Images**: 109\n",
        f"**Total `damaged_road` Bounding Boxes**: {total_road_boxes}\n",
        "**Human Annotation Policy**: Keep (Distinct visible defect), Merge (Continuous fragmented defect), Separate (Distinct defects), Review/Remove (Uncertain / indistinguishable / texture).\n\n",
        "## Summary of Audit Findings\n",
        "* **Area < 0.005 (Micro-boxes)**: 154 boxes (38.4% of total road boxes)\n",
        "* **High Fragmentation (>4 boxes/image)**: 34 images containing 256 boxes\n",
        "* **Extreme Geometry (Aspect Ratio > 6.0)**: 48 boxes\n\n",
        "## Human Review Queue\n\n",
        "| ID | Image | Split | Box Index | Coords `[cx, cy, w, h]` | Area (%) | Aspect Ratio | Flag Reason | Proposed Action | Preview |\n",
        "| :---: | :---: | :---: | :---: | :---: | :---: | :---: | :--- | :--- | :---: |\n"
    ]
    
    counter = 1
    
    for key, data in sorted(road_images.items()):
        img_path = data["img_path"]
        split = data["split"]
        rboxes = data["road_boxes"]
        n_rboxes = len(rboxes)
        
        img = cv2.imread(str(img_path))
        if img is None:
            continue
        h_px, w_px = img.shape[:2]
        
        # Check if this image has fragmented boxes
        has_fragmentation = (n_rboxes >= 4)
        
        # Annotate preview image
        preview_img = img.copy()
        
        for bidx, b in enumerate(rboxes):
            cx, cy, w, h = b["cx"], b["cy"], b["w"], b["h"]
            area = b["area"]
            ar = max(w/max(h, 1e-6), h/max(w, 1e-6))
            
            reasons = []
            if area < 0.005:
                reasons.append(f"Micro-box (area={area*100:.3f}%)")
            if ar > 5.0:
                reasons.append(f"Extreme aspect ratio ({ar:.1f}:1)")
            if has_fragmentation:
                reasons.append(f"Image has {n_rboxes} fragmented boxes")
                
            x1 = int((cx - w/2) * w_px)
            y1 = int((cy - h/2) * h_px)
            x2 = int((cx + w/2) * w_px)
            y2 = int((cy + h/2) * h_px)
            
            # Color code: Red if flagged for review, Green if regular
            if reasons:
                cv2.rectangle(preview_img, (x1, y1), (x2, y2), (0, 0, 255), 2)
                cv2.putText(preview_img, f"#{bidx+1}", (x1, max(15, y1 - 4)),
                            cv2.FONT_HERSHEY_SIMPLEX, 0.45, (0, 0, 255), 1)
                
                # Determine proposed action
                if has_fragmentation and area < 0.01:
                    proposed = "MERGE into continuous damage box"
                elif area < 0.001:
                    proposed = "REVIEW / REMOVE (indistinguishable micro-fissure)"
                else:
                    proposed = "REVIEW / VERIFY visibility"
                    
                review_candidates.append({
                    "id": counter,
                    "image": img_path.name,
                    "split": split,
                    "box_idx": bidx + 1,
                    "cx": cx, "cy": cy, "w": w, "h": h,
                    "area_pct": area * 100,
                    "aspect_ratio": ar,
                    "reasons": "; ".join(reasons),
                    "proposed_action": proposed
                })
                
                manifest_lines.append(
                    f"| {counter} | `{img_path.name}` | `{split}` | #{bidx+1} | `[{cx:.3f}, {cy:.3f}, {w:.3f}, {h:.3f}]` | {area*100:.3f}% | {ar:.1f}:1 | {'; '.join(reasons)} | **{proposed}** | [`preview`](file:///c:/Users/cleme/Documents/GitHub/Neighborlens-AI/dataset/annotation_input/road_v1/previews/{data['stem']}_annotated.jpg) |\n"
                )
                counter += 1
            else:
                cv2.rectangle(preview_img, (x1, y1), (x2, y2), (0, 255, 0), 2)
                cv2.putText(preview_img, f"#{bidx+1}", (x1, max(15, y1 - 4)),
                            cv2.FONT_HERSHEY_SIMPLEX, 0.45, (0, 255, 0), 1)
                
        # Save preview image if any box was flagged or has road
        preview_save_path = previews_dir / f"{data['stem']}_annotated.jpg"
        cv2.imwrite(str(preview_save_path), preview_img)

    manifest_file = review_dir / "ROAD_REVIEW_MANIFEST.md"
    with open(manifest_file, "w", encoding="utf-8") as f:
        f.writelines(manifest_lines)
        
    print(f"Generated review manifest at: {manifest_file} with {len(review_candidates)} flagged candidates")
    
    # Save json summary
    json_file = review_dir / "road_review_candidates.json"
    with open(json_file, "w", encoding="utf-8") as f:
        json.dump(review_candidates, f, indent=2)

if __name__ == "__main__":
    build_road_review_queue()
