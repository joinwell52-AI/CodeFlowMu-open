#!/usr/bin/env python3
"""Sync _renderSmokeSection from _panel-inline.js into _inline-check.js and index.html."""
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
INLINE = ROOT / "codeflowmu-shell" / "scripts" / "_panel-inline.js"
TARGETS = [
    ROOT / "codeflowmu-shell" / "scripts" / "_inline-check.js",
    ROOT / "codeflowmu-desktop" / "panel" / "index.html",
]

START = "/** Render Smoke / system test section tbody"
END = "/** Render just the ADMIN→PM section tbody. */"


def extract_block(src: str) -> str:
    i = src.index(START)
    j = src.index(END, i)
    return src[i:j]


def patch_file(path: Path, block: str) -> None:
    text = path.read_text(encoding="utf-8")
    if "function _renderSmokeSection" in text:
        i = text.index(START)
        j = text.index(END, i)
        text = text[:i] + block + text[j:]
    else:
        if END not in text:
            raise SystemExit(f"anchor not found: {path}")
        text = text.replace(END, block + END, 1)
    path.write_text(text, encoding="utf-8")
    print("patched", path)


def main() -> None:
    block = extract_block(INLINE.read_text(encoding="utf-8"))
    for p in TARGETS:
        patch_file(p, block)


if __name__ == "__main__":
    main()
