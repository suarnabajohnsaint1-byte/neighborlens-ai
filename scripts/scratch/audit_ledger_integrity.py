import json
from pathlib import Path

def audit_review_ledger():
    v1_dir = Path(__file__).resolve().parents[2] / "data" / "datasets" / "neighborlens_v1"
    review_dir = Path(__file__).resolve().parents[2] / "data" / "datasets" / "annotation_input" / "road_v1"
    ledger_path = review_dir / "ROAD_REVIEW_DECISIONS.json"
    
    with open(ledger_path, "r", encoding="utf-8") as f:
        ledger = json.load(f)
        
    images = ledger["images"]
    total_imgs = len(images)
    total_boxes = 0
    candidate_ids = set()
    
    dec_counts = {"KEEP": 0, "MERGE": 0, "SEPARATE": 0, "REMOVE": 0, "REVIEW": 0, "UNRESOLVED": 0}
    invalid_decisions = []
    invalid_merges = []
    coord_mismatches = []
    
    for img_name, img_data in images.items():
        split = img_data["split"]
        stem = Path(img_name).stem
        lbl_file = v1_dir / "labels" / split / f"{stem}.txt"
        
        with open(lbl_file, "r") as lf:
            lines = [l.strip() for l in lf if l.strip()]
            
        existing_box_indices = set(range(1, len(lines) + 1))
        
        for b in img_data["boxes"]:
            total_boxes += 1
            cid = b["candidate_id"]
            bidx = b["box_idx"]
            
            # Rule 1: candidate_id uniqueness
            if cid in candidate_ids:
                print(f"[DUPLICATE CANDIDATE ID] {cid}")
            candidate_ids.add(cid)
            
            # Rule 2: box_idx validity
            if bidx not in existing_box_indices:
                print(f"[INVALID BOX IDX] {bidx} in {img_name} (max {len(lines)})")
                
            # Rule 3: Coordinate match
            line = lines[bidx - 1]
            parts = line.split()
            class_id = int(parts[0])
            cx, cy, w, h = map(float, parts[1:5])
            coords = b["coords"]
            diff = max(abs(cx - coords[0]), abs(cy - coords[1]), abs(w - coords[2]), abs(h - coords[3]))
            if diff > 1e-3 or class_id != 0:
                coord_mismatches.append((img_name, bidx, coords, (cx, cy, w, h)))
                
            # Decision checking
            dec = b["human_decision"].strip().upper()
            mg = b.get("merge_group", [])
            
            if dec == "":
                dec_counts["UNRESOLVED"] += 1
            elif dec in ["KEEP", "MERGE", "SEPARATE", "REMOVE", "REVIEW"]:
                dec_counts[dec] += 1
                if dec == "MERGE":
                    if not isinstance(mg, list) or len(mg) == 0:
                        invalid_merges.append((img_name, bidx, "MERGE without merge_group"))
                    elif any(idx not in existing_box_indices for idx in mg):
                        invalid_merges.append((img_name, bidx, f"Invalid box index in merge_group: {mg}"))
                else:
                    if isinstance(mg, list) and len(mg) > 0:
                        invalid_merges.append((img_name, bidx, f"Non-MERGE decision with non-empty merge_group: {mg}"))
            else:
                invalid_decisions.append((img_name, bidx, dec))

    print("=== REVIEW LEDGER AUDIT SUMMARY ===")
    print(f"Total Images: {total_imgs}")
    print(f"Total Candidates: {total_boxes}")
    print(f"Unique Candidate IDs: {len(candidate_ids)}")
    print(f"Reviewed Candidates: {total_boxes - dec_counts['UNRESOLVED']}")
    print(f"Unresolved Candidates: {dec_counts['UNRESOLVED']}")
    print(f"Decision Counts: {dec_counts}")
    print(f"Invalid Decisions: {len(invalid_decisions)}")
    print(f"Invalid Merge Groups: {len(invalid_merges)}")
    print(f"Coordinate Mismatches: {len(coord_mismatches)}")

if __name__ == "__main__":
    audit_review_ledger()
