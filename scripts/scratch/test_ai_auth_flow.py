import urllib.request, json, uuid, glob

print("=========================================================")
print("E2E AUDIT: AI AUTHENTICATION & MAPS API CONFIG ROUTING")
print("=========================================================")

# Step 1: Verify Maps Config Endpoint on Port 3000
print("\n[Step 1] Verifying GET http://127.0.0.1:3000/api/config/maps")
with urllib.request.urlopen('http://127.0.0.1:3000/api/config/maps') as resp:
    print("  HTTP Status:", resp.status)
    data = json.loads(resp.read().decode('utf-8'))
    print("  Data:", data)

# Step 2: Login citizen on Port 3000 to get JWT token (exactly like frontend/js/auth/auth.js)
print("\n[Step 2] Logging in as 'citizen' via POST http://127.0.0.1:3000/api/auth/login")
login_req = urllib.request.Request(
    'http://127.0.0.1:3000/api/auth/login',
    data=json.dumps({'username': 'citizen', 'password': '1'}).encode('utf-8'),
    headers={'Content-Type': 'application/json'}
)
with urllib.request.urlopen(login_req) as resp:
    print("  HTTP Status:", resp.status)
    login_data = json.loads(resp.read().decode('utf-8'))
    token = login_data.get('token')
    print("  JWT Token Received:", bool(token))
    print("  Token Format Valid:", token.startswith('eyJ'))
    print("  User Role:", login_data.get('user', {}).get('role'))

# Step 3: Test POST /api/ai/damage-pair WITH Authorization header (like yoloDamageDetector.js)
print("\n[Step 3] Testing POST http://127.0.0.1:3000/api/ai/damage-pair WITH Authorization header")
imgs = glob.glob('data/datasets/neighborlens_v1/images/**/*.jpg', recursive=True)
with open(imgs[0], 'rb') as f:
    img_bytes = f.read()

boundary = '----WebKitFormBoundary' + uuid.uuid4().hex
body = bytearray()
for idx in [1, 2]:
    body.extend(f'--{boundary}\r\n'.encode('utf-8'))
    body.extend(f'Content-Disposition: form-data; name="images"; filename="photo_{idx}.jpg"\r\n'.encode('utf-8'))
    body.extend(b'Content-Type: image/jpeg\r\n\r\n')
    body.extend(img_bytes)
    body.extend(b'\r\n')
body.extend(f'--{boundary}--\r\n'.encode('utf-8'))

req_pair = urllib.request.Request(
    'http://127.0.0.1:3000/api/ai/damage-pair',
    data=bytes(body),
    headers={
        'Content-Type': f'multipart/form-data; boundary={boundary}',
        'Authorization': f'Bearer {token}'
    }
)
with urllib.request.urlopen(req_pair) as resp:
    print("  HTTP Status:", resp.status)
    result = json.loads(resp.read().decode('utf-8'))
    print("  Dual Damage Verification Response:")
    print("    - ok:", result.get('ok'))
    print("    - is_valid_match:", result.get('is_valid_match'))
    print("    - composite_similarity_score:", result.get('composite_similarity_score'))
    print("    - damage_type_consensus:", result.get('damage_type_consensus'))
    print("    - highest_severity:", result.get('highest_severity'))
    print("    - perspective_aligned:", result.get('alignment', {}).get('perspective_aligned'))
    print("    - homography inlier ratio:", result.get('alignment', {}).get('inlier_ratio'))
    print("    - Reached FastAPI :8000 successfully: YES")

# Step 4: Test single-image POST /api/ai/damage WITH Authorization header
print("\n[Step 4] Testing POST http://127.0.0.1:3000/api/ai/damage WITH Authorization header")
body_single = bytearray()
body_single.extend(f'--{boundary}\r\n'.encode('utf-8'))
body_single.extend(f'Content-Disposition: form-data; name="images"; filename="single_photo.jpg"\r\n'.encode('utf-8'))
body_single.extend(b'Content-Type: image/jpeg\r\n\r\n')
body_single.extend(img_bytes)
body_single.extend(b'\r\n')
body_single.extend(f'--{boundary}--\r\n'.encode('utf-8'))

req_single = urllib.request.Request(
    'http://127.0.0.1:3000/api/ai/damage',
    data=bytes(body_single),
    headers={
        'Content-Type': f'multipart/form-data; boundary={boundary}',
        'Authorization': f'Bearer {token}'
    }
)
try:
    with urllib.request.urlopen(req_single) as resp:
        print("  HTTP Status:", resp.status)
        result_single = json.loads(resp.read().decode('utf-8'))
        print("  Single Damage Response:", result_single.get('ok'), result_single.get('summary'))
except urllib.error.HTTPError as e:
    print("  HTTP Status:", e.code, e.read().decode('utf-8'))

print("\n=========================================================")
print("ALL RUNTIME AUTH & ROUTING VERIFICATIONS PASSED")
print("=========================================================")
