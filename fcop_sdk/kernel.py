from __future__ import annotations

import asyncio
import json
import os
import threading
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

from .protocol import ProtocolError, ProtocolViolation, resolve_target_state, validate_transition

REQUIRED_RUNTIME_PATHS = [
    "tasks",
    "reports",
    "issues",
    "ledger",
    "ledger/views",
    "_lifecycle/inbox",
    "_lifecycle/active",
    "_lifecycle/review",
    "_lifecycle/done",
    "_lifecycle/archive",
    "history",
    "shared",
    "alerts",
]

LIFECYCLE_SYSCALLS = {
    "WRITE_TASK",
    "CLAIM_TASK",
    "SUBMIT_TASK",
    "FINISH_TASK",
    "APPROVE_TASK",
    "REJECT_TASK",
    "ARCHIVE_TASK",
    "ARCHIVE_TO_HISTORY",
}
UI_SYSCALLS = {"CLICK", "TYPE", "EDIT_CODE"}
INFERENCE_SYSCALLS = {"INFERENCE", "SEARCH", "MCP_TOOL"}

MODE_ALLOWED_SYSCALLS = {
    "native": UI_SYSCALLS | {"JOURNAL_APPEND"},
    "gemini": INFERENCE_SYSCALLS | LIFECYCLE_SYSCALLS | {"WRITE_REPORT", "WRITE_ISSUE", "WRITE_REVIEW"},
    "mcp": INFERENCE_SYSCALLS | LIFECYCLE_SYSCALLS | {"WRITE_REPORT", "WRITE_ISSUE", "WRITE_REVIEW"},
}

_SINGLETON_LOCK = threading.Lock()
_ACTIVE_KERNELS: Dict[str, str] = {}


def verify_fcop_kernel_path(root: str | Path = "fcop") -> Path:
    root_path = Path(root).resolve()
    missing = [sub for sub in REQUIRED_RUNTIME_PATHS if not (root_path / sub).exists()]
    if missing:
        raise ProtocolError(
            f"FCoP runtime directories missing under {root_path}: {missing}"
        )
    return root_path


class MutationKernel:
    """Single mutation authority for dual-driver runtime."""

    def __init__(self, root: str | Path, mode: str = "mcp"):
        self.root = verify_fcop_kernel_path(root)
        self.mode = mode.strip().lower()
        if self.mode not in MODE_ALLOWED_SYSCALLS:
            raise ProtocolError(f"Unsupported kernel mode: {mode}")
        self.kernel_dir = self.root / "kernel"
        self.kernel_dir.mkdir(parents=True, exist_ok=True)
        self.journal_path = self.kernel_dir / "journal.jsonl"
        self._dispatch_lock = asyncio.Lock()
        self._closed = False
        self._acquire_singleton_lock()

    async def dispatch_async(
        self,
        task_id: str,
        syscall: str,
        payload: Dict[str, Any],
        *,
        driver_mode: str,
        caller: str,
    ) -> Dict[str, Any]:
        syscall_norm = syscall.strip().upper()
        driver_mode_norm = driver_mode.strip().lower()
        self._validate_runtime_request(
            task_id=task_id,
            syscall=syscall_norm,
            payload=payload,
            driver_mode=driver_mode_norm,
            caller=caller,
        )

        async with self._dispatch_lock:
            tx_id = f"tx-{uuid.uuid4().hex[:12]}"
            stage_before = self._resolve_task_stage(task_id) if task_id else None
            expected_stage = None

            if syscall_norm in LIFECYCLE_SYSCALLS and task_id:
                target = resolve_target_state(syscall_norm)
                expected_stage = target
                if stage_before and target != "inbox":
                    validate_transition(stage_before, target)

            entry = {
                "tx_id": tx_id,
                "at": datetime.now(timezone.utc).isoformat(),
                "task_id": task_id,
                "syscall": syscall_norm,
                "caller": caller,
                "driver_mode": driver_mode_norm,
                "kernel_mode": self.mode,
                "stage_before": stage_before,
                "expected_stage": expected_stage,
                "payload": payload,
                "status": "accepted",
            }
            await asyncio.to_thread(self._append_journal, entry)
            return entry

    async def record_result_async(
        self,
        tx_id: str,
        *,
        ok: bool,
        elapsed_ms: float,
        result: Dict[str, Any] | None = None,
        error: str | None = None,
    ) -> None:
        entry = {
            "tx_id": tx_id,
            "at": datetime.now(timezone.utc).isoformat(),
            "status": "done" if ok else "failed",
            "elapsed_ms": round(float(elapsed_ms), 2),
            "result": result or {},
            "error": error or "",
        }
        await asyncio.to_thread(self._append_journal, entry)

    def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        with _SINGLETON_LOCK:
            _ACTIVE_KERNELS.pop(str(self.root), None)

    def _validate_runtime_request(
        self,
        *,
        task_id: str,
        syscall: str,
        payload: Dict[str, Any],
        driver_mode: str,
        caller: str,
    ) -> None:
        if self._closed:
            raise ProtocolError("Kernel already closed")
        if not isinstance(payload, dict):
            raise ProtocolError("payload must be dict")
        if not syscall:
            raise ProtocolError("syscall is required")
        if driver_mode not in MODE_ALLOWED_SYSCALLS:
            raise ProtocolError(f"Unknown driver_mode: {driver_mode}")
        if syscall not in MODE_ALLOWED_SYSCALLS[driver_mode]:
            raise ProtocolViolation(
                f"syscall {syscall} is not allowed in driver_mode={driver_mode}"
            )
        if self.mode != "mcp" and self.mode != driver_mode:
            raise ProtocolViolation(
                f"Kernel mode {self.mode} cannot accept driver_mode {driver_mode}"
            )
        self._check_caller(syscall=syscall, driver_mode=driver_mode, caller=caller)
        if syscall in LIFECYCLE_SYSCALLS and not task_id:
            raise ProtocolError(f"{syscall} requires task_id")

    @staticmethod
    def _check_caller(syscall: str, driver_mode: str, caller: str) -> None:
        if driver_mode == "native" and caller.startswith("gemini"):
            raise ProtocolViolation("Model caller cannot execute native syscall")
        if driver_mode in {"gemini", "mcp"} and caller.startswith("cursor"):
            if syscall in {"INFERENCE", "MCP_TOOL"}:
                return
            raise ProtocolViolation("Cursor caller cannot execute lifecycle in gemini mode")

    def _resolve_task_stage(self, task_id: str) -> Optional[str]:
        lifecycle = self.root / "_lifecycle"
        for stage in ["inbox", "active", "review", "done", "archive"]:
            if list((lifecycle / stage).glob(f"{task_id}*.md")):
                return stage
        history_root = self.root / "history"
        if history_root.exists() and list(history_root.glob(f"**/{task_id}*.md")):
            return "history"
        return None

    def _append_journal(self, entry: Dict[str, Any]) -> None:
        line = json.dumps(entry, ensure_ascii=False)
        with open(self.journal_path, "a", encoding="utf-8") as f:
            f.write(line + "\n")
            f.flush()
            os.fsync(f.fileno())

    def _acquire_singleton_lock(self) -> None:
        key = str(self.root)
        with _SINGLETON_LOCK:
            owner = _ACTIVE_KERNELS.get(key)
            if owner and owner != self.mode:
                raise ProtocolError(
                    f"Kernel already active for {key} in mode={owner}; "
                    f"use mode='mcp' for shared dual-driver kernel."
                )
            _ACTIVE_KERNELS[key] = self.mode


def update_lease(project_dir: str, agent_id: str) -> None:
    leases_dir = Path(project_dir) / "fcop" / "kernel" / "leases"
    leases_dir.mkdir(parents=True, exist_ok=True)
    (leases_dir / f"{agent_id}.lease").write_text(str(int(time.time())), encoding="utf-8")


def read_lease(project_dir: str, agent_id: str) -> int:
    lease_path = Path(project_dir) / "fcop" / "kernel" / "leases" / f"{agent_id}.lease"
    if not lease_path.exists():
        return 0
    try:
        return int(lease_path.read_text(encoding="utf-8").strip())
    except Exception:
        return 0


def check_zombie_agents(project_dir: str, lease_timeout_seconds: int = 300) -> List[str]:
    leases_dir = Path(project_dir) / "fcop" / "kernel" / "leases"
    if not leases_dir.exists():
        return []
    now = int(time.time())
    zombies: List[str] = []
    for lease in leases_dir.glob("*.lease"):
        agent_id = lease.stem
        if now - read_lease(project_dir, agent_id) > lease_timeout_seconds:
            zombies.append(agent_id)
    return zombies


def write_journal(project_dir: str, action: str, details: Dict[str, Any]) -> None:
    kernel_dir = Path(project_dir) / "fcop" / "kernel"
    kernel_dir.mkdir(parents=True, exist_ok=True)
    journal_path = kernel_dir / "journal.jsonl"
    entry = {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "action": action,
        "details": details,
    }
    with open(journal_path, "a", encoding="utf-8") as f:
        f.write(json.dumps(entry, ensure_ascii=False) + "\n")


class FCoPStateEnforcer:
    """Compatibility bridge for legacy callers."""

    @staticmethod
    def validate_transition(from_state: Optional[str], to_state: str) -> bool:
        try:
            validate_transition((from_state or "inbox"), to_state)
            return True
        except ProtocolViolation:
            return False
