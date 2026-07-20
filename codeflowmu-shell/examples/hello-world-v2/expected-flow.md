# Hello World v2 — 端到端时序与验收清单

## 前置检查

| 项 | 要求 |
|---|---|
| `codeflowmu-shell` 已启动 | `npm start`，port 18765 ready |
| PC 面板 | `http://127.0.0.1:18765` 可正常打开 |
| PWA | `https://joinwell52-ai.github.io/codeflowmu-pwa/` 可访问 |
| Cursor SDK | `CODEFLOW_CURSOR_API_KEY` 可选 |
| fcop Python | `PYTHON_BIN` 指向已装 fcop 1.5.1 的解释器（可选） |

---

## 时序步骤

### T+0s — 用户经 PWA 发任务

1. 打开 PWA，填写任务表单
2. 提交类似 JSON（字段示意）：

   ```json
   {
     "sender": "PM",
     "recipient": "DEV",
     "priority": "P2",
     "body": "实现 FizzBuzz (1-30) 并写回执"
   }
   ```

3. PWA 经 WebSocket relay（`wss://...`）发送 `new_task` 事件
4. PC 端 `codeflowmu-shell` 收到 relay → 落盘
   `~/.codeflowmu/v2/inbox/TASK-DEMO-001-PM-to-DEV.md`

### T+2s — PC 面板刷新

5. PC 浏览器 `GET http://127.0.0.1:18765/api/v2/tasks` 刷新
6. 列表出现 TASK-DEMO-001，状态为 `active` 或 `inbox`

### T+5s — DEV Agent 开始执行

7. `InboxWatcher` 发现新文件 → `TaskDispatcher.dispatch()`
8. Cursor SDK Agent（或 InMemory）开始会话

### T+30s — Agent 完成并进入 Review

9. Agent 完成 FizzBuzz 相关交付
10. `ReviewEngine` 触发 → `ReviewWriter.writeReview()`
11. 落盘：`~/.codeflowmu/v2/reviews/REVIEW-DEMO-001-...md`

### T+32s — PC 面板 + PWA 显示 DONE

12. `GET /api/v2/reviews` 返回新 review
13. `GET /api/v2/tasks` 中 task status 更新
14. PC 面板与 PWA 任务卡片显示 DONE 状态 ✓

---

## 验收清单

| 检查项 | 通过 |
|---|---|
| `/api/v2/tasks` 含 TASK-DEMO-001 | ✓ |
| `/api/v2/reviews` 含 REVIEW-DEMO-001 | ✓ |
| `/api/v2/sessions/current` active_count 曾 ≥ 1 | 执行期间应短暂 >0 |
| PWA 任务状态 = DONE | ✓ |
| PC 端 dashboard 状态 = DONE | ✓ |

---

## 截图参考

`examples/hello-world-v2/screenshots/` 目录可存放演示截图：

- `01-pwa-send-task.png` — PWA 发任务界面
- `02-pc-panel-inbox.png` — PC 面板 inbox 视图
- `03-pc-panel-done.png` — PC 面板 DONE 状态
- `04-pwa-done.png` — PWA DONE 状态
