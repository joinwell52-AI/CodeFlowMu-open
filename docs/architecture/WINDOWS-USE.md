# Windows Use 开发设计

## 1. 目标

Windows Use 是 CodeFlowMu 面向 AI Agent 的 Windows 桌面应用控制能力。第一版仅支持 Windows，产品名固定为 **Windows Use**；内部通过 `ComputerUseProvider` 抽象隔离平台实现，为未来增加其他桌面后端保留扩展点。

当前 CodeFlowMu **实际可用的 Agent 入口只有 Cursor**。MVP 只把 Windows Use 作为 stdio MCP server 挂载到 Cursor SDK。能力总线保留未来接入其他 Agent 平台的适配点，但本版本不注册、不暴露也不测试 Google、Claude 或其他平台入口。

本能力不是单纯的 Skill。Skill 只描述使用方法，真正执行由本地 Windows Host 完成：

```text
Cursor Agent
    -> Windows Use tool declarations
    -> CodeFlowMu MCP capability bus
    -> policy and approval gate
    -> ComputerUseProvider
    -> Python Windows Host
    -> Win32 / UI Automation / screen capture
    -> target application
```

## 2. MVP 范围

MVP 提供以下工具：

| 工具 | 类型 | 说明 |
|---|---|---|
| `windows.capabilities` | 只读 | 检查运行平台和 Host 能力 |
| `windows.list_apps` | 只读 | 枚举当前活动桌面的顶层窗口 |
| `windows.screenshot` | 只读 | 截取指定可见窗口，返回 PNG |
| `windows.inspect_ui` | 只读 | 读取目标窗口的 UI Automation 控件树 |
| `windows.click` | 写操作 | 按窗口内相对坐标点击 |
| `windows.type_text` | 写操作 | 向前台目标窗口发送 Unicode 文本 |
| `windows.keypress` | 写操作 | 发送受限快捷键组合 |
| `windows.scroll` | 写操作 | 在窗口内滚动 |
| `windows.invoke_ui` | 写操作 | 通过 UIA selector 调用控件 |
| `windows.cancel` | 控制 | 取消当前 Windows Use 操作 |

不在 MVP 范围：后台无人值守桌面、UAC/管理员认证、绕过 MFA/CAPTCHA、终端自动化、ChatGPT/CodeFlowMu 自身自动化、录屏、远程桌面服务，以及无法解析独立 App User Model ID 的 `ApplicationFrameHost.exe` 托管窗口。后者在加入可靠 AUMID 绑定前默认阻止，避免一个宿主进程授权覆盖多个 UWP 应用。

## 3. Windows 连接层

Host 使用四类 Windows 能力：

1. Win32 窗口发现：`EnumWindows`、`HWND`、PID、可执行文件名、窗口矩形。
2. UI Automation：通过 `pywinauto` 的 UIA backend 读取控件树并调用标准控件。
3. 图像捕获：MVP 使用 Pillow `ImageGrab` 截取可见窗口；后续版本替换为 Windows Graphics Capture，以支持更稳定的窗口级捕获。
4. 输入：使用 Win32 `SendInput` 发送鼠标、滚轮、键盘和 Unicode 文本。

UIA 优先，视觉坐标作为降级路径。Host 只运行在当前用户的活动桌面，不提升权限。

参考：

- Microsoft UI Automation: https://learn.microsoft.com/windows/win32/winauto/uiauto-uiautomationoverview
- Windows Graphics Capture: https://learn.microsoft.com/windows/apps/develop/media-authoring-processing/screen-capture
- OpenAI Computer Use loop: https://developers.openai.com/api/docs/guides/tools-computer-use

## 4. 安全模型

Windows Use 默认拒绝访问未授权应用。`windows.list_apps` 和 `windows.capabilities` 可以在未授权时调用，其余工具必须提供 `app_id`，并且该应用必须出现在：

- `CODEFLOW_WINDOWS_USE_ALLOW_APPS` 环境变量；或
- 创建 `WindowsUseService` 时传入的 `alwaysAllowedAppIds`。

环境变量是逗号分隔的可执行文件名或应用标识，例如：

```text
CODEFLOW_WINDOWS_USE_ENABLED=1
CODEFLOW_WINDOWS_USE_ALLOW_APPS=notepad.exe,mspaint.exe
```

安全不变量：

- 模型不能调用工具给自己授权；授权来自 Host 配置或用户界面。
- `windows.list_apps` 对未授权应用隐藏窗口标题与可执行文件路径，只返回授权所需的应用标识和窗口标识。
- Host 校验 `window_id` 所属进程必须与已授权 `app_id` 一致，防止借用其他应用的授权控制敏感窗口。
- 每个动作写入审计日志，但文本输入只记录长度和 SHA-256，不记录原文。
- 禁止对 `cmd.exe`、`powershell.exe`、`pwsh.exe`、`wt.exe`、`windowsterminal.exe`、`codeflowmu` 和 ChatGPT 本身执行自动化。
- 每个 Host 调用有超时和输出大小限制。
- Windows 前台窗口可能被用户接管；调用方必须允许随时取消。
- 权限等级高于当前进程的窗口可能因 UIPI/UIA 边界而拒绝操作，这是预期行为。

## 5. 运行协议

Node 端通过 stdin 向 Python Host 发送单个 UTF-8 JSON 请求，Host 通过 stdout 返回单个 JSON 响应。这样避免命令行拼接、中文转义和 shell 注入。

Cursor 入口使用同一个 Host 的 `--mcp` 模式；Host 通过 stdio 提供 MCP `initialize`、`tools/list` 和 `tools/call`。未来其他 Agent 平台应在能力总线侧增加适配器，不能绕过同一策略与审计层直接调用 Win32。

请求示例：

```json
{
  "command": "click",
  "args": {
    "window_id": "0x000A073C",
    "x": 120,
    "y": 80,
    "button": "left"
  }
}
```

响应示例：

```json
{
  "ok": true,
  "result": {
    "window_id": "0x000A073C",
    "clicked": true
  }
}
```

## 6. 错误约定

| 代码 | 含义 |
|---|---|
| `WINDOWS_ONLY` | 当前不是 Windows |
| `APP_APPROVAL_REQUIRED` | 应用未授权 |
| `APP_BLOCKED` | 应用位于硬阻止列表 |
| `WINDOW_NOT_FOUND` | 窗口不存在或已关闭 |
| `WINDOW_NOT_VISIBLE` | 窗口不在活动可见桌面 |
| `WINDOW_APP_MISMATCH` | 窗口不属于声明的已授权应用 |
| `UIA_UNAVAILABLE` | 未安装 UIA 可选依赖 |
| `HOST_TIMEOUT` | 本地 Host 超时 |
| `HOST_PROTOCOL_ERROR` | Host 返回无效响应 |
| `CANCELLED` | 用户或调用方取消 |

## 7. 审计

默认审计位置遵循 CodeFlowMu 操作手册的运行时日志约定：

```text
fcop/logs/runtime/windows-use-YYYYMMDD.jsonl
```

每条记录包含：时间、工具、应用、窗口、结果、耗时、错误代码和参数摘要。截图像素与输入文本不写审计日志。

## 8. 依赖和部署

Node 运行时继续使用现有 TypeScript 架构。Python Host 的基础窗口枚举与输入只依赖标准库；截图依赖 Pillow；UIA 依赖 `pywinauto`。

```text
python -m pip install -r packages/codeflowmu-runtime/src/windows-use/host/requirements.txt
```

在未安装可选依赖时，`windows.capabilities` 会明确报告缺失能力，而不会伪造成功。

## 9. 验收标准

1. 非 Windows 平台返回 `WINDOWS_ONLY`。
2. 可以枚举当前可见顶层窗口。
3. 未授权应用的读取和写操作均被策略层拒绝。
4. 已授权应用可以截图、点击、输入、快捷键和滚动。
5. UIA 依赖可用时可以检查和调用标准控件。
6. 审计不包含文本输入原文。
7. 单元测试覆盖策略、桥接协议、路由和敏感字段脱敏。
8. Windows smoke test 至少验证 `capabilities` 与 `list_apps`。

## 10. Panel 产品配置

设置页的 **Windows Use** 卡片是默认配置入口：

- 开关与应用白名单按项目保存到 `.codeflowmu/runtime/windows-use.json`；
- Panel 通过 `/api/v2/windows-use/settings`、`health`、`apps` 三组接口读取设置、检查依赖并发现当前可见应用；
- 未授权应用只显示可执行文件标识，不显示窗口标题和完整路径；
- 终端、CodeFlowMu、ChatGPT/Codex 等硬阻止应用在界面中不可选择，后端仍会再次拒绝；
- `sdk-factory` 在每次 Cursor Agent 发送前读取当前项目设置，因此保存后下一次发送生效，无需重启 Shell；
- 环境变量继续作为部署覆盖项保留，但产品默认使用项目设置文件。

当前只向 Cursor 注册 MCP server。能力总线及 `ComputerUseProvider` 抽象保留未来宿主适配点，但不得由其他入口绕过同一策略和审计层直接调用 Windows Host。

Agent 行为规范位于 `skills/windows-use/SKILL.md`，并登记在 source-of-truth 与运行态两份 Agent Skill manifest。`SkillContextRouter` 在任务出现 Windows Use、Computer Use、Win32、UI Automation 或桌面应用等信号时按需加载该 Skill，不把完整 Skill 库塞入上下文。
