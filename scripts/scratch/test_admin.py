import urllib.request
import json

def test_admin():
    login_data = json.dumps({"username": "admin", "password": "admin123"}).encode('utf-8')
    req = urllib.request.Request("http://localhost:3000/api/auth/login", data=login_data, headers={'Content-Type': 'application/json'})
    with urllib.request.urlopen(req) as resp:
        data = json.loads(resp.read().decode())
        print("Admin login response:", data)

if __name__ == "__main__":
    test_admin()
