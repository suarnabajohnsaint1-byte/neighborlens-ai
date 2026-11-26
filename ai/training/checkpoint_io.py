from __future__ import annotations

import os
import time
from pathlib import Path

RETRY_DELAYS_SECONDS = (0.5, 1.0, 2.0, 4.0, 8.0, 16.0)


def temporary_path_for(target):
    target = Path(target)
    return target.with_name(f".{target.name}.{os.getpid()}.tmp")


def atomic_replace(target, write_temporary, delays=RETRY_DELAYS_SECONDS, sleep=time.sleep):
    target = Path(target)
    temporary = temporary_path_for(target)
    for attempt in range(len(delays) + 1):
        try:
            result = write_temporary(temporary)
            os.replace(temporary, target)
            return result
        except OSError:
            if attempt == len(delays):
                try:
                    os.remove(temporary)
                except OSError:
                    pass
                raise
            sleep(delays[attempt])


def write_synced(path, data):
    with open(path, "wb") as handle:
        handle.write(data)
        handle.flush()
        os.fsync(handle.fileno())
    return len(data)


def atomic_write_bytes(target, data, delays=RETRY_DELAYS_SECONDS, sleep=time.sleep):
    return atomic_replace(target, lambda temporary: write_synced(temporary, data), delays, sleep)


class AtomicCheckpointPath(type(Path())):
    def write_bytes(self, data):
        return atomic_write_bytes(self, data)


def make_atomic_strip_optimizer(strip_optimizer, delays=RETRY_DELAYS_SECONDS, sleep=time.sleep):
    def atomic_strip_optimizer(f="best.pt", s="", updates=None):
        target = Path(s or f)
        return atomic_replace(
            target,
            lambda temporary: strip_optimizer(f, s=str(temporary), updates=updates),
            delays,
            sleep,
        )

    return atomic_strip_optimizer


def protect_final_eval(trainer, trainer_module):
    original_strip = getattr(trainer_module, "strip_optimizer", None)
    if original_strip is None:
        raise RuntimeError("Ultralytics trainer module has no strip_optimizer; checkpoint finalization cannot be protected.")
    original_final_eval = trainer.final_eval
    atomic_strip = make_atomic_strip_optimizer(original_strip)

    def final_eval():
        trainer_module.strip_optimizer = atomic_strip
        try:
            return original_final_eval()
        finally:
            trainer_module.strip_optimizer = original_strip

    trainer.final_eval = final_eval


def use_atomic_checkpoint_writes(trainer, trainer_module=None):
    trainer.wdir = AtomicCheckpointPath(trainer.wdir)
    trainer.last = AtomicCheckpointPath(trainer.last)
    trainer.best = AtomicCheckpointPath(trainer.best)
    if trainer_module is None:
        from ultralytics.engine import trainer as trainer_module
    protect_final_eval(trainer, trainer_module)
