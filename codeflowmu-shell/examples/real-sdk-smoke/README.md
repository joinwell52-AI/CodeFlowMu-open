# real-sdk-smoke — Cursor SDK 真实调用冒烟示例

## 目的

验证 v0.2.0-alpha 起可选的 Cursor SDK 真实调用路径：
配置 `CURSOR_API_KEY` 后，CodeFlowMu 使用真实 LLM adapter，
而非默认的 InMemorySdkAdapter（fake 模式）。

## 前置条件

1. codeflowmu 已构建（`npm start` 或 EXE）
2. 环境变量 `CURSOR_API_KEY` 已设置（ADMIN 提供的有效 key）
3. 网络可访问 Cursor API

## 使用步骤

```powershell
# 1. 设置 API key
$env:CURSOR_API_KEY = "<ADMIN 提供的有效 key>"

# 2. 启动 CodeFlowMu（启动 banner 应显示 adapter=cursor-sdk 而非 in-memory）
cd codeflowmu-shell
npm start

# 3. 在另一终端 drop 示例 fixture
copy examples\real-sdk-smoke\sample-task-with-cursor-sdk.md "$env:USERPROFILE\.codeflowmu\v2\inbox\"
```

## 预期现象

- stdout 中 VERDICT 解析为 `approve` / `reject` / `needs_human` 之一
- 若 verdict=needs_human：出现 `[NeedsHumanGate]` 日志 + review 文件落盘
- 若 verdict=approve：不应出现 `[NeedsHumanGate]` 拦截

## 失败情形

| 现象 | 可能原因 |
|---|---|
| 仍用 InMemorySdkAdapter | sdk-factory.ts 未读到 `CURSOR_API_KEY` |
| SDK 调用报错 | SDK 版本或网络问题，检查 stderr catch |
| 无 VERDICT 解析结果 | SessionManager 未等待 SDK 流结束 |
| 超过 30s 无响应 | Cursor API 限流或超时配置过短 |
