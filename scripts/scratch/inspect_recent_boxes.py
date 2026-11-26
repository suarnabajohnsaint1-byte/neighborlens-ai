import json

with open("data/datasets/annotation_input/road_v1/ROAD_REVIEW_DECISIONS.json", "r", encoding="utf-8") as f:
    data = json.load(f)

for img_name, img_data in data["images"].items():
    if img_data.get("split") == "train":
        for b in img_data.get("boxes", []):
            ts = b.get("updated_at", "")
            if ts >= "2026-09-16T21:46:50":
                print(f"{ts} | Image: {img_name[:30]}... | Cand: #{b['candidate_id']} (Box #{b['box_idx']}) | Dec: {b['human_decision']} | Notes: {b.get('notes')}")
