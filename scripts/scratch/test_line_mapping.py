import os
import json
from pathlib import Path

def test_mapping():
    v1_dir = Path(__file__).resolve().parents[2] / "data" / "datasets" / "neighborlens_v1"
    decisions_file = Path(__file__).resolve().parents[2] / "data" / "datasets" / "annotation_input" / "road_v1" / "ROAD_REVIEW_DECISIONS.json"
    
    with open(decisions_file, "r") as f:
        data = json.load(f)
        
    mismatches = 0
    total_checked = 0
    
    for img_name, img_data in data["images"].items():
        split = img_data["split"]
        stem = Path(img_name).stem
        lbl_path = v1_dir / "labels" / split / f"{stem}.txt"
        
        with open(lbl_path, "r") as lf:
            lines = [l.strip() for l in lf if l.strip()]
            
        for b in img_data["boxes"]:
            bidx = b["box_idx"] # 1-indexed
            # Line in file should match
            line = lines[bidx - 1]
            parts = line.split()
            cid = int(parts[0])
            cx, cy, w, h = map(float, parts[1:5])
            
            # compare coords
            coords = b["coords"]
            diff = max(abs(cx - coords[0]), abs(cy - coords[1]), abs(w - coords[2]), abs(h - coords[3]))
            if diff > 1e-3 or cid != 0:
                print(f"Mismatch in {img_name} box #{bidx}: file=({cx},{cy},{w},{h}), json={coords}")
                mismatches += 1
            total_checked += 1
            
    print(f"Mapping verification completed: {total_checked} boxes checked, {mismatches} mismatches.")

if __name__ == "__main__":
    test_mapping()
