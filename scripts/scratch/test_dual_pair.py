import urllib.request, json, uuid, os, time, glob

# 1. Register / Login citizen on Node port 3000
unique_user = f"citizen_test_{int(time.time())}"
reg_req = urllib.request.Request(
    'http://127.0.0.1:3000/api/auth/register',
    data=json.dumps({
        'username': unique_user,
        'password': 'password123',
        'fullName': 'Test Citizen Resident',
        'barangay': 'Barangay 1'
    }).encode('utf-8'),
    headers={'Content-Type': 'application/json'}
)
with urllib.request.urlopen(reg_req) as resp:
    reg_data = json.loads(resp.read().decode('utf-8'))
    token = reg_data.get('token')
    print('Citizen registered & token acquired:', bool(token))

# 2. Test POST /api/ai/damage-pair with two sample images
imgs = glob.glob('data/datasets/neighborlens_v1/images/**/*.jpg', recursive=True)
img_path = imgs[0] if imgs else None

print('Using test image:', img_path)
with open(img_path, 'rb') as f:
    img_bytes = f.read()

boundary = '----WebKitFormBoundary' + uuid.uuid4().hex
body = bytearray()

for idx in [1, 2]:
    body.extend(f'--{boundary}\r\n'.encode('utf-8'))
    body.extend(f'Content-Disposition: form-data; name="images"; filename="angle_{idx}.jpg"\r\n'.encode('utf-8'))
    body.extend(b'Content-Type: image/jpeg\r\n\r\n')
    body.extend(img_bytes)
    body.extend(b'\r\n')
body.extend(f'--{boundary}--\r\n'.encode('utf-8'))

req = urllib.request.Request(
    'http://127.0.0.1:3000/api/ai/damage-pair',
    data=bytes(body),
    headers={
        'Content-Type': f'multipart/form-data; boundary={boundary}',
        'Authorization': f'Bearer {token}'
    }
)

try:
    with urllib.request.urlopen(req) as resp:
        print('Dual damage verification HTTP Status:', resp.status)
        result = json.loads(resp.read().decode('utf-8'))
        print('Dual damage verification summary:')
        print('  ok:', result.get('ok'))
        print('  is_valid_match:', result.get('is_valid_match'))
        print('  composite_similarity_score:', result.get('composite_similarity_score'))
        print('  damage_type_consensus:', result.get('damage_type_consensus'))
        print('  alignment:', result.get('alignment'))
        print('  image1 detections:', len(result.get('image1_detections', [])))
        print('  image2 detections:', len(result.get('image2_detections', [])))
except urllib.error.HTTPError as e:
    print('Dual damage verification HTTP error:', e.code, e.read().decode('utf-8'))
except Exception as e:
    print('Error:', e)
