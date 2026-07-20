# 项目初始化与发布来源说明

## 接入通道边界

Open Dev Team Edition 当前只提供真实 Cursor SDK 接入。供应商无关的 Agent 接口用于未来扩展，但发行包不包含 Google/Gemini、Claude、OpenRouter 或 Anthropic 的适配器、模型读取接口、配置项、依赖和测试。Windows Use 与 Browser Use 是 Open 默认产品能力，但具体应用和网站仍须由用户在安装后配置并授权。

公开版的 `projects/newproject` 是没有添加其他项目时使用的干净兜底项目。它在首次启动时由发行包内的 `templates/default-project` 创建，不来自母版项目，也不应包含聊天、任务、报告或其他用户数据。旧版 `workspace/<项目>` 仅兼容识别，启动和升级都不会自动移动。

环境预检会区分三种情况：

- 项目未初始化：点击“一键初始化/接管项目”。
- 初始化会同时安装公开版自带的 Windows Use 与 Browser Use 技能包；技能库应显示“已接入、包在盘”，不应显示“包缺失”。
- FCoP 骨架不完整或协议版本过旧：点击“初始化/修复环境”。
- 仅缺少 Cursor API Key：点击“去配置”，进入“设置 → 通道设置 → Cursor”。

Panel 中设为当前的项目目录是项目根的唯一真相源。切换项目后，Agent Runtime、MCP、任务/报告落盘和目录监听应同步热切换。

Runtime 数据必须落在当前项目 `.codeflowmu/runtime`，不得按同名 `newproject` 复用用户全局 Agent/session。新建或添加项目时会同时投影 PM Skills manifest、Agent Playbook manifest 与公开 Skill 包。

未配置真实 Cursor Provider 时，正式 TASK 保留在 inbox；公开版不得用 InMemory 测试适配器假装完成。PM 最终 REPORT 落盘后自动生成 EVAL 旁路观察，手动按钮只承担重试与刷新。

返工流程中的 DEV→QA 是具体任务依赖，不是仅按线程和角色判断。PM 会让新 QA 任务引用本轮新 DEV task_id；旧轮次 DEV REPORT 不会提前放行 QA。QA 等待时保留在 inbox 并显示 `waiting_dependency`，本轮 DEV 提交有效 done REPORT 后由 Runtime 自动释放。没有 DEV 前置要求的独立 QA 不受此门禁影响。

发行代码由应用内自保护壳维护启动基线，项目业务目录不属于保护范围。保护安装代码不得通过削减 PM/DEV/QA/OPS 的正常项目工具能力实现。

发行包由母版构建脚本按白名单生成，不是复制旧安装文件夹；公开包不会携带母版聊天记录、任务报告、ledger 历史、API Key 或外部项目文件。

设置页的版本信息来自发行根的 `VERSION.json`，更新日志来自 `VERSION_HISTORY.json`。两者由发布脚本生成，不依赖母版私有版本文件。
# 启动日志说明

- `[LifecycleGovernor] ... reconcile summary`：启动后的任务账本对账摘要，属于正常信息。
- `[mobile-gateway] connected`：移动网关连接成功，属于正常信息。
- `[panel-api:slow] detected ...`：检测到 Panel 接口超过 300ms，只提示一次。
- `[panel-api:slow-summary]`：慢请求每 60 秒最多汇总一次，不再逐请求刷屏。只有排障时才设置 `CODEFLOWMU_PANEL_API_DEBUG=1` 查看逐请求耗时。

仅执行本地构建时不要求 `D:\CodeFlowMu-open` 已存在；正式发布会先创建或克隆该 Git 目标目录，再比较 GitHub 基线、验证、同步和推送。
