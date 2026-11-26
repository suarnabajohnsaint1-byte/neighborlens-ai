from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import sys
from datetime import datetime, timezone
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[2]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from ai.inference.damage_contract import CANONICAL_CLASS_NAMES, PRODUCTION_MANIFEST_NAME, release_label

LEGACY_CLASS_NAMES = frozenset({"damaged_road", "damaged_street_light", "damaged_traffic_light"})
EXPECTED_VERSION = "neighborlens_v3_1_interim"
DEFAULT_SOURCE = PROJECT_ROOT / "models" / "checkpoints" / EXPECTED_VERSION / "weights" / "best.pt"
DEFAULT_PRODUCTION = PROJECT_ROOT / "models" / "production" / "best.pt"
DEFAULT_ARCHIVE = PROJECT_ROOT / "models" / "production" / "archive" / "best_legacy_pre_v3_1.pt"


class PromotionError(RuntimeError):
    pass


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def display_path(path: Path) -> str:
    try:
        return path.resolve().relative_to(PROJECT_ROOT).as_posix()
    except ValueError:
        return path.as_posix()


def inspect_checkpoint(path: Path) -> dict:
    if not path.is_file():
        raise PromotionError(f"Checkpoint not found: {path}")
    from ultralytics import YOLO

    model = YOLO(str(path))
    names = {int(key): str(value) for key, value in dict(model.names).items()}
    ckpt = getattr(model, "ckpt", None) or {}
    train_args = ckpt.get("train_args") or {}
    return {
        "path": display_path(path),
        "sha256": sha256(path),
        "size_bytes": path.stat().st_size,
        "names": names,
        "train_name": train_args.get("name"),
        "base_model": train_args.get("model"),
        "epoch": ckpt.get("epoch"),
    }


def is_canonical(names: dict) -> bool:
    return names == CANONICAL_CLASS_NAMES


def is_legacy(names: dict) -> bool:
    return bool(LEGACY_CLASS_NAMES & set(names.values()))


def read_target_eligible(source: Path):
    config_path = source.parent.parent / "train_config.json"
    if not config_path.is_file():
        raise PromotionError(f"Missing {config_path}; cannot establish target eligibility.")
    value = json.loads(config_path.read_text(encoding="utf-8")).get("target_eligible")
    if not isinstance(value, bool):
        raise PromotionError(f"{config_path} has no boolean target_eligible.")
    return value


def copy_atomically(source: Path, destination: Path) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_name(destination.name + ".tmp")
    shutil.copyfile(source, temporary)
    with temporary.open("r+b") as handle:
        os.fsync(handle.fileno())
    os.replace(temporary, destination)


def verify_source(source: Path) -> tuple[dict, bool]:
    info = inspect_checkpoint(source)
    if not is_canonical(info["names"]):
        raise PromotionError(f"Source classes {info['names']} are not the canonical mapping {CANONICAL_CLASS_NAMES}.")
    if info["train_name"] != EXPECTED_VERSION:
        raise PromotionError(f"Source run name is {info['train_name']!r}, expected {EXPECTED_VERSION!r}.")
    target_eligible = read_target_eligible(source)
    if target_eligible is not False:
        raise PromotionError("Source run reports target_eligible=true; this promotion only covers the v3.1 interim baseline.")
    return info, target_eligible


def archive_legacy(production: Path, archive: Path) -> dict:
    current = inspect_checkpoint(production)
    if is_canonical(current["names"]):
        raise PromotionError(f"{production} already serves canonical classes; refusing to archive it as the legacy model.")
    if not is_legacy(current["names"]):
        raise PromotionError(f"{production} classes {current['names']} are neither canonical nor the known legacy taxonomy.")
    if archive.exists():
        if sha256(archive) != current["sha256"]:
            raise PromotionError(f"{archive} exists with different content; refusing to overwrite a rollback copy.")
    else:
        copy_atomically(production, archive)
    if sha256(archive) != current["sha256"]:
        raise PromotionError("Archived legacy checkpoint does not match the original production checksum.")
    return {**current, "archive_path": display_path(archive)}


def promote(source: Path, production: Path, archive: Path) -> dict:
    source_info, target_eligible = verify_source(source)
    if production.is_file() and sha256(production) == source_info["sha256"]:
        legacy = None
        if archive.is_file():
            legacy = inspect_checkpoint(archive)
            legacy["archive_path"] = display_path(archive)
    else:
        legacy = archive_legacy(production, archive)
        copy_atomically(source, production)

    promoted = inspect_checkpoint(production)
    if promoted["sha256"] != source_info["sha256"]:
        raise PromotionError("Production checksum does not match the source checkpoint after copying.")
    if not is_canonical(promoted["names"]):
        raise PromotionError(f"Production classes {promoted['names']} are not canonical after copying.")
    if sha256(source) != source_info["sha256"]:
        raise PromotionError("Source checkpoint changed during promotion.")

    manifest = {
        "version": EXPECTED_VERSION,
        "release_label": release_label(EXPECTED_VERSION, target_eligible),
        "target_eligible": target_eligible,
        "research_target_achieved": False,
        "held_out_test_evaluated": False,
        "classes": {str(key): value for key, value in CANONICAL_CLASS_NAMES.items()},
        "source_checkpoint": source_info["path"],
        "source_sha256": source_info["sha256"],
        "production_checkpoint": display_path(production),
        "production_sha256": promoted["sha256"],
        "production_size_bytes": promoted["size_bytes"],
        "legacy_archive": None if legacy is None else {
            "path": legacy["archive_path"],
            "sha256": legacy["sha256"],
            "size_bytes": legacy["size_bytes"],
            "names": {str(key): value for key, value in legacy["names"].items()},
        },
        "promoted_utc": datetime.now(timezone.utc).replace(microsecond=0).isoformat(),
    }
    manifest_path = production.parent / PRODUCTION_MANIFEST_NAME
    temporary = manifest_path.with_name(manifest_path.name + ".tmp")
    temporary.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    os.replace(temporary, manifest_path)
    return {"source": source_info, "legacy": legacy, "production": promoted, "manifest": display_path(manifest_path)}


def rollback(production: Path, archive: Path) -> dict:
    if not archive.is_file():
        raise PromotionError(f"No rollback copy at {archive}.")
    archived = inspect_checkpoint(archive)
    manifest_path = production.parent / PRODUCTION_MANIFEST_NAME
    if manifest_path.is_file():
        recorded = (json.loads(manifest_path.read_text(encoding="utf-8")).get("legacy_archive") or {}).get("sha256")
        if recorded and recorded != archived["sha256"]:
            raise PromotionError("Rollback copy does not match the legacy checksum recorded at promotion.")
    copy_atomically(archive, production)
    if sha256(production) != archived["sha256"]:
        raise PromotionError("Production checksum does not match the rollback copy after restoring.")
    if manifest_path.is_file():
        manifest_path.unlink()
    return {"restored": inspect_checkpoint(production)}


def parse_args(argv=None):
    parser = argparse.ArgumentParser(description="Promote the v3.1 interim checkpoint to models/production/best.pt, or roll it back.")
    parser.add_argument("--source", type=Path, default=DEFAULT_SOURCE)
    parser.add_argument("--production", type=Path, default=DEFAULT_PRODUCTION)
    parser.add_argument("--archive", type=Path, default=DEFAULT_ARCHIVE)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--check-only", action="store_true")
    mode.add_argument("--rollback", action="store_true")
    return parser.parse_args(argv)


def main(argv=None) -> int:
    args = parse_args(argv)
    try:
        if args.rollback:
            result = rollback(args.production, args.archive)
        elif args.check_only:
            source_info, target_eligible = verify_source(args.source)
            result = {"source": source_info, "target_eligible": target_eligible, "production": inspect_checkpoint(args.production)}
        else:
            result = promote(args.source, args.production, args.archive)
    except PromotionError as error:
        print(f"PROMOTION FAILED: {error}", file=sys.stderr)
        return 1
    print(json.dumps(result, indent=2, default=str))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
