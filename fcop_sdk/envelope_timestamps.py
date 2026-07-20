# -*- coding: utf-8 -*-
"""Post-write stamp for TASK/REPORT frontmatter — local offset + timezone."""
from __future__ import annotations

import json
import os
import re
from datetime import datetime
from typing import Any

from .local_iso import get_local_timezone, to_local_iso_string, to_utc_iso_string
from .protocol import read_fcop_file, write_fcop_file

_OFFSET_ISO_RE = re.compile(
    r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:[+-]\d{2}:\d{2}|Z)$"
)


def _has_explicit_offset(value: str) -> bool:
    return bool(_OFFSET_ISO_RE.match((value or "").strip().strip('"')))


def _quote_iso(value: str) -> str:
    """YAML-safe quoted ISO string."""
    return json.dumps(str(value), ensure_ascii=False)


def _format_yaml_value(key: str, value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, bool):
        return "true" if value else "false"
    s = str(value).strip()
    if key in ("created_at", "updated_at", "created_at_utc") or "T" in s:
        if not (s.startswith('"') and s.endswith('"')):
            return _quote_iso(s.strip('"'))
    if any(c in s for c in ":[]{}#&*!|>'\"\\") and not (s.startswith('"') and s.endswith('"')):
        return _quote_iso(s)
    return s


def _write_frontmatter(filepath: str, frontmatter: dict, body: str) -> None:
    from fcop_sdk.atomic_write import atomic_write_text

    yaml_lines = ["---"]
    for k, v in frontmatter.items():
        yaml_lines.append(f"{k}: {_format_yaml_value(k, v)}")
    yaml_lines.append("---")
    content = "\n".join(yaml_lines) + "\n\n" + body
    atomic_write_text(filepath, content, skip_if_exists=False)


def stamp_envelope_timestamps(filepath: str) -> None:
    """Normalize user-visible timestamps on a freshly written TASK/REPORT file."""
    if not os.path.isfile(filepath):
        return
    frontmatter, body = read_fcop_file(filepath)
    now = datetime.now().astimezone()
    local = to_local_iso_string(now)
    utc = to_utc_iso_string(now)
    tz = get_local_timezone()

    existing_created = str(frontmatter.get("created_at") or "").strip().strip('"')
    if existing_created and _has_explicit_offset(existing_created) and not existing_created.endswith("Z"):
        created = existing_created
    else:
        created = local

    frontmatter["created_at"] = created
    frontmatter["updated_at"] = local
    frontmatter["timezone"] = tz
    frontmatter["created_at_utc"] = utc
    _write_frontmatter(filepath, frontmatter, body)
