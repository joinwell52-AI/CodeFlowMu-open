# -*- coding: utf-8 -*-
"""Rough JS brace/backtick depth scan for _inline-check.js"""
import re
from pathlib import Path

path = Path(__file__).resolve().parent / "_inline-check.js"
text = path.read_text(encoding="utf-8")
lines = text.splitlines()

brace = 0
paren = 0
brack = 0
tpl = 0  # template literal depth
in_line_comment = False
in_block_comment = False
in_str = None  # ' or "
i = 0
n = len(text)
last_tpl_open = None

while i < n:
    c = text[i]
    nxt = text[i + 1] if i + 1 < n else ""

    if in_block_comment:
        if c == "*" and nxt == "/":
            in_block_comment = False
            i += 2
            continue
        i += 1
        continue

    if in_line_comment:
        if c == "\n":
            in_line_comment = False
        i += 1
        continue

    if in_str:
        if c == "\\":
            i += 2
            continue
        if c == in_str:
            in_str = None
        i += 1
        continue

    if tpl > 0:
        if c == "\\":
            i += 2
            continue
        if c == "$" and nxt == "{":
            brace += 1
            i += 2
            continue
        if c == "`":
            tpl -= 1
            i += 1
            continue
        i += 1
        continue

    if c == "/" and nxt == "/":
        in_line_comment = True
        i += 2
        continue
    if c == "/" and nxt == "*":
        in_block_comment = True
        i += 2
        continue
    if c in "'\"":
        in_str = c
        i += 1
        continue
    if c == "`":
        tpl += 1
        last_tpl_open = text.count("\n", 0, i) + 1
        i += 1
        continue
    if c == "{":
        brace += 1
    elif c == "}":
        brace -= 1
    elif c == "(":
        paren += 1
    elif c == ")":
        paren -= 1
    elif c == "[":
        brack += 1
    elif c == "]":
        brack -= 1
    i += 1

line_no = len(lines)
print("EOF state: brace=%d paren=%d brack=%d tpl=%d in_str=%s" % (brace, paren, brack, tpl, in_str))
if tpl > 0:
    print("unclosed template opened near line", last_tpl_open)
if brace != 0:
    print("unclosed braces:", brace)

# find last line that opens template without closing before EOF
tpl = 0
last_open = None
for lineno, line in enumerate(lines, 1):
    i = 0
    while i < len(line):
        c = line[i]
        if tpl > 0:
            if c == "`" and (i == 0 or line[i - 1] != "\\"):
                tpl -= 1
            elif c == "$" and i + 1 < len(line) and line[i + 1] == "{":
                pass
            i += 1
            continue
        if c == "`":
            tpl += 1
            last_open = lineno
        i += 1

if tpl > 0 and last_open:
    print("simple scan: unclosed backtick from line", last_open)
