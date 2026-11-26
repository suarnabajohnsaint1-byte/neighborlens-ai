import os
import json
from pathlib import Path

def prepare_review_template():
    review_dir = Path(__file__).resolve().parents[2] / "data" / "datasets" / "annotation_input" / "road_v1"
    candidates_file = review_dir / "road_review_candidates.json"
    
    with open(candidates_file, "r", encoding="utf-8") as f:
        candidates = json.load(f)
        
    print(f"Loaded {len(candidates)} candidates.")
    
    # Structure decisions file by image for easier human review
    images_map = {}
    for c in candidates:
        img_name = c["image"]
        if img_name not in images_map:
            images_map[img_name] = {
                "image": img_name,
                "split": c["split"],
                "preview_path": f"data/datasets/annotation_input/road_v1/previews/{Path(img_name).stem}_annotated.jpg",
                "boxes": []
            }
        images_map[img_name]["boxes"].append({
            "candidate_id": c["id"],
            "box_idx": c["box_idx"],
            "coords": [round(c["cx"], 4), round(c["cy"], 4), round(c["w"], 4), round(c["h"], 4)],
            "area_pct": round(c["area_pct"], 3),
            "aspect_ratio": round(c["aspect_ratio"], 1),
            "flag_reason": c["reasons"],
            "default_action": c["proposed_action"],
            "human_decision": "" # Allowed: KEEP, MERGE, SEPARATE, REMOVE, REVIEW
        })
        
    decisions_template = {
        "review_instructions": {
            "allowed_decisions": ["KEEP", "MERGE", "SEPARATE", "REMOVE", "REVIEW"],
            "definitions": {
                "KEEP": "Clearly visible road damage instance to retain as-is.",
                "MERGE": "Multiple fragmented boxes representing the same continuous defective road surface; merge into one enclosing box.",
                "SEPARATE": "Spatially distinct defect instances to keep separate.",
                "REMOVE": "Indistinguishable micro-fissure, normal asphalt grain, skid mark, or shadow.",
                "REVIEW": "Ambiguous case requiring secondary check."
            }
        },
        "total_flagged_images": len(images_map),
        "total_flagged_boxes": len(candidates),
        "images": images_map
    }
    
    decisions_file = review_dir / "ROAD_REVIEW_DECISIONS.json"
    with open(decisions_file, "w", encoding="utf-8") as f:
        json.dump(decisions_template, f, indent=2)
        
    print(f"Generated review decisions template at: {decisions_file}")

if __name__ == "__main__":
    prepare_review_template()
