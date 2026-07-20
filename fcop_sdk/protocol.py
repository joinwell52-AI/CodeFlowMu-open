from __future__ import annotations

import os
import re
from dataclasses import dataclass
from typing import Any, Dict, Mapping, Tuple

FRONTMATTER_RE = re.compile(r"^---\r?\n([\s\S]*?)\r?\n---")


class ProtocolError(RuntimeError):
    """Base error for protocol shape violations."""


class ProtocolViolation(RuntimeError):
    """Raised when runtime transition violates lifecycle contract."""


VALID_TRANSITIONS: Dict[str, list[str]] = {
    "inbox": ["active"],
    "active": ["review", "done"],
    "review": ["active", "done"],
    "done": ["archive"],
    "archive": ["history"],
    "history": [],
}

SYSCALL_TO_TARGET: Dict[str, str] = {
    "WRITE_TASK": "inbox",
    "CLAIM_TASK": "active",
    "SUBMIT_TASK": "review",
    "FINISH_TASK": "done",
    "APPROVE_TASK": "done",
    "REJECT_TASK": "active",
    "ARCHIVE_TASK": "archive",
    "ARCHIVE_TO_HISTORY": "history",
    "WRITE_REPORT": "done",
    "WRITE_ISSUE": "active",
    "WRITE_REVIEW": "review",
    "INFERENCE": "active",
    "SEARCH": "active",
    "MCP_TOOL": "active",
    "JOURNAL_APPEND": "active",
    "CLICK": "active",
    "TYPE": "active",
    "EDIT_CODE": "active",
}


def validate_transition(current: str, target: str) -> None:
    current_norm = (current or "").strip().lower()
    target_norm = (target or "").strip().lower()
    if not current_norm or not target_norm:
        raise ProtocolViolation(f"Invalid transition input: {current!r} -> {target!r}")
    if current_norm == target_norm:
        return
    allowed = VALID_TRANSITIONS.get(current_norm, [])
    if target_norm not in allowed:
        raise ProtocolViolation(
            f"Forbidden transition: {current_norm} -> {target_norm}; allowed={allowed}"
        )


def resolve_target_state(
    syscall: str, mapping: Mapping[str, str] | None = None
) -> str:
    lookup = mapping or SYSCALL_TO_TARGET
    syscall_norm = (syscall or "").strip().upper()
    target = lookup.get(syscall_norm)
    if not target:
        raise ProtocolError(f"Unknown syscall: {syscall}")
    return target


@dataclass(frozen=True)
class Snapshot:
    task_id: str
    state: str
    stage_path: str
    updated_at: str


def parse_frontmatter(content: str) -> Tuple[Dict[str, Any], str]:
    match = FRONTMATTER_RE.match(content)
    if not match:
        return {}, content
    yaml_str = match.group(1)
    body = content[match.end() :].lstrip()
    frontmatter: Dict[str, Any] = {}
    for line in yaml_str.splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        if ":" in line:
            k, v = line.split(":", 1)
            k = k.strip()
            v = v.strip()
            if (v.startswith('"') and v.endswith('"')) or (
                v.startswith("'") and v.endswith("'")
            ):
                v = v[1:-1]
            frontmatter[k] = v
    return frontmatter, body


def _yaml_scalar_value(value: Any) -> str:
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return str(value)
    text = str(value)
    if re.match(r"^[A-Za-z0-9_.:/@+-]+$", text):
        return text
    escaped = text.replace("\\", "\\\\").replace('"', '\\"')
    return f'"{escaped}"'


def serialize_frontmatter(frontmatter: Dict[str, Any], body: str) -> str:
    yaml_lines = ["---"]
    for k, v in frontmatter.items():
        if v is None or v == "":
            continue
        if isinstance(v, list):
            yaml_lines.append(f"{k}:")
            for item in v:
                yaml_lines.append(f"  - {_yaml_scalar_value(item)}")
        else:
            yaml_lines.append(f"{k}: {_yaml_scalar_value(v)}")
    yaml_lines.append("---")
    return "\n".join(yaml_lines) + "\n\n" + body


def read_fcop_file(filepath: str) -> Tuple[Dict[str, Any], str]:
    if not os.path.exists(filepath):
        raise FileNotFoundError(f"FCoP file not found: {filepath}")
    with open(filepath, "r", encoding="utf-8") as f:
        content = f.read()
    return parse_frontmatter(content)


def write_fcop_file(
    filepath: str,
    frontmatter: Dict[str, Any],
    body: str,
    *,
    skip_if_exists: bool = False,
) -> None:
    from fcop_sdk.atomic_write import atomic_write_text

    content = serialize_frontmatter(frontmatter, body)
    atomic_write_text(filepath, content, skip_if_exists=skip_if_exists)


def patch_frontmatter_field(filepath: str, key: str, value: Any) -> None:
    frontmatter, body = read_fcop_file(filepath)
    frontmatter[key] = value
    write_fcop_file(filepath, frontmatter, body)
