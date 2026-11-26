import urllib.request
import urllib.error
import hashlib
from pathlib import Path

# 1. Test POST rejection
req = urllib.request.Request("http://127.0.0.1:8088/api/candidates", data=b'{"test": 1}', method="POST")
try:
    urllib.request.urlopen(req)
    print("FAIL: POST request was accepted!")
except urllib.error.HTTPError as e:
    print(f"PASS: POST request rejected with {e.code} {e.reason}")

# 2. Test PUT rejection
req = urllib.request.Request("http://127.0.0.1:8088/api/candidates", data=b'{"test": 1}', method="PUT")
try:
    urllib.request.urlopen(req)
    print("FAIL: PUT request was accepted!")
except urllib.error.HTTPError as e:
    print(f"PASS: PUT request rejected with {e.code} {e.reason}")

# 3. Verify SHA-256 remains identical
ledger_path = Path("data/datasets/annotation_input/road_v1/ROAD_REVIEW_DECISIONS.json")
initial_hash = "39e01017b2182aaf94c175f7ad4b3c8f7879ad0ee749bcf276b8b4cdd42a566c"
current_hash = hashlib.sha256(ledger_path.read_bytes()).hexdigest()
print(f"Initial Checksum: {initial_hash}")
print(f"Current Checksum: {current_hash}")
assert initial_hash == current_hash, "Checksum changed!"
print("PASS: Authoritative ledger remains completely unchanged!")
