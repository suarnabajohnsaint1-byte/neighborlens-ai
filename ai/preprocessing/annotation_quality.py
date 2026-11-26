from collections import Counter, defaultdict
from pathlib import Path

from ai.preprocessing.scene_lineage import IMAGE_EXTENSIONS, SPLITS

CANONICAL_NAMES = {
    0: "broken_streetlight",
    1: "clogged_drainage",
    2: "pothole",
    3: "road_crack",
}
SAFE_AUTOMATIC_FIX = "SAFE_AUTOMATIC_FIX"
MANUAL_REVIEW_REQUIRED = "MANUAL_REVIEW_REQUIRED"
CRITICAL = "critical"
WARNING = "warning"
EDGE_TOLERANCE = 1e-3
MICRO_AREA = 0.0025
MICRO_SIDE = 0.02
NEAR_DUPLICATE_IOU = 0.9
EXTREME_OVERLAP_IOU = 0.6
CONTAINMENT_RATIO = 0.9
FRAGMENT_CLASSES = (2, 3)
FRAGMENT_MIN_BOXES = 4
FRAGMENT_MIN_SMALL_BOXES = 3
FRAGMENT_SMALL_AREA = 0.02
FRAGMENT_TOUCH_IOU = 0.0


def parse_label_file(path):
    boxes = []
    issues = []
    text = Path(path).read_text(encoding="utf-8")
    for line_number, raw in enumerate(text.splitlines(), start=1):
        line = raw.strip()
        if not line:
            continue
        parts = line.split()
        if len(parts) != 5:
            issues.append(_issue("malformed_line", CRITICAL, MANUAL_REVIEW_REQUIRED, line_number, raw))
            continue
        try:
            class_float = float(parts[0])
            values = [float(item) for item in parts[1:]]
        except ValueError:
            issues.append(_issue("non_numeric_line", CRITICAL, MANUAL_REVIEW_REQUIRED, line_number, raw))
            continue
        if class_float != int(class_float) or int(class_float) not in CANONICAL_NAMES:
            issues.append(_issue("invalid_class_id", CRITICAL, MANUAL_REVIEW_REQUIRED, line_number, raw))
            continue
        boxes.append({"line": line_number, "class_id": int(class_float), "box": tuple(values), "raw": line})
    return boxes, issues


def _issue(kind, severity, action, line, detail=""):
    return {"kind": kind, "severity": severity, "action": action, "line": line, "detail": detail}


def to_corners(box):
    x_center, y_center, width, height = box
    return (
        x_center - width / 2,
        y_center - height / 2,
        x_center + width / 2,
        y_center + height / 2,
    )


def iou_and_containment(box_a, box_b):
    ax1, ay1, ax2, ay2 = to_corners(box_a)
    bx1, by1, bx2, by2 = to_corners(box_b)
    inter_w = max(0.0, min(ax2, bx2) - max(ax1, bx1))
    inter_h = max(0.0, min(ay2, by2) - max(ay1, by1))
    inter = inter_w * inter_h
    area_a = box_a[2] * box_a[3]
    area_b = box_b[2] * box_b[3]
    union = area_a + area_b - inter
    iou = inter / union if union > 0 else 0.0
    smaller = min(area_a, area_b)
    containment = inter / smaller if smaller > 0 else 0.0
    return iou, containment


def audit_label_boxes(boxes):
    issues = []
    valid = []
    for item in boxes:
        x_center, y_center, width, height = item["box"]
        line = item["line"]
        if width <= 0 or height <= 0:
            issues.append(_issue("non_positive_size", CRITICAL, MANUAL_REVIEW_REQUIRED, line, item["raw"]))
            continue
        if not all(0.0 <= value <= 1.0 for value in item["box"]):
            overshoot = max(max(abs(value - min(max(value, 0.0), 1.0)) for value in item["box"]), 0.0)
            action = SAFE_AUTOMATIC_FIX if overshoot <= EDGE_TOLERANCE else MANUAL_REVIEW_REQUIRED
            issues.append(_issue("coordinate_outside_unit_range", CRITICAL, action, line, item["raw"]))
            if action == MANUAL_REVIEW_REQUIRED:
                continue
        x1, y1, x2, y2 = to_corners(item["box"])
        if x1 < -EDGE_TOLERANCE or y1 < -EDGE_TOLERANCE or x2 > 1 + EDGE_TOLERANCE or y2 > 1 + EDGE_TOLERANCE:
            action = SAFE_AUTOMATIC_FIX if max(-x1, -y1, x2 - 1, y2 - 1) <= 0.01 else MANUAL_REVIEW_REQUIRED
            issues.append(_issue("box_extends_outside_image", WARNING, action, line, item["raw"]))
        elif x1 < 0 or y1 < 0 or x2 > 1 or y2 > 1:
            issues.append(_issue("box_extends_outside_image", WARNING, SAFE_AUTOMATIC_FIX, line, item["raw"]))
        area = width * height
        if area < MICRO_AREA or width < MICRO_SIDE or height < MICRO_SIDE:
            issues.append(
                _issue("micro_box", WARNING, MANUAL_REVIEW_REQUIRED, line, f"area={area:.5f} {item['raw']}")
            )
        valid.append(item)

    seen = {}
    for item in valid:
        key = (item["class_id"], tuple(round(value, 6) for value in item["box"]))
        if key in seen:
            issues.append(
                _issue("exact_duplicate_box", WARNING, SAFE_AUTOMATIC_FIX, item["line"], f"duplicates line {seen[key]}")
            )
        else:
            seen[key] = item["line"]

    unique = [item for item in valid if seen[(item["class_id"], tuple(round(v, 6) for v in item["box"]))] == item["line"]]
    for first_index in range(len(unique)):
        for second_index in range(first_index + 1, len(unique)):
            first, second = unique[first_index], unique[second_index]
            iou, containment = iou_and_containment(first["box"], second["box"])
            same_class = first["class_id"] == second["class_id"]
            detail = f"lines {first['line']},{second['line']} iou={iou:.2f} containment={containment:.2f}"
            if same_class and iou >= NEAR_DUPLICATE_IOU:
                issues.append(_issue("near_duplicate_box", WARNING, MANUAL_REVIEW_REQUIRED, first["line"], detail))
            elif iou >= EXTREME_OVERLAP_IOU or containment >= CONTAINMENT_RATIO:
                kind = "extreme_overlap_same_class" if same_class else "extreme_overlap_cross_class"
                issues.append(_issue(kind, WARNING, MANUAL_REVIEW_REQUIRED, first["line"], detail))

    for class_id in FRAGMENT_CLASSES:
        class_boxes = [item for item in unique if item["class_id"] == class_id]
        if len(class_boxes) < FRAGMENT_MIN_BOXES:
            continue
        small = [item for item in class_boxes if item["box"][2] * item["box"][3] < FRAGMENT_SMALL_AREA]
        touching = 0
        for first_index in range(len(class_boxes)):
            for second_index in range(first_index + 1, len(class_boxes)):
                iou, containment = iou_and_containment(class_boxes[first_index]["box"], class_boxes[second_index]["box"])
                if iou > FRAGMENT_TOUCH_IOU:
                    touching += 1
        if len(small) >= FRAGMENT_MIN_SMALL_BOXES or touching >= 2:
            issues.append(
                _issue(
                    "possible_fragmented_annotation",
                    WARNING,
                    MANUAL_REVIEW_REQUIRED,
                    0,
                    f"class={CANONICAL_NAMES[class_id]} boxes={len(class_boxes)} small={len(small)} overlapping_pairs={touching}",
                )
            )
    return issues


def audit_dataset_annotations(dataset_root):
    dataset_root = Path(dataset_root)
    report = defaultdict(list)
    summary = Counter()
    for split in SPLITS:
        images_dir = dataset_root / split / "images"
        labels_dir = dataset_root / split / "labels"
        image_stems = {
            path.stem: path
            for path in images_dir.iterdir()
            if path.is_file() and path.suffix.lower() in IMAGE_EXTENSIONS
        } if images_dir.is_dir() else {}
        label_stems = {path.stem: path for path in labels_dir.glob("*.txt")} if labels_dir.is_dir() else {}
        for stem in sorted(set(image_stems) - set(label_stems)):
            report[f"{split}/{stem}"].append(_issue("missing_label", CRITICAL, MANUAL_REVIEW_REQUIRED, 0))
        for stem in sorted(set(label_stems) - set(image_stems)):
            report[f"{split}/{stem}"].append(_issue("orphan_label", CRITICAL, MANUAL_REVIEW_REQUIRED, 0))
        for stem, label_path in sorted(label_stems.items()):
            boxes, issues = parse_label_file(label_path)
            if not boxes and not issues:
                issues.append(_issue("empty_label", WARNING, MANUAL_REVIEW_REQUIRED, 0, "background-only image"))
            issues.extend(audit_label_boxes(boxes))
            summary[f"{split}.labels"] += 1
            for found in issues:
                report[f"{split}/{label_path.name}"].append(found)
                summary[found["kind"]] += 1
    return dict(report), dict(summary)


def box_statistics(dataset_root):
    stats = defaultdict(lambda: Counter())
    for split in SPLITS:
        labels_dir = Path(dataset_root) / split / "labels"
        if not labels_dir.is_dir():
            continue
        for label_path in labels_dir.glob("*.txt"):
            boxes, _ = parse_label_file(label_path)
            for item in boxes:
                stats[split][item["class_id"]] += 1
    return {split: dict(counter) for split, counter in stats.items()}
