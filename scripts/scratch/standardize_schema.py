import json
from pathlib import Path

def standardize_schema():
    ledger_path = Path(__file__).resolve().parents[2] / "data" / "datasets" / "annotation_input" / "road_v1" / "ROAD_REVIEW_DECISIONS.json"
    
    with open(ledger_path, "r", encoding="utf-8") as f:
        data = json.load(f)
        
    data["review_instructions"] = {
        "allowed_decisions": ["KEEP", "MERGE", "SEPARATE", "REMOVE", "REVIEW"],
        "fields_guide": {
            "human_decision": "Must be exactly one of: 'KEEP', 'MERGE', 'SEPARATE', 'REMOVE', 'REVIEW'.",
            "merge_group": "For 'MERGE' decisions only: list of 1-indexed box numbers participating in the merge, e.g. [1, 2, 3]. Leave as [] for all other decisions.",
            "notes": "Optional string for human reviewer comments / rationale."
        },
        "definitions": {
            "KEEP": "Clearly visible road damage instance to retain as-is.",
            "MERGE": "Multiple fragmented boxes representing the same continuous defective road surface; merge into one enclosing box.",
            "SEPARATE": "Spatially distinct defect instances to keep separate.",
            "REMOVE": "Indistinguishable micro-fissure, normal asphalt grain, skid mark, or shadow.",
            "REVIEW": "Ambiguous case requiring secondary check."
        }
    }
    
    total_boxes = 0
    total_images = len(data["images"])
    
    for img_name, img_data in data["images"].items():
        new_boxes = []
        for b in img_data["boxes"]:
            total_boxes += 1
            new_box = {
                "candidate_id": b["candidate_id"],
                "box_idx": b["box_idx"],
                "coords": b["coords"],
                "area_pct": b["area_pct"],
                "aspect_ratio": b["aspect_ratio"],
                "flag_reason": b["flag_reason"],
                "default_action": b["default_action"],
                "human_decision": "",
                "merge_group": [],
                "notes": ""
            }
            new_boxes.append(new_box)
        img_data["boxes"] = new_boxes
        
    with open(ledger_path, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2)
        
    print(f"Standardized schema saved to: {ledger_path}")
    print(f"Total images: {total_images}")
    print(f"Total boxes: {total_boxes}")

if __name__ == "__main__":
    standardize_schema()
