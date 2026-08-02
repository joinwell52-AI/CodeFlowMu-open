# CodeFlowMu Open PC 与 PWA 帮助手册

> 适用版本：V1.2.5-open
> 更新日期：2026-08-02
> 界面截图：CodeFlowMu PC Panel V1.2.5
> PWA 截图：CodeFlowMu PWA V1.0.58、V1.0.59

本手册面向首次安装和日常使用 CodeFlowMu Open Dev Team Edition 的用户。Open 版默认在本机运行，团队角色为 PM、DEV、OPS、QA，EVAL 作为独立观察角色。

## 1. 启动与确认连接

完成安装后，在仓库根目录运行 `npm start`，然后打开启动日志给出的 Panel 地址。顶部绿色「已连接」表示浏览器已连接 Shell；版本徽标、当前项目、实例类型和端口用于确认当前运行环境。

![PC 仪表盘](../images/pc/V1.2.5/pc-dashboard-V1.2.5.png)

仪表盘集中显示任务、报告、运行中事项、待审批、团队状态和 Runtime 告警。首次使用时先确认：

- 顶部为绿色「已连接」；
- 当前项目是准备工作的项目根；
- 团队角色已经显示；
- 运行时告警没有阻断项。

## 2. 创建和查看任务

左侧进入「任务」。顶部「正式任务」查看已经进入生命周期的 TASK；「投递审查」用于在正式 TASK 生成前检查任务书。

![PC 任务页面](../images/pc/V1.2.5/pc-tasks-V1.2.5.png)

任务书首次检查发现问题时：在线下修改 Markdown，点击「继续编辑」，在新的任务书写入页重新上传修改后的文件，覆盖旧草稿后再次检查。不要直接重跑未修改的旧文件，也不需要先创建重复 TASK。

任务列表可按主线、关键词和进行中/已归档筛选；「列表」「看板」「任务线」分别适合逐项查看、按状态查看和查看父子关系。

## 3. 管理多个项目

进入「设置 → 项目」可新建独立项目、添加已有项目或将某个项目设为当前。顶部项目下拉与该列表同步。

![PC 项目与版本页面](../images/pc/V1.2.5/pc-projects-and-version-V1.2.5.png)

「设为当前」会让 Runtime、MCP、Watcher 和 Agent 工作目录一起切换到 active project。Shell 安装根不会因此改变。切换后请检查顶部当前项目和页面中的项目根一致；若启动一致性诊断报错，应先修复根绑定，不能继续项目写入。

同一页面下方的「版本更新日志」展示每个版本的具体功能、修复、关联任务和影响范围，可使用搜索框按版本或更新内容检索。

## 4. 操作审批

左侧「审批」只处理动作发生前的一次性高风险操作授权，例如破坏性操作、外部写入、发布、凭据或 Runtime 治理边界变更。

![PC 审批页面](../images/pc/V1.2.5/pc-approvals-V1.2.5.png)

TASK、REPORT、REVIEW、事实核查和 EVAL 不进入全局操作审批；它们继续使用任务生命周期。审批通过只表示允许尝试执行，不等于执行已经成功，最终结果仍应查看验证状态和审计记录。

## 5. 设置中心

「设置」集中承载运行参数、版本信息、项目管理、发布、Git、数据工具和自动化能力。每个标签都是独立页面，不需要离开 Panel。

### 5.1 常规、通知与关于

![PC 常规设置](../images/pc/V1.2.5/pc-settings-general-V1.2.5.png)

![PC 通知设置](../images/pc/V1.2.5/pc-settings-notifications-V1.2.5.png)

![PC 关于与版本日志](../images/pc/V1.2.5/pc-settings-about-V1.2.5.png)

常规设置用于确认项目根、界面语言、主题和 API 接入通道；通知设置管理桌面提醒；关于页展示母版、Shell、PWA 与协议版本以及具体更新日志。

### 5.2 项目与 PWA 项目

![PC 项目设置](../images/pc/V1.2.5/pc-settings-projects-V1.2.5.png)

![PC PWA 项目设置](../images/pc/V1.2.5/pc-settings-pwa-projects-V1.2.5.png)

项目设置管理本机 active project；PWA 项目设置管理独立 Web 项目的注册、版本和发布入口。二者都不会把 `host_root` 错当成当前业务项目根。

## 6. Git 状态与数据工具

「设置 → Git 状态」区分产品文件和非母版变更：

- 产品文件未提交会阻止发版；
- 项目工作区与 FCoP/运行配置只显示数量，默认不参与母版提交；
- 提交前应核对分支、远端同步状态和本次变更范围。

![PC Git 状态](../images/pc/V1.2.5/pc-settings-git-status-V1.2.5.png)

不要为了让工作区显示干净而把真实项目、任务、报告、运行日志或本地配置加入产品提交。

「数据导出」用于生成可迁移的数据包；「任务模板」用于维护常用任务书结构。

![PC 数据导出](../images/pc/V1.2.5/pc-settings-data-export-V1.2.5.png)

![PC 任务模板](../images/pc/V1.2.5/pc-settings-task-templates-V1.2.5.png)

## 7. Windows Use 与 Browser Use

Windows Use 面向获准的本机 Windows 应用；Browser Use 面向获准的浏览器目标。两项能力默认关闭，必须先登记目标、说明用途，再显式启用。

![PC Windows Use](../images/pc/V1.2.5/pc-settings-windows-use-V1.2.5.png)

![PC Browser Use](../images/pc/V1.2.5/pc-settings-browser-use-V1.2.5.png)

受保护应用、未登记目标和超出授权范围的操作不会因为启用了能力而自动放行。账号与密码仅保存在项目根的本地环境文件，不进入 Git、任务正文或截图。

## 8. 团队、问题与运行观察

### 8.1 团队配置

团队配置用于设置角色模型、团队身份、审批模式和运行参数。修改模型后只影响后续会话，已经运行的会话继续使用启动时捕获的模型。

![PC 团队配置](../images/pc/V1.2.5/pc-team-config-V1.2.5.png)

### 8.2 问题与门铃

「问题」用于查看结构化 ISSUE；「门铃」显示 MCP 工具调用、系统事件和故障记录，适合判断 Agent 是否真正开始工作。

![PC 问题页面](../images/pc/V1.2.5/pc-issues-V1.2.5.png)

![PC 门铃事件](../images/pc/V1.2.5/pc-doorbell-events-V1.2.5.png)

### 8.3 EVAL、技能库与文件浏览

EVAL 是独立观察层，不代替 PM、QA 或 ADMIN 验收。技能库展示 Runtime 可匹配的技能包及接入状态；文件浏览用于只读查看 FCoP、文档和项目文件结构。

![PC EVAL 评估](../images/pc/V1.2.5/pc-evaluation-V1.2.5.png)

![PC 技能库](../images/pc/V1.2.5/pc-skills-library-V1.2.5.png)

![PC 文件浏览](../images/pc/V1.2.5/pc-file-browser-V1.2.5.png)

## 9. 开源版本发版台

维护者可在「设置 → 开源版本发版」查看版本号、允许同步的产品变更组、构建状态、类型契约检查和发版记录。

![PC 开源版本发版台](../images/pc/V1.2.5/pc-open-release-V1.2.5.png)

![PC 开源发版设置](../images/pc/V1.2.5/pc-settings-open-release-V1.2.5.png)

发布前必须先提交母版产品代码，并填写用户可理解的版本名称与具体更新内容。系统随后依次执行版本预审、Open 构建、完整性验证、发行树依赖安装与 TypeScript 契约检查、安全同步、提交和推送。任一步失败都应先修复依赖闭包或审批范围，不能跳过门禁。

## 10. PWA 手机端

PWA 用于在手机上查看团队状态、任务、报告、审批与动态，并可向角色发送消息。首次使用先从 PC Panel 获取绑定入口，在 PWA「我的」中完成设备绑定；状态栏的 PC 与 Gateway 均为绿色后再进行业务操作。

当前 PWA V1.0.59 在「我的」页新增常驻的「本版更新」卡片，直接展示版本名称和具体更新内容；完成更新后仍可随时查看，不再只依赖一次性的升级提示条。下列功能截图拍摄于 V1.0.58，界面主体与 V1.0.59 一致。

![PWA V1.0.59 本版更新](../images/pwa/V1.0.59/pwa-release-notes-V1.0.59.png)

### 10.1 首页与任务

![PWA 首页与团队概览](../images/pwa/V1.0.58/pwa-dashboard-V1.0.58.png)

![PWA 任务线](../images/pwa/V1.0.58/pwa-tasks-timeline-V1.0.58.png)

任务页支持正式任务、投递审查、列表与任务线视图。发布任务时可手工填写标题和详情，也可导入修改后的 Markdown 任务书；首次检查未通过时，应修改文件后重新上传覆盖旧草稿。

![PWA 发布任务](../images/pwa/V1.0.58/pwa-publish-task-V1.0.58.png)

### 10.2 报告、审批与动态

![PWA 报告](../images/pwa/V1.0.58/pwa-reports-V1.0.58.png)

![PWA 审批](../images/pwa/V1.0.58/pwa-approvals-V1.0.58.png)

![PWA 动态](../images/pwa/V1.0.58/pwa-activity-V1.0.58.png)

报告页按主任务、子任务和记录筛选；审批页只处理需要明确授权的操作；动态页用于查看角色活动与系统事件。审批通过不等于执行完成，仍应回到报告或任务状态确认结果。

### 10.3 聊天与设备绑定

![PWA 聊天](../images/pwa/V1.0.58/pwa-chat-V1.0.58.png)

![PWA 我的与设备绑定](../images/pwa/V1.0.58/pwa-my-settings-V1.0.58.png)

「我的」显示当前 PWA 版本、语言与绑定状态，并提供重新绑定、清缓存和重新加载。公开文档截图不得包含二维码、绑定链接或访问令牌。

## 11. 常见问题

| 现象 | 处理 |
|---|---|
| Panel 当前项目正确，但 TASK 查询返回不存在 | 检查 Runtime、MCP 和 Watcher 是否都绑定同一 active project；重启后仍不一致时停止写入并查看启动诊断 |
| `Runtime writer lock is already owned` | 已有实例占用同一 Writer Lock；不要再启动第二个相同实例，回到已有 Panel 或先按受控流程停止原实例 |
| 任务书修复检查仍使用旧内容 | 点击「继续编辑」，重新上传线下修改后的 Markdown，保存覆盖旧草稿后再检查 |
| 开源构建提示相对 import 缺失或 TypeScript 名称缺失 | 将调用方、实现、类型定义和必要测试作为完整 change group 纳入发布，再重新构建 |
| 图片在公开仓库缺失 | 截图必须位于 `docs/images/` 且加入 Open include 清单；帮助文档使用相对路径引用 |

更多资料：

- [快速开始](getting-started.md)
- [版本边界](edition-boundary.md)
- [贡献指南](contributing.md)
