from pathlib import Path
from ultralytics import YOLO

workspace = Path(__file__).resolve().parents[2]
best_weights = workspace / "models" / "checkpoints" / "neighborlens_v8_experimental" / "weights" / "best.pt"
model = YOLO(str(best_weights))

test_img_dir = workspace / "data" / "datasets" / "neighborlens_v2_experimental" / "images" / "test"
images = list(test_img_dir.glob("*.jpg"))[:5]

print(f"Testing {len(images)} images with conf=0.01:")
for img in images:
    res = model.predict(source=str(img), conf=0.01, verbose=False)[0]
    boxes = res.boxes
    print(f"\nImage: {img.name}")
    print(f"  Detected boxes: {len(boxes)}")
    for b in boxes:
        cls_id = int(b.cls[0].item())
        cls_name = model.names[cls_id]
        conf = float(b.conf[0].item())
        print(f"    - {cls_name} (class {cls_id}): conf={conf:.4f}")
