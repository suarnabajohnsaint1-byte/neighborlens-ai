"""Promote the validated local YOLOv8m v9 checkpoint or restore YOLO11s."""

from __future__ import annotations

import argparse
import csv
import json
import os
import shutil
import stat
import sys
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from tempfile import NamedTemporaryFile, TemporaryDirectory

from ai.inference.damage_contract import CANONICAL_CLASS_NAMES, PRODUCTION_MANIFEST_NAME, validate_model_names
from ai.training.promote_production_model import PROJECT_ROOT, display_path, sha256

RUN = "yolov8m_v9_qa_filtered_exp01"
SOURCE = PROJECT_ROOT / "runs" / "neighborlens-v9" / RUN / "weights" / "best.pt"
PRODUCTION = PROJECT_ROOT / "models" / "production" / "best.pt"
SOURCE_SHA = "6e55d6fec65531180e1655e1b3c5931101fbf96e23346dff272b29c5422cd3d2"
ORIGINAL_SHA = "f218ccde1a6d27455250fa40a6b38515170fba746512be7c10198fc46d1e6ef2"
ORIGINAL_RUN = "beta_testing_v3"
NEW_VERSION = "neighborlens_yolov8m_v9"
METRICS = {
    "precision": "metrics/precision(B)",
    "recall": "metrics/recall(B)",
    "map50": "metrics/mAP50(B)",
    "map50_95": "metrics/mAP50-95(B)",
}


class MigrationError(RuntimeError):
    pass


def require_digest(path: Path, expected: str) -> None:
    if not path.is_file() or sha256(path) != expected:
        raise MigrationError(f"Missing checkpoint or checksum mismatch: {path}")


def inspect(path: Path, expected: str, architecture: str, run: str) -> dict:
    from ultralytics import YOLO

    require_digest(path, expected)
    model = YOLO(str(path))
    validate_model_names(model.names)
    ckpt = model.ckpt
    args = ckpt["train_args"]
    layers = {type(layer).__name__ for layer in model.model.model}
    yaml = model.model.yaml
    if architecture == "YOLOv8m":
        matches = "C2f" in layers and "C3k2" not in layers and (
            yaml.get("depth_multiple"), yaml.get("width_multiple")
        ) == (0.67, 0.75)
    else:
        matches = {"C3k2", "C2PSA"} <= layers and yaml.get("scale") == "s"
    if not matches or model.task != "detect" or args.get("name") != run:
        raise MigrationError(f"{path} does not contain the expected {architecture} detector from {run}.")
    return {
        "path": display_path(path),
        "sha256": expected,
        "size_bytes": path.stat().st_size,
        "architecture": architecture,
        "classes": model.names,
        "training_run": run,
        "training_base_model": args.get("model"),
        "checkpoint_timestamp": ckpt.get("date"),
        "ultralytics_version": ckpt.get("version"),
        "checkpoint_metrics": {name: ckpt["train_metrics"][column] for name, column in METRICS.items()},
    }


def validation_record(source: Path, candidate: dict) -> dict:
    run_dir = source.parent.parent
    with (run_dir / "results.csv").open(encoding="utf-8", newline="") as handle:
        rows = list(csv.DictReader(handle))
    best = max(rows, key=lambda row: float(row[METRICS["map50_95"]]))
    best_epoch, last_epoch = int(best["epoch"]), int(rows[-1]["epoch"])
    if (best_epoch, last_epoch) != (39, 69) or any(
        float(best[column]) != candidate["checkpoint_metrics"][name] for name, column in METRICS.items()
    ):
        raise MigrationError("The checkpoint metrics disagree with the expected training run and its results.csv.")
    experiment = json.loads((run_dir / "experiment.json").read_text(encoding="utf-8"))
    if experiment["train_args"]["name"] != RUN or experiment["model"] != "yolov8m.pt":
        raise MigrationError("Experiment metadata does not identify the expected training run.")
    return {
        "scope": "recorded_validation_only",
        "independently_reproduced": False,
        "images": 1259,
        "best_epoch": best_epoch,
        "last_epoch": last_epoch,
        "selected_epoch_metrics": candidate["checkpoint_metrics"],
        "supplied_summary_metrics": {"precision": 0.703, "recall": 0.635, "map50": 0.669, "map50_95": 0.384},
        "results_csv": display_path(run_dir / "results.csv"),
        "experiment_metadata": display_path(run_dir / "experiment.json"),
        "training_git_commit": experiment["git_commit"],
        "dataset_yaml_sha256": experiment["data_yaml_sha256"],
        "test_freeze_sha256": experiment["test_freeze_sha256"],
    }


def json_bytes(value: dict) -> bytes:
    return (json.dumps(value, indent=2) + "\n").encode("utf-8")


def replace_file(destination: Path, content: Path | bytes, expected: str | None = None) -> None:
    with NamedTemporaryFile(dir=destination.parent, prefix=".migration-", suffix=".tmp", delete=False) as handle:
        staged = Path(handle.name)
        try:
            if isinstance(content, Path):
                with content.open("rb") as source:
                    shutil.copyfileobj(source, handle)
            else:
                handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())
            handle.close()
            if expected is not None:
                require_digest(staged, expected)
            os.replace(staged, destination)
        finally:
            handle.close()
            staged.unlink(missing_ok=True)


def manifest_path(weights: Path) -> Path:
    return weights.with_name(PRODUCTION_MANIFEST_NAME)


def snapshot(production: Path, directory: Path) -> None:
    shutil.copy2(production, directory / "best.pt")
    manifest = manifest_path(production)
    if manifest.is_file():
        shutil.copy2(manifest, directory / PRODUCTION_MANIFEST_NAME)


def make_backup(production: Path, original: dict, timestamp: datetime) -> Path:
    root = production.parent / "archive"
    root.mkdir(exist_ok=True)
    backup = root / timestamp.strftime("yolo11s-beta_testing_v3-%Y%m%dT%H%M%S%fZ")
    backup.mkdir()
    snapshot(production, backup)
    manifest = manifest_path(backup / "best.pt")
    metadata = backup / "backup.json"
    with metadata.open("xb") as handle:
        handle.write(json_bytes({
            **original,
            "backed_up_utc": timestamp.isoformat(),
            "original_manifest_sha256": sha256(manifest) if manifest.is_file() else None,
        }))
    for path in backup.iterdir():
        path.chmod(stat.S_IREAD)
    return backup


def verify_backup(backup: Path) -> None:
    metadata = json.loads((backup / "backup.json").read_text(encoding="utf-8"))
    weights = backup / "best.pt"
    require_digest(weights, ORIGINAL_SHA)
    if metadata["sha256"] != ORIGINAL_SHA or metadata["size_bytes"] != weights.stat().st_size:
        raise MigrationError(f"Backup metadata does not match the original checkpoint: {backup}")
    manifest = manifest_path(weights)
    recorded = metadata["original_manifest_sha256"]
    if (sha256(manifest) if manifest.is_file() else None) != recorded:
        raise MigrationError(f"Backup manifest does not match the original state: {backup}")


def activate(production: Path, weights: Path, digest: str, manifest: bytes | None) -> None:
    target_manifest = manifest_path(production)
    # During the swap, a fresh inference worker fails closed on a mismatched manifest.
    if manifest is not None:
        replace_file(target_manifest, manifest)
    if not production.is_file() or sha256(production) != digest:
        replace_file(production, weights, digest)
    if manifest is None:
        target_manifest.unlink(missing_ok=True)


def read_manifest(weights: Path) -> bytes | None:
    path = manifest_path(weights)
    return path.read_bytes() if path.is_file() else None


def verify_health(production: Path, architecture: str, version: str) -> dict:
    from fastapi.testclient import TestClient

    from ai.inference.inference_api import create_app

    with TestClient(create_app(str(production), 0.30)) as client:
        response = client.get("/health")
        response.raise_for_status()
        health = response.json()
    validate_model_names(health["classes"])
    info = health["model_info"]
    if health["ok"] is not True or (info["architecture"], info["version"]) != (architecture, version):
        raise MigrationError(f"Unexpected inference health response: {health}")
    return info


@contextmanager
def recovery(production: Path, previous_weights: Path, previous_sha: str):
    previous_manifest = read_manifest(previous_weights)
    try:
        yield
    except BaseException as error:
        try:
            activate(production, previous_weights, previous_sha, previous_manifest)
        except Exception as restore_error:
            raise MigrationError(f"Migration failed ({error}). Restore failed ({restore_error}).") from restore_error
        raise


def promote(source: Path, production: Path, backup: Path | None) -> dict:
    candidate = inspect(source, SOURCE_SHA, "YOLOv8m", RUN)
    validation = validation_record(source, candidate)
    original = inspect(production, ORIGINAL_SHA, "YOLO11s", ORIGINAL_RUN)
    verify_health(production, "YOLO11s", ORIGINAL_RUN)
    timestamp = datetime.now(timezone.utc)
    if backup is None:
        backup = make_backup(production, original, timestamp)
    verify_backup(backup)
    original_weights = backup / "best.pt"
    if read_manifest(original_weights) != read_manifest(production):
        raise MigrationError("Selected backup does not preserve the active YOLO11s manifest.")
    manifest = {
        "version": NEW_VERSION,
        "release_label": "v9",
        "architecture": "YOLOv8m",
        "target_eligible": False,
        "research_target_achieved": False,
        "held_out_test_evaluated": False,
        "classes": CANONICAL_CLASS_NAMES,
        "source_checkpoint": candidate["path"],
        "source_sha256": SOURCE_SHA,
        "production_checkpoint": display_path(production),
        "production_sha256": SOURCE_SHA,
        "production_size_bytes": candidate["size_bytes"],
        "training_run": RUN,
        "recorded_validation": validation,
        "rollback_archive": display_path(backup),
        "promoted_utc": timestamp.isoformat(),
    }
    with recovery(production, original_weights, ORIGINAL_SHA):
        activate(production, source, SOURCE_SHA, json_bytes(manifest))
        require_digest(production, SOURCE_SHA)
        require_digest(source, SOURCE_SHA)
        info = verify_health(production, "YOLOv8m", NEW_VERSION)
    return {"backup": display_path(backup), "active_sha256": SOURCE_SHA, "model_info": info}


def rollout_backup(production: Path) -> Path:
    manifest = read_manifest(production)
    if manifest is not None:
        backup = json.loads(manifest).get("rollback_archive")
        if backup:
            return PROJECT_ROOT / backup
    raise MigrationError("The active manifest has no rollback archive. Supply --backup.")


def rollback(production: Path, backup: Path) -> dict:
    verify_backup(backup)
    original = backup / "best.pt"
    inspect(original, ORIGINAL_SHA, "YOLO11s", ORIGINAL_RUN)
    with TemporaryDirectory(dir=production.parent, prefix=".rollback-") as directory:
        previous = Path(directory)
        snapshot(production, previous)
        previous_weights = previous / "best.pt"
        with recovery(production, previous_weights, sha256(previous_weights)):
            activate(production, original, ORIGINAL_SHA, read_manifest(original))
            require_digest(production, ORIGINAL_SHA)
            if read_manifest(production) != read_manifest(original):
                raise MigrationError("Rollback did not restore the original manifest state.")
            info = verify_health(production, "YOLO11s", ORIGINAL_RUN)
    return {"backup": display_path(backup), "active_sha256": ORIGINAL_SHA, "model_info": info}


@contextmanager
def migration_lock(production: Path):
    lock = production.with_name(".yolov8m-v9-migration.lock")
    try:
        handle = lock.open("x")
    except FileExistsError as error:
        raise MigrationError(f"Migration lock exists: {lock}. Check the prior process before removing it.") from error
    try:
        with handle:
            handle.write(f"{os.getpid()}\n")
        yield
    finally:
        lock.unlink()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("check", "promote", "rollback"))
    parser.add_argument("--backup", type=Path, help="Use a previously verified rollback directory.")
    args = parser.parse_args()
    try:
        if args.action == "check":
            candidate = inspect(SOURCE, SOURCE_SHA, "YOLOv8m", RUN)
            if PRODUCTION.is_file() and sha256(PRODUCTION) == SOURCE_SHA:
                active = inspect(PRODUCTION, SOURCE_SHA, "YOLOv8m", RUN)
                info = verify_health(PRODUCTION, "YOLOv8m", NEW_VERSION)
            else:
                active = inspect(PRODUCTION, ORIGINAL_SHA, "YOLO11s", ORIGINAL_RUN)
                info = verify_health(PRODUCTION, "YOLO11s", ORIGINAL_RUN)
            print(json_bytes({
                "candidate": candidate,
                "production": active,
                "model_info": info,
                "recorded_validation": validation_record(SOURCE, candidate),
            }).decode(), end="")
            return 0
        with migration_lock(PRODUCTION):
            if args.action == "promote":
                result = promote(SOURCE, PRODUCTION, args.backup)
            else:
                result = rollback(PRODUCTION, args.backup or rollout_backup(PRODUCTION))
    except Exception as error:
        print(f"LOCAL MIGRATION FAILED: {error}", file=sys.stderr)
        return 1
    print(json_bytes(result).decode(), end="")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
