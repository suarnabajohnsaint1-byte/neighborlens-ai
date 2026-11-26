import os
import json
from pathlib import Path

def verify_review_infrastructure():
    v1_dir = Path(__file__).resolve().parents[2] / "data" / "datasets" / "neighborlens_v1"
    review_dir = Path(__file__).resolve().parents[2] / "data" / "datasets" / "annotation_input" / "road_v1"
    ledger_path = review_dir / "ROAD_REVIEW_DECISIONS.json"
    manifest_path = review_dir / "ROAD_REVIEW_MANIFEST.md"
    previews_dir = review_dir / "previews"
    
    with open(ledger_path, "r", encoding="utf-8") as f:
        ledger = json.load(f)
        
    images = ledger["images"]
    total_imgs = len(images)
    total_boxes = 0
    decision_counts = {"KEEP": 0, "MERGE": 0, "SEPARATE": 0, "REMOVE": 0, "REVIEW": 0, "UNRESOLVED": 0}
    
    missing_source_imgs = 0
    missing_previews = 0
    coord_mismatches = 0
    
    for img_name, img_data in images.items():
        split = img_data["split"]
        stem = Path(img_name).stem
        source_img = v1_dir / "images" / split / img_name
        source_lbl = v1_dir / "labels" / split / f"{stem}.txt"
        preview_img = previews_dir / f"{stem}_annotated.jpg"
        
        if not source_img.exists():
            print(f"Missing source image: {source_img}")
            missing_source_imgs += 1
        if not preview_img.exists():
            print(f"Missing preview image: {preview_img}")
            missing_previews += 1
            
        with open(source_lbl, "r") as lf:
            lines = [l.strip() for l in lf if l.strip()]
            
        for b in img_data["boxes"]:
            total_boxes += 1
            dec = b["human_decision"].strip().upper()
            if dec in decision_counts:
                decision_counts[dec] += 1
            else:
                decision_counts["UNRESOLVED"] += 1
                
            bidx = b["box_idx"]
            line = lines[bidx - 1]
            parts = line.split()
            cid = int(parts[0])
            cx, cy, w, h = map(float, parts[1:5])
            coords = b["coords"]
            diff = max(abs(cx - coords[0]), abs(cy - coords[1]), abs(w - coords[2]), abs(h - coords[3]))
            if diff > 1e-3 or cid != 0:
                coord_mismatches += 1
                
    print("=== TASK 1 INFRASTRUCTURE VERIFICATION RESULTS ===")
    print(f"Total Flagged Images: {total_imgs} (Expected: 86)")
    print(f"Total Flagged Boxes: {total_boxes} (Expected: 334)")
    print(f"Missing Source Images: {missing_source_imgs}")
    print(f"Missing Preview Images: {missing_previews}")
    print(f"Coordinate Mismatches: {coord_mismatches}")
    print(f"Decision Counts: {decision_counts}")
    print(f"Human Review Progress: {total_boxes - decision_counts['UNRESOLVED']} / {total_boxes} completed ({((total_boxes - decision_counts['UNRESOLVED'])/total_boxes)*100:.1f}%)")

if __name__ == "__main__":
    verify_review_infrastructure()
