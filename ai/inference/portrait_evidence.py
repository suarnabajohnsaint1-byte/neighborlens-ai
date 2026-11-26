"""Optional face regions for evidence validation. Discard landmark output."""

from hashlib import sha256
from pathlib import Path
from threading import Lock

import cv2
import numpy as np


YUNET_SHA256 = "ebafce4e3c118d6554634be5c27ab333b4c047a9a8c3faf1d7cf93101c22f0f0"
FACE_SCORE = 0.80
MAX_EDGE = 640


class FaceRegions:
    def __init__(self, detector):
        self.detector = detector
        self.lock = Lock()

    def detect(self, image):
        height, width = image.shape[:2]
        scale = min(1.0, MAX_EDGE / max(height, width))
        dimensions = (max(1, round(width * scale)), max(1, round(height * scale)))
        resized = cv2.resize(image, dimensions, interpolation=cv2.INTER_AREA) if scale < 1 else image
        with self.lock:
            self.detector.setInputSize(dimensions)
            _, rows = self.detector.detect(resized)
        if rows is None:
            return []
        boxes = rows[:, :4].astype(np.float64)
        valid = np.isfinite(boxes).all(axis=1) & (boxes[:, 2:] > 0).all(axis=1)
        return [
            (x * width / dimensions[0], y * height / dimensions[1],
             w * width / dimensions[0], h * height / dimensions[1])
            for x, y, w, h in boxes[valid]
        ]


def load_face_regions(weights: str | Path | None):
    constructor = getattr(getattr(cv2, "FaceDetectorYN", None), "create", None)
    if not callable(constructor):
        raise RuntimeError("The portrait filter requires OpenCV FaceDetectorYN.")
    if weights is None:
        raise RuntimeError("Provide the pinned YuNet ONNX file to enable the portrait filter.")
    path = Path(weights)
    if not path.is_file():
        raise RuntimeError("The portrait filter's YuNet ONNX file is missing.")
    if sha256(path.read_bytes()).hexdigest() != YUNET_SHA256:
        raise RuntimeError("The portrait filter's YuNet ONNX checksum does not match.")
    try:
        regions = FaceRegions(constructor(str(path), "", (320, 320), FACE_SCORE))
        regions.detect(np.zeros((320, 320, 3), dtype=np.uint8))
    except (cv2.error, OSError) as error:
        raise RuntimeError("The portrait filter could not run YuNet with this OpenCV build.") from error
    return regions


def on_face(box, face):
    x, y, width, height = face
    shared_width = max(0, min(box.x + box.width, x + width) - max(box.x, x))
    shared_height = max(0, min(box.y + box.height, y + height) - max(box.y, y))
    shared = shared_width * shared_height
    if shared <= 0 or box.width <= 0 or box.height <= 0:
        return False
    defect_fraction = shared / (box.width * box.height)
    center_x = box.x + box.width / 2
    center_y = box.y + box.height / 2
    contains_center = x <= center_x <= x + width and y <= center_y <= y + height
    return defect_fraction >= 0.50 or (
        contains_center and defect_fraction >= 0.10 and shared >= 0.70 * width * height
    )


def portrait_candidates(detections, faces):
    return [item for item in detections if not any(on_face(item.bounding_box, face) for face in faces)]
