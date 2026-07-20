# codeflowmu v1.0 — Hello World v2 Demo

5 分钟可跑通的 **PWA 发任务 → PC 收任务 → Agent 执行 → Review → DONE** 全链路演示。

---

## 前置条件

1. **Node.js 22+** 已安装
2. **Python 3.10+** 且已安装 `fcop` 1.5.1（可选，用于 fcop 侧联调）

   ```bash
   pip install fcop==1.5.1
   ```

3. **Cursor API Key**（可选）：未设置时使用 InMemory 假 adapter

---

## 启动 codeflowmu Shell

```bash
# 在 CodeFlowMu 仓库根目录
cd codeflowmu-shell
npm install
npm start
```

启动成功后应看到类似 banner：

```
===========================================================
  codeflowmu-shell v1.0.0-rc.1
  panel: http://127.0.0.1:18765
  adapter: cursor-sdk | in-memory
===========================================================
```

---

## 浏览 API v2 面板

浏览器打开 `http://127.0.0.1:18765`，常用接口：

| 路径 | 说明 |
|---|---|
| `GET /api/v2/agents` | 列出已注册 agent |
| `GET /api/v2/tasks?limit=20` | 最近 20 条任务 |
| `GET /api/v2/reviews?limit=20` | 最近 20 条 review |
| `GET /api/v2/sessions/current` | 当前 session 数量 + PID |
| `POST /api/v2/config/reload` | 热重载（v1.0 stub） |

---

## 运行 Hello World Demo

### 方式 1：本地 copy 任务文件

```bash
# Windows
copy examples\hello-world-v2\sample-task.md %USERPROFILE%\.codeflowmu\v2\inbox\TASK-DEMO-001-PM-to-DEV.md

# macOS / Linux
cp examples/hello-world-v2/sample-task.md ~/.codeflowmu/v2/inbox/TASK-DEMO-001-PM-to-DEV.md
```

### 方式 2：经 PWA 发任务

1. 打开 PWA：https://joinwell52-ai.github.io/codeflowmu-pwa/
2. 在 `CODEFLOW_CONFIG` 中配置 `roomKey` 等
3. 发送新任务

---

## 预期现象

1. 任务文件出现在 inbox，shell 日志显示 dispatch
2. 访问 `http://127.0.0.1:18765/api/v2/tasks` 可见 TASK-DEMO-001 状态变化
3. Agent 完成后，`http://127.0.0.1:18765/api/v2/reviews` 出现 review 文件
4. PC 面板与 PWA 最终显示 DONE 状态

详细时序见 [expected-flow.md](./expected-flow.md)。

---

## 禁用 Web Panel（纯 CLI）

```bash
npm start -- --no-panel
# 或
CODEFLOW_NO_PANEL=1 npm start
```

---

## 常见问题

**Q: 端口 18765 被占用怎么办？**
A: Shell 启动时会尝试绑定 panel 端口；可换端口或加 `--no-panel` 跳过面板。

**Q: 没有 Cursor API Key 能跑吗？**
A: 可以。未设置 `CODEFLOW_CURSOR_API_KEY` 时 shell 自动回退 InMemorySdkAdapter，治理循环仍可演示。

**Q: PWA 连不上 localhost？**
A: `web/pwa/config.js` 里 `apiV2BaseUrl` 需指向 `http://localhost:18765/api/v2`；v1.0-rc.1 默认已配置。
