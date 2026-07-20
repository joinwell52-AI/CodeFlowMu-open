"""Atomic text writes with unique tmp paths and per-target locking."""

from __future__ import annotations

import os
import random
import threading
import time
from typing import Dict, Literal

WriteOutcome = Literal["written", "noop"]

_locks_guard = threading.Lock()
_path_locks: Dict[str, threading.Lock] = {}


def _path_lock(filepath: str) -> threading.Lock:
    key = os.path.normpath(filepath)
    with _locks_guard:
        lock = _path_locks.get(key)
        if lock is None:
            lock = threading.Lock()
            _path_locks[key] = lock
        return lock


def build_unique_tmp_path(target_path: str) -> str:
    """REPORT-xxx.md.<pid>.<timestamp_ms>.<random_hex>.tmp"""
    directory = os.path.dirname(target_path) or "."
    base = os.path.basename(target_path)
    stamp = int(time.time() * 1000)
    rand = f"{random.randint(0, 0xFFFFFFFF):08x}"
    return os.path.join(directory, f"{base}.{os.getpid()}.{stamp}.{rand}.tmp")


def _is_stale_tmp_for_target(name: str, report_basename: str) -> bool:
    if name == f"{report_basename}.tmp":
        return True
    prefix = f"{report_basename}."
    if not name.startswith(prefix) or not name.endswith(".tmp"):
        return False
    suffix = name[len(prefix) : -4]
    parts = suffix.split(".")
    if len(parts) != 3:
        return False
    pid, stamp, rand = parts
    return pid.isdigit() and stamp.isdigit() and len(rand) >= 1


def cleanup_stale_tmps_for_target(target_path: str) -> None:
    directory = os.path.dirname(target_path) or "."
    base = os.path.basename(target_path)
    try:
        names = os.listdir(directory)
    except OSError:
        return
    for name in names:
        if not _is_stale_tmp_for_target(name, base):
            continue
        try:
            os.unlink(os.path.join(directory, name))
        except OSError:
            pass


def atomic_write_text(
    filepath: str,
    content: str,
    *,
    skip_if_exists: bool = False,
    encoding: str = "utf-8",
) -> WriteOutcome:
    """Write via unique tmp, fsync, atomic replace; optional no-op if target exists."""
    parent = os.path.dirname(filepath)
    if parent:
        os.makedirs(parent, exist_ok=True)

    lock = _path_lock(filepath)
    with lock:
        if skip_if_exists and os.path.isfile(filepath):
            return "noop"

        tmp_path = build_unique_tmp_path(filepath)
        try:
            with open(tmp_path, "w", encoding=encoding) as handle:
                handle.write(content)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(tmp_path, filepath)
        except Exception:
            try:
                if os.path.isfile(tmp_path):
                    os.unlink(tmp_path)
            except OSError:
                pass
            raise

        cleanup_stale_tmps_for_target(filepath)
        return "written"
