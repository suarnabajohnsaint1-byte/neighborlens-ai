"""
Neighborlens AI Road Annotation Candidate Visualizer (Read-Only)
==================================================================
Serves a local web visualizer for inspecting the 334 road damage candidates
and their annotated previews prior to the official human review.

Strict Safety Rules:
- READ-ONLY: Never writes or alters ROAD_REVIEW_DECISIONS.json.
- Verifies SHA-256 checksum of the authoritative ledger.
- Rejects any non-GET HTTP methods (405 Method Not Allowed).
- Completely isolated from production Node/FastAPI services.
"""

import os
import sys
import json
import hashlib
import argparse
from pathlib import Path
from http.server import HTTPServer, SimpleHTTPRequestHandler
import urllib.parse

WORKSPACE_DIR = Path(__file__).resolve().parents[3]
LEDGER_PATH = WORKSPACE_DIR / "data" / "datasets" / "annotation_input" / "road_v1" / "ROAD_REVIEW_DECISIONS.json"
PREVIEWS_DIR = WORKSPACE_DIR / "data" / "datasets" / "annotation_input" / "road_v1" / "previews"
HTML_PATH = Path(__file__).resolve().parent / "index.html"

def get_ledger_hash():
    """Computes SHA-256 hash of the authoritative ledger."""
    if not LEDGER_PATH.exists():
        raise FileNotFoundError(f"Authoritative ledger not found: {LEDGER_PATH}")
    return hashlib.sha256(LEDGER_PATH.read_bytes()).hexdigest()

INITIAL_HASH = get_ledger_hash()

def load_candidates_data():
    """Parses candidates strictly in read mode without modifying anything."""
    with open(LEDGER_PATH, "r", encoding="utf-8") as f:
        data = json.load(f)

    candidates = []
    for img_name, img_data in data.get("images", {}).items():
        preview_path = img_data.get("preview_path", "")
        preview_filename = Path(preview_path).name
        split = img_data.get("split", "")

        for b in img_data.get("boxes", []):
            candidates.append({
                "candidate_id": b.get("candidate_id"),
                "image_name": img_name,
                "split": split,
                "preview_filename": preview_filename,
                "box_idx": b.get("box_idx"),
                "coords": b.get("coords"),
                "area_pct": b.get("area_pct", 0.0),
                "aspect_ratio": b.get("aspect_ratio", 0.0),
                "flag_reason": b.get("flag_reason", ""),
                "default_action": b.get("default_action", ""),
                "human_decision": b.get("human_decision", ""),
                "merge_group": b.get("merge_group", []),
                "notes": b.get("notes", "")
            })

    candidates.sort(key=lambda x: x["candidate_id"])
    return candidates

class ReadOnlyViewerHandler(SimpleHTTPRequestHandler):
    def log_message(self, format, *args):
        # Keep terminal output clean
        sys.stdout.write("%s - - [%s] %s\n" % (self.address_string(), self.log_date_time_string(), format%args))

    def do_POST(self):
        self.send_error(405, "Method Not Allowed: Viewer is strictly READ-ONLY.")

    def do_PUT(self):
        self.send_error(405, "Method Not Allowed: Viewer is strictly READ-ONLY.")

    def do_DELETE(self):
        self.send_error(405, "Method Not Allowed: Viewer is strictly READ-ONLY.")

    def do_PATCH(self):
        self.send_error(405, "Method Not Allowed: Viewer is strictly READ-ONLY.")

    def do_GET(self):
        # Enforce ledger immutability check on every request
        current_hash = get_ledger_hash()
        if current_hash != INITIAL_HASH:
            print(f"[FATAL SECURITY ERROR] Ledger checksum changed! {current_hash} != {INITIAL_HASH}")
            self.send_error(500, "Security Check Failed: Ledger hash altered.")
            return

        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path

        if path in ("/", "/index.html"):
            if not HTML_PATH.exists():
                self.send_error(404, "index.html not found.")
                return
            content = HTML_PATH.read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(content)))
            self.send_header("Cache-Control", "no-cache")
            self.end_headers()
            self.wfile.write(content)
            return

        elif path == "/api/candidates":
            candidates = load_candidates_data()
            content = json.dumps(candidates).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(content)))
            self.send_header("Cache-Control", "no-cache")
            self.end_headers()
            self.wfile.write(content)
            return

        elif path == "/api/status":
            candidates = load_candidates_data()
            unreviewed = sum(1 for c in candidates if c["human_decision"] == "")
            status_obj = {
                "ok": True,
                "read_only": True,
                "ledger_sha256": INITIAL_HASH,
                "total_candidates": len(candidates),
                "unreviewed_candidates": unreviewed,
                "previews_directory": str(PREVIEWS_DIR)
            }
            content = json.dumps(status_obj).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(content)))
            self.end_headers()
            self.wfile.write(content)
            return

        elif path.startswith("/previews/"):
            filename = urllib.parse.unquote(path[len("/previews/"):])
            # Prevent directory traversal
            clean_filename = Path(filename).name
            file_path = PREVIEWS_DIR / clean_filename
            if not file_path.exists() or not file_path.is_file():
                self.send_error(404, f"Preview image not found: {clean_filename}")
                return

            content_type = "image/jpeg"
            if clean_filename.lower().endswith(".png"):
                content_type = "image/png"

            content = file_path.read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(content)))
            self.send_header("Cache-Control", "public, max-age=3600")
            self.end_headers()
            self.wfile.write(content)
            return

        else:
            self.send_error(404, "Endpoint not found.")

def run_programmatic_verification():
    """Performs comprehensive verification without keeping the server running."""
    print("=" * 65)
    print("Neighborlens AI Road Annotation Visualizer Verification")
    print("=" * 65)
    
    # 1. Check ledger file and hash
    print(f"1. Authoritative Ledger Path: {LEDGER_PATH}")
    print(f"   SHA-256 Checksum         : {INITIAL_HASH}")
    assert LEDGER_PATH.exists(), "Authoritative ledger does not exist!"

    # 2. Parse candidates
    candidates = load_candidates_data()
    print(f"2. Total Candidates Loaded   : {len(candidates)} (Expected: 334)")
    assert len(candidates) == 334, f"Expected 334 candidates, got {len(candidates)}"

    # 3. Verify Candidate IDs
    cand_ids = [c["candidate_id"] for c in candidates]
    unique_ids = set(cand_ids)
    print(f"3. Unique Candidate IDs      : {len(unique_ids)} (Unique: {len(unique_ids) == len(cand_ids)})")
    print(f"   Candidate ID Range        : {min(cand_ids)} to {max(cand_ids)}")
    assert cand_ids == list(range(1, 335)), "Candidate IDs are not 1..334 sequential!"

    # 4. Check previews existence
    missing_previews = []
    for c in candidates:
        img_path = PREVIEWS_DIR / c["preview_filename"]
        if not img_path.exists():
            missing_previews.append(c["preview_filename"])
    print(f"4. Resolved Preview Images   : {len(candidates) - len(missing_previews)} / {len(candidates)}")
    print(f"   Missing Previews Count    : {len(missing_previews)}")
    assert len(missing_previews) == 0, f"Found {len(missing_previews)} missing previews!"

    # 5. Check metadata completeness
    unreviewed_count = 0
    empty_merge_count = 0
    malformed_meta = 0
    for c in candidates:
        if c["human_decision"] == "":
            unreviewed_count += 1
        if c["merge_group"] == []:
            empty_merge_count += 1
        if not c["coords"] or len(c["coords"]) != 4 or not c["flag_reason"]:
            malformed_meta += 1

    print(f"5. Unreviewed Decisions      : {unreviewed_count} / 334 (100% empty)")
    print(f"   Empty Merge Groups        : {empty_merge_count} / 334 (100% empty)")
    print(f"   Malformed Metadata Count  : {malformed_meta}")
    assert unreviewed_count == 334, "Some decisions are not empty!"
    assert empty_merge_count == 334, "Some merge groups are not empty!"
    assert malformed_meta == 0, "Some candidate records have malformed metadata!"

    # 6. Post-verification Hash Check
    final_hash = get_ledger_hash()
    print(f"6. Post-Audit SHA-256 Check  : {final_hash}")
    assert final_hash == INITIAL_HASH, "Authoritative ledger was modified during check!"
    print("   [PASSED] Ledger remains 100% untouched and identical.")

    print("=" * 65)
    print("READ-ONLY ANNOTATION VIEWER READY — AUTHORITATIVE LEDGER UNCHANGED")
    print("=" * 65)

def main():
    parser = argparse.ArgumentParser(description="NeighborLens AI Road Annotation Candidate Visualizer")
    parser.add_argument("--port", type=int, default=8088, help="Port to bind viewer HTTP server (default: 8088)")
    parser.add_argument("--host", default="127.0.0.1", help="Host address (default: 127.0.0.1)")
    parser.add_argument("--verify", action="store_true", help="Run programmatic verification and exit")
    args = parser.parse_args()

    if args.verify:
        run_programmatic_verification()
        sys.exit(0)

    print("=" * 65)
    print("Neighborlens AI Road Annotation Candidate Visualizer (Read-Only)")
    print("=" * 65)
    print(f"Authoritative Ledger: {LEDGER_PATH}")
    print(f"Ledger SHA-256      : {INITIAL_HASH}")
    print(f"Previews Directory  : {PREVIEWS_DIR}")
    print(f"Server URL          : http://{args.host}:{args.port}")
    print("=" * 65)
    print("Press Ctrl+C to stop the visualizer server.")

    server = HTTPServer((args.host, args.port), ReadOnlyViewerHandler)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down visualizer server...")
        server.server_close()
        final_hash = get_ledger_hash()
        assert final_hash == INITIAL_HASH, "Ledger modified during server runtime!"
        print(f"Final Ledger Checksum Verified: {final_hash} (UNMODIFIED)")

if __name__ == "__main__":
    main()
