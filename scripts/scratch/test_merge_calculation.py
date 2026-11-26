import json
from pathlib import Path

DECISIONS_PATH = Path("data/datasets/annotation_input/road_v1/ROAD_REVIEW_DECISIONS.json")
LABELS_DIR = Path("data/datasets/neighborlens_v2/labels/train")

with open(DECISIONS_PATH, "r", encoding="utf-8") as f:
    data = json.load(f)

# Find merge groups
merge_groups_by_image = {}

for img_name, img_data in data["images"].items():
    if img_data.get("split") != "train":
        continue
    for b in img_data.get("boxes", []):
        if b.get("human_decision") == "MERGE":
            grp = tuple(sorted(b.get("merge_group", [])))
            key = (img_name, grp)
            if key not in merge_groups_by_image:
                merge_groups_by_image[key] = []
            merge_groups_by_image[key].append(b)

print(f"Total merge groups: {len(merge_groups_by_image)}")

for (img_name, grp), boxes in merge_groups_by_image.items():
    print("=" * 70)
    print(f"Image: {img_name}")
    print(f"Merge Group: {list(grp)} ({len(boxes)} member boxes)")

    # Read original v2 label lines to get exact high-precision coords
    stem = Path(img_name).stem
    label_path = LABELS_DIR / f"{stem}.txt"
    with open(label_path, "r", encoding="utf-8") as lf:
        lines = [l.strip().split() for l in lf if l.strip()]

    # Map each box to its high precision v2 coords
    member_coords = []
    for b in boxes:
        ledger_coords = b["coords"]
        # Find matching line in label
        best_line = None
        best_dist = float("inf")
        for line in lines:
            if int(line[0]) == 0:
                coords = [float(x) for x in line[1:5]]
                dist = max(abs(c - lc) for c, lc in zip(coords, ledger_coords))
                if dist < best_dist:
                    best_dist = dist
                    best_line = coords
        assert best_dist < 1e-3, f"Failed to match box {b['box_idx']}"
        member_coords.append((b["box_idx"], b["candidate_id"], best_line))

    # Calculate min enclosing rectangle
    x_mins = []
    y_mins = []
    x_maxs = []
    y_maxs = []

    for b_idx, cand_id, (cx, cy, w, h) in member_coords:
        xmin = cx - w / 2.0
        ymin = cy - h / 2.0
        xmax = cx + w / 2.0
        ymax = cy + h / 2.0
        x_mins.append(xmin)
        y_mins.append(ymin)
        x_maxs.append(xmax)
        y_maxs.append(ymax)
        print(f"  Box #{b_idx} (Cand #{cand_id}): YOLO=[{cx:.6f}, {cy:.6f}, {w:.6f}, {h:.6f}] -> XYXY=[{xmin:.6f}, {ymin:.6f}, {xmax:.6f}, {ymax:.6f}]")

    m_xmin = max(0.0, min(x_mins))
    m_ymin = max(0.0, min(y_mins))
    m_xmax = min(1.0, max(x_maxs))
    m_ymax = min(1.0, max(y_maxs))

    m_cx = (m_xmin + m_xmax) / 2.0
    m_cy = (m_ymin + m_ymax) / 2.0
    m_w = m_xmax - m_xmin
    m_h = m_ymax - m_ymin

    print(f"  --> Merged Box: XYXY=[{m_xmin:.6f}, {m_ymin:.6f}, {m_xmax:.6f}, {m_ymax:.6f}]")
    print(f"  --> Merged YOLO: [0, {m_cx:.6f}, {m_cy:.6f}, {m_w:.6f}, {m_h:.6f}]")
    assert 0.0 <= m_cx <= 1.0 and 0.0 <= m_cy <= 1.0
    assert 0.0 < m_w <= 1.0 and 0.0 < m_h <= 1.0
