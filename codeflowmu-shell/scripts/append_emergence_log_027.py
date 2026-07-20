# -*- coding: utf-8 -*-
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
LOG = ROOT / "fcop" / "internal" / "emergence-log.md"

ENTRY = """
## 2026-06-12 · controlled_emergence · Panel probe 污染修复 (TASK-027)

### 摘要
EVAL GAP-011 晋升后，DEV 在 Panel/ledger 视图层默认隐藏 MCP-PROBE 自举任务（thread_key=mcp-tool-probe 等标记），并修复 detectViewsStale 与 PM todo 投影对齐。

### 关联对象（污染列表）
- TASK-20260612-013, 014, 023, 024, 025（视图过滤；磁盘 lifecycle 保留）

### 处理动作
- `probeBootstrapTask.ts` + Panel `isProbeBootstrapTask` 过滤
- `LedgerBuilder.#roleTodoTasks` 统一 todo 投影；detectViewsStale 含 PM
- 未手工 mv `_lifecycle/`
"""

def main() -> None:
    text = LOG.read_text(encoding="utf-8")
    if "TASK-027" in text and "Panel probe 污染修复" in text:
        print("already appended")
        return
    LOG.write_text(text.rstrip() + "\n" + ENTRY, encoding="utf-8")
    print("appended")

if __name__ == "__main__":
    main()
