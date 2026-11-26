import os
import json
from datetime import datetime, timezone
from pathlib import Path

LEDGER_PATH = Path("data/datasets/annotation_input/road_v1/ROAD_REVIEW_DECISIONS.json")

EXPECTED_CANDIDATE_IDS = {58, 81, 100, 105, 174}

with open(LEDGER_PATH, "r", encoding="utf-8") as f:
    data = json.load(f)

unresolved_train_candidates = []

for img_name, img_data in data.get("images", {}).items():
    split = img_data.get("split")
    for b in img_data.get("boxes", []):
        dec = b.get("human_decision", "").strip().upper()
        if dec == "":
            if split == "train":
                unresolved_train_candidates.append((img_name, b))

print(f"Verified unresolved TRAIN candidate count: {len(unresolved_train_candidates)}")
assert len(unresolved_train_candidates) == 5, f"Expected exactly 5 unresolved candidates, got {len(unresolved_train_candidates)}"

found_cand_ids = {b["candidate_id"] for _, b in unresolved_train_candidates}
assert found_cand_ids == EXPECTED_CANDIDATE_IDS, f"Candidate IDs mismatch: {found_cand_ids} != {EXPECTED_CANDIDATE_IDS}"

# Apply the explicit human decision: KEEP
now_iso = datetime.now(timezone.utc).isoformat()

for img_name, b in unresolved_train_candidates:
    print(f"Updating candidate #{b['candidate_id']} on {img_name} to KEEP")
    b["human_decision"] = "KEEP"
    b["merge_group"] = []
    b["notes"] = "Human decision: keep unchanged (E-3 human review completion)"
    b["updated_at"] = now_iso

# Update image review statuses
for img_name, img_data in data.get("images", {}).items():
    if img_data.get("split") == "train":
        all_resolved = all(b.get("human_decision") in {"KEEP", "MERGE", "SEPARATE", "REMOVE"} for b in img_data.get("boxes", []))
        if all_resolved:
            img_data["reviewed"] = True
            if not img_data.get("reviewed_at"):
                img_data["reviewed_at"] = now_iso

# Atomic write
tmp_path = LEDGER_PATH.with_suffix(".tmp")
with open(tmp_path, "w", encoding="utf-8") as f:
    json.dump(data, f, indent=2)

os.replace(tmp_path, LEDGER_PATH)
print("Successfully updated ROAD_REVIEW_DECISIONS.json atomically.")
