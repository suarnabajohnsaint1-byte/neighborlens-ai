import json
import os
from PIL import Image

decisions_path = "data/datasets/annotation_input/road_v1/ROAD_REVIEW_DECISIONS.json"

with open(decisions_path, "r", encoding="utf-8") as f:
    dec_data = json.load(f)

images_dict = dec_data.get("images", {})
unreadable_previews = []

for img_name, img_entry in images_dict.items():
    preview_path = img_entry.get("preview_path", "")
    try:
        with Image.open(preview_path) as img:
            w, h = img.size
            if w == 0 or h == 0:
                unreadable_previews.append((preview_path, "zero dimensions"))
    except Exception as e:
        unreadable_previews.append((preview_path, str(e)))

print(f"Total checked previews: {len(images_dict)}")
print(f"Unreadable previews: {len(unreadable_previews)}")
