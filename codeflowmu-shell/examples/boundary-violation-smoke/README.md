# boundary-violation-smoke — Boundary 强约束冒烟示例

## 目的

验证 v1.0-rc.1 阶段的 Boundary 强约束：
当 task 请求的动作违反 `boundary.cannot` 列表时，
触发 `BOUNDARY_VIOLATED`，并经 `NeedsHumanGate` 记录 review 文件。

## 前置条件

1. codeflowmu v1.0-rc.1 或以上（含 boundary schema + BoundaryViolationError）
2. codeflowmu 已启动

## 使用步骤

```powershell
# 启动 CodeFlowMu（v1.0-rc.1）
cd codeflowmu-shell
npm start

# 在另一个终端 drop 触发违规的 fixture
copy examples\boundary-violation-smoke\sample-task-violating-boundary.md "$env:USERPROFILE\.codeflowmu\v2\inbox\"
```

## 预期流程

1. `InboxWatcher` 发现新 task 文件
2. `TaskParser` 解析 YAML front-matter 与正文
3. `TaskDispatcher` 创建会话，agent 尝试 `boundary.actions` 中的禁止动作
4. `BoundaryValidator` 检测到违反 `boundary.cannot` 列表
5. 抛出 `BoundaryViolationError`（`BOUNDARY_VIOLATED`）
6. `NeedsHumanGate` 记录 `reason: BOUNDARY_VIOLATED` 并触发 review
7. `ReviewWriter` 写出含 `BOUNDARY_VIOLATED` 的 review 到 `<dataDir>/reviews/`
8. 若 relay 在线，relay 应收到 `boundary_violated` 事件

## 核心验收

- `<dataDir>/reviews/` 出现 `REVIEW-*.md`
- review 文件正文含 `BOUNDARY_VIOLATED`
- 进程不崩溃：Boundary 违规应被捕获，不应 unhandled exception

## 失败情形

| 现象 | 可能原因 |
|---|---|
| 进程崩溃 unhandled | BoundaryViolationError 未被 catch |
| review 不含 `BOUNDARY_VIOLATED` | ReviewWriter 未传递 reason |
| 任务仍被正常执行 | BoundaryValidator 未注入 Runtime |
| 治理循环跳过 boundary 检查 | TaskDispatcher 未调用 BoundaryValidator |
