# -*- coding: utf-8 -*-
"""Unit checks for patrol tool arg normalization (run: python test_fcop_patrol_normalize.py)."""
from __future__ import annotations

import os
import sys

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, SCRIPT_DIR)

from fcop_invoke_once import normalize_patrol_tool_args  # noqa: E402


def test_strips_role_from_fcop_check() -> None:
    out = normalize_patrol_tool_args("fcop_check", {"role": "PM"})
    assert out == {}
    assert "role" not in out


def test_keeps_valid_lang() -> None:
    out = normalize_patrol_tool_args("fcop_report", {"lang": "zh", "role": "PM"})
    assert out == {"lang": "zh"}


def test_language_alias() -> None:
    out = normalize_patrol_tool_args("get_team_status", {"language": "en"})
    assert out == {"lang": "en"}


def test_ignores_invalid_lang() -> None:
    out = normalize_patrol_tool_args("fcop_check", {"lang": "fr", "scope": "auto"})
    assert out == {}


def test_non_patrol_tool_passthrough() -> None:
    args = {"recipient": "PM"}
    assert normalize_patrol_tool_args("list_tasks", args) is args


def main() -> None:
    test_strips_role_from_fcop_check()
    test_keeps_valid_lang()
    test_language_alias()
    test_ignores_invalid_lang()
    test_non_patrol_tool_passthrough()
    print("test_fcop_patrol_normalize: ok")


if __name__ == "__main__":
    main()
