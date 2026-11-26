"""Shared helpers for reading the immutable raw image folders and the class mapping."""

from __future__ import annotations

import hashlib
from dataclasses import dataclass
from pathlib import Path

import yaml
from PIL import Image, ImageOps

PROJECT_ROOT = Path(__file__).resolve().parents[2]
RAW_ROOT = PROJECT_ROOT / "data" / "raw"
NEW_DATASET_ROOT = PROJECT_ROOT / "data" / "processed"
CLASS_MAPPING_PATH = NEW_DATASET_ROOT / "class_mapping.yaml"
SOURCE_FOLDERS = ("damages_road", "street_light", "clogging_drainage")

IMAGE_SUFFIXES = {".jpg", ".jpeg", ".jfif", ".png", ".webp", ".bmp", ".tif", ".tiff", ".heic", ".heif", ".gif"}
YOLO_READY_SUFFIXES = {".jpg", ".jpeg", ".png", ".webp", ".bmp", ".tif", ".tiff"}
APPROVED_STATUS = "approved"


@dataclass(frozen=True)
class ClassMapping:
    status: str
    names: dict[int, str]
    folder_to_class: dict[str, str]

    @property
    def approved(self) -> bool:
        return self.status == APPROVED_STATUS

    def class_id(self, name: str) -> int:
        for class_id, class_name in self.names.items():
            if class_name == name:
                return class_id
        raise KeyError(name)


def load_class_mapping(path: Path = CLASS_MAPPING_PATH) -> ClassMapping:
    data = yaml.safe_load(path.read_text(encoding="utf-8"))
    names = {int(k): str(v) for k, v in data["names"].items()}
    folder_to_class = {str(k): str(v) for k, v in data["source_folders"].items()}
    unknown = set(folder_to_class.values()) - set(names.values())
    if unknown:
        raise ValueError(f"Source folders map to classes not in names: {sorted(unknown)}")
    if sorted(names) != list(range(len(names))):
        raise ValueError("Class IDs must be contiguous and start at 0")
    return ClassMapping(status=str(data.get("status", "")), names=names, folder_to_class=folder_to_class)


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(1 << 20):
            digest.update(chunk)
    return digest.hexdigest()


def difference_hash(image: Image.Image, hash_size: int = 8) -> int:
    grey = ImageOps.exif_transpose(image).convert("L").resize((hash_size + 1, hash_size), Image.Resampling.LANCZOS)
    pixels = grey.tobytes()
    bits = 0
    for row in range(hash_size):
        offset = row * (hash_size + 1)
        for col in range(hash_size):
            bits = (bits << 1) | (pixels[offset + col] > pixels[offset + col + 1])
    return bits


def hamming(a: int, b: int) -> int:
    return (a ^ b).bit_count()


def iter_files(root: Path):
    for path in sorted(root.rglob("*")):
        if path.is_file():
            yield path
