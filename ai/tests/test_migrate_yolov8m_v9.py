import json
import stat
from datetime import datetime, timezone

import pytest

from ai.training import migrate_yolov8m_v9 as migration


@pytest.fixture
def checkpoints(tmp_path, monkeypatch):
    production = tmp_path / "production" / "best.pt"
    production.parent.mkdir()
    production.write_bytes(b"YOLO11s")
    candidate = tmp_path / "candidate.pt"
    candidate.write_bytes(b"YOLOv8m")
    monkeypatch.setattr(migration, "ORIGINAL_SHA", migration.sha256(production))
    monkeypatch.setattr(migration, "SOURCE_SHA", migration.sha256(candidate))

    def inspect(path, digest, architecture, run):
        migration.require_digest(path, digest)
        return {"path": str(path), "sha256": digest, "size_bytes": path.stat().st_size}

    def health(path, architecture, version):
        digest = migration.SOURCE_SHA if architecture == "YOLOv8m" else migration.ORIGINAL_SHA
        migration.require_digest(path, digest)
        manifest = migration.read_manifest(path)
        if manifest is not None:
            assert json.loads(manifest)["production_sha256"] == digest
        return {"architecture": architecture, "version": version}

    monkeypatch.setattr(migration, "inspect", inspect)
    monkeypatch.setattr(migration, "verify_health", health)
    monkeypatch.setattr(migration, "validation_record", lambda *_: {})
    yield candidate, production
    for path in production.parent.glob("archive/*/*"):
        path.chmod(stat.S_IWRITE | stat.S_IREAD)


@pytest.mark.parametrize("with_manifest", [False, True])
def test_rollback_restores_exact_bytes_and_manifest_state(checkpoints, with_manifest):
    source, production = checkpoints
    manifest_path = migration.manifest_path(production)
    original_manifest = b'{ "production_sha256": "%s", "unknown_field": 1 }\r\n' % migration.ORIGINAL_SHA.encode()
    if with_manifest:
        manifest_path.write_bytes(original_manifest)

    promoted = migration.promote(source, production, None)
    backup = migration.rollout_backup(production)
    assert promoted["active_sha256"] == migration.SOURCE_SHA
    assert production.read_bytes() == source.read_bytes() == b"YOLOv8m"
    assert not (backup / "best.pt").stat().st_mode & stat.S_IWRITE
    assert (backup / "best.pt").read_bytes() == b"YOLO11s"

    migration.rollback(production, backup)
    assert migration.read_manifest(production) == (original_manifest if with_manifest else None)
    assert production.read_bytes() == b"YOLO11s"
    assert migration.promote(source, production, backup)["backup"] == promoted["backup"]
    assert len(list(backup.parent.iterdir())) == 1


def test_promotion_recovers_from_failed_inference_startup(checkpoints, monkeypatch):
    source, production = checkpoints
    original_health = migration.verify_health

    def health(path, architecture, version):
        if architecture == "YOLOv8m":
            assert path.read_bytes() == b"YOLOv8m"
            raise RuntimeError("forced startup failure")
        return original_health(path, architecture, version)

    monkeypatch.setattr(migration, "verify_health", health)
    with pytest.raises(RuntimeError, match="forced startup failure"):
        migration.promote(source, production, None)
    assert production.read_bytes() == b"YOLO11s"
    assert migration.read_manifest(production) is None
    assert not list(production.parent.glob(".migration-*.tmp"))
    (backup,) = (production.parent / "archive").iterdir()
    migration.verify_backup(backup)


def test_promotion_recovers_when_weights_cannot_be_replaced(checkpoints, monkeypatch):
    source, production = checkpoints
    replace_file = migration.replace_file

    def deny_checkpoint_swap(path, content, expected=None):
        if path == production:
            raise PermissionError("checkpoint is locked")
        replace_file(path, content, expected)

    monkeypatch.setattr(migration, "replace_file", deny_checkpoint_swap)
    with pytest.raises(PermissionError, match="checkpoint is locked"):
        migration.promote(source, production, None)
    assert production.read_bytes() == b"YOLO11s"
    assert migration.read_manifest(production) is None


def test_existing_backup_cannot_be_overwritten(checkpoints):
    _, production = checkpoints
    timestamp = datetime(2026, 11, 16, tzinfo=timezone.utc)
    original = {"sha256": migration.ORIGINAL_SHA, "size_bytes": production.stat().st_size}
    backup = migration.make_backup(production, original, timestamp)
    with pytest.raises(FileExistsError):
        migration.make_backup(production, {}, timestamp)
    migration.verify_backup(backup)


def test_bad_backup_is_refused_before_rollback(checkpoints):
    source, production = checkpoints
    migration.promote(source, production, None)
    backup = migration.rollout_backup(production)
    weights = backup / "best.pt"
    weights.chmod(stat.S_IWRITE | stat.S_IREAD)
    weights.write_bytes(b"corrupted")
    manifest = migration.read_manifest(production)
    with pytest.raises(migration.MigrationError, match="checksum mismatch"):
        migration.rollback(production, backup)
    assert production.read_bytes() == b"YOLOv8m"
    assert migration.read_manifest(production) == manifest
