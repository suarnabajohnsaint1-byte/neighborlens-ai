"""Candidate-level veto using the separately benchmarked COCO detector."""

from hashlib import file_digest
from pathlib import Path
from threading import Lock

from ultralytics import YOLO

WEIGHTS_SHA256 = "9b09cc8bf347f0fc8a5f7657480587f25db09b34bf33b0652110fb03a8ad4fef"
UNRELATED_SUBJECTS = {"cat", "cell phone", "cup", "dog", "keyboard", "laptop", "person", "tv"}
STREETLIGHT_LOOKALIKES = {"bottle", "vase"}
MIN_SUBJECT_CONFIDENCE = .25
MIN_CANDIDATE_OVERLAP = .25
MIN_LOOKALIKE_IOU = .40


class ObjectRegions:
    def __init__(self, weights):
        path = Path(weights)
        with path.open("rb") as stream:
            if file_digest(stream, "sha256").hexdigest() != WEIGHTS_SHA256:
                raise RuntimeError("The COCO relevance checkpoint checksum does not match.")
        self.detector = YOLO(str(path))
        self.lock = Lock()

    def detect(self, image):
        with self.lock:
            result = self.detector.predict(image, imgsz=640, conf=MIN_SUBJECT_CONFIDENCE,
                                           rect=False, verbose=False, max_det=100)[0]
        return [(result.names[int(cls)], x1, y1, x2, y2)
                for x1, y1, x2, y2, _, cls in result.boxes.data.cpu().tolist()
                if result.names[int(cls)] in UNRELATED_SUBJECTS | STREETLIGHT_LOOKALIKES]


def subject_candidates(detections, subjects):
    def retain(item):
        box = item.bounding_box
        area = box.width * box.height
        if area <= 0:
            return True
        for name, x1, y1, x2, y2 in subjects:
            w = max(0, min(box.x + box.width, x2) - max(box.x, x1))
            h = max(0, min(box.y + box.height, y2) - max(box.y, y1))
            shared = w * h
            if name in UNRELATED_SUBJECTS and shared >= MIN_CANDIDATE_OVERLAP * area:
                return False
            union = area + (x2 - x1) * (y2 - y1) - shared
            if (item.damage_type == "broken_streetlight" and name in STREETLIGHT_LOOKALIKES
                    and shared >= MIN_LOOKALIKE_IOU * union):
                return False
        return True
    return [item for item in detections if retain(item)]
