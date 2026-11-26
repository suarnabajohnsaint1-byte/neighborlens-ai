import urllib.request
import urllib.parse
import json
import base64
from pathlib import Path

def test_inference_endpoints():
    print("=== TESTING DAMAGE INFERENCE INTEGRATION ===")
    
    # 1. Check if Roboflow is reachable from Node.js damage detection service
    sample_img_path = list(Path("data/datasets/neighborlens_v1/images/train").glob("*.jpg"))[0]
    print(f"Using test image: {sample_img_path}")
    
    # Test Node.js API with a mock request or direct call
    # First, let's login to get a token
    login_data = json.dumps({"username": "admin", "password": "replace-this-with-a-long-random-secret"}).encode('utf-8')
    req = urllib.request.Request("http://localhost:3000/api/auth/login", data=login_data, headers={'Content-Type': 'application/json'})
    
    token = None
    try:
        with urllib.request.urlopen(req, timeout=5) as resp:
            data = json.loads(resp.read().decode())
            token = data.get("token")
            print(f"[OK] Admin login successful. User: {data.get('user')}")
    except Exception as e:
        print(f"[NOTE] Admin login test: {e}")

    # Let's test citizen login with test account
    login_data2 = json.dumps({"username": "citizen", "password": "1"}).encode('utf-8')
    req2 = urllib.request.Request("http://localhost:3000/api/auth/login", data=login_data2, headers={'Content-Type': 'application/json'})
    try:
        with urllib.request.urlopen(req2, timeout=5) as resp:
            data = json.loads(resp.read().decode())
            token = data.get("token")
            print(f"[OK] Citizen login successful. User: {data.get('user')}")
    except Exception as e:
        print(f"[NOTE] Citizen login test: {e}")

if __name__ == "__main__":
    test_inference_endpoints()
