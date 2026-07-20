"""Read 8 fcop schemas + 5 codeflow schemas, dump headline summary for §3 mapping table.

Run: py -3 inspect-fcop-schemas.py
"""
from __future__ import annotations
import json
from pathlib import Path

FCOP_DIR = Path("D:/FCoP/src/fcop/_data/schemas")
CF_DIR = Path("D:/Bridgeflow/packages/codeflow-protocol/schemas")


def summarize(label: str, p: Path) -> None:
    d = json.loads(p.read_text(encoding="utf-8"))
    title = d.get("title", "-")
    desc = d.get("description", "-")
    desc_short = (desc[:140] + "...") if len(desc) > 140 else desc
    req = d.get("required", [])
    props = list(d.get("properties", {}).keys())
    print(f"--- {label} ({p.name}) ---")
    print(f"  title:       {title}")
    print(f"  description: {desc_short}")
    print(f"  required:    {req}")
    print(f"  properties:  {props}")
    print()


print("================ fcop@1.1.0 (8 schemas) ================")
for name in ["agent", "boundary", "encoding", "event", "failure", "ipc-envelope", "review", "skill"]:
    summarize(f"fcop:{name}", FCOP_DIR / f"{name}.schema.json")

print("================ CodeFlowMu v0.1 (5 schemas) ================")
for name in ["agent", "task", "review", "session", "skill"]:
    summarize(f"cf:{name}", CF_DIR / f"{name}.schema.json")
