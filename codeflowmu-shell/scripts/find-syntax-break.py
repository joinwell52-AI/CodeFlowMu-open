# -*- coding: utf-8 -*-
"""Find approximate location of unclosed JS structure in extracted inline script."""
import re
from pathlib import Path

html = Path(__file__).resolve().parents[2] / "codeflowmu-desktop/panel/index.html"
lines = html.read_text(encoding="utf-8").splitlines()
body = "\n".join(lines[3766:18113])  # 1-based line 3767..18113

# Track template literal depth (only unescaped ` toggles when not in // or /* */ or ' " strings)
i = 0
n = len(body)
line = 1
col = 0
tpl_depth = 0
in_line_comment = False
in_block_comment = False
in_sq = False
in_dq = False
brace = 0
paren = 0
bracket = 0

def adv(ch):
    global line, col, i
    if ch == "\n":
        line += 1
        col = 0
    else:
        col += 1
    i += 1

stack_tpl_start = []  # (line, col, depth)

while i < n:
    ch = body[i]
    nxt = body[i + 1] if i + 1 < n else ""

    if in_line_comment:
        adv(ch)
        if ch == "\n":
            in_line_comment = False
        continue

    if in_block_comment:
        adv(ch)
        if ch == "*" and nxt == "/":
            adv(nxt)
            in_block_comment = False
        continue

    if in_sq:
        adv(ch)
        if ch == "\\":
            if i + 1 < n:
                adv(body[i + 1])
            continue
        if ch == "'":
            in_sq = False
        continue

    if in_dq:
        adv(ch)
        if ch == "\\":
            if i + 1 < n:
                adv(body[i + 1])
            continue
        if ch == '"':
            in_dq = False
        continue

    if tpl_depth > 0:
        if ch == "\\":
            adv(ch)
            if i < n:
                adv(body[i])
            continue
        if ch == "`":
            tpl_depth -= 1
            adv(ch)
            continue
        if ch == "$" and nxt == "{":
            # enter expression in template - count nested braces
            adv(ch)
            adv(nxt)
            expr_brace = 1
            while i < n and expr_brace > 0:
                c2 = body[i]
                if c2 == "`":
                    # nested template in expression
                    tpl_depth += 1
                    stack_tpl_start.append((line, col, tpl_depth))
                    adv(c2)
                    continue
                if c2 == "{":
                    expr_brace += 1
                elif c2 == "}":
                    expr_brace -= 1
                adv(c2)
            continue
        adv(ch)
        continue

    # normal code
    if ch == "/" and nxt == "/":
        in_line_comment = True
        adv(ch)
        adv(nxt)
        continue
    if ch == "/" and nxt == "*":
        in_block_comment = True
        adv(ch)
        adv(nxt)
        continue
    if ch == "'":
        in_sq = True
        adv(ch)
        continue
    if ch == '"':
        in_dq = True
        adv(ch)
        continue
    if ch == "`":
        tpl_depth += 1
        stack_tpl_start.append((line, col, tpl_depth))
        adv(ch)
        continue
    if ch == "{":
        brace += 1
    elif ch == "}":
        brace -= 1
    elif ch == "(":
        paren += 1
    elif ch == ")":
        paren -= 1
    elif ch == "[":
        bracket += 1
    elif ch == "]":
        bracket -= 1
    adv(ch)

html_line = 3767
print("END STATE:")
print("  tpl_depth:", tpl_depth)
print("  brace:", brace, "paren:", paren, "bracket:", bracket)
if stack_tpl_start:
    print("  unclosed template opens (last 8):")
    for item in stack_tpl_start[-8:]:
        ln, c, d = item
        print(f"    html~{html_line + ln - 1}:{c+1} depth={d}")
        snippet = lines[html_line + ln - 2] if 0 <= html_line + ln - 2 < len(lines) else ""
        print("      ", snippet[:120])
