"""
Neighborlens AI Road Annotation Review Local Server
======================================================
Serves a dedicated local visual review interface for inspecting and recording
human review decisions for the 59 TRAIN candidate images (227 candidate boxes).

Strict Safety Boundaries:
1. WRITES ONLY to data/datasets/annotation_input/road_v1/ROAD_REVIEW_DECISIONS.json (or specified target).
2. HARD PROHIBITION on writing to neighborlens_v1 or neighborlens_v2 images/labels.
3. REJECTS any decisions targeting validation or test splits (HTTP 403).
4. REJECTS invalid decision types, non-existent box IDs, or malformed merge groups.
5. Performs atomic file writes to prevent ledger corruption.
6. Zero auto-decisions: Records only explicit human selections.
"""

import os
import sys
import json
import argparse
from pathlib import Path
from datetime import datetime, timezone
from http.server import HTTPServer, SimpleHTTPRequestHandler
import urllib.parse
from typing import Dict, Any, List

WORKSPACE_DIR = Path(__file__).resolve().parents[3]
DEFAULT_DECISIONS_PATH = WORKSPACE_DIR / "data" / "datasets" / "annotation_input" / "road_v1" / "ROAD_REVIEW_DECISIONS.json"
DEFAULT_PREVIEWS_DIR = WORKSPACE_DIR / "data" / "datasets" / "annotation_input" / "road_v1" / "previews"
DEFAULT_TRAIN_IMG_DIR = WORKSPACE_DIR / "data" / "datasets" / "neighborlens_v2" / "images" / "train"
HTML_PATH = Path(__file__).resolve().parent / "index.html"

# Import validator
sys.path.insert(0, str(Path(__file__).resolve().parent))
from validate_decisions import validate_review_decisions, ALLOWED_DECISIONS

FORBIDDEN_WRITE_PATHS = [
    WORKSPACE_DIR / "data" / "datasets" / "neighborlens_v1",
    WORKSPACE_DIR / "data" / "datasets" / "neighborlens_v2",
]

def load_train_candidates_data(decisions_path: Path) -> List[Dict[str, Any]]:
    """
    Loads and returns candidate images and boxes belonging strictly to the TRAIN split.
    """
    if not decisions_path.exists():
        raise FileNotFoundError(f"Authoritative ledger not found: {decisions_path}")

    with open(decisions_path, "r", encoding="utf-8") as f:
        data = json.load(f)

    train_images = []
    images_dict = data.get("images", {})

    for img_name, img_data in images_dict.items():
        if img_data.get("split") != "train":
            continue

        preview_path = img_data.get("preview_path", "")
        preview_filename = Path(preview_path).name

        boxes = []
        for b in img_data.get("boxes", []):
            boxes.append({
                "candidate_id": b.get("candidate_id"),
                "box_idx": b.get("box_idx"),
                "coords": b.get("coords"),
                "area_pct": b.get("area_pct", 0.0),
                "aspect_ratio": b.get("aspect_ratio", 0.0),
                "flag_reason": b.get("flag_reason", ""),
                "default_action": b.get("default_action", ""),
                "human_decision": b.get("human_decision", ""),
                "merge_group": b.get("merge_group", []),
                "notes": b.get("notes", ""),
                "updated_at": b.get("updated_at", "")
            })

        # Sort boxes by box_idx
        boxes.sort(key=lambda x: x["box_idx"])

        # Determine image-level review status
        is_reviewed = len(boxes) > 0 and all(b["human_decision"] in ALLOWED_DECISIONS for b in boxes)

        train_images.append({
            "image_name": img_name,
            "split": "train",
            "preview_filename": preview_filename,
            "reviewed": img_data.get("reviewed", is_reviewed),
            "reviewed_at": img_data.get("reviewed_at", ""),
            "boxes": boxes
        })

    # Sort images deterministically by filename
    train_images.sort(key=lambda x: x["image_name"])
    return train_images

def save_image_decisions(
    decisions_path: Path,
    image_name: str,
    box_decisions: List[Dict[str, Any]]
) -> Dict[str, Any]:
    """
    Validates and atomically saves human review decisions for a single TRAIN image.
    Enforces strict safety boundaries.
    """
    # 1. Safety verification: Target path must not touch forbidden dataset directories
    resolved_target = decisions_path.resolve()
    for forbidden in FORBIDDEN_WRITE_PATHS:
        try:
            resolved_target.relative_to(forbidden.resolve())
            raise PermissionError(f"CRITICAL SAFETY VIOLATION: Attempt to write within forbidden path {forbidden}")
        except ValueError:
            pass  # Not relative to forbidden, which is safe

    if not decisions_path.exists():
        raise FileNotFoundError(f"Decisions ledger does not exist: {decisions_path}")

    with open(decisions_path, "r", encoding="utf-8") as f:
        ledger_data = json.load(f)

    images = ledger_data.get("images", {})
    if image_name not in images:
        raise ValueError(f"Image '{image_name}' not found in decisions ledger.")

    target_img = images[image_name]
    split = target_img.get("split", "")

    # 2. Frozen Split Boundary
    if split != "train":
        raise PermissionError(
            f"FROZEN SPLIT PROTECTION: Image '{image_name}' belongs to split '{split}'. "
            "Only the TRAIN split can be reviewed or modified during Phase 3B."
        )

    # 3. Validate submitted decisions
    existing_boxes = {b["box_idx"]: b for b in target_img.get("boxes", [])}
    all_box_indices = set(existing_boxes.keys())

    # Map incoming decisions by box_idx
    incoming_by_idx: Dict[int, Dict[str, Any]] = {}
    for entry in box_decisions:
        b_idx = entry.get("box_idx")
        if b_idx is None or b_idx not in all_box_indices:
            raise ValueError(f"Invalid or unknown box_idx #{b_idx} for image '{image_name}'.")

        decision = entry.get("human_decision", "").strip().upper()
        if decision not in ALLOWED_DECISIONS and decision != "":
            raise ValueError(
                f"Invalid decision '{decision}' for box #{b_idx}. "
                f"Must be one of {sorted(list(ALLOWED_DECISIONS))}."
            )

        merge_group = entry.get("merge_group", [])
        if not isinstance(merge_group, list):
            raise ValueError(f"merge_group for box #{b_idx} must be a list of integers.")

        if decision == "MERGE":
            if len(merge_group) < 2:
                raise ValueError(
                    f"MERGE decision for box #{b_idx} must include at least 2 box IDs in merge_group (got {merge_group})."
                )
            if b_idx not in merge_group:
                raise ValueError(
                    f"Box #{b_idx} marked MERGE must be included in its own merge_group {merge_group}."
                )
            for mb in merge_group:
                if mb not in all_box_indices:
                    raise ValueError(
                        f"Non-existent box #{mb} referenced in merge_group for box #{b_idx}."
                    )
        elif decision in ("KEEP", "SEPARATE", "REMOVE", ""):
            if merge_group:
                raise ValueError(f"Decision '{decision}' for box #{b_idx} cannot have a non-empty merge_group.")

        incoming_by_idx[b_idx] = entry

    # 4. Check for mutual consistency among MERGE groups
    now_iso = datetime.now(timezone.utc).isoformat()
    for b_idx, entry in incoming_by_idx.items():
        dec = entry.get("human_decision", "").strip().upper()
        if dec == "MERGE":
            grp = sorted(entry.get("merge_group", []))
            for sibling_id in grp:
                sibling_entry = incoming_by_idx.get(sibling_id)
                if sibling_entry:
                    s_dec = sibling_entry.get("human_decision", "").strip().upper()
                    s_grp = sorted(sibling_entry.get("merge_group", []))
                    if s_dec == "REMOVE":
                        raise ValueError(
                            f"Conflict: Box #{b_idx} is in merge_group {grp} with Box #{sibling_id}, "
                            f"but Box #{sibling_id} is marked REMOVE."
                        )
                    if s_dec == "MERGE" and s_grp != grp:
                        raise ValueError(
                            f"Conflict: Box #{b_idx} has merge_group {grp}, but sibling #{sibling_id} has {s_grp}."
                        )

    # 5. Apply updates to the ledger in memory
    for b in target_img.get("boxes", []):
        b_idx = b.get("box_idx")
        if b_idx in incoming_by_idx:
            inc = incoming_by_idx[b_idx]
            b["human_decision"] = inc.get("human_decision", "").strip().upper()
            b["merge_group"] = sorted(inc.get("merge_group", [])) if inc.get("human_decision") == "MERGE" else []
            b["notes"] = inc.get("notes", "").strip()
            b["updated_at"] = now_iso

    # Update image review metadata
    all_resolved = all(b.get("human_decision") in ALLOWED_DECISIONS for b in target_img.get("boxes", []))
    target_img["reviewed"] = all_resolved
    if all_resolved:
        target_img["reviewed_at"] = now_iso

    # 6. Atomic save: write to temporary file in same directory, then rename
    tmp_path = decisions_path.with_suffix(".tmp")
    with open(tmp_path, "w", encoding="utf-8") as f:
        json.dump(ledger_data, f, indent=2)

    os.replace(tmp_path, decisions_path)
    return {
        "success": True,
        "image_name": image_name,
        "reviewed": all_resolved,
        "timestamp": now_iso
    }

class RoadReviewRequestHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, decisions_path=None, previews_dir=None, **kwargs):
        self.decisions_path = decisions_path or DEFAULT_DECISIONS_PATH
        self.previews_dir = previews_dir or DEFAULT_PREVIEWS_DIR
        super().__init__(*args, **kwargs)

    def log_message(self, format, *args):
        sys.stdout.write("%s - - [%s] %s\n" % (self.address_string(), self.log_date_time_string(), format % args))

    def send_json(self, status_code: int, data: Any):
        content = json.dumps(data).encode("utf-8")
        self.send_response(status_code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(content)))
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(content)

    def do_GET(self):
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

        elif path == "/api/images":
            try:
                data = load_train_candidates_data(self.decisions_path)
                self.send_json(200, {"success": True, "images": data, "total": len(data)})
            except Exception as e:
                self.send_json(500, {"success": False, "error": str(e)})
            return

        elif path == "/api/status":
            try:
                metrics = validate_review_decisions(self.decisions_path)
                self.send_json(200, {"success": True, "metrics": metrics})
            except Exception as e:
                self.send_json(500, {"success": False, "error": str(e)})
            return

        elif path.startswith("/previews/"):
            filename = urllib.parse.unquote(path[len("/previews/"):])
            clean_filename = Path(filename).name
            file_path = self.previews_dir / clean_filename
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

    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path

        if path == "/api/save":
            try:
                content_length = int(self.headers.get("Content-Length", 0))
                body = self.rfile.read(content_length).decode("utf-8")
                payload = json.loads(body)

                image_name = payload.get("image_name")
                box_decisions = payload.get("decisions", [])

                if not image_name or not isinstance(box_decisions, list):
                    self.send_json(400, {
                        "success": False,
                        "error": "Payload must contain 'image_name' (str) and 'decisions' (list)."
                    })
                    return

                res = save_image_decisions(self.decisions_path, image_name, box_decisions)
                # Fetch fresh status metrics
                metrics = validate_review_decisions(self.decisions_path)
                res["metrics"] = metrics
                self.send_json(200, res)

            except PermissionError as pe:
                self.send_json(403, {"success": False, "error": str(pe)})
            except ValueError as ve:
                self.send_json(400, {"success": False, "error": str(ve)})
            except Exception as e:
                self.send_json(500, {"success": False, "error": str(e)})
            return

        else:
            self.send_error(404, "Unknown POST endpoint.")

def make_handler(decisions_path: Path, previews_dir: Path):
    return lambda *args, **kwargs: RoadReviewRequestHandler(
        *args, decisions_path=decisions_path, previews_dir=previews_dir, **kwargs
    )

def main():
    parser = argparse.ArgumentParser(description="NeighborLens Road Annotation Review Local Server")
    parser.add_argument("--port", type=int, default=8090, help="HTTP port (default: 8090)")
    parser.add_argument("--host", default="127.0.0.1", help="Host IP (default: 127.0.0.1)")
    parser.add_argument("--decisions", type=Path, default=DEFAULT_DECISIONS_PATH, help="Path to ROAD_REVIEW_DECISIONS.json")
    parser.add_argument("--previews", type=Path, default=DEFAULT_PREVIEWS_DIR, help="Path to previews folder")
    args = parser.parse_args()

    print("=" * 65)
    print("Neighborlens AI Road Annotation Review Local Tool (TRAIN Split)")
    print("=" * 65)
    print(f"Authoritative Ledger: {args.decisions}")
    print(f"Previews Directory  : {args.previews}")
    print(f"Target Review Scope : 59 TRAIN images (Val/Test strictly frozen)")
    print(f"Local Server URL    : http://{args.host}:{args.port}")
    print("=" * 65)
    print("Press Ctrl+C to terminate the review server.")

    handler = make_handler(args.decisions, args.previews)
    server = HTTPServer((args.host, args.port), handler)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down review server...")
        server.server_close()

if __name__ == "__main__":
    main()
