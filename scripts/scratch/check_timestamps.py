import json
from datetime import datetime

with open("data/datasets/annotation_input/road_v1/ROAD_REVIEW_DECISIONS.json", "r", encoding="utf-8") as f:
    data = json.load(f)

records_by_time = []
for img_name, img_data in data["images"].items():
    if img_data.get("split") == "train":
        for b in img_data.get("boxes", []):
            records_by_time.append({
                "image": img_name,
                "cand_id": b["candidate_id"],
                "box_idx": b["box_idx"],
                "dec": b.get("human_decision"),
                "notes": b.get("notes", ""),
                "updated_at": b.get("updated_at", "")
            })

records_by_time.sort(key=lambda x: x["updated_at"])

print(f"Total records: {len(records_by_time)}")
# Group by decision
from collections import Counter
print("Decision distribution:", Counter(r["dec"] for r in records_by_time))

# Show timestamps distribution
ts_counts = Counter(r["updated_at"][:19] if r["updated_at"] else "empty" for r in records_by_time)
print("\nTimestamp distribution:")
for ts, count in ts_counts.items():
    print(f"  {ts}: {count} boxes")
