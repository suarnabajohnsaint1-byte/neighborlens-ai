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

imgs = glob.glob('data/datasets/neighborlens_v1/images/**/*.jpg', recursive=True)
img_path = imgs[0] if imgs else None

with open(img_path, 'rb') as f:
    img_bytes = f.read()

# Test POST /api/ai/damage
boundary = '----WebKitFormBoundary' + uuid.uuid4().hex
body = bytearray()
body.extend(f'--{boundary}\r\n'.encode('utf-8'))
body.extend(f'Content-Disposition: form-data; name="images"; filename="single.jpg"\r\n'.encode('utf-8'))
body.extend(b'Content-Type: image/jpeg\r\n\r\n')
body.extend(img_bytes)
body.extend(b'\r\n')
body.extend(f'--{boundary}--\r\n'.encode('utf-8'))

req = urllib.request.Request(
    'http://127.0.0.1:3000/api/ai/damage',
    data=bytes(body),
    headers={
        'Content-Type': f'multipart/form-data; boundary={boundary}',
        'Authorization': f'Bearer {token}'
    }
)

try:
    with urllib.request.urlopen(req) as resp:
        print('Single damage detection HTTP Status:', resp.status)
        result = json.loads(resp.read().decode('utf-8'))
        print('Single damage detection summary:', result.get('ok'), result.get('summary'))
except Exception as e:
    print('Error:', e)
