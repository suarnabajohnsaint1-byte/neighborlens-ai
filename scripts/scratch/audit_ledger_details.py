import json
from collections import Counter

with open("data/datasets/annotation_input/road_v1/ROAD_REVIEW_DECISIONS.json", "r", encoding="utf-8") as f:
    data = json.load(f)

train_images = []
val_images = []
test_images = []

for img_name, img_data in data["images"].items():
    sp = img_data.get("split")
    if sp == "train":
        train_images.append((img_name, img_data))
    elif sp == "val":
        val_images.append((img_name, img_data))
    elif sp == "test":
        test_images.append((img_name, img_data))

print(f"Split distribution: {len(train_images)} train, {len(val_images)} val, {len(test_images)} test (total: {len(data['images'])})")

# Check val/test for any human decisions
val_test_decisions = []
for split_name, img_list in [("val", val_images), ("test", test_images)]:
    for img_name, img_data in img_list:
        for b in img_data.get("boxes", []):
            dec = b.get("human_decision", "").strip()
            if dec:
                val_test_decisions.append((split_name, img_name, b.get("candidate_id"), dec))

print(f"Decisions targeting val/test: {len(val_test_decisions)}")

# Examine TRAIN decisions
train_boxes = []
for img_name, img_data in train_images:
    for b in img_data.get("boxes", []):
        train_boxes.append((img_name, b))

print(f"Total candidate boxes in train: {len(train_boxes)}")

decisions_counter = Counter(b.get("human_decision", "").strip().upper() for _, b in train_boxes)
print(f"TRAIN decision counts: {dict(decisions_counter)}")

# Detailed lists
remove_records = []
merge_records = []
separate_records = []
keep_records = []

for img_name, b in train_boxes:
    dec = b.get("human_decision", "").strip().upper()
    if dec == "REMOVE":
        remove_records.append((img_name, b["candidate_id"], b["box_idx"], b.get("coords"), b.get("notes", "")))
    elif dec == "MERGE":
        merge_records.append((img_name, b["candidate_id"], b["box_idx"], b.get("merge_group", []), b.get("coords"), b.get("notes", "")))
    elif dec == "SEPARATE":
        separate_records.append((img_name, b["candidate_id"], b["box_idx"], b.get("coords"), b.get("notes", "")))
    elif dec == "KEEP":
        keep_records.append((img_name, b["candidate_id"], b["box_idx"], b.get("coords"), b.get("notes", "")))

print(f"\nExact counts: KEEP={len(keep_records)}, REMOVE={len(remove_records)}, MERGE_BOXES={len(merge_records)}, SEPARATE={len(separate_records)}")
assert len(keep_records) + len(remove_records) + len(merge_records) + len(separate_records) == 227

# Group merge records by image and merge_group
merge_groups_dict = {}
for img_name, cand_id, box_idx, grp, coords, notes in merge_records:
    grp_key = (img_name, tuple(sorted(grp)))
    if grp_key not in merge_groups_dict:
        merge_groups_dict[grp_key] = []
    merge_groups_dict[grp_key].append((cand_id, box_idx, coords, notes))

print(f"\nTotal unique MERGE groups: {len(merge_groups_dict)}")
for idx, (grp_key, members) in enumerate(merge_groups_dict.items(), 1):
    img_name, grp = grp_key
    print(f"  Merge Group {idx}: Image '{img_name}', Box IDs: {list(grp)}")
    for cand_id, box_idx, coords, notes in members:
        print(f"    - Member candidate #{cand_id} (box #{box_idx}): coords={coords}, notes='{notes}'")

print("\nExact REMOVE records:")
for idx, (img_name, cand_id, box_idx, coords, notes) in enumerate(remove_records, 1):
    print(f"  {idx}. Image '{img_name}' -> Candidate #{cand_id} (Box #{box_idx}), coords={coords}, notes='{notes}'")

print("\nExact SEPARATE records:")
for idx, (img_name, cand_id, box_idx, coords, notes) in enumerate(separate_records, 1):
    print(f"  {idx}. Image '{img_name}' -> Candidate #{cand_id} (Box #{box_idx}), coords={coords}, notes='{notes}'")
