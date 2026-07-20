# -*- coding: utf-8 -*-
"""Find line where inline panel script breaks (UTF-8 safe)."""
import subprocess
import sys

path = r"d:\codeflowmu\codeflowmu-desktop\panel\index.html"
with open(path, "r", encoding="utf-8") as f:
    lines = f.readlines()

start, end = 3765, 18235  # 0-based: content after <script> through before </script>
block = lines[start:end]

def check(snippet: str) -> tuple[bool, str]:
    r = subprocess.run(
        ["node", "-e", snippet],
        capture_output=True,
        text=True,
        encoding="utf-8",
    )
    ok = r.returncode == 0
    msg = (r.stderr or r.stdout or "").strip().split("\n")[-1]
    return ok, msg

full = "".join(block)
wrapped = "const LANGS = " + full.split("const LANGS", 1)[1] if "const LANGS" in full else full
# Actually full block is entire script
ok, msg = check(
    "const vm=require('vm');const fs=require('fs');"
    "const code=fs.readFileSync(process.argv[1],'utf8');"
    "try{new vm.Script(code);console.log('OK');}"
    "catch(e){console.error(e.message);process.exit(1);}"
    + " ",
    # pass via temp file
)
# use temp file
tmp = r"d:\codeflowmu\codeflowmu-shell\scripts\_inline-check.js"
with open(tmp, "w", encoding="utf-8") as f:
    f.write("".join(block))

ok, msg = check(
    "const vm=require('vm');const fs=require('fs');"
    "const code=fs.readFileSync(r'" + tmp.replace("\\", "\\\\") + "','utf8');"
    "try{new vm.Script(code);console.log('OK');}catch(e){console.error(e.message);process.exit(1);}"
)
print("full block:", "OK" if ok else msg)

# binary search by line
lo, hi = 0, len(block)
first_bad = None
while lo < hi:
    mid = (lo + hi) // 2
    snippet = "".join(block[: mid + 1])
    with open(tmp, "w", encoding="utf-8") as f:
        f.write(snippet)
    ok, msg = check(
        "const vm=require('vm');const fs=require('fs');"
        "const code=fs.readFileSync(r'" + tmp.replace("\\", "\\\\") + "','utf8');"
        "try{new vm.Script(code);}catch(e){process.exit(1);}"
    )
    if ok:
        lo = mid + 1
    else:
        hi = mid
        if "Unexpected identifier" in msg or "Unexpected token" in msg:
            first_bad = mid

if first_bad is not None:
    ln = start + 1 + first_bad
    print("first line that breaks parse when truncated:", ln)
    print("content:", block[first_bad].rstrip()[:120])
else:
    print("truncation search did not isolate; error may need full context")
