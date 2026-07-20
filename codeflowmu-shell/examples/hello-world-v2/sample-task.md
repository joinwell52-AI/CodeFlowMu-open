---
protocol: fcop
version: 1
kind: task
task_id: TASK-DEMO-001
sender: PM
recipient: DEV
priority: P2
thread_key: hello-world-v2-demo
status: active
created_at: 2026-05-13T08:00:00+08:00
---

# TASK-DEMO-001：Hello World v2 — FizzBuzz

## §0 背景

请实现经典 FizzBuzz：对 1-30 的整数，3 的倍数输出 "Fizz"，5 的倍数输出 "Buzz"，同时整除 3 和 5 输出 "FizzBuzz"，否则输出数字本身。

## §1 交付物

1. 写回执文件 `REPORT-DEMO-001-DEV-to-PM.md`
2. 附 Python 3.10+ 可运行脚本（或等价实现）
3. 打印 1-30 的完整输出

## §2 验收标准（前 15 项）

```
1, 2, Fizz, 4, Buzz, Fizz, 7, 8, Fizz, Buzz, 11, Fizz, 13, 14, FizzBuzz
```

## §3 备注

本任务用于 codeflowmu v1.0 端到端演示：
PWA 发任务 → PC 本地 inbox → DEV agent 执行 → Review 落盘 → PC+PWA 显示 DONE。
