import requests
import io
from PIL import Image, ImageDraw

def create_sample_image(color=(128, 128, 128), text="test"):
    img = Image.new('RGB', (640, 480), color=color)
    draw = ImageDraw.Draw(img)
    draw.rectangle([100, 100, 300, 300], fill=(50, 50, 50))
    buf = io.BytesIO()
    img.save(buf, format='JPEG')
    return buf.getvalue()

def run_tests():
    print("--- 1. Testing FastAPI Health & Model Metadata ---")
    fastapi_health = requests.get("http://127.0.0.1:8000/health").json()
    print("FastAPI Health:", fastapi_health)

    # Login to Node.js
    login_res = requests.post("http://127.0.0.1:3000/api/auth/login", json={"username": "citizen", "password": "1"})
    token = login_res.json().get("token")
    headers = {"Authorization": f"Bearer {token}"}
    print("Logged in as citizen, token obtained:", bool(token))

    test_img = create_sample_image()

    print("\n--- 2. Testing Single Image Inference Endpoint (POST /api/ai/damage) ---")
    files = {"images": ("car_test.jpg", test_img, "image/jpeg")}
    damage_res = requests.post("http://127.0.0.1:3000/api/ai/damage", headers=headers, files=files)
    print("Damage HTTP Status:", damage_res.status_code)
    damage_json = damage_res.json()
    print("Damage Response Model:", damage_json.get("summary", {}).get("model") or damage_json.get("model"))
    print("Damage Response Detections:", damage_json.get("detections"))

    print("\n--- 3. Testing Dual Photo Verification (POST /api/ai/damage-pair) ---")
    files_pair = [
        ("images", ("img1.jpg", test_img, "image/jpeg")),
        ("images", ("img2.jpg", test_img, "image/jpeg"))
    ]
    pair_res = requests.post("http://127.0.0.1:3000/api/ai/damage-pair", headers=headers, files=files_pair)
    print("Pair HTTP Status:", pair_res.status_code)
    pair_json = pair_res.json()
    print("Pair Response Summary:", pair_json.get("summary"))
    print("Pair Consensus Type:", pair_json.get("damage_type_consensus"))
    print("Pair Is Valid Match:", pair_json.get("is_valid_match"))

    print("\n--- 4. Direct FastAPI Model Metadata Check ---")
    fastapi_pred = requests.post("http://127.0.0.1:8000/predict", files={"image": ("test.jpg", test_img, "image/jpeg")}).json()
    print("FastAPI /predict model field:", fastapi_pred.get("model"))
    assert fastapi_pred.get("model") == "yolov8m-coco-baseline", f"Expected yolov8m-coco-baseline, got {fastapi_pred.get('model')}"
    print("Assertion passed: FastAPI returns 'yolov8m-coco-baseline'!")

if __name__ == "__main__":
    run_tests()
