# -*- coding: utf-8 -*-
"""Find '+esc/+t inside template literal regions in _inline-check.js"""
from pathlib import Path

text = (Path(__file__).resolve().parent / "_inline-check.js").read_text(encoding="utf-8")
n = len(text)
i = 0
state = "code"
line = 1
col = 0
bugs = []

while i < n:
    c = text[i]
    if c == "\n":
        line += 1
        col = 0
        i += 1
        continue
    col += 1
    if state == "code":
        if c == "/" and i + 1 < n and text[i + 1] == "/":
            i += 2
            while i < n and text[i] != "\n":
                i += 1
            continue
        if c == "/" and i + 1 < n and text[i + 1] == "*":
            i += 2
            while i + 1 < n and not (text[i] == "*" and text[i + 1] == "/"):
                if text[i] == "\n":
                    line += 1
                i += 1
            i += 2
            continue
        if c == "'":
            state = "sq"
            i += 1
            continue
        if c == '"':
            state = "dq"
            i += 1
            continue
        if c == "`":
            state = "tpl"
            tpl_start = line
            i += 1
            continue
    elif state == "sq":
        if c == "\\":
            i += 2
            continue
        if c == "'":
            state = "code"
        i += 1
        continue
    elif state == "dq":
        if c == "\\":
            i += 2
            continue
        if c == '"':
            state = "code"
        i += 1
        continue
    elif state == "tpl":
        if c == "\\":
            i += 2
            continue
        if c == "$" and i + 1 < n and text[i + 1] == "{":
            state = "expr"
            i += 2
            continue
        if c == "'" and i + 1 < n and text[i + 1] == "+":
            snippet = text[i : i + 40].replace("\n", " ")
            bugs.append((line, snippet))
        if c == "`":
            state = "code"
        i += 1
        continue
    elif state == "expr":
        depth = 0
        # simplified: scan until matching } at depth 0 from expr entry
        pass
        i += 1
        continue

# Re-run with proper expr handling
i = 0
state = "code"
line = 1
expr_depth = 0
bugs = []

while i < n:
    c = text[i]
    if c == "\n":
        line += 1
        i += 1
        continue
    if state == "code":
        if c == "/" and i + 1 < n and text[i + 1] == "/":
            i += 2
            while i < n and text[i] != "\n":
                i += 1
            continue
        if c == "/" and i + 1 < n and text[i + 1] == "*":
            i += 2
            while i + 1 < n and not (text[i] == "*" and text[i + 1] == "/"):
                i += 1
            i += 2
            continue
        if c == "'":
            state = "sq"
            i += 1
            continue
        if c == '"':
            state = "dq"
            i += 1
            continue
        if c == "`":
            state = "tpl"
            i += 1
            continue
    elif state == "sq":
        if c == "\\":
            i += 2
            continue
        if c == "'":
            state = "code"
        i += 1
        continue
    elif state == "dq":
        if c == "\\":
            i += 2
            continue
        if c == '"':
            state = "code"
        i += 1
        continue
    elif state == "tpl":
        if c == "\\":
            i += 2
            continue
        if c == "$" and i + 1 < n and text[i + 1] == "{":
            state = "expr"
            expr_depth = 1
            i += 2
            continue
        if c == "'" and i + 1 < n and text[i + 1] == "+":
            bugs.append((line, text[max(0, i - 20) : i + 50].replace("\n", " ")))
        if c == "`":
            state = "code"
        i += 1
        continue
    elif state == "expr":
        if c == "\\":
            i += 2
            continue
        if c in "'\"":
            q = c
            i += 1
            while i < n:
                if text[i] == "\\":
                    i += 2
                    continue
                if text[i] == q:
                    i += 1
                    break
                if text[i] == "\n":
                    line += 1
                i += 1
            continue
        if c == "`":
            # nested template in expr - skip nested (rare)
            i += 1
            depth = 1
            while i < n and depth:
                if text[i] == "\\":
                    i += 2
                    continue
                if text[i] == "`":
                    depth += 1 if depth > 0 else 0
                    # wrong - use stack
                i += 1
            continue
        if c == "{":
            expr_depth += 1
        elif c == "}":
            expr_depth -= 1
            if expr_depth == 0:
                state = "tpl"
        i += 1
        continue

print("bugs in template literals (html line ~3767+bug_line):")
for ln, snip in bugs:
    print(f"  inline ~{3766 + ln}: {snip}")
