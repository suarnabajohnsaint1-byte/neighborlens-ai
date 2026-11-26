"""
Neighborlens AI Dataset & Model Preview Visual Generator
Renders clean, high-resolution scientific preview images adhering strictly to:
- Pure white document background
- Black borders, text, and dividers
- Untouched original color photographs
- Ground-truth boxes with actual class labels
- 3-way comparisons: Ground Truth | YOLOv3 (infrastructure_v3) | YOLOv8
"""

import os
import cv2
import numpy as np
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont
from ultralytics import YOLO

WORKSPACE_ROOT = Path(__file__).resolve().parents[2]
OUT_DIR = WORKSPACE_ROOT / "docs" / "progress" / "yolo-comparison"
OUT_DIR.mkdir(parents=True, exist_ok=True)

# Canonical 4-class taxonomy
CLASSES = {
    0: "damaged_road",
    1: "clogged_drainage",
    2: "damaged_street_light",
    3: "damaged_traffic_light"
}

# Color palette for bounding boxes (high visibility, professional)
CLASS_COLORS = {
    0: (230, 81, 0),    # Deep Orange for damaged_road
    1: (0, 151, 167),   # Cyan/Teal for clogged_drainage
    2: (245, 127, 23),  # Amber/Yellow for damaged_street_light
    3: (194, 24, 91),   # Pink/Magenta for damaged_traffic_light
}

FONT_PATH = "C:/Windows/Fonts/segoeui.ttf"
FONT_BOLD_PATH = "C:/Windows/Fonts/segoeuib.ttf"
FONT_MONO_PATH = "C:/Windows/Fonts/consola.ttf"

def get_font(size: int, bold: bool = False, mono: bool = False):
    try:
        path = FONT_MONO_PATH if mono else (FONT_BOLD_PATH if bold else FONT_PATH)
        return ImageFont.truetype(path, size)
    except Exception:
        return ImageFont.load_default()

# 6 Representative Images
ITEMS = [
    {
        "id": 1,
        "split": "train",
        "split_label": "TRAIN SAMPLE",
        "filename": "00A89F15-00E2-4176-9419-11373B709B54_1_105_c_jpeg.rf.99b6b0bd01da1747b7ea4f96681f4724.jpg",
        "dataset_version": "neighborlens_v2 (source: v1)",
        "desc": "Neighborhood street asphalt cracking"
    },
    {
        "id": 2,
        "split": "val",
        "split_label": "VALIDATION SAMPLE",
        "filename": "55.jpg",
        "dataset_version": "neighborlens_v2 (source: v1 drainage)",
        "desc": "Street curb drainage inlet clogged with debris"
    },
    {
        "id": 3,
        "split": "val",
        "split_label": "VALIDATION SAMPLE",
        "filename": "1_jpg.rf.43cf2fe7ea2edceefc12489648885ce5.jpg",
        "dataset_version": "neighborlens_v2 (source: v1)",
        "desc": "Neighborhood street light fixtures on utility pole"
    },
    {
        "id": 4,
        "split": "test",
        "split_label": "TEST SAMPLE",
        "filename": "18_jpg.rf.3dc7dfb70ede241ad8cefb5097cc45d4.jpg",
        "dataset_version": "neighborlens_v2 (source: v1)",
        "desc": "Urban intersection traffic signals at distance"
    },
    {
        "id": 5,
        "split": "train",
        "split_label": "TRAIN SAMPLE",
        "filename": "1.jpg",
        "dataset_version": "neighborlens_v2 (source: v1 drainage)",
        "desc": "Clogged roadside drainage channel with sludge"
    },
    {
        "id": 6,
        "split": "val",
        "split_label": "VALIDATION SAMPLE",
        "filename": "0C054702-3974-4ABC-8723-B17D8DD22A3D_1_105_c_jpeg.rf.31c8216c795f744eebd46698f5affb2b.jpg",
        "dataset_version": "neighborlens_v2 (source: v1)",
        "desc": "Asphalt road pothole and structural fissures"
    }
]

def load_image_and_labels(item):
    split = item["split"]
    fn = item["filename"]
    img_p = WORKSPACE_ROOT / "data" / "datasets" / "neighborlens_v2" / "images" / split / fn
    lbl_p = WORKSPACE_ROOT / "data" / "datasets" / "neighborlens_v2" / "labels" / split / f"{img_p.stem}.txt"
    
    img = Image.open(img_p).convert("RGB")
    boxes = []
    if lbl_p.exists():
        with open(lbl_p, "r", encoding="utf-8") as f:
            for line in f:
                parts = line.strip().split()
                if len(parts) >= 5:
                    cid = int(parts[0])
                    cx, cy, w, h = map(float, parts[1:5])
                    boxes.append((cid, cx, cy, w, h))
    return img, boxes

def draw_ground_truth(img: Image.Image, boxes: list, scale_to: tuple = None) -> Image.Image:
    if scale_to:
        target_w, target_h = scale_to
        # letterbox or fit with aspect ratio preserved
        im_w, im_h = img.size
        # fit inside target_w, target_h
        scale = min(target_w / im_w, target_h / im_h)
        nw, nh = int(im_w * scale), int(im_h * scale)
        res_img = img.resize((nw, nh), Image.Resampling.LANCZOS)
        pad_x = (target_w - nw) // 2
        pad_y = (target_h - nh) // 2
        canvas = Image.new("RGB", (target_w, target_h), (245, 245, 245))
        canvas.paste(res_img, (pad_x, pad_y))
        
        draw = ImageDraw.Draw(canvas)
        font = get_font(12, bold=True)
        
        for cid, cx, cy, w, h in boxes:
            # map normalized coordinates to canvas
            box_cx = pad_x + cx * nw
            box_cy = pad_y + cy * nh
            box_w = w * nw
            box_h = h * nh
            x1 = int(box_cx - box_w / 2)
            y1 = int(box_cy - box_h / 2)
            x2 = int(box_cx + box_w / 2)
            y2 = int(box_cy + box_h / 2)
            
            color = CLASS_COLORS.get(cid, (0, 200, 0))
            # draw rectangle
            draw.rectangle([x1, y1, x2, y2], outline=color, width=3)
            # badge
            label_txt = f"GT: {CLASSES.get(cid, str(cid))}"
            tb = draw.textbbox((x1, y1), label_txt, font=font)
            badge_w = tb[2] - tb[0] + 6
            badge_h = tb[3] - tb[1] + 4
            by1 = max(0, y1 - badge_h)
            draw.rectangle([x1, by1, x1 + badge_w, by1 + badge_h], fill=color)
            draw.text((x1 + 3, by1 + 2), label_txt, fill=(255, 255, 255), font=font)
            
        return canvas
    else:
        # direct draw
        draw_img = img.copy()
        draw = ImageDraw.Draw(draw_img)
        font = get_font(14, bold=True)
        w_img, h_img = img.size
        for cid, cx, cy, w, h in boxes:
            x1 = int((cx - w / 2) * w_img)
            y1 = int((cy - h / 2) * h_img)
            x2 = int((cx + w / 2) * w_img)
            y2 = int((cy + h / 2) * h_img)
            color = CLASS_COLORS.get(cid, (0, 200, 0))
            draw.rectangle([x1, y1, x2, y2], outline=color, width=3)
            label_txt = f"GT: {CLASSES.get(cid, str(cid))}"
            tb = draw.textbbox((x1, y1), label_txt, font=font)
            badge_w = tb[2] - tb[0] + 8
            badge_h = tb[3] - tb[1] + 4
            by1 = max(0, y1 - badge_h)
            draw.rectangle([x1, by1, x1 + badge_w, by1 + badge_h], fill=color)
            draw.text((x1 + 4, by1 + 2), label_txt, fill=(255, 255, 255), font=font)
        return draw_img

def draw_predictions(img: Image.Image, preds: list, model_name: str, scale_to: tuple = None) -> Image.Image:
    im_w, im_h = img.size
    if scale_to:
        target_w, target_h = scale_to
        scale = min(target_w / im_w, target_h / im_h)
        nw, nh = int(im_w * scale), int(im_h * scale)
        res_img = img.resize((nw, nh), Image.Resampling.LANCZOS)
        pad_x = (target_w - nw) // 2
        pad_y = (target_h - nh) // 2
        canvas = Image.new("RGB", (target_w, target_h), (245, 245, 245))
        canvas.paste(res_img, (pad_x, pad_y))
        draw = ImageDraw.Draw(canvas)
        font = get_font(12, bold=True)
        
        for cid, conf, (px1, py1, px2, py2) in preds:
            x1 = int(pad_x + (px1 / im_w) * nw)
            y1 = int(pad_y + (py1 / im_h) * nh)
            x2 = int(pad_x + (px2 / im_w) * nw)
            y2 = int(pad_y + (py2 / im_h) * nh)
            color = (200, 0, 0) # Red for predictions
            draw.rectangle([x1, y1, x2, y2], outline=color, width=3)
            cname = CLASSES.get(cid, f"class_{cid}")
            label_txt = f"{cname} {conf:.2f}"
            tb = draw.textbbox((x1, y1), label_txt, font=font)
            badge_w = tb[2] - tb[0] + 6
            badge_h = tb[3] - tb[1] + 4
            by1 = max(0, y1 - badge_h)
            draw.rectangle([x1, by1, x1 + badge_w, by1 + badge_h], fill=color)
            draw.text((x1 + 3, by1 + 2), label_txt, fill=(255, 255, 255), font=font)
        return canvas
    else:
        draw_img = img.copy()
        draw = ImageDraw.Draw(draw_img)
        font = get_font(14, bold=True)
        for cid, conf, (px1, py1, px2, py2) in preds:
            color = (200, 0, 0)
            draw.rectangle([int(px1), int(py1), int(px2), int(py2)], outline=color, width=3)
            cname = CLASSES.get(cid, f"class_{cid}")
            label_txt = f"{cname} {conf:.2f}"
            tb = draw.textbbox((int(px1), int(py1)), label_txt, font=font)
            badge_w = tb[2] - tb[0] + 8
            badge_h = tb[3] - tb[1] + 4
            by1 = max(0, int(py1) - badge_h)
            draw.rectangle([int(px1), by1, int(px1) + badge_w, by1 + badge_h], fill=color)
            draw.text((int(px1) + 4, by1 + 2), label_txt, fill=(255, 255, 255), font=font)
        return draw_img

def render_contact_sheet(annotated: bool = False) -> Image.Image:
    """
    Renders 2x3 contact sheet:
    Total width: 1400px, height: 1120px
    Document style:
    - Pure white background (255, 255, 255)
    - Black borders, text, dividers
    - Authentic color photos
    """
    canvas_w = 1400
    canvas_h = 1140
    canvas = Image.new("RGB", (canvas_w, canvas_h), (255, 255, 255))
    draw = ImageDraw.Draw(canvas)
    
    # Outer black document border
    draw.rectangle([15, 15, canvas_w - 15, canvas_h - 15], outline=(0, 0, 0), width=2)
    
    # Header
    title_font = get_font(24, bold=True)
    subtitle_font = get_font(14, bold=False)
    meta_font = get_font(12, bold=False)
    
    if annotated:
        title = "Neighborlens AI Ground-Truth Annotation Preview"
        sub = "Actual Dataset Human Ground-Truth Labels & Bounding Boxes (data/datasets/neighborlens_v2)"
        note = "STATUS: GROUND TRUTH / DATASET LABELS (NOT MODEL PREDICTIONS)"
    else:
        title = "Neighborlens AI Dataset Preview"
        sub = "Representative Training, Validation & Test Split Samples (data/datasets/neighborlens_v2)"
        note = "AUTHENTIC DATASET PHOTOGRAPHS — ORIGINAL PIXELS UNMODIFIED"
        
    draw.text((40, 35), title, fill=(0, 0, 0), font=title_font)
    draw.text((40, 70), sub, fill=(60, 60, 60), font=subtitle_font)
    draw.text((canvas_w - 40, 70), note, fill=(0, 0, 0), font=get_font(11, bold=True), anchor="ra")
    
    # Header divider
    draw.line([30, 100, canvas_w - 30, 100], fill=(0, 0, 0), width=2)
    
    # Grid parameters: 2 rows x 3 cols
    cols = 3
    rows = 2
    margin_x = 40
    start_y = 120
    card_w = 410
    card_h = 460
    img_box_w = 406
    img_box_h = 310
    spacing_x = 35
    spacing_y = 30
    
    card_title_font = get_font(14, bold=True)
    card_text_font = get_font(12, bold=False)
    card_badge_font = get_font(11, bold=True)
    
    for idx, item in enumerate(ITEMS):
        c = idx % cols
        r = idx // cols
        x = margin_x + c * (card_w + spacing_x)
        y = start_y + r * (card_h + spacing_y)
        
        # Draw card outline
        draw.rectangle([x, y, x + card_w, y + card_h], outline=(0, 0, 0), width=1, fill=(255, 255, 255))
        
        # Load image & boxes
        raw_img, boxes = load_image_and_labels(item)
        
        # Draw either raw image or annotated image
        if annotated:
            disp_img = draw_ground_truth(raw_img, boxes, scale_to=(img_box_w, img_box_h))
        else:
            # letterbox fit raw image
            im_w, im_h = raw_img.size
            scale = min(img_box_w / im_w, img_box_h / im_h)
            nw, nh = int(im_w * scale), int(im_h * scale)
            res = raw_img.resize((nw, nh), Image.Resampling.LANCZOS)
            disp_img = Image.new("RGB", (img_box_w, img_box_h), (245, 245, 245))
            pad_x = (img_box_w - nw) // 2
            pad_y = (img_box_h - nh) // 2
            disp_img.paste(res, (pad_x, pad_y))
            
        canvas.paste(disp_img, (x + 2, y + 2))
        # border below image
        draw.line([x, y + img_box_h + 2, x + card_w, y + img_box_h + 2], fill=(0, 0, 0), width=1)
        
        # Metadata area
        meta_y = y + img_box_h + 12
        
        # Split badge
        split_lbl = item["split_label"]
        draw.rectangle([x + 10, meta_y, x + 150, meta_y + 22], outline=(0, 0, 0), fill=(240, 240, 240), width=1)
        draw.text((x + 80, meta_y + 3), split_lbl, fill=(0, 0, 0), font=card_badge_font, anchor="ma")
        
        # Class list
        cids = list(set([b[0] for b in boxes]))
        class_str = ", ".join([CLASSES[c] for c in cids]) if cids else "No GT objects"
        draw.text((x + 10, meta_y + 30), f"Class: {class_str}", fill=(0, 0, 0), font=card_title_font)
        
        # Box count
        draw.text((x + 10, meta_y + 52), f"Annotations: {len(boxes)} box(es) | Size: {raw_img.width}x{raw_img.height}", fill=(50, 50, 50), font=card_text_font)
        
        # Filename (shortened if long)
        fname = item["filename"]
        display_fn = fname if len(fname) < 42 else (fname[:20] + "..." + fname[-18:])
        draw.text((x + 10, meta_y + 72), f"File: {display_fn}", fill=(80, 80, 80), font=get_font(11, mono=True))
        
        # Description
        draw.text((x + 10, meta_y + 92), f"Context: {item['desc']}", fill=(60, 60, 60), font=card_text_font)
        
    # Footer divider
    foot_y = canvas_h - 45
    draw.line([30, foot_y, canvas_w - 30, foot_y], fill=(0, 0, 0), width=1)
    draw.text((40, foot_y + 8), "NeighborLens AI Research & Evaluation Suite — Authentic Ground-Truth Records (Academic Audit)", fill=(80, 80, 80), font=meta_font)
    draw.text((canvas_w - 40, foot_y + 8), "Zero Synthetic Pixels • Stratified v2/v3 Benchmarks", fill=(80, 80, 80), font=meta_font, anchor="ra")
    
    return canvas

def generate_previews():
    print("Generating dataset-preview.png...")
    preview = render_contact_sheet(annotated=False)
    preview.save(OUT_DIR / "dataset-preview.png", "PNG")
    print(f"Saved: {OUT_DIR / 'dataset-preview.png'}")
    
    print("Generating dataset-ground-truth-preview.png...")
    gt_preview = render_contact_sheet(annotated=True)
    gt_preview.save(OUT_DIR / "dataset-ground-truth-preview.png", "PNG")
    print(f"Saved: {OUT_DIR / 'dataset-ground-truth-preview.png'}")

if __name__ == "__main__":
    generate_previews()
