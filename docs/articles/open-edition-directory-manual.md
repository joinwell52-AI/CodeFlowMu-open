# CodeFlowMu Open 目录手册

本文说明 CodeFlowMu Open Dev Team Edition 的目录结构、目录职责、发版来源和本地更新边界。

公开版不是母版仓库的完整拷贝。它是通过 Cursor SDK 接口驱动、由 FCoP 协议治理的多 Agent 开发团队应用：PM / DEV / OPS / QA 负责开发执行，EVAL 独立观察。

## 一句话边界

- `D:\CodeFlowMu-open` 是开源版工具根目录，受保护，用户不应把它当成项目开发目录。
- 当前版本每台电脑只支持一个标准安装，Windows 默认安装根为 `D:\CodeFlowMu-open`。
- `D:\CodeFlowMu-open\projects\newproject` 是默认团队项目，首次启动时自动创建，可初始化 FCoP 并写入任务、报告、附件和项目文件。
- 用户也可以添加自己的外部项目目录，作为 Agent 协同开发目标。
- 开源版自身更新采用全量替换应用文件，但保留 Git、依赖、虚拟环境、本地配置、`projects/`、旧版 `workspace/` 和外部项目目录。

## 母版、构建产物、公开仓库

| 层级 | 路径 | 用途 | 是否手动维护 |
|---|---|---|---|
| 母版源目录 | `D:\codeflowmu\editions\open-dev-team\` | 开源版专属 README、安装说明、页面模板、GitHub 文章素材源 | 是 |
| 母版图片源 | `D:\codeflowmu\docs\images\` | 公开 README 和文章使用的产品图片、截图 | 是 |
| 发版构建产物 | `D:\codeflowmu\release\open-dev-team\CodeFlowMu\` | 每次发版生成的完整公开包，用于检查和同步 | 否 |
| 公开本地仓库 | `D:\CodeFlowMu-open\` | `joinwell52-AI/CodeFlowMu-open` 的本地工作区，用户下载/运行的公开版 | 由发版流程更新 |
| GitHub 公开仓库 | `joinwell52-AI/CodeFlowMu-open` | 对外展示、下载、安装、引导和贡献入口 | 由公开本地仓库推送 |

不要直接维护 `D:\codeflowmu\release\open-dev-team`。它是临时构建结果，下次构建会重建。所有公开内容都应回到母版源目录修改。

## 开源版根目录

| 目录或文件 | 做什么 | 来源/生成方式 | 更新策略 |
|---|---|---|---|
| `.git/` | 公开仓库 Git 历史和远端配置 | clone / git init 公开仓库 | 本地保留，不随应用包覆盖 |
| `.gitignore` | 公开仓库忽略规则 | 发版脚本生成 | 随发版覆盖 |
| `.codeflowmu/` | 开源版 UI 配置、导航、欢迎文案和本地运行标记 | 发版包 + 本地运行生成 | 配置文件随发版覆盖，运行标记保留 |
| `.venv/` / `venv/` | Python 虚拟环境，安装 `fcop` / `fcop-mcp` | 启动脚本本地创建 | 保留，不随发版覆盖 |
| `node_modules/` | Node 依赖 | `npm install` 本地创建 | 保留，不随发版覆盖 |
| `adoptedSource/` | 公开版初始化素材源，包括 FCoP 协议骨架和 pending 条款 | 母版发版复制 | 随发版覆盖 |
| `codeflowmu-desktop/` | Web Panel 前端页面和静态资源 | 母版发版复制 | 随发版覆盖 |
| `codeflowmu-shell/` | 开源版启动入口、API、任务/项目/环境检测后端 | 母版发版复制 | 随发版覆盖 |
| `docs/` | 公开文档、文章、图片、技能清单 | 母版发版复制 | 随发版覆盖 |
| `fcop/` | 工具级公开协议资料，当前仅保留 adopted 条款 | 母版发版复制 + 本地项目初始化另写项目内 fcop | 公开资料随发版覆盖，运行账本不放这里 |
| `packages/` | 开源版运行需要的本地包，如 protocol/runtime | 母版发版复制 | 随发版覆盖 |
| `projects/` | 多个 CodeFlowMu 团队项目的集合，首次启动创建 `newproject` | 本地运行创建，发版仅保留 README | 保留，不随发版覆盖 |
| `workspace/` | 旧版安装级项目集合；项目内部也可能用作业务产物目录 | 升级兼容保留 | 保留，不自动移动或覆盖 |
| `codeflowmu.team.json` | 固定开发团队 PM / DEV / OPS / QA，加独立观察者 EVAL | 发版脚本生成 | 随发版覆盖 |
| `package.json` / `package-lock.json` | 公开版 npm 安装与启动配置 | 发版脚本改写 | 随发版覆盖 |
| `START-CODEFLOWMU-OPEN.bat` | Windows 一键启动脚本，检查依赖并启动服务 | 发版脚本生成 | 随发版覆盖 |
| `VERSION.json` | 产品版本、渠道、仓库、更新策略 | 发版脚本生成 | 随发版覆盖 |
| `RELEASES.md` | 当前公开版发布说明 | 发版脚本生成 | 随发版覆盖 |
| `RELEASE_MANIFEST.json` | 本次发版包含、跳过、排除文件清单 | 发版脚本生成 | 随发版覆盖 |
| `UPDATE.md` | 公开版全量更新说明 | 发版脚本生成 | 随发版覆盖 |
| `README.md` / `README.zh.md` | GitHub 首页介绍，中英双语入口 | `editions/open-dev-team/` | 随发版覆盖 |
| `INSTALL.md` | 安装和启动说明 | `editions/open-dev-team/` | 随发版覆盖 |
| `LICENSE` | 开源许可证 | 母版根目录 | 随发版覆盖 |

## `docs/` 目录

| 子目录 | 做什么 | 母版来源 |
|---|---|---|
| `docs/open/` | 快速开始、边界说明、Gateway 说明、贡献说明、GitHub about | `editions/open-dev-team/pages/` |
| `docs/articles/` | GitHub 文章、产品说明、目录手册、发版边界说明 | `editions/open-dev-team/github/articles/` |
| `docs/images/` | README 和文章使用的公开图片、截图 | `D:\codeflowmu\docs\images\` |
| `docs/skills/` | 公开版 Agent 技能清单和技能说明 | `D:\codeflowmu\docs\skills\` |

公开文章和图片属于开源仓库展示层。发版时必须与应用代码一起检查，否则公开仓库会出现“代码已更新、介绍还停留在旧版本”的断层。

## `projects/` 项目集合目录

`projects/` 是开源版默认项目集合，不是工具源码。每个子目录是一个独立团队项目；旧版安装级 `workspace/<项目>` 仍可按注册表绝对路径原地运行。

首次启动后应至少存在：

```text
D:\CodeFlowMu-open\projects\newproject
```

`newproject` 是默认示例项目根。初始化后，项目内会出现自己的：

```text
fcop/
AGENTS.md
CLAUDE.md
.cursor/rules/
workspace/
```

任务、报告、附件、聊天上下文、Agent 会话和 FCoP 账本应写入项目根，而不是写入 `D:\CodeFlowMu-open` 工具根。

## `fcop/` 与项目内 `fcop/` 的区别

| 位置 | 含义 |
|---|---|
| `D:\CodeFlowMu-open\fcop\adopted\` | 工具包自带的公开协议条款和运行时说明 |
| `D:\CodeFlowMu-open\projects\newproject\fcop\` | 当前项目自己的 FCoP 协作账本、任务、报告、问题和生命周期目录 |
| 外部项目根下的 `fcop\` | 用户真实项目自己的 FCoP 协作目录 |

开源版工具根下的 `fcop` 不是项目账本。项目账本必须在项目根下。

## 本地运行生成但不应公开提交的内容

以下内容由安装或运行生成，原则上不进入公开发版包：

- `node_modules/`
- `.venv/` / `venv/`
- `.env` / `.env.*`
- `.codeflowmu/open-runtime-initialized.flag`
- `.codeflowmu/report-watcher/`
- `fcop/logs/`
- `fcop/chat/`
- `fcop/reports/`
- `fcop/tasks/`
- `fcop/issues/`
- `fcop/reviews/`
- `fcop/_lifecycle/`
- `fcop/attachments/`
- `projects/` 中用户自己的项目内容
- 旧版 `workspace/` 中用户自己的项目内容

## 发版时会覆盖什么

发版流程会从母版构建完整公开包，然后同步到 `D:\CodeFlowMu-open`。通常覆盖：

- 应用源码和 Web Panel
- Shell/API 后端
- 本地 runtime 包
- 根 README、安装说明、发布说明
- `docs/open/`、`docs/articles/`、`docs/images/`、`docs/skills/`
- 公开初始化模板和固定团队配置

## 发版时会保留什么

全量更新不是删除用户环境。同步时应保留：

- `.git/`
- `node_modules/`
- `.venv/` / `venv/`
- `.env` / `.env.*`
- `.codeflowmu/mobile-gateway.json`
- `projects/`
- 旧版 `workspace/`
- 用户添加的外部项目目录

## 维护规则

1. 应用代码改母版对应源码，不改 `release/open-dev-team`。
2. GitHub 首页改 `editions/open-dev-team/README.md` 和 `README.zh.md`。
3. 安装说明改 `editions/open-dev-team/INSTALL.md`。
4. 公开文章改 `editions/open-dev-team/github/articles/`。
5. 开源版页面模板改 `editions/open-dev-team/pages/`。
6. 开源版 UI 配置改 `editions/open-dev-team/panel/`。
7. 公开图片改 `D:\codeflowmu\docs\images\`，确保 README 引用的是公开可发布图片。
8. 发版后检查 `D:\codeflowmu\release\open-dev-team\CodeFlowMu`，再同步到 `D:\CodeFlowMu-open`。

## 快速判断

| 你要做的事 | 应该改哪里 |
|---|---|
| 改 GitHub 首页介绍 | `D:\codeflowmu\editions\open-dev-team\README.md` / `README.zh.md` |
| 新增公开文章 | `D:\codeflowmu\editions\open-dev-team\github\articles\` |
| 更新安装手册 | `D:\codeflowmu\editions\open-dev-team\INSTALL.md` |
| 更新公开图片 | `D:\codeflowmu\docs\images\` |
| 检查发版结果 | `D:\codeflowmu\release\open-dev-team\CodeFlowMu\` |
| 运行开源版 | `D:\CodeFlowMu-open\START-CODEFLOWMU-OPEN.bat` |
| 开发用户项目 | `D:\CodeFlowMu-open\projects\newproject`、旧版已登记项目或用户添加的外部项目根 |
| 提交公开仓库 | `D:\CodeFlowMu-open` |
