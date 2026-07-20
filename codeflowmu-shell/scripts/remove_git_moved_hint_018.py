# -*- coding: utf-8 -*-
"""TASK-20260611-018: Remove tc-git-moved-hint from team config."""
from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
PANEL = ROOT / "codeflowmu-desktop" / "panel" / "index.html"
INLINE_CHECK = ROOT / "codeflowmu-shell" / "scripts" / "_inline-check.js"

HINT_BLOCK = re.compile(
    r"\n\s*<!-- Git 备份已迁至 设置→Git 状态 -->\n"
    r"\s*<div class=\"tcc-card\" id=\"tc-git-moved-hint\">.*?"
    r"\s*</div>\n",
    re.DOTALL,
)

I18N_ZH = re.compile(
    r"\n\s*'team\.gitBackupMovedHint':[^\n]+\n",
)
I18N_EN = re.compile(
    r"\n\s*'team\.gitBackupMovedHint':[^\n]+\n",
)


def strip_file(path: Path) -> None:
    text = path.read_text(encoding="utf-8")
    original = text
    if path == PANEL:
        text = HINT_BLOCK.sub("\n", text, count=1)
    text = I18N_ZH.sub("\n", text)
    if text == original:
        print(f"no change: {path}")
        return
    path.write_text(text, encoding="utf-8")
    print(f"patched {path}")


def main() -> None:
    strip_file(PANEL)
    strip_file(INLINE_CHECK)


if __name__ == "__main__":
    main()
