# -*- coding: utf-8 -*-
"""Scan _inline-check.js for unclosed template literals (rough lexer)."""
from pathlib import Path

s = Path(__file__).resolve().parent / "_inline-check.js"
text = s.read_text(encoding="utf-8")
n = len(text)
i = 0
state = "code"
stack = []
line = 1

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
            stack.append(("tpl", line))
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
            stack.append(("expr", line))
            state = "expr"
            i += 2
            continue
        if c == "`":
            stack.pop()
            state = "code"
        i += 1
        continue
    elif state == "expr":
        if c == "{":
            stack.append(("{", line))
            i += 1
            continue
        if c == "}":
            if stack and stack[-1][0] == "{":
                stack.pop()
            elif stack and stack[-1][0] == "expr":
                stack.pop()
                state = "tpl"
            i += 1
            continue
        if c == "'":
            state = "sq_e"
            i += 1
            continue
        if c == '"':
            state = "dq_e"
            i += 1
            continue
        if c == "`":
            stack.append(("tpl", line))
            state = "tpl"
            i += 1
            continue
        i += 1
        continue
    elif state == "sq_e":
        if c == "\\":
            i += 2
            continue
        if c == "'":
            state = "expr"
        i += 1
        continue
    elif state == "dq_e":
        if c == "\\":
            i += 2
            continue
        if c == '"':
            state = "expr"
        i += 1
        continue
    i += 1

print("end state:", state)
print("open stack (last 15):", stack[-15:])
