import json

with open("data/datasets/annotation_input/road_v1/ROAD_REVIEW_DECISIONS.json", "r", encoding="utf-8") as f:
    data = json.load(f)

unresolved_train = []
unresolved_val_test = []

for img_name, img_data in data.get("images", {}).items():
    split = img_data.get("split")
    for b in img_data.get("boxes", []):
        dec = b.get("human_decision", "").strip().upper()
        if dec == "":
            record = {
                "image": img_name,
                "split": split,
                "candidate_id": b.get("candidate_id"),
                "box_idx": b.get("box_idx"),
                "coords": b.get("coords"),
                "flag_reason": b.get("flag_reason"),
                "human_decision": b.get("human_decision"),
                "merge_group": b.get("merge_group"),
                "notes": b.get("notes")
            }
            if split == "train":
                unresolved_train.append(record)
            else:
                unresolved_val_test.append(record)

print(f"Total unresolved TRAIN candidates: {len(unresolved_train)}")
print(f"Total unresolved VAL/TEST candidates: {len(unresolved_val_test)}")

print("\n--- UNRESOLVED TRAIN CANDIDATES ---")
for idx, u in enumerate(unresolved_train, 1):
    print(f"{idx}. Image: {u['image']}")
    print(f"   Candidate ID: #{u['candidate_id']} (Box #{u['box_idx']})")
    print(f"   Split: {u['split']}")
    print(f"   Current Decision: '{u['human_decision']}'")
    print(f"   Coords: {u['coords']}")
    print(f"   Flag Reason: {u['flag_reason']}")
