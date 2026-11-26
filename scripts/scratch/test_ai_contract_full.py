import requests
import io
from PIL import Image, ImageDraw

def create_sample_image(color=(128, 128, 128)):
    img = Image.new('RGB', (640, 480), color=color)
    draw = ImageDraw.Draw(img)
    draw.rectangle([100, 100, 300, 300], fill=(50, 50, 50))
    buf = io.BytesIO()
    img.save(buf, format='JPEG')
    return buf.getvalue()

def run_tests():
    print("=== Step 13: Executing End-to-End AI Contract Verification Tests ===\n")
    test_img = create_sample_image()

    # 1. FastAPI /health
    print("1. Testing FastAPI /health...")
    health_res = requests.get("http://127.0.0.1:8000/health")
    assert health_res.status_code == 200, f"Health check failed: {health_res.status_code}"
    health_json = health_res.json()
    print("   [OK] Health Status:", health_json)

    # 2. FastAPI /predict
    print("\n2. Testing FastAPI /predict with COCO baseline image...")
    pred_res = requests.post("http://127.0.0.1:8000/predict", files={"image": ("test.jpg", test_img, "image/jpeg")})
    assert pred_res.status_code == 200, f"/predict failed: {pred_res.status_code}"
    pred_json = pred_res.json()
    print("   [OK] /predict payload:", {
        "ok": pred_json.get("ok"),
        "detected": pred_json.get("detected"),
        "category": pred_json.get("category"),
        "canonical_category": pred_json.get("canonical_category"),
        "display_category": pred_json.get("display_category"),
        "confidence": pred_json.get("confidence"),
        "model": pred_json.get("model"),
        "source": pred_json.get("source"),
        "inconclusive": pred_json.get("inconclusive"),
    })
    assert pred_json.get("detected") is False, "COCO baseline should evaluate detected=False"
    assert pred_json.get("category") == "Inconclusive", "Category should be Inconclusive"
    assert pred_json.get("model") == "yolov8m-coco-baseline", "Model should be yolov8m-coco-baseline"
    assert pred_json.get("source") == "yolo_backend_unsupported", "Source should be yolo_backend_unsupported"
    assert pred_json.get("inconclusive") is True, "Inconclusive should be True"

    # 3. FastAPI /api/v1/damage/verify-pair
    print("\n3. Testing FastAPI /api/v1/damage/verify-pair with COCO baseline pair...")
    pair_res = requests.post("http://127.0.0.1:8000/api/v1/damage/verify-pair", files=[
        ("image1", ("img1.jpg", test_img, "image/jpeg")),
        ("image2", ("img2.jpg", test_img, "image/jpeg"))
    ])
    assert pair_res.status_code == 200, f"verify-pair failed: {pair_res.status_code}"
    pair_json = pair_res.json()
    print("   [OK] verify-pair payload:", {
        "ok": pair_json.get("ok"),
        "detected": pair_json.get("detected"),
        "inconclusive": pair_json.get("inconclusive"),
        "category": pair_json.get("category"),
        "display_category": pair_json.get("display_category"),
        "agreement": pair_json.get("agreement"),
        "is_valid_match": pair_json.get("is_valid_match"),
        "source": pair_json.get("source"),
        "model": pair_json.get("model")
    })
    assert pair_json.get("detected") is False, "Dual verification without damage class should be detected=False"
    assert pair_json.get("category") == "Inconclusive", "Dual verification should be Inconclusive"
    assert pair_json.get("agreement") is False, "Agreement should be False without valid damage class"

    # 4. Node.js Authentication & /api/ai/damage
    print("\n4. Testing Node.js /api/auth/login and /api/ai/damage...")
    login_res = requests.post("http://127.0.0.1:3000/api/auth/login", json={"username": "citizen", "password": "1"})
    token = login_res.json().get("token")
    headers = {"Authorization": f"Bearer {token}"}
    assert bool(token), "JWT token required"
    print("   [OK] Citizen token obtained.")

    node_dmg_res = requests.post("http://127.0.0.1:3000/api/ai/damage", headers=headers, files={"images": ("test.jpg", test_img, "image/jpeg")})
    assert node_dmg_res.status_code == 200, f"Node /api/ai/damage returned {node_dmg_res.status_code}: {node_dmg_res.text}"
    node_dmg_json = node_dmg_res.json()
    primary = node_dmg_json.get("primary", {})
    print("   [OK] Node /api/ai/damage primary payload:", {
        "ok": primary.get("ok"),
        "detected": primary.get("detected"),
        "inconclusive": primary.get("inconclusive"),
        "category": primary.get("category"),
        "display_category": primary.get("display_category"),
        "confidence": primary.get("confidence"),
        "source": primary.get("source"),
        "model": primary.get("model")
    })
    assert primary.get("detected") is False, "Node single damage must be detected=False"
    assert primary.get("inconclusive") is True, "Node single damage must be inconclusive=True"
    assert primary.get("category") == "Inconclusive", "Node category must be Inconclusive"

    # 5. Node.js /api/ai/damage-pair
    print("\n5. Testing Node.js /api/ai/damage-pair...")
    node_pair_res = requests.post("http://127.0.0.1:3000/api/ai/damage-pair", headers=headers, files=[
        ("images", ("img1.jpg", test_img, "image/jpeg")),
        ("images", ("img2.jpg", test_img, "image/jpeg"))
    ])
    assert node_pair_res.status_code == 200, f"Node /api/ai/damage-pair returned {node_pair_res.status_code}"
    node_pair_json = node_pair_res.json()
    print("   [OK] Node /api/ai/damage-pair payload:", {
        "ok": node_pair_json.get("ok"),
        "detected": node_pair_json.get("detected"),
        "inconclusive": node_pair_json.get("inconclusive"),
        "category": node_pair_json.get("category"),
        "display_category": node_pair_json.get("display_category"),
        "confidence": node_pair_json.get("confidence"),
        "agreement": node_pair_json.get("agreement"),
        "source": node_pair_json.get("source"),
        "model": node_pair_json.get("summary", {}).get("model")
    })
    assert node_pair_json.get("detected") is False, "Node damage pair must be detected=False"
    assert node_pair_json.get("inconclusive") is True, "Node damage pair must be inconclusive=True"
    assert node_pair_json.get("category") == "Inconclusive", "Node damage pair category must be Inconclusive"

    print("\n[OK] ALL 5 API CONTRACT VERIFICATION TESTS PASSED SUCCESSFULLY!")

if __name__ == "__main__":
    run_tests()
