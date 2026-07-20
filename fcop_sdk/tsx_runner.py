"""Run codeflowmu-runtime TS CLIs via local tsx (Windows-safe)."""

from __future__ import annotations

import subprocess
from pathlib import Path


def runtime_package_dir() -> Path:
    root = Path(__file__).resolve().parents[1]
    return root / "packages" / "codeflowmu-runtime"


def run_ts_cli(script_name: str, project_root: str, *args: str) -> str:
    """Execute scripts/<script_name> with node --import tsx; cwd = runtime package."""
    pkg = runtime_package_dir()
    script = pkg / "scripts" / script_name
    if not script.is_file():
        raise FileNotFoundError(f"TS CLI not found: {script}")
    cmd = ["node", "--import", "tsx", str(script), *args]
    proc = subprocess.run(
        cmd,
        cwd=str(pkg),
        capture_output=True,
        text=True,
        encoding="utf-8",
        timeout=120,
    )
    if proc.returncode != 0:
        err = (proc.stderr or proc.stdout or "").strip()
        raise RuntimeError(err or f"TS CLI exit {proc.returncode}")
    return (proc.stdout or "").strip()
