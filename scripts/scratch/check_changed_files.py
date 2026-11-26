import json
from pathlib import Path

DECISIONS_PATH = Path("data/datasets/annotation_input/road_v1/ROAD_REVIEW_DECISIONS.json")

with open(DECISIONS_PATH, "r", encoding="utf-8") as f:
    data = json.load(f)

changed_images = set()
remove_images = set()
merge_images = set()

for img_name, img_data in data["images"].items():
    if img_data.get("split") != "train":
        continue
    for b in img_data.get("boxes", []):
        dec = b.get("human_decision")
        if dec == "REMOVE":
            remove_images.add(img_name)
            changed_images.add(img_name)
        elif dec == "MERGE":
            merge_images.add(img_name)
            changed_images.add(img_name)

print(f"Total images with REMOVE decisions: {len(remove_images)}")
print(f"Total images with MERGE decisions: {len(merge_images)}")
print(f"Overlap (images with both REMOVE and MERGE): {len(remove_images & merge_images)}")
print(f"Total unique TRAIN images/files changed: {len(changed_images)}")
print(f"Total TRAIN images/files unchanged: {171 - len(changed_images)}")

print("\nList of all changed TRAIN label files:")
for idx, img in enumerate(sorted(changed_images), 1):
    stem = Path(img).stem
    reasons = []
    if img in remove_images:
        reasons.append("REMOVE")
    if img in merge_images:
        reasons.append("MERGE")
    print(f"  {idx}. {stem}.txt ({'+'.join(reasons)})")
