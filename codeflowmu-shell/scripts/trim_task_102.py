# -*- coding: utf-8 -*-
import re
from datetime import datetime
from pathlib import Path

task_path = Path(r"D:\codeflowmu\fcop\_lifecycle\inbox\TASK-20260611-102-ADMIN-to-PM.md")
bak = task_path.with_suffix(task_path.suffix + ".bak-pm-trim")
source = bak if bak.exists() else task_path
raw = source.read_text(encoding="utf-8")

idx = raw.find("\n## ")
if idx < 0:
    raise SystemExit("body not found")
body = raw[idx + 1 :]

now = datetime.now().astimezone().strftime("%Y-%m-%dT%H:%M:%S%z")
now = now[:-2] + ":" + now[-2:]

fm = f"""---
protocol: fcop
version: "1.0"
sender: ADMIN
recipient: PM
priority: P2
thread_key: panel-task-102
subject: Panel/ledger 展示修复：A4 误报 + active 隐藏 noted_only + dispatch 振荡
references:
  - TASK-20260611-042
  - REPORT-20260611-090-DEV-to-PM
  - REPORT-20260611-091-PM-to-ADMIN
task_id: TASK-20260611-102
state: inbox
lifecycle_path: fcop/_lifecycle/inbox
transitions:
  - at: 2026-06-12T00:00:53+08:00
    from: null
    to: inbox
    by: ADMIN
    tool: create_task
  - at: {now}
    from: active
    to: inbox
    by: PM-01
    action: pm_trim_transitions
    reason: dedupe_rejected_busy_loop
    note: removed oscillation spam
---
"""

out = fm + body
task_path.write_text(out, encoding="utf-8", newline="\n")
print("written", task_path, "size", len(out), "restore", out.count("runtime_restore_failed_dispatch"))
