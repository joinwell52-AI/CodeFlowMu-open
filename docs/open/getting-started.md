# 快速开始

推荐 Windows 用户直接运行：

```bat
START-CODEFLOWMU-OPEN.bat
```

启动器会检查 Node.js 和 npm，创建本地 `.venv`，安装 Python 依赖，安装 Node 依赖，并启动本地面板。

默认地址：

```text
http://127.0.0.1:18765/
```

首次启动会清理公开版运行态缓存，让界面进入干净初始化状态。它不会清理源码、Git 仓库、`node_modules` 或 `.venv`。

## 第一步：确认或添加项目

公开版的 `CodeFlowMu-open` 根目录是工具安装目录，受保护，不能直接作为开发目标。
首次启动生成的 `projects/newproject` 是独立的默认项目，可以直接使用。`projects/`
用于存放多个团队项目；用户也可以登记旧版 `workspace/<project>` 或任意外部项目目录，系统不会自动搬迁旧目录。

启动后进入：

```text
设置 → 项目 → 添加项目
```

选择你自己的产品或代码目录，然后设为当前项目。之后：

- FCoP 初始化写入你的项目根；
- TASK / REPORT / REVIEW 写入你的项目根；
- 附件、聊天上下文和 Agent 会话绑定你的项目根；
- CodeFlowMu-open 自身不会被 Agent 当成任务目标修改。

### 新建软件与添加已有代码是两条不同流程

**新建独立项目（推荐用于从零开发一个软件）：**

1. 打开“设置 → 项目”。
2. 点击“新建独立项目”。
3. 输入名称和一个不存在或为空的完整目录，例如
   默认路径为 `D:\CodeFlowMu-open\projects\codedaysign`。
4. 系统自动创建目录、初始化 dev-team/FCoP、登记项目并切换当前项目。
5. 等待“项目已切换，正在同步适配”完成，再发布 ADMIN→PM TASK。

**添加已有项目（推荐用于已有源码）：**

1. 先确保源码目录已经存在。
2. 点击“添加已有项目”并选择该目录。
3. 设为当前；如果尚未初始化 FCoP，在环境预检中执行一键初始化。
4. 适配完成后再发布 TASK。

任务中的 `new_workspace` 只会在当前项目根下创建 `workspace/<slug>` 业务工作区，
不会把它登记为独立项目，也不会切换 Runtime。禁止让正在旧项目执行的 TASK 中途
自行切换项目，否则 TASK/REPORT 留在旧项目、Agent 上下文进入新项目，证据链会断裂。

只要 Panel 当前项是已经初始化的 `projects/newproject`、其他 `projects/<project>`、兼容的旧版 `workspace/<project>`
或用户登记的外部项目，Open 就必须允许创建任务和运行 Agent。只有当前项错误指向
`CodeFlowMu-open` 工具根本身时，才应拒绝写入和启动项目任务。

判断“现在任务会写到哪里”时，只看 Panel 当前项目和健康接口返回的 `root/projectRoot`；
任务正文中的项目名、路径或 `new_workspace` slug 都不会改变当前项目。新建/添加项目后
必须等切换适配遮罩完成，再发布 TASK。正在执行的 TASK 不允许中途切换项目。

Open 切换项目时会把公开的 `windows-use`、`browser-use` Skill 包以及 Agent Playbook
manifest 投影到项目根。技能库应显示 PM 5/5，且公开 Skill 包“缺包 0”；缺包 2 通常表示
旧项目尚未完成这次投影，重新切换该项目或执行环境初始化/修复即可恢复。

每个当前项目使用自己的 `.codeflowmu/runtime` 保存 Agent 注册、SDK Agent ID、session、
inbox 与 transcript。没有配置 Cursor API Key 时，TASK 会保留在 inbox 并显示配置提示，
不会由 `sdk-fake-*` 测试适配器空跑完成。

PM 向 ADMIN 提交最终 `status=done` REPORT 后，系统自动生成 EVAL 旁路观察。
任务行和详情中的“生成/刷新 EVAL”仅用于失败重试或人工重新评估。

安装根由应用内自保护壳维持启动基线；这不会限制 Agent 对 Panel 当前业务项目的正常
代码、测试、构建和证据写入。

日志中同一 QA/OPS `waiting_dependency` 最多每 30 秒提示一次。若持续出现
`[open-integrity] removed_untrusted: fcop/ledger/...`，说明运行的仍是旧版保护规则；
V1.1.10-open 修复版只保护发行资产 `fcop/adopted/`，不会删除任何 ledger 运行态。

手动启动：

```bash
npm install
npm start
```
