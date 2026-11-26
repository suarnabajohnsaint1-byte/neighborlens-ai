import json
import os

decisions_path = "data/datasets/annotation_input/road_v1/ROAD_REVIEW_DECISIONS.json"
manifest_path = "data/datasets/annotation_input/road_v1/ROAD_REVIEW_MANIFEST.md"
previews_dir = "data/datasets/annotation_input/road_v1/previews"

with open(decisions_path, "r", encoding="utf-8") as f:
    dec_data = json.load(f)

images_dict = dec_data.get("images", {})
print(f"Total image entries in DECISIONS.json: {len(images_dict)}")

total_candidates = 0
untouched_count = 0
missing_fields = []
missing_previews = []
candidate_ids = []

for img_name, img_entry in images_dict.items():
    preview_path = img_entry.get("preview_path", "")
    boxes = img_entry.get("boxes", [])
    
    # Check preview path exists
    if not os.path.exists(preview_path):
        missing_previews.append((img_name, preview_path))
        
    for b in boxes:
        total_candidates += 1
        cand_id = b.get("candidate_id")
        box_idx = b.get("box_idx")
        coords = b.get("coords")
        dec = b.get("human_decision")
        
        if cand_id is None or box_idx is None or coords is None or len(coords) != 4:
            missing_fields.append((img_name, b))
        else:
            candidate_ids.append(cand_id)
            
        if dec == "":
            untouched_count += 1

print(f"Total candidates: {total_candidates}")
print(f"Untouched (empty human_decision): {untouched_count}")
print(f"Missing preview images: {len(missing_previews)}")
print(f"Missing candidate fields: {len(missing_fields)}")
print(f"Candidate IDs unique & sequential 1..334: {candidate_ids == list(range(1, 335))}")

# Check previews directory total count
preview_files = [f for f in os.listdir(previews_dir) if f.lower().endswith(('.jpg', '.jpeg', '.png'))]
print(f"Total preview image files on disk: {len(preview_files)}")
