"""One-off helper: sync fcop/logs/README.md from logs-paths.ts ROOT_README (UTF-8 safe on Windows)."""
from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SRC = ROOT / "codeflowmu-shell" / "src" / "logs-paths.ts"
OUT = ROOT / "fcop" / "logs" / "README.md"

text = SRC.read_text(encoding="utf-8")
marker = "export const ROOT_README = `"
start = text.find(marker)
if start < 0:
    raise SystemExit("ROOT_README block not found in logs-paths.ts")
start += len(marker)
end = text.find("`;\n\n/** 自然日键", start)
if end < 0:
    raise SystemExit("ROOT_README closing backtick not found")
inner = text[start:end]
inner = inner.replace("${ROOT_README_VERSION}", "collab-assets-v1")
# TS source escapes backticks as \` — restore for Markdown
inner = inner.replace("\\`", "`")

OUT.parent.mkdir(parents=True, exist_ok=True)
OUT.write_text(inner, encoding="utf-8")
print(f"wrote {OUT} ({OUT.stat().st_size} bytes)")
