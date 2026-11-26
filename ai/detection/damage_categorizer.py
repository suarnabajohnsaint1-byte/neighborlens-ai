"""Map YOLO class IDs to readable civic infrastructure damage labels."""

from __future__ import annotations

from typing import Any, Dict, Iterable, List, Mapping

CLASS_METADATA: Dict[int, Dict[str, str]] = {
    0: {
        "class_name": "damaged_road",
        "status_label": "Road Surface Damage Detected",
        "severity_description": "Road surface deterioration may affect vehicle safety and drainage flow.",
    },
    1: {
        "class_name": "clogged_drainage",
        "status_label": "Drainage Blockage Detected",
        "severity_description": "Blocked drainage could lead to localized flooding and sanitation concerns.",
    },
    2: {
        "class_name": "damaged_street_light",
        "status_label": "Street Light Damage Detected",
        "severity_description": "A damaged or nonfunctional street light may reduce visibility and public safety.",
    },
    3: {
        "class_name": "damaged_traffic_light",
        "status_label": "Traffic Light Damage Detected",
        "severity_description": "A malfunctioning or damaged traffic signal poses severe intersection and pedestrian collision risks.",
    },
}


class DamageCategorizer:
    """Convert raw YOLO class IDs into human-readable infrastructure status labels."""

    @staticmethod
    def map_class_id(class_id: int) -> Dict[str, str]:
        class_id = int(class_id)
        meta = CLASS_METADATA.get(class_id, {
            "class_name": f"unknown_{class_id}",
            "status_label": "Unclassified Infrastructure Issue",
            "severity_description": "The detected object does not match the known infrastructure categories.",
        })
        return {
            "class_id": class_id,
            "class_name": meta["class_name"],
            "status_label": meta["status_label"],
            "severity_description": meta["severity_description"],
        }

    @classmethod
    def from_prediction(cls, prediction: Any) -> Dict[str, Any]:
        if isinstance(prediction, Mapping):
            class_id = int(prediction.get("class_id", prediction.get("cls", 0)))
            confidence = float(prediction.get("confidence", 0.0))
        else:
            class_id = int(getattr(prediction, "cls", 0))
            if hasattr(prediction, "cls") and hasattr(prediction.cls, "item"):
                class_id = int(prediction.cls.item())
            confidence = 0.0
            if hasattr(prediction, "conf") and prediction.conf is not None:
                confidence = float(prediction.conf.item()) if hasattr(prediction.conf, "item") else float(prediction.conf)

        details = cls.map_class_id(class_id)
        details["confidence"] = confidence
        return details

    @classmethod
    def categorize_batch(cls, predictions: Iterable[Any]) -> List[Dict[str, Any]]:
        return [cls.from_prediction(prediction) for prediction in predictions]


if __name__ == "__main__":
    print("Mapped classes:")
    for class_id, details in CLASS_METADATA.items():
        print(class_id, details["class_name"], "->", details["status_label"])
