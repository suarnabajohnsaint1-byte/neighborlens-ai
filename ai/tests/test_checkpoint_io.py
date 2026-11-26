import builtins
import errno
import io
import os
import pickle
import sys
import types
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from ai.training import checkpoint_io
from ai.training.checkpoint_io import AtomicCheckpointPath, atomic_write_bytes, use_atomic_checkpoint_writes

CHECKPOINT = {"epoch": 21, "best_fitness": 0.05, "optimizer": {"state": [1, 2, 3]}, "scaler": {"scale": 65536.0}, "updates": 1234}


def no_temp_files(directory):
    return not [path for path in Path(directory).iterdir() if path.name.endswith(".tmp")]


def test_atomic_write_creates_exact_bytes_and_leaves_no_temp_file(tmp_path):
    target = tmp_path / "last.pt"
    data = pickle.dumps(CHECKPOINT)
    assert atomic_write_bytes(target, data) == len(data)
    assert pickle.loads(target.read_bytes()) == CHECKPOINT
    assert no_temp_files(tmp_path)


def test_atomic_write_replaces_existing_checkpoint(tmp_path):
    target = tmp_path / "last.pt"
    target.write_bytes(pickle.dumps({"epoch": 20}))
    atomic_write_bytes(target, pickle.dumps(CHECKPOINT))
    assert pickle.loads(target.read_bytes())["epoch"] == 21


def test_transient_replace_errors_are_retried_with_backoff(tmp_path, monkeypatch):
    target = tmp_path / "last.pt"
    target.write_bytes(b"epoch20")
    real_replace = os.replace
    failures = {"left": 2}

    def flaky_replace(source, destination):
        if failures["left"]:
            failures["left"] -= 1
            raise OSError(errno.EINVAL, "Invalid argument")
        return real_replace(source, destination)

    monkeypatch.setattr(checkpoint_io.os, "replace", flaky_replace)
    sleeps = []
    atomic_write_bytes(target, b"epoch21", sleep=sleeps.append)
    assert target.read_bytes() == b"epoch21"
    assert sleeps == [0.5, 1.0]
    assert no_temp_files(tmp_path)


def test_persistent_failure_raises_and_keeps_previous_checkpoint_intact(tmp_path, monkeypatch):
    target = tmp_path / "last.pt"
    target.write_bytes(b"epoch20-valid")

    def always_fail(source, destination):
        raise OSError(errno.EINVAL, "Invalid argument")

    monkeypatch.setattr(checkpoint_io.os, "replace", always_fail)
    sleeps = []
    with pytest.raises(OSError) as raised:
        atomic_write_bytes(target, b"epoch21", sleep=sleeps.append)
    assert raised.value.errno == errno.EINVAL
    assert target.read_bytes() == b"epoch20-valid"
    assert sleeps == list(checkpoint_io.RETRY_DELAYS_SECONDS)
    assert no_temp_files(tmp_path)


def test_target_is_never_opened_for_truncating_write(tmp_path, monkeypatch):
    target = tmp_path / "last.pt"
    target.write_bytes(b"epoch20")
    real_open = builtins.open

    def windows_mapped_file_open(file, mode="r", *args, **kwargs):
        if Path(file) == target and "w" in mode:
            raise OSError(errno.EINVAL, "Invalid argument")
        return real_open(file, mode, *args, **kwargs)

    monkeypatch.setattr(builtins, "open", windows_mapped_file_open)
    monkeypatch.setattr(io, "open", windows_mapped_file_open)
    with pytest.raises(OSError):
        Path(target).write_bytes(b"epoch21")
    atomic_write_bytes(target, b"epoch21", sleep=lambda _: None)
    assert target.read_bytes() == b"epoch21"


def test_atomic_path_children_keep_atomic_writes(tmp_path):
    weights = AtomicCheckpointPath(tmp_path)
    epoch_file = weights / "epoch20.pt"
    assert isinstance(epoch_file, AtomicCheckpointPath)
    assert isinstance(epoch_file, Path)
    assert str(epoch_file) == str(tmp_path / "epoch20.pt")
    epoch_file.write_bytes(b"payload")
    assert (tmp_path / "epoch20.pt").read_bytes() == b"payload"


def fake_trainer_module():
    def strip_optimizer(f="best.pt", s="", updates=None):
        checkpoint = pickle.loads(Path(f).read_bytes())
        stripped = {**checkpoint, "optimizer": None, "scaler": None, "ema": None, "updates": None, "epoch": -1, **(updates or {})}
        Path(s or f).write_bytes(pickle.dumps(stripped))
        return stripped

    return types.SimpleNamespace(strip_optimizer=strip_optimizer)


def make_trainer(wdir, module, final_eval=None):
    trainer = types.SimpleNamespace(wdir=wdir, last=wdir / "last.pt", best=wdir / "best.pt")

    def default_final_eval():
        ckpt = module.strip_optimizer(trainer.last)
        module.strip_optimizer(trainer.best, updates={"train_results": ckpt.get("train_results")})
        return "evaluated"

    trainer.final_eval = final_eval or default_final_eval
    return trainer


def test_callback_converts_trainer_paths_used_by_save_model(tmp_path):
    wdir = tmp_path / "weights"
    module = fake_trainer_module()
    trainer = make_trainer(wdir, module)
    use_atomic_checkpoint_writes(trainer, module)
    assert all(isinstance(path, AtomicCheckpointPath) for path in (trainer.wdir, trainer.last, trainer.best))
    data = pickle.dumps(CHECKPOINT)
    trainer.wdir.mkdir(parents=True, exist_ok=True)
    trainer.last.write_bytes(data)
    trainer.best.write_bytes(data)
    (trainer.wdir / "epoch20.pt").write_bytes(data)
    for name in ("last.pt", "best.pt", "epoch20.pt"):
        assert pickle.loads((wdir / name).read_bytes()) == CHECKPOINT
    assert no_temp_files(wdir)


def test_atomic_strip_preserves_stripping_semantics_and_replaces_atomically(tmp_path):
    module = fake_trainer_module()
    last = tmp_path / "last.pt"
    last.write_bytes(pickle.dumps({**CHECKPOINT, "train_results": {"mAP50": [0.1]}}))
    atomic_strip = checkpoint_io.make_atomic_strip_optimizer(module.strip_optimizer, sleep=lambda _: None)
    returned = atomic_strip(last)
    stored = pickle.loads(last.read_bytes())
    assert stored == returned
    assert stored["epoch"] == -1 and stored["optimizer"] is None and stored["scaler"] is None and stored["ema"] is None
    assert stored["train_results"] == {"mAP50": [0.1]}
    assert no_temp_files(tmp_path)


def test_atomic_strip_respects_explicit_output_path(tmp_path):
    module = fake_trainer_module()
    source = tmp_path / "last.pt"
    source.write_bytes(pickle.dumps(CHECKPOINT))
    output = tmp_path / "stripped.pt"
    checkpoint_io.make_atomic_strip_optimizer(module.strip_optimizer)(source, s=str(output))
    assert pickle.loads(source.read_bytes()) == CHECKPOINT
    assert pickle.loads(output.read_bytes())["epoch"] == -1


def test_atomic_strip_survives_target_that_cannot_be_opened_for_writing(tmp_path):
    last = tmp_path / "last.pt"
    last.write_bytes(pickle.dumps(CHECKPOINT))
    real = fake_trainer_module().strip_optimizer

    def windows_strip(f="best.pt", s="", updates=None):
        if Path(s or f) == last:
            raise OSError(errno.EINVAL, "Invalid argument")
        return real(f, s=s, updates=updates)

    with pytest.raises(OSError):
        windows_strip(last)
    checkpoint_io.make_atomic_strip_optimizer(windows_strip, sleep=lambda _: None)(last)
    assert pickle.loads(last.read_bytes())["epoch"] == -1


def test_atomic_strip_retries_then_keeps_full_checkpoint_on_persistent_failure(tmp_path, monkeypatch):
    module = fake_trainer_module()
    last = tmp_path / "last.pt"
    last.write_bytes(pickle.dumps(CHECKPOINT))

    def always_fail(source, destination):
        raise OSError(errno.EINVAL, "Invalid argument")

    monkeypatch.setattr(checkpoint_io.os, "replace", always_fail)
    sleeps = []
    with pytest.raises(OSError):
        checkpoint_io.make_atomic_strip_optimizer(module.strip_optimizer, sleep=sleeps.append)(last)
    assert pickle.loads(last.read_bytes()) == CHECKPOINT
    assert sleeps == list(checkpoint_io.RETRY_DELAYS_SECONDS)
    assert no_temp_files(tmp_path)


def test_final_eval_uses_atomic_strip_only_during_final_eval(tmp_path):
    module = fake_trainer_module()
    original = module.strip_optimizer
    wdir = tmp_path / "weights"
    wdir.mkdir()
    seen = []
    trainer = make_trainer(wdir, module)
    inner = trainer.final_eval

    def recording_final_eval():
        seen.append(module.strip_optimizer)
        return inner()

    trainer.final_eval = recording_final_eval
    for name in ("last.pt", "best.pt"):
        (wdir / name).write_bytes(pickle.dumps({**CHECKPOINT, "train_results": {"epoch": [1, 2]}}))
    use_atomic_checkpoint_writes(trainer, module)
    assert module.strip_optimizer is original
    assert trainer.final_eval() == "evaluated"
    assert seen and seen[0] is not original
    assert module.strip_optimizer is original
    for name in ("last.pt", "best.pt"):
        stored = pickle.loads((wdir / name).read_bytes())
        assert stored["epoch"] == -1 and stored["optimizer"] is None
    assert no_temp_files(wdir)


def test_final_eval_restores_strip_optimizer_after_error(tmp_path):
    module = fake_trainer_module()
    original = module.strip_optimizer

    def failing_final_eval():
        raise RuntimeError("validation failed")

    trainer = make_trainer(tmp_path, module, failing_final_eval)
    use_atomic_checkpoint_writes(trainer, module)
    with pytest.raises(RuntimeError):
        trainer.final_eval()
    assert module.strip_optimizer is original


def test_missing_strip_optimizer_fails_loudly(tmp_path):
    trainer = make_trainer(tmp_path, fake_trainer_module())
    with pytest.raises(RuntimeError):
        use_atomic_checkpoint_writes(trainer, types.SimpleNamespace())


def run_main_with_fake_runtime(monkeypatch, tmp_path, argv):
    from ai.training import train_yolo

    calls = {"callbacks": [], "train": []}

    class FakeYOLO:
        def __init__(self, weights):
            calls["weights"] = weights

        def add_callback(self, event, func):
            calls["callbacks"].append((event, func))

        def train(self, **kwargs):
            calls["train"].append(kwargs)
            weights = tmp_path / "checkpoints" / "run" / "weights"
            weights.mkdir(parents=True, exist_ok=True)
            (weights / "best.pt").write_bytes(b"best")

    fake_torch = types.ModuleType("torch")
    fake_torch.cuda = types.SimpleNamespace(is_available=lambda: True, get_device_name=lambda index: "fake gpu")
    fake_ultralytics = types.ModuleType("ultralytics")
    fake_ultralytics.YOLO = FakeYOLO
    monkeypatch.setitem(sys.modules, "torch", fake_torch)
    monkeypatch.setitem(sys.modules, "ultralytics", fake_ultralytics)
    monkeypatch.setattr(train_yolo, "run_dataset_gates", lambda root, baseline: ({"mode": "integrity", "passed": True, "overlap_counts": {}}, False))
    data = tmp_path / "data.yaml"
    data.write_text("nc: 4\n", encoding="utf-8")
    monkeypatch.setattr(sys, "argv", ["train_yolo", "--data", str(data), "--project", str(tmp_path / "checkpoints"), "--name", "run", *argv])
    train_yolo.main()
    return calls


def test_resume_registers_atomic_checkpoint_callback_and_resumes_from_last(monkeypatch, tmp_path):
    weights = tmp_path / "checkpoints" / "run" / "weights"
    weights.mkdir(parents=True)
    (weights / "last.pt").write_bytes(b"epoch20")
    calls = run_main_with_fake_runtime(monkeypatch, tmp_path, ["--resume"])
    assert calls["weights"] == str(weights / "last.pt")
    assert calls["train"] == [{"resume": True}]
    assert calls["callbacks"] == [("on_pretrain_routine_start", use_atomic_checkpoint_writes)]


def test_fresh_training_registers_atomic_checkpoint_callback(monkeypatch, tmp_path):
    calls = run_main_with_fake_runtime(monkeypatch, tmp_path, ["--model", "yolov8m.pt"])
    assert calls["callbacks"] == [("on_pretrain_routine_start", use_atomic_checkpoint_writes)]
    assert calls["train"][0]["optimizer"] == "AdamW"
    assert calls["train"][0]["batch"] == 8 and calls["train"][0]["imgsz"] == 640
