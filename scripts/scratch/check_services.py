import urllib.request
import json

def check_services():
    services = {
        "Node API (3000)": "http://localhost:3000/api/health",
        "FastAPI YOLO (8000)": "http://127.0.0.1:8000/health",
        "FastAPI YOLO Docs (8000)": "http://127.0.0.1:8000/docs",
        "FastAPI Alt Port (8080)": "http://127.0.0.1:8080/health",
    }
    
    for name, url in services.items():
        try:
            req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
            with urllib.request.urlopen(req, timeout=2) as resp:
                status = resp.status
                body = resp.read().decode('utf-8', errors='ignore')[:200]
                print(f"[ONLINE] {name} ({url}) -> Status: {status}, Body: {body}")
        except Exception as e:
            print(f"[OFFLINE] {name} ({url}) -> Error: {e}")

if __name__ == "__main__":
    check_services()
