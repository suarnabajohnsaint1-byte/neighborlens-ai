"""Extract experimental features through the same two-photo detector used by Citizen scans."""
import json
import mimetypes
from pathlib import Path

import numpy as np
from fastapi.testclient import TestClient

from ai.inference.inference_api import create_app
from ai.training.severity_dataset import digest

ROOT = Path(__file__).resolve().parents[2]
FEATURE_VERSION = "opencv_visual_extent/1/pair-v1"


def view_features(observation):
    if not observation or (observation.get("source"), observation.get("version"), observation.get("quality")) != (
            "opencv_visual_extent", "1", "EXPERIMENTAL"):
        return None
    category, values = observation["category"], observation["features"]
    diagonal = np.hypot(*observation["grid"])
    if category == "broken_streetlight":
        return [values["line_segments"], values.get("longest_line_px", 0) / diagonal]
    features = [values["crop_fraction"], values["largest_component_fraction"],
                values["threshold_stability_iou"], values["components"]]
    if category == "road_crack":
        features.extend([values["skeleton_length_px"] / diagonal, values["branch_clusters"],
                         values.get("mean_strip_width_px", 0) / diagonal])
    if category == "pothole":
        features.append(values.get("largest_contour_circularity", 0))
    return features


def paired_features(response):
    if not response.get("detected") or not response.get("class_agreement"):
        return None, None
    category = response["canonical_category"]
    observations = [response[key].get("visual_extent") for key in ("image1_assessment", "image2_assessment")]
    if any(not item or item["category"] != category for item in observations):
        return category, None
    views = [view_features(item) for item in observations]
    if any(view is None for view in views):
        return category, None
    # Preserve two-view disagreement without encoding photo order.
    return category, np.concatenate([np.min(views, axis=0), np.max(views, axis=0)]).tolist()


def detector_identity():
    baseline = json.loads((ROOT / "ai/ARCHITECTURE_BASELINE.json").read_text())
    checkpoint = baseline["checkpoints"]["production"]
    if digest(ROOT / checkpoint["path"]) != checkpoint["sha256"]:
        raise ValueError("Detector differs from recorded checkpoint")
    return checkpoint, baseline["runtime"]


def observations(root, catalog, cases):
    checkpoint, runtime = detector_identity()
    images = {item["sha256"]: item for item in catalog}
    with TestClient(create_app(str(ROOT / checkpoint["path"]), runtime["confidence"], runtime["image_size"])) as client:
        for case in cases:
            files = {}
            for i, fingerprint in enumerate(case["photos"], 1):
                path = (root / images[fingerprint]["image"]).resolve()
                if not path.is_relative_to(root.resolve()) or digest(path) != fingerprint:
                    raise ValueError("Input image differs from frozen inventory")
                files[f"image{i}"] = (path.name, path.read_bytes(), mimetypes.guess_type(path)[0])
            result = client.post("/verify-pair", files=files)
            if result.status_code == 422 and result.json().get("detail", {}).get("code") == "DUPLICATE_EVIDENCE":
                detected, features = None, None
            else:
                result.raise_for_status()
                detected, features = paired_features(result.json())
            yield {**case, "detected_category": detected, "features": features}
