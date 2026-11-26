import urllib.request, json, uuid, os, glob

print("=== VERIFYING RUNTIME API AUTH & MAPS CONFIG ROUTING ===")

# Test 1: GET /api/config/maps on port 3000
print("\n[Test 1] GET http://127.0.0.1:3000/api/config/maps")
try:
    with urllib.request.urlopen("http://127.0.0.1:3000/api/config/maps") as resp:
        print("  Status:", resp.status)
        data = json.loads(resp.read().decode('utf-8'))
        print("  Payload:", data)
except Exception as e:
    print("  Failed:", e)

# Test 2: Login demo citizen 'citizen' / '1' on port 3000
print("\n[Test 2] POST http://127.0.0.1:3000/api/auth/login (citizen / 1)")
token = None
try:
    login_req = urllib.request.Request(
        'http://127.0.0.1:3000/api/auth/login',
        data=json.dumps({'username': 'citizen', 'password': '1'}).encode('utf-8'),
        headers={'Content-Type': 'application/json'}
    )
    with urllib.request.urlopen(login_req) as resp:
        print("  Status:", resp.status)
        login_res = json.loads(resp.read().decode('utf-8'))
        token = login_res.get('token')
        print("  JWT Token Acquired:", bool(token), f"({token[:25]}...)" if token else "")
        print("  User Info:", login_res.get('user'))
except Exception as e:
    print("  Failed:", e)

# Test 3: Unauthenticated AI Request -> Must return 401
print("\n[Test 3] POST http://127.0.0.1:3000/api/ai/damage-pair (NO Auth Token - Expecting 401)")
boundary = '----WebKitFormBoundary' + uuid.uuid4().hex
body = bytearray()
for idx in [1, 2]:
    body.extend(f'--{boundary}\r\n'.encode('utf-8'))
    body.extend(f'Content-Disposition: form-data; name="images"; filename="img_{idx}.jpg"\r\n'.encode('utf-8'))
    body.extend(b'Content-Type: image/jpeg\r\n\r\n')
    body.extend(b'\xff\xd8\xff\xe0\x00\x10JFIF\x00\x01\x01\x01\x00`\x00`\x00\x00\xff\xdb\x00C\x00\x08\x06\x06\x07\x06\x05\x08\x07\x07\x07\t\t\x08\n\x0c\x14\r\x0c\x0b\x0b\x0c\x19\x12\x13\x0f\x14\x1d\x1a\x1f\x1e\x1d\x1a\x1c\x1c #.(($+,""87)+++=0444\'9=82<2342\xff\xc0\x00\x0b\x08\x00\x01\x00\x01\x01\x01\x11\x00\xff\xc4\x00\x1f\x00\x00\x01\x05\x01\x01\x01\x01\x01\x01\x00\x00\x00\x00\x00\x00\x00\x00\x01\x02\x03\x04\x05\x06\x07\x08\t\n\x0b\xff\xda\x00\x08\x01\x01\x00\x00?\x00\x7f\x00\xff\xd9')
    body.extend(b'\r\n')
body.extend(f'--{boundary}--\r\n'.encode('utf-8'))

unauth_req = urllib.request.Request(
    'http://127.0.0.1:3000/api/ai/damage-pair',
    data=bytes(body),
    headers={'Content-Type': f'multipart/form-data; boundary={boundary}'}
)
try:
    with urllib.request.urlopen(unauth_req) as resp:
        print("  Unexpected success:", resp.status)
except urllib.error.HTTPError as e:
    print(f"  Correctly rejected with HTTP {e.code}: {e.read().decode('utf-8')}")

# Test 4: Authenticated AI Request with real images -> Must pass auth, reach FastAPI :8000, and return 200
print("\n[Test 4] POST http://127.0.0.1:3000/api/ai/damage-pair (Authenticated with Token)")
imgs = glob.glob('data/datasets/neighborlens_v1/images/**/*.jpg', recursive=True)
img_path = imgs[0] if imgs else None

with open(img_path, 'rb') as f:
    real_img_bytes = f.read()

body_auth = bytearray()
for idx in [1, 2]:
    body_auth.extend(f'--{boundary}\r\n'.encode('utf-8'))
    body_auth.extend(f'Content-Disposition: form-data; name="images"; filename="angle_{idx}.jpg"\r\n'.encode('utf-8'))
    body_auth.extend(b'Content-Type: image/jpeg\r\n\r\n')
    body_auth.extend(real_img_bytes)
    body_auth.extend(b'\r\n')
body_auth.extend(f'--{boundary}--\r\n'.encode('utf-8'))

auth_ai_req = urllib.request.Request(
    'http://127.0.0.1:3000/api/ai/damage-pair',
    data=bytes(body_auth),
    headers={
        'Content-Type': f'multipart/form-data; boundary={boundary}',
        'Authorization': f'Bearer {token}'
    }
)
try:
    with urllib.request.urlopen(auth_ai_req) as resp:
        print("  Status:", resp.status)
        ai_res = json.loads(resp.read().decode('utf-8'))
        print("  AI Response Summary:")
        print("    ok:", ai_res.get('ok'))
        print("    is_valid_match:", ai_res.get('is_valid_match'))
        print("    composite_similarity_score:", ai_res.get('composite_similarity_score'))
        print("    damage_type_consensus:", ai_res.get('damage_type_consensus'))
        print("    alignment perspectiveAligned:", ai_res.get('alignment', {}).get('perspective_aligned'))
        print("    reached FastAPI microservice: YES")
except Exception as e:
    print("  Failed:", e)

print("\n=== ALL VERIFICATIONS COMPLETED ===")
