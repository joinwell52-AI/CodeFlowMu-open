# Windows Use 用户与操作手册

> 适用范围：CodeFlowMu Windows Use V1，Windows 桌面，Cursor Agent 入口。

## 目录

1. Windows Use 是什么
2. 当前支持与不支持
3. 启用前准备
4. 总开关与应用白名单
5. 第一次使用
6. 如何给 AI 下命令
7. 常见使用场景
8. 浏览器与企业 Web 应用
9. 桌面、资源管理器与桌面图标
10. Agent 范围与生效时机
11. 工具能力说明
12. 用户确认与高风险操作
13. 撤销、停止与紧急接管
14. 隐私、脱敏与审计
15. 配置文件与部署覆盖
16. 错误代码与排查
17. 当前限制
18. FAQ

## 1. Windows Use 是什么

Windows Use 让 CodeFlowMu 中通过 Cursor 运行的 AI Agent 操作用户当前登录的 Windows 桌面应用。它由三部分组成：

```text
Agent 使用规范（Windows Use Skill）
    → Cursor MCP 工具（windows.*）
    → 本机 Windows Host（Win32 / Screenshot / UI Automation / SendInput）
```

它不是单纯的一段提示词。实际点击、输入、截图和控件读取由本机 Windows Host 完成，应用白名单与安全策略在 Host 执行动作前再次校验。

Windows Use 只在当前用户的活动桌面会话中运行，不提升权限，也不能越过 Windows UIPI、UAC 或应用自身的权限边界。

## 2. 当前支持与不支持

### 已支持

- 发现当前桌面中有可见顶层窗口的应用；
- 获取已授权窗口的截图；
- 读取 UI Automation 控件树；
- 调用标准按钮、菜单项等 UI Automation 控件；
- 按窗口相对坐标点击；
- 输入 Unicode 文本；
- 发送受限键盘按键或组合键；
- 在目标窗口中滚动；
- 记录脱敏动作审计；
- 用户通过 Panel 启停能力和维护项目级应用白名单。

### 当前不支持或不保证

- 可靠启动一个尚未打开的应用；
- 正式的“双击”“拖拽”“显示桌面”工具；
- 后台无人值守桌面、锁屏桌面和 Windows 服务会话；
- 绕过 UAC、MFA、CAPTCHA、登录验证或安全提示；
- 控制管理员权限高于 CodeFlowMu 的应用；
- 只授权某个窗口、文档、网页标签页或单个 Agent；
- 按站点限制 `chrome.exe` 或 `msedge.exe`；
- 被遮挡窗口的稳定离屏截图。V1 使用可见区域捕获，后续才考虑 Windows Graphics Capture；
- 保证所有自绘界面、游戏、Canvas、远程桌面或特殊渲染应用都能被 UI Automation 识别。

## 3. 启用前准备

使用前确认：

1. CodeFlowMu 运行在 Windows。
2. 当前 Agent 入口是 Cursor。
3. Panel 的 Windows Use 状态显示：`Windows ✓`、`截图 ✓`、`UI Automation ✓`。
4. 准备操作的应用已经打开，并有一个当前桌面可见的顶层窗口。
5. 当前 Windows 桌面没有锁定。

若截图或 UI Automation 显示不可用，参见“错误代码与排查”。

## 4. 总开关与应用白名单

Windows Use 同时通过两道门：

1. **启用能力**：当前项目的总开关。关闭时不会向 Cursor Agent 挂载 Windows Use。
2. **应用白名单**：决定 Agent 可以控制哪些 Windows 进程。总开关打开后，未进入白名单的应用仍不能截图、读取控件、点击或输入。

### 4.1 白名单显示的是什么

Panel 中的 `notepad.exe`、`chrome.exe`、`explorer.exe` 是进程可执行文件标识，不是窗口名称、文档名称或网站名称。

白名单是 **项目级、进程级、所有 Cursor Agent 共享**：

- 项目级：只对当前活动项目生效，切换项目不会自动继承。
- 进程级：授权一个 `.exe` 会覆盖该进程的全部可见窗口。
- Agent 共享：当前项目中通过 Cursor 运行的 PM、DEV、QA、OPS 等 Agent 共享同一份白名单。
- 非跨平台：Google、Claude、Fake/In-memory 和其他入口不会获得该能力。

### 4.2 授权前后能看到什么

未授权时，Windows Use 只返回完成授权所需的有限信息：

- 应用标识；
- 窗口标识；
- 窗口类；
- 窗口位置和大小；
- 是否为前台窗口。

未授权应用的窗口标题和完整可执行路径会隐藏。授权后才允许返回窗口标题、截图、UI Automation 控件和动作结果。

### 4.3 常见白名单项

| 白名单项 | 实际授权范围 | 风险与建议 |
|---|---|---|
| `notepad.exe` | 所有记事本窗口 | 适合首次测试 |
| `mspaint.exe` | 所有画图窗口 | 适合截图和点击测试 |
| `chrome.exe` | 所有 Chrome 窗口、标签页及已登录企业应用 | 范围很大，浏览器任务优先使用 Chrome 专用能力 |
| `msedge.exe` | 所有 Edge 窗口和其中的 Web 应用 | 范围很大，建议短时授权 |
| `explorer.exe` | 所有文件资源管理器窗口，并可能包含 Windows 桌面 | 可接触文件和桌面图标，谨慎授权 |

授权 `chrome.exe` 不等于只授权当前网站。如果 Chrome 同时打开邮箱、管理后台和企业系统，Windows Use 理论上可以观察和操作这些 Chrome 窗口。

### 4.4 受保护应用（独立只读表）

“应用白名单”和“受保护应用”是两个独立表页：

- **应用白名单**只显示用户可以选择授权的应用；复选框是可选授权。
- **受保护应用**由系统安全策略维护，整体灰色、只读、没有复选框，绝对不能加入白名单。

以下应用被硬阻止。Panel 的“受保护应用”表只展示策略项与当前运行状态，后端与 Host 还会再次拒绝：

- 命令提示符、PowerShell、Windows Terminal；
- CodeFlowMu；
- ChatGPT、Codex；
- `ApplicationFrameHost.exe`、`TextInputHost.exe` 等高风险宿主；
- 当前安全策略列出的其他受保护进程。

Agent 不能调用工具给自己增加白名单。只有用户在 Panel 保存设置，或部署管理员设置环境覆盖项，才能改变授权。

### 4.5 应用目标与本地凭据

Windows Use 使用独立的完整设置页，顶部“应用目标与本地凭据”区域支持录入：

- Windows EXE：标识、显示名称、应用说明、EXE 完整路径、结构化登录特征及按需使用的账号密码；
- Web 应用：标识、显示名称、应用说明、HTTPS 网址、Chrome/Edge、结构化登录特征及按需使用的账号密码。

每个目标必须明确选择登录方式：

- 无需登录；
- 账号 + 密码；
- 扫码登录；
- 验证码登录；
- 账号密码 + 验证码；
- 其他方式。

验证码模式还要选择短信、邮箱、身份验证器或其他渠道，并可填写“登录操作提示”。这些字段是提供给 Agent 的结构化特征：Agent 会先读取 `windows.list_targets`，不会再通过页面外观猜测登录流程。扫码和验证码模式会标记 `requiresUser=true`，Agent 必须停在相应步骤等待用户；登录特征尚未设置时也必须询问用户。

仅勾选进程白名单、但还没有建立应用目标档案的 EXE，也会生成一个 `loginMethod=unspecified`、`requiresUser=true` 的保守记录。它仍可被授权操作，但 Agent 会先询问登录方式，绝不会自行判断。要消除这一步，应在上方“应用目标与本地凭据”中为该 EXE 建立目标并选择登录方式。

选择 Windows EXE 时点击“选择本机应用…”，使用 Windows 原生文件选择器选取 `.exe`；系统会自动填入完整路径，并尽量从文件版本信息带出产品名、文件说明、厂商和版本。无需手工输入路径。每个目标都可以填写“应用说明/用途”，该说明会直接显示在目标列表和授权判断界面。

保存后的 Web 目标会出现在“Web 应用白名单”；运行中的本机程序显示在“Windows 应用白名单”。两类授权分别勾选，不再要求用 `chrome.exe` 代替某个具体网站的配置授权。

非敏感目标定义保存在 `.codeflowmu/runtime/windows-use.json`。账号和密码只写当前活动项目根目录的本地 `.env`：

```text
CODEFLOW_WINDOWS_TARGET_COMPANY_ERP_USERNAME="operator"
CODEFLOW_WINDOWS_TARGET_COMPANY_ERP_PASSWORD="password"
```

密码保存后不再通过 API、Panel 或 Agent 工具回显；Agent 只能看到账号/密码是否已保存。编辑目标时密码框留空表示保留原密码。删除目标会同步删除 `.env` 中对应的账号和密码。保存一个原生 EXE 目标会把该 EXE 加入可选授权范围；受保护 EXE 会被后端拒绝。Web 目标必须使用 HTTPS，URL 中不能内嵌账号或密码。

`.env` 是本地明文文件并由 Git 忽略，不等同于系统凭据保险库。能读取项目目录的本机程序仍可能读取它。当前阶段完成的是目标与凭据的安全录入、脱敏展示和本地保存；自动登录执行仍必须遵守目标校验和高风险动作确认规则。

## 5. 第一次使用

建议用记事本完成首次验证：

1. 手动打开记事本。
2. 打开 CodeFlowMu Panel → 设置 → Windows Use。
3. 点击“刷新应用”。
4. 找到并勾选 `notepad.exe`。
5. 勾选“启用能力”。
6. 点击“保存 Windows Use”。
7. 向一个 Cursor Agent 发送新任务：

```text
使用 Windows Use 检查当前打开的记事本。
只告诉我窗口标题和是否能读取编辑区域，不要点击、输入、保存或关闭。
```

确认只读检查正常后，再测试输入：

```text
使用 Windows Use 操作当前打开的记事本。
先确认目标窗口是 notepad.exe，再点击编辑区域，在末尾输入“Windows Use 测试”。
不要保存，不要关闭。输入后重新检查窗口并告诉我结果。
```

## 6. 如何给 AI 下命令

一条可靠的命令最好包含五部分：

```text
目标应用 + 目标窗口/内容 + 要执行的动作 + 禁止动作 + 验证要求
```

推荐模板：

```text
使用 Windows Use 操作【应用】中的【目标】。
执行【动作】。
不要【禁止动作】。
完成后重新检查窗口，并报告【验证结果】。
```

### 只读检查示例

```text
使用 Windows Use 查看当前打开的记事本，只读取窗口和控件信息，不点击、不输入、不保存。
```

### 输入示例

```text
使用 Windows Use 在当前记事本末尾输入“测试完成”。不要保存或关闭；输入后检查文本是否可见。
```

### 点击按钮示例

```text
使用 Windows Use 检查当前打开的业务客户端，找到名称为“查询”的标准按钮并调用它。
不要使用坐标猜测；如果 UI Automation 找不到就停止并报告。
```

### 限制目标窗口示例

```text
使用 Windows Use 操作 notepad.exe 中标题包含“会议记录”的窗口。
如果匹配窗口不是唯一一个，不要操作，列出候选窗口让我选择。
```

### 高风险动作示例

```text
使用 Windows Use 找到资源管理器中的 report.tmp。
先只定位，不要删除。删除前必须再次向我确认准确路径和文件名。
```

## 7. 常见使用场景

### 7.1 已打开的原生 Windows 应用

这是 V1 最可靠的场景。先授权应用，再要求 Agent 使用 UI Automation 识别控件；标准按钮、输入框、列表通常比纯坐标点击稳定。

### 7.2 自绘界面或控件树不可用

Agent 可以使用窗口截图和相对坐标作为降级路径。命令中应要求：

- 先截图观察；
- 只使用目标窗口内坐标；
- 小批量执行动作；
- 执行后重新截图验证；
- 观察失败后停止，不使用旧坐标继续操作。

### 7.3 多个同类窗口

白名单按进程授权，因此多个记事本窗口都会被授权。命令中应使用窗口标题或内容限定目标，并要求匹配不唯一时停止。

### 7.4 应用未打开

V1 没有正式的 `windows.launch_app`。如果应用没有可见窗口，它通常不会出现在发现列表中。请先手动打开应用，再刷新白名单。

## 8. 浏览器与企业 Web 应用

Windows Use 可以在授权 `chrome.exe` 或 `msedge.exe` 后把浏览器当作普通 Windows 应用操作，因此也能接触浏览器中打开的企业应用。

但浏览器授权的边界是整个浏览器进程，不是域名、标签页或企业应用：

- 授权 `chrome.exe` 会覆盖所有 Chrome 窗口；
- Windows Use 不理解站点级权限；
- 浏览器中的登录态、邮箱、后台和其他标签页可能同时处于授权范围；
- 页面滚动、动态内容和缩放会让坐标操作更脆弱。

因此：

- 需要使用现有 Chrome 登录态、标签页和网页语义时，优先使用 CodeFlowMu/宿主提供的 Chrome 专用能力；
- 只有浏览器专用能力无法处理的系统弹窗、原生文件对话框或特殊渲染界面，才考虑 Windows Use；
- 授权浏览器后应使用明确的窗口标题、站点和禁止动作描述；任务结束后取消授权。

示例：

```text
优先使用 Chrome 能力操作已登录的企业系统。
只有遇到浏览器外的 Windows 原生对话框时才使用 Windows Use。
不要访问其他标签页，不要提交表单，提交前必须让我确认。
```

## 9. 桌面、资源管理器与桌面图标

Windows 桌面和文件资源管理器通常属于 `explorer.exe`。授权 `explorer.exe` 可能允许访问：

- 文件资源管理器窗口；
- 桌面窗口；
- 桌面图标；
- 部分系统外壳界面。

命令示例：

```text
使用 Windows Use 在 Windows 桌面查找名称为“XXXX”的图标并尝试打开。
只操作完全匹配的图标；如果桌面不可见、匹配不唯一或无法可靠双击，就停止并报告。
```

当前限制：V1 没有正式的 `show_desktop` 和 `double_click` 工具，截图也依赖可见区域。因此桌面被窗口遮挡、图标位于特殊 WorkerW 桌面层或缩放变化时，这个场景不稳定。不要把它当作正式的应用启动能力。

## 10. Agent 范围与生效时机

当前项目打开 Windows Use 后，**所有通过 Cursor 运行的 Agent** 都会挂载 `windows.*` 工具，例如 PM、DEV、QA、OPS。当前版本没有按角色或单 Agent 开关。

需要同时满足：

- 当前活动项目已启用；
- Agent 使用 Cursor 入口；
- 目标应用已进入当前项目白名单；
- Agent 在保存设置之后开始一次新的发送。

生效规则：

- 保存后，下一次 Agent 发送读取最新设置并挂载工具；
- 已经执行中的 Agent 轮次不会中途获得新工具；
- 取消授权后，下一次发送开始使用新白名单；
- 不同项目分别保存，不自动共享；
- Windows Use Skill 按任务语义加载，但工具挂载目前对当前项目的全部 Cursor Agent 生效。

## 11. 工具能力说明

| 工具 | 类型 | 作用 | 主要前提 |
|---|---|---|---|
| `windows.capabilities` | 只读 | 检查 Windows、截图、UIA、MCP 能力 | 无需应用授权 |
| `windows.list_targets` | 只读 | 返回已授权目标及结构化登录特征 | 不返回密码；需按 requiresUser 暂停 |
| `windows.launch_target` | 写操作 | 按目标 ID 启动原生 EXE，或用配置的 Chrome/Edge 打开 Web 目标 | 只使用已保存的精确路径/HTTPS 地址；不接受任意命令、参数、路径或网址 |
| `windows.list_apps` | 只读 | 列出当前可见顶层窗口 | 无需应用授权；未授权标题脱敏 |
| `windows.wait_for_app` | 只读等待 | 启动后最多等待 15 秒，返回匹配窗口 | 替代 Shell `Start-Sleep` |
| `windows.activate` | 写操作 | 恢复最小化窗口并执行多级前台激活 | 仅限已授权 app_id/window_id；失败时请用户点击一次 |
| `windows.screenshot` | 只读 | 截取已授权窗口 | app_id 与 window_id 必须匹配 |
| `windows.inspect_ui` | 只读 | 读取 UI Automation 控件树 | 已授权；应用支持 UIA |
| `windows.invoke_ui` | 写操作 | 调用标准 UIA 控件 | selector 必须匹配目标控件 |
| `windows.click` | 写操作 | 按窗口相对坐标点击 | 已授权且窗口可激活 |
| `windows.type_text` | 写操作 | 输入 Unicode 文本 | 应先聚焦可编辑区域 |
| `windows.keypress` | 写操作 | 发送受限按键或组合键 | 不允许 Windows 键等高风险组合 |
| `windows.scroll` | 写操作 | 在窗口指定位置滚动 | 已授权且窗口可激活 |
| `windows.cancel` | 控制 | 请求取消当前 Windows Use 操作 | V1 动作为短调用，取消能力有限 |

`windows.invoke_ui` 会优先直接调用 UI Automation InvokePattern，不要求窗口抢占前台。`windows.click` 在 Windows 前台锁拒绝激活时，会退化为只发送给已授权窗口的有界鼠标消息；不会调用 PowerShell。文字与键盘输入仍需要真实焦点，若多级激活失败，应请用户点击一次目标窗口。

`windows.launch_target` 对原生应用是幂等的：它先检查已授权窗口和精确 EXE 路径对应的运行进程。已运行、最小化、隐藏或仍在初始化时返回 `already_running=true`，绝不重复创建进程。白名单只是授权，不是反复启动指令。

`windows.cancel` 会把当前 MCP 会话置为真实暂停状态；暂停后发现和桌面操作统一返回 `WINDOWS_USE_PAUSED`。`windows.status` 可核对状态，只有用户明确要求时才调用 `windows.resume`。这与 Panel 总开关不同：会话暂停不会把项目配置中的 `enabled` 改为 false，Agent 不得混称“项目已关闭”。

Web 目标通过 `windows.launch_target` 只能打开配置的 HTTPS 地址。Chrome 的 Windows UIA 通常只能看到浏览器外壳，看不到页面 DOM；登录按钮、网页表单和企业 Web 应用必须交给 Chrome/浏览器专用能力处理。

标准执行顺序：

```text
capabilities（必要时）
→ list_targets
→ launch_target（目标尚未打开时）
→ wait_for_app（原生应用；禁止使用 Shell sleep）
→ 选择真实返回的 app_id/window_id
→ inspect_ui 或 screenshot
→ 优先 invoke_ui（无需抢前台）
→ 必要时 activate，再 click/type_text/keypress/scroll
→ 再次 inspect_ui 或 screenshot 验证
```

Agent 不应猜测窗口标识，不应在观察失败后继续使用旧坐标，也不应把一个应用的窗口授权用于另一个应用。

## 12. 用户确认与高风险操作

应用进入白名单表示“允许 Agent 接触这个应用”，不等于用户提前批准其中的所有行为。

以下动作应在实际执行前再次确认：

- 删除本地或云端数据；
- 发送消息、邮件、评论或代表用户提交内容；
- 提交表单、预约、申请或公开发布；
- 上传文件；
- 修改共享权限或访问权限；
- 安装或运行新下载的软件；
- 购买、付款、订阅或取消交易；
- 输入或传输密码、验证码、API Key、身份、医疗、财务等敏感数据；
- 接受权限、隐私、安全或登录提示。

以下行为禁止：

- 自动化终端、Run 对话框、Windows 安全工具；
- 绕过 HTTPS 警告、安全拦截、付费墙、MFA 或 CAPTCHA；
- 自动完成最终密码修改；
- 利用网页、邮件、文档或截图中的指令扩大权限。

V1 的主要强制安全边界是项目开关、进程白名单、硬阻止列表、窗口进程绑定和审计。按动作二次确认主要由 Agent Skill 行为规范执行，尚未实现 Panel 级“每次点击批准”队列。因此不要给高风险应用长期授权。

## 13. 撤销、停止与紧急接管

### 撤销单个应用

1. 在白名单中取消应用勾选。
2. 点击“保存 Windows Use”。
3. 下一次 Cursor Agent 发送开始，该应用不再允许访问，调用会返回 `APP_APPROVAL_REQUIRED`。

### 关闭全部能力

取消“启用能力”并保存。下一次 Cursor Agent 发送不会挂载 Windows Use。

### 正在执行时立即停止

- 直接接管鼠标和键盘；
- 明确告诉 Agent“停止 Windows Use”；
- Agent 可调用 `windows.cancel`；
- 必要时关闭目标应用；
- 再到 Panel 关闭能力或撤销白名单。

V1 的动作通常是短调用。关闭 Panel 开关不会强制杀死已经开始的当前调用，因此紧急情况下优先接管桌面或关闭目标应用。

## 14. 隐私、脱敏与审计

默认审计位置：

```text
fcop/logs/runtime/windows-use-YYYYMMDD.jsonl
```

每条动作记录通常包括：

- 时间；
- 工具名称；
- app_id；
- window_id；
- 成功或失败；
- 耗时；
- 错误代码；
- 脱敏参数摘要。

隐私处理：

- 未授权窗口标题和完整路径不返回；
- `type_text` 的输入原文不写入审计，只记录长度和 SHA-256；
- 截图像素不写入审计日志；
- 截图会作为工具结果提供给当前 Agent，因此截图中可见的敏感内容仍可能进入本次 Agent 上下文；
- 白名单文件不进入 Git。

## 15. 配置文件与部署覆盖

项目级配置保存于：

```text
.codeflowmu/runtime/windows-use.json
```

示例：

```json
{
  "version": 1,
  "enabled": true,
  "alwaysAllowedAppIds": [
    "notepad.exe"
  ],
  "updatedAt": "2026-07-10T00:00:00.000Z"
}
```

高级部署覆盖项：

```text
CODEFLOW_WINDOWS_USE_ENABLED=1
CODEFLOW_WINDOWS_USE_ALLOW_APPS=notepad.exe,mspaint.exe
CODEFLOW_WINDOWS_USE_HOST=D:\codeflowmu\packages\codeflowmu-runtime\src\windows-use\host\windows_use_host.py
```

环境变量适合安装包、测试或集中部署，不建议普通用户直接编辑。环境白名单会与项目白名单合并；启用环境变量会覆盖项目开关判断。

Python 依赖：

```text
python -m pip install -r packages/codeflowmu-runtime/src/windows-use/host/requirements.txt
```

公开版发行构建会尝试安装这些依赖。

## 16. 错误代码与排查

| 错误代码 | 含义 | 处理方式 |
|---|---|---|
| `WINDOWS_ONLY` | 当前不是 Windows | 在 Windows 上运行 |
| `APP_APPROVAL_REQUIRED` | 应用未进入白名单 | 在 Panel 勾选应用并保存，再发起新 Agent 轮次 |
| `APP_BLOCKED` | 应用属于硬阻止列表 | 不能授权，改用安全的专用能力 |
| `APP_ID_REQUIRED` | 未提供应用标识 | 先调用 `windows.list_apps` |
| `WINDOW_NOT_FOUND` | 窗口已关闭或标识过期 | 刷新应用并重新选择窗口 |
| `WINDOW_NOT_VISIBLE` | 窗口不在当前可见桌面 | 恢复窗口并确保桌面未锁定 |
| `WINDOW_APP_MISMATCH` | 窗口不属于声明的应用 | 停止操作，重新发现窗口 |
| `UIA_UNAVAILABLE` | pywinauto/UI Automation 不可用 | 安装依赖或改用截图降级 |
| `HOST_TIMEOUT` | Host 调用超时 | 停止输入，刷新窗口后重试一次 |
| `HOST_PROTOCOL_ERROR` | Host 返回无效数据 | 检查 Python 路径和 Host 日志 |
| `CANCELLED` | 操作被取消 | 根据用户要求停止或重新开始 |

### Panel 找不到应用

- 确认应用已经打开且有可见顶层窗口；
- 点击“刷新应用”；
- 某些 UWP 应用只显示为共享宿主，V1 会阻止不可靠的共享宿主授权；
- 最小化、后台托盘或没有标题的窗口可能不会被列出。

### 保存后 Agent 仍没有工具

- 确认 Agent 使用 Cursor；
- 确认保存的是当前活动项目；
- 新发起一次 Agent 发送，旧轮次不会热注入；
- 检查 `.codeflowmu/runtime/windows-use.json`；
- 检查是否有环境变量强制关闭；
- 确认 Windows Host 文件存在。

### 可以发现但不能点击或输入

- 确认目标应用已勾选；
- 确认 window_id 来自最新一次 `list_apps`；
- 确认应用权限不高于 CodeFlowMu；
- 确认窗口可激活且桌面没有锁定；
- 若用户刚切换窗口，让 Agent 重新观察后再操作。

## 17. 当前限制

Windows Use V1 是可用的原生 Windows 应用控制基础设施，但还不是 ChatGPT Computer Use 的全部产品能力。主要差距：

- 没有稳定的应用安装目录与快捷方式索引；
- 没有安全的 `launch_app`、`double_click`、`drag`、`show_desktop`；
- 没有 Windows Graphics Capture 离屏窗口捕获；
- 没有角色级或单 Agent 白名单；
- 没有窗口级、网页站点级授权；
- 没有 Panel 动作确认队列；
- `windows.cancel` 对同步短动作的中断能力有限；
- 复杂自绘控件仍依赖视觉坐标。

因此 V1 的正式推荐范围是：**用户已经打开、已明确授权、当前可见的原生 Windows 应用窗口**。

## 18. FAQ

### 启用后所有 Agent 都能用吗？

当前活动项目里，所有通过 Cursor 运行的 Agent 都会挂载工具并共享白名单。其他入口和其他项目不会。

### 白名单授权的是一个窗口吗？

不是。授权的是进程标识，例如 `notepad.exe`，它会覆盖所有记事本窗口。

### 可以操作浏览器里打开的企业应用吗？

可以，但授权 `chrome.exe` 会覆盖所有 Chrome 窗口，不只企业应用。优先使用 Chrome 专用能力。

### 可以说“打开桌面的 XXXX 图标”吗？

可以尝试，但需要授权 `explorer.exe`，并且桌面必须可见。V1 缺少正式双击和显示桌面工具，因此不保证稳定。

### 可以让 AI 启动一个关闭的应用吗？

当前没有正式的安全启动工具。请先手动打开应用。

### 关闭开关会立即停止当前动作吗？

不会保证中断已经开始的短调用。请先接管桌面或要求 Agent 停止，再关闭能力。

### 输入的文字会记录到日志吗？

不会记录原文，只记录长度和 SHA-256。但文字会被发送到目标应用，截图中可见内容也可能进入当前 Agent 上下文。

### 为什么终端、ChatGPT 和 CodeFlowMu 不能勾选？

这些应用可能造成权限扩大、自我自动化或任意命令执行，因此由 Host 硬阻止。

完整架构、安全模型和开发契约见 [`architecture/WINDOWS-USE.md`](architecture/WINDOWS-USE.md)。
