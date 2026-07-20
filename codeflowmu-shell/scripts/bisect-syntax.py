# -*- coding: utf-8 -*-
"""Binary-search which half of inline script first breaks esbuild parse."""
import subprocess
from pathlib import Path

root = Path(__file__).resolve().parents[2]
html = root / "codeflowmu-desktop/panel/index.html"
lines = html.read_text(encoding="utf-8").splitlines()
body_lines = lines[3766:18113]
n = len(body_lines)
def try_parse(slice_end: int) -> bool:
    chunk = body_lines[:slice_end]
    text = "\n".join(chunk) + "\n/*__REST__*/\n"
    tmp = Path(__file__).resolve().parent / "_bisect-tmp.js"
    tmp.write_text(text, encoding="utf-8")
    r = subprocess.run(
        ["npx", "esbuild", str(tmp)],
        capture_output=True,
        text=True,
        cwd=str(root / "codeflowmu-shell"),
        shell=True,
    )
    return r.returncode == 0


lo, hi = 100, n
# find smallest prefix that still fails (error in prefix)
while lo < hi:
    mid = (lo + hi) // 2
    if try_parse(mid):
        lo = mid + 1  # prefix OK -> error after mid
    else:
        hi = mid  # prefix bad -> error at or before mid

print("first bad line index in slice (0-based):", hi)
print("html line ~", 3767 + hi)
if hi < n:
    for j in range(max(0, hi - 3), min(n, hi + 3)):
        print(f"  {3767+j}: {body_lines[j][:100]}")
