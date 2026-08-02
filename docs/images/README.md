# CodeFlowMu 文档图片

本目录保存可进入母版与 Open Edition 的公开图片。

## PC 截图规则

- 路径：`pc/<母版版本>/`
- 文件名：`pc-<页面>-<母版版本>.png`
- 新版本新增目录，不覆盖旧版本截图；历史文档继续引用当时版本。
- Open 帮助手册使用相对路径引用图片。
- 新增截图后必须同步更新 `editions/open-dev-team/include.list`；如果图片属于本轮母版差异，还须登记到 Open release change group。

## V1.2.5 PC 截图目录

V1.2.5 当前共 22 张，全部位于 [`pc/V1.2.5/`](pc/V1.2.5/)：

| 分组 | 页面 | 文件 |
|---|---|---|
| 总览 | 仪表盘 | `pc-dashboard-V1.2.5.png` |
| 协作 | 任务 | `pc-tasks-V1.2.5.png` |
| 协作 | 问题 | `pc-issues-V1.2.5.png` |
| 协作 | 审批 | `pc-approvals-V1.2.5.png` |
| 协作 | 门铃 / MCP 事件 | `pc-doorbell-events-V1.2.5.png` |
| 监督 | EVAL 评估 | `pc-evaluation-V1.2.5.png` |
| 能力 | 技能库 | `pc-skills-library-V1.2.5.png` |
| 文件 | 文件浏览 | `pc-file-browser-V1.2.5.png` |
| 团队 | 团队配置 | `pc-team-config-V1.2.5.png` |
| 设置 | 常规 | `pc-settings-general-V1.2.5.png` |
| 设置 | 通知 | `pc-settings-notifications-V1.2.5.png` |
| 设置 | 关于 / 版本日志 | `pc-settings-about-V1.2.5.png` |
| 设置 | 项目 | `pc-settings-projects-V1.2.5.png` |
| 设置 | 项目与版本综合页 | `pc-projects-and-version-V1.2.5.png` |
| 设置 | PWA 项目 | `pc-settings-pwa-projects-V1.2.5.png` |
| 设置 | 开源版本发版 | `pc-settings-open-release-V1.2.5.png` |
| 设置 | Git 状态 | `pc-settings-git-status-V1.2.5.png` |
| 设置 | 数据导出 | `pc-settings-data-export-V1.2.5.png` |
| 设置 | 任务模板 | `pc-settings-task-templates-V1.2.5.png` |
| 设置 | Windows Use | `pc-settings-windows-use-V1.2.5.png` |
| 设置 | Browser Use | `pc-settings-browser-use-V1.2.5.png` |
| 发布 | 开源版本发版台 | `pc-open-release-V1.2.5.png` |

涉及聊天正文、REPORT 正文、日志明细、移动端绑定二维码或访问令牌的页面，不直接使用真实运行数据制作公开截图。公开截图应使用空状态、示例数据或完成脱敏后再入库。

## PWA 截图规则

- 路径：`pwa/<PWA版本>/`
- 文件名：`pwa-<页面>-<PWA版本>.png`
- PWA 与母版分别按自己的版本号建目录；升版时新增目录，不覆盖旧版截图。
- 绑定二维码、访问令牌、API Key 和其他凭据不得进入公开截图。

## V1.0.58 PWA 截图目录

V1.0.58 当前共 8 张，全部位于 [`pwa/V1.0.58/`](pwa/V1.0.58/)：

| 页面 | 文件 |
|---|---|
| 首页 / 团队概览 | `pwa-dashboard-V1.0.58.png` |
| 任务线 | `pwa-tasks-timeline-V1.0.58.png` |
| 发布任务 | `pwa-publish-task-V1.0.58.png` |
| 报告 | `pwa-reports-V1.0.58.png` |
| 审批 | `pwa-approvals-V1.0.58.png` |
| 动态 | `pwa-activity-V1.0.58.png` |
| 聊天 | `pwa-chat-V1.0.58.png` |
| 我的 / 设备绑定 | `pwa-my-settings-V1.0.58.png` |

## V1.0.59 PWA 截图目录

V1.0.59 新增「本版更新」常驻展示截图，位于 [`pwa/V1.0.59/`](pwa/V1.0.59/)：

| 页面 | 文件 |
|---|---|
| 我的 / 本版更新 | `pwa-release-notes-V1.0.59.png` |
