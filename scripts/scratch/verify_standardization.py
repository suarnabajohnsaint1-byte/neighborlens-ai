import json
from pathlib import Path

def verify_standardization():
    ledger_path = Path(__file__).resolve().parents[2] / "data" / "datasets" / "annotation_input" / "road_v1" / "ROAD_REVIEW_DECISIONS.json"
    v1_dir = Path(__file__).resolve().parents[2] / "data" / "datasets" / "neighborlens_v1"
    
    with open(ledger_path, "r", encoding="utf-8") as f:
        data = json.load(f)
        
    images = data["images"]
    total_imgs = len(images)
    total_boxes = 0
    non_empty_decisions = 0
    non_empty_merges = 0
    non_empty_notes = 0
    
    for img_name, img_data in images.items():
        for b in img_data["boxes"]:
            total_boxes += 1
            if b["human_decision"] != "":
                non_empty_decisions += 1
            if b["merge_group"] != []:
                non_empty_merges += 1
            if b["notes"] != "":
                non_empty_notes += 1
                
    print(f"Verified Images Count: {total_imgs} (Expected: 86)")
    print(f"Verified Boxes Count: {total_boxes} (Expected: 334)")
    print(f"Non-empty human_decision count: {non_empty_decisions} (Expected: 0)")
    print(f"Non-empty merge_group count: {non_empty_merges} (Expected: 0)")
    print(f"Non-empty notes count: {non_empty_notes} (Expected: 0)")

if __name__ == "__main__":
    verify_standardization()
