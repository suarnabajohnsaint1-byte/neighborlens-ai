"""Stage only the validated inference source and checkpoint for this Vercel project."""

from hashlib import sha256
from pathlib import Path
from shutil import copy2

ROOT = Path(__file__).resolve().parent
REPO = ROOT.parent
EXPECTED_SHA256 = "f218ccde1a6d27455250fa40a6b38515170fba746512be7c10198fc46d1e6ef2"
SOURCES = (
    "ai/inference/inference_api.py",
    "ai/inference/damage_contract.py",
    "ai/inference/yolo_detector.py",
    "ai/inference/portrait_evidence.py",
    "ai/inference/object_evidence.py",
    "ai/inference/detection_preview.py",
    "models/evidence/face_detection_yunet_2026may.onnx",
    "models/evidence/YuNet-LICENSE.txt",
    "models/checkpoints/yolo26n.pt",
    "ai/inference/scene_scoring.py",
    "ai/inference/severity_evidence.py",
    "ai/inference/mask_geometry.py",
    "ai/inference/visual_extent.py",
    "models/production/best.pt",
)


def main():
    for relative in SOURCES:
        source = REPO / relative
        if not source.is_file():
            raise RuntimeError(f"Missing tracked inference source: {relative}. Enable outside-root source access.")
        target = ROOT / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        copy2(source, target)
    digest = sha256((ROOT / "models/production/best.pt").read_bytes()).hexdigest()
    if digest != EXPECTED_SHA256:
        raise RuntimeError("Production model checksum changed; deployment refused pending validation.")


if __name__ == "__main__":
    main()
