# CodeFlowMu Open 开源版本发布规则与操作手册

> 本文是 CodeFlowMu Open 的发布边界规则。目标不是“把母版目录复制一份”，而是从母版源码构建一个可审计、无运行态、无用户数据、首次启动完全独立的公开发行版。

## 0. 文档权威性

本文是 CodeFlowMu Open 发版的**唯一规范性手册**。构建脚本、版本控制器、发布面板、安全同步、首次启动器和升级逻辑都必须遵守本文。

```text
母版源文件：editions/open-dev-team/github/articles/open-release-rules.md
开源生成位置：docs/articles/open-release-rules.md
构建器：scripts/build-open-dev-team.mjs
校验器：scripts/verify-open-dev-team.mjs
版本控制器：scripts/open-edition-version-controller.mjs
```

发生冲突时：

1. 先停止发布。
2. 以本文定义确认正确语义。
3. 同时修正文档、实现和测试。
4. 禁止只改脚本、不改手册；也禁止手册写一套、程序执行另一套。

任何发版流程新增、删除、改名、重排或改变失败语义时，都必须在同一个母版提交中完成三件事：更新本手册、更新实现、更新自动化测试。发现手册没有覆盖现有行为时，必须先补齐文件、命令、输入、输出、顺序、门禁、错误码和恢复动作，再允许发布。发行校验器必须检查本手册的关键门禁章节仍然存在，防止后续修改再次把规则“改没”。

本文的修改必须对应 ADMIN 明确授权的 TASK。

## 1. `newproject` 的来源与作用

### 1.1 它是什么

`newproject` 是 CodeFlowMu Open 自带的**默认兜底项目**，不是临时目录，也不是等待删除的示例。

- 客户不创建或不添加其他项目时，始终使用 `newproject`。
- 客户添加其他项目后，可以在 Panel 中切换；`newproject` 仍保留为可切回的本地项目。
- `newproject` 必须完成 dev-team/FCoP 初始化，首次启动即可使用。
- `newproject` 的初始聊天、TASK、REPORT、ISSUE 和业务代码必须为空。

### 1.2 它怎么生成

`newproject` 不能从母版 `workspace` 复制，也不能从本机旧安装复制。它按以下链路产生：

```text
构建阶段
  scripts/build-open-dev-team.mjs
    → 调用官方 fcop Project.init(team="dev-team", lang="zh")
    → 生成 templates/default-project
    → 生成空 ledger 骨架
    → 校验没有历史 TASK / REPORT / chat

首次启动阶段
  codeflowmu-shell/src/open-start.ts
    → 检查 projects/newproject/fcop/fcop.json
    → 不存在时复制 templates/default-project
    → 得到实际 projects/newproject
    → 在安装级项目注册表中登记为 open-default-newproject
```

### 1.3 为什么使用模板而不直接提交运行目录

公开 Git 仓库必须提供一个可初始化的默认项目，但 `projects/newproject` 又会在客户使用后产生聊天、任务和业务代码。

因此采用“模板与运行目录分离”：

| 路径 | 是否进入公开 Git | 内容 |
|---|---|---|
| `templates/default-project` | 是 | 已初始化、无历史数据的只读发布模板 |
| `projects/newproject` | 否 | 首次启动从模板复制出的真实兜底项目，后续归客户使用 |

这样既保证 clone 后开箱即用，也保证客户运行数据不会在下一次发版时被提交。

### 1.4 模板允许和禁止的内容

允许：

```text
README.md
AGENTS.md
CLAUDE.md
.cursor/rules/
fcop/fcop.json
fcop/LETTER-TO-ADMIN.md
fcop/shared/
fcop/ledger/*.jsonl（必须为空）
fcop/ledger/views/（空视图骨架）
fcop/_lifecycle/（空桶）
```

禁止：

```text
聊天消息
真实 TASK / REPORT / ISSUE / REVIEW
附件
业务代码
Agent session/checkpoint
母版路径或母版项目 ID
用户 API Key、Token 或 .env
```

### 1.5 `newproject` 的升级规则

- 构建新版本时：始终重新生成干净的 `templates/default-project`。
- 发布到公开 Git 时：只提交模板，不提交本机 `projects/newproject`。
- 客户升级时：保留客户的 `projects/newproject` 及旧版 `workspace/<项目>`，不得用新模板覆盖。
- 客户明确选择“重置默认项目”时：必须先提示会丢失该项目数据，并由客户确认；普通升级绝不执行重置。

## 2. 核心原则

开源发布必须满足以下不变量：

1. **源码可派生，运行态不可继承。** 开源版源码可以从母版中筛选生成，但不得继承母版的项目、聊天、任务、报告、账本、会话或缓存。
2. **首次安装完全独立。** 新安装不得读取母版项目注册表，不得自动关联母版目录，也不得从用户全局目录迁移母版项目。
3. **发布包是干净产品，不是旧安装快照。** 发行树只能包含应用代码、公开文档、公开协议资产和一个已初始化但没有历史数据的默认项目模板。
4. **当前项目是唯一运行根。** 用户首次启动后，安装器从干净模板生成已初始化的 `projects/newproject`；已有注册表中的绝对路径（包括旧版 `workspace/<项目>`）优先。用户主动切换项目后，Runtime、MCP、Watcher、ledger 和 Agent cwd 才切换到该项目。
5. **安装代码不可被 Agent 持久修改。** Open 不削减 Agent 的正常工具能力；运行时自保护壳负责把发行版代码维持在启动基线，业务开发仍以 Panel 当前项目根为工作上下文。
6. **Runtime 状态按真实项目根隔离。** Open 的 Agent 注册、sdk_agent_id、session 与 inbox 数据写入当前项目 `.codeflowmu/runtime`；禁止仅按 `newproject` slug 复用用户全局 Runtime 状态。

## 3. 五种目录与职责

| 名称 | 示例 | 职责 | 能否包含用户运行态 |
|---|---|---|---|
| 母版源码仓库 | `D:\codeflowmu` | 开发、测试、生成开源版 | 可以，但不得进入发行包 |
| 开源发行树 | `release/open-dev-team/CodeFlowMu` | 本次待发布的纯净产物 | **绝对不可以** |
| 本地公开仓库 | `D:\CodeFlowMu-open` | GitHub 公开仓库的本地工作副本 | Git 工作树必须干净；本机测试态不得提交 |
| 新用户安装目录 | 用户 clone/download 的目录 | 首次运行 Open | 首次启动前不存在运行态 |
| 用户项目目录 | `projects/newproject`、兼容的旧版 `workspace/<项目>` 或外部目录 | TASK、REPORT、聊天、附件和产品代码 | 可以，归用户所有 |

母版源码仓库与开源运行时之间只能存在“构建时源码派生关系”，不能存在“运行时项目状态继承关系”。

## 4. 发布流程

### 4.0 发版涉及的文件与职责

下表是发版链路的文件级地图。任何脚本、目录或产物发生变化时，必须同步更新本表、实现和测试。

| 类别 | 路径 | 作用 | 发版时如何处理 |
|---|---|---|---|
| 规范源 | `editions/open-dev-team/github/articles/open-release-rules.md` | 本手册唯一规范源 | 修改发版行为时必须先/同时更新；构建时投影为公开仓库的 `docs/articles/open-release-rules.md` |
| 版本与审批清单 | `editions/open-dev-team/manifest.json` | Open/母版版本、目标仓库、功能边界、已批准 change group 及路径 | 构建前读取；未登记或未批准差异由审批过滤器移除，禁止临时绕过 |
| 基础包含清单 | `editions/open-dev-team/include.list` | 定义可进入候选发行树的母版目录和文件 | 按 glob 从母版复制；它只表示“可候选”，不代表差异已经获批 |
| 强制排除清单 | `editions/open-dev-team/exclude.list` | 排除 Git、密钥、依赖缓存、运行态、母版计划文档和临时文件 | 优先级高于 include；命中项不得进入发行树 |
| Open 专属覆盖 | `editions/open-dev-team/github/**` | 公开仓库专属 README、文档、工作流、模板等 | 构建时覆盖/投影到发行树对应路径，不直接运行母版同名文件 |
| 构建器 | `scripts/build-open-dev-team.mjs` | 清空并生成发行树、应用审批过滤、生成版本/模板/启动文件、校验依赖闭包和写校验和 | 输出固定到 `release/open-dev-team/CodeFlowMu`；失败立即停止 |
| 版本控制器 | `scripts/open-edition-version-controller.mjs` | 检查版本、比较公开基线、批准功能组、执行版本升级 | `check`、`diff`、`verify-release` 必须按当前发布意图使用；已发布有差异时先 bump |
| 发行树校验器 | `scripts/verify-open-dev-team.mjs` | 独立验证发行树边界、版本、审批、校验和、启动契约和模块依赖闭包 | 构建后、同步前运行；失败不得同步 |
| 公开目标校验器 | `scripts/verify-open-public-target.mjs` | 比较发行树与 `D:\CodeFlowMu-open`，确认同步完整且保留项未泄漏 | 同步后、commit 前运行；失败不得提交 |
| Panel 编排入口 | `codeflowmu-shell/src/web-panel.ts` | 执行“版本检查→准备目标仓库→构建→验证→审批→同步→目标验证→提交→推送”，记录每步输出 | 任一步 `ok=false` 必须停止后续步骤；禁止吞掉 stderr 或继续推送 |
| 发版记录 | `.codeflowmu/open-release-history.jsonl` | 保存每次 Panel 发版的版本、路径、步骤、退出码和日志尾部 | 只作母版本机审计，不进入公开包 |
| 中间发行树 | `release/open-dev-team/CodeFlowMu/` | 本次唯一允许同步到公开仓库的源 | 每次从零生成；不得手改，不得从目标仓库反向补文件 |
| 发行清单 | `release/open-dev-team/CodeFlowMu/RELEASE_MANIFEST.json` | 记录源 commit、dirty 状态、审批过滤、包含/排除项和校验和数量 | 由构建器生成；不得手改；必须显示 `sourceDirty=false` 才可正式发布 |
| 版本文件 | `VERSION.json`、`VERSION_HISTORY.json`、各 `package.json`/lock | 对外版本与 npm 版本 | 构建器统一重写；校验器检查一致性 |
| 完整性文件 | `SHA256SUMS` | 发行树逐文件 SHA-256 | 所有生成与过滤完成后最后生成；之后修改任何发行文件都必须重新构建 |
| Open 启动入口 | `codeflowmu-shell/src/open-start.ts` | 创建/恢复默认项目、设置 Open 环境、启动完整性保护并加载 `main.ts` | 构建器生成；目标仓库真实启动必须从这里执行 |
| 目标公开仓库 | `D:\CodeFlowMu-open` | `joinwell52-AI/CodeFlowMu-open` 的本地 Git 工作副本 | 可以预先存在；先 fetch/checkout GitHub `main`，再安全同步发行树；不得拿旧残留补足缺失文件 |
| 公开远端 | `https://github.com/joinwell52-AI/CodeFlowMu-open.git` | 对外发布源 | 只有目标校验和真实启动冒烟通过后才能 commit/push |

### 4.0.1 文件从母版到公开仓库的处理顺序

每个普通源码文件必须经历以下状态，不允许跨级：

```text
母版 Git 已跟踪文件
  → include.list 候选
  → exclude.list 排除检查
  → manifest.json change group 审批检查
  → release/open-dev-team/CodeFlowMu 中的发行文件
  → 相对 import 依赖闭包检查
  → RELEASE_MANIFEST.json + SHA256SUMS 固化
  → verify-open-dev-team.mjs 独立校验
  → 安全同步到 D:\CodeFlowMu-open
  → verify-open-public-target.mjs 目标校验
  → 在 D:\CodeFlowMu-open 安装依赖并执行 npm start
  → 查看 Shell/Runtime/Panel 启动日志
  → git add/commit
  → git push origin main
```

各类文件处理规则：

- **普通源码**：原路径复制；必须同时包含全部相对依赖。
- **Open 专属覆盖文件**：从 `editions/open-dev-team/github/**` 投影到公开路径，覆盖候选树同名文件。
- **生成文件**：只能由构建器生成，并登记在批准组；禁止从旧发行树或目标仓库复制回来。
- **母版运行态**：即使在 Git 工作树出现，也必须被排除，不能登记进 change group。
- **目标仓库保留项**：仅保留 `.git/`、本机依赖、`.env`、用户项目/运行态；这些文件不进入 commit。
- **目标仓库旧应用文件**：发行树不存在的旧应用源码必须删除，不能因为“可能有用”而残留。
- **未跟踪源码**：构建前必须加入母版 Git；否则 provenance 不完整，禁止发布。

### 4.0.2 Panel“发布开源版本”的逐步语义

Panel 的完整发布动作必须严格按下列顺序执行并展示每一步 stdout/stderr：

1. **检查母版本地待发布版本**：运行版本控制器 `check`，确认 manifest、母版版本和 Open 版本合法。
2. **准备并读取目标 GitHub 仓库**：目标目录不存在则 clone；存在则确认 origin，执行 fetch，并把本地 `main` 对齐 `origin/main`。目录已存在不是错误。
3. **发版预审：比较本地版本与 GitHub 版本**：直接读取本地 `editions/open-dev-team/manifest.json` 的待发布版本与 GitHub `main` 的 `VERSION.json`。本地版本必须严格高于 GitHub 版本；相等表示该版本已发布，低于表示版本回退，两者都必须在构建前立即停止。
4. **基于 GitHub 基线构建本地开源版本**：清空旧发行树，重新执行构建器；审批过滤以刚读取的公开 `main` 为基线。
5. **验证本地开源发布物**：运行发行树校验；此时必须发现路径遗漏、模块缺失、版本不一致、dirty source、未批准差异和校验和错误。
6. **比较实际差异与变更审批**：运行版本控制器 `verify-release`，确认本轮发行树的所有实际差异都属于批准组。此步骤是构建后的审批复审，不得替代构建前版本预审。
7. **安全同步**：只从发行树写入目标仓库；保留明确允许的本机状态，删除发行树已不存在的旧应用文件。
8. **验证目标仓库**：比较发行树与目标仓库，确认每个应发布文件均存在且内容一致。
9. **安装依赖与真实启动冒烟**：在目标仓库执行依赖安装和 `npm start`；等待 Shell、Runtime、Panel 完成加载，再主动停止测试进程。
10. **检查 Git diff**：确认 staged 候选只包含公开源码、文档、模板和版本文件，不含 workspace、账本、日志、密钥或依赖。
11. **提交公开仓库**：提交信息必须包含 Open 版本和对应 TASK/审批记录。
12. **推送 GitHub**：只推送已通过全部校验和启动冒烟的 commit；推送失败不得伪造发布成功记录。

发版预审的判定必须简单且固定：

| 本地待发布版本 | GitHub `main` 版本 | 预审结论 | 后续动作 |
|---|---|---|---|
| 高于 GitHub | 已存在 | 通过 | 允许进入构建 |
| 等于 GitHub | 已存在 | `VERSION_ALREADY_PUBLISHED` | 先成对升级母版/Open 版本，再由 ADMIN 重新审批 |
| 低于 GitHub | 已存在 | `VERSION_ROLLBACK_BLOCKED` | 修正本地版本，禁止回退发布 |
| 合法版本 | GitHub 尚无 `VERSION.json` | `FIRST_PUBLIC_RELEASE` | 按首次发布继续 |
| 任一版本格式非法 | 任意 | `OPEN_VERSION_FORMAT_INVALID` | 修复版本文件后重跑预审 |

预审必须同时存在于 Panel 展示和发布后端：页面应在点击前显示本地/GitHub 两个版本；即使绕过页面直接请求发布 API，后端也必须在构建前重复比较并阻断。不能把这项检查推迟到构建、校验或审批比较之后。

任何一步失败时，发版记录必须保存失败步骤、退出码、stderr 和路径；修复后从“准备目标仓库/重新构建”开始重跑，
不得只在 `D:\CodeFlowMu-open` 手工补一个文件后继续 commit。

### 4.1 阶段 A：母版准备

发布前必须：

- 明确本次公开功能组和对应 TASK。
- 母版 Git 工作树达到可审计状态。
- 版本号、母版版本号和 Open 版本号一致。
- 所有进入 Open 的文件都属于已批准功能组。

禁止：

- 用未提交的临时文件直接拼发行包。
- 把母版运行日志或项目目录登记成公开功能。
- 因为“本机能运行”就跳过版本和边界检查。

### 4.2 阶段 B：构建发行树

构建器从母版按 include/exclude 和发布审批规则生成：

```text
release/open-dev-team/CodeFlowMu
```

构建是**重新生成**，不是增量复制旧发行目录。开始构建时必须先清空旧发行树，再从批准的源码重新创建。

发行树允许包含：

- Open 应用源码和静态资源
- 公开 FCoP 协议资产
- 公开文档
- 版本文件、发布清单和校验和
- `workspace/README.md`
- `templates/default-project/`：已完成 dev-team/FCoP 初始化的干净兜底项目模板

发行树绝对禁止包含：

```text
.codeflowmu/projects-registry.json
.codeflowmu/runtime/
.codeflowmu/report-watcher/
fcop/chat/
fcop/logs/
fcop/tasks/
fcop/reports/
fcop/issues/
fcop/_lifecycle/
fcop/attachments/
workspace/<旧项目>/
用户会话数据库或 Agent checkpoint
.env、API Key、Token、私有 Gateway 配置
```

发行树不直接携带正在运行的 `projects/newproject`。它携带 `templates/default-project`，其中允许存在初始化所需的 `fcop/fcop.json`、规则、角色模板和空 ledger 骨架；不得存在聊天、历史任务、历史报告、附件或产品代码。首次启动时才复制成实际的 `projects/newproject`。

### 4.2.1 新增源码与依赖闭包登记

任何进入 Open 的源码都必须以“可启动的依赖闭包”登记，不能只登记本次直接修改的入口文件。
当一个已批准文件新增 `import`、`export ... from`、动态 `import()` 或其他运行时加载关系时，
发布者必须沿每一条相对路径依赖逐级检查，直到所有本地依赖都已经包含在发行树中。

以本次故障为例：

```text
codeflowmu-shell/src/web-panel.ts
  → import "./artifact-layout.ts"
  → editions/open-dev-team/manifest.json 必须登记 artifact-layout.ts
  → 构建后的 release/open-dev-team/CodeFlowMu 中必须真实存在该文件
  → 同步后的 D:\CodeFlowMu-open 中也必须真实存在该文件
```

新增或移动源码文件时必须逐项完成：

1. 确认源文件已经加入母版 Git，禁止依赖未跟踪文件发版。
2. 找出该文件的所有相对 `import`、`export ... from` 和动态 `import()`。
3. 将入口文件及其全部本地依赖登记到同一个已批准 change group；测试、模板和运行时生成文件也适用。
4. 如果依赖属于另一个已批准功能组，必须确认该功能组同时处于本次发布审批范围，不能依赖未选中的功能组。
5. 构建器完成审批过滤后，必须重新扫描发行树的相对模块依赖；任何目标文件缺失立即令构建失败。
6. 校验器必须独立重复依赖闭包检查，不能只相信构建器的 included 记录。
7. 同步到公开仓库后必须再次检查依赖闭包，并从目标目录真实启动一次，不能只在母版目录运行测试。
8. 真实启动至少要运行到 Shell、Runtime 与 Panel 完成加载；出现 `ERR_MODULE_NOT_FOUND`、缺少导出或模块初始化失败，一律禁止提交和推送。

以下做法均不合格：

- 只在 change group 中登记 `web-panel.ts`，漏掉它新引用的本地模块。
- 因为母版本机能运行，就假定审批过滤后的 Open 发行树也能运行。
- 构建成功后不检查发行树，直接同步到 `D:\CodeFlowMu-open`。
- 只检查文件清单或 SHA-256，不执行目标仓库启动冒烟。
- 用目标仓库旧版本残留文件掩盖本次发行树缺失；发布同步必须能在无该残留文件时正常启动。

### 4.3 阶段 C：发行校验

发布前校验必须同时检查：

1. **路径检查**：没有禁止目录和旧项目文件。
2. **内容检查**：没有密钥、私有地址、用户数据和机器本地绝对路径。
3. **注册表检查**：发行树不存在项目注册表。
4. **启动代码检查**：Open 启动器不得读取 `%USERPROFILE%/.codeflowmu/v2/projects-registry.json` 或任何母版注册表。
5. **版本检查**：根包、Shell、Runtime、`VERSION.json`、`RELEASE_MANIFEST.json` 版本一致。
6. **审批检查**：所有差异属于 ADMIN 已批准功能组。
7. **Git 检查**：构建来源可定位到明确 commit。
8. **校验和检查**：发布清单记录的 SHA-256 与文件一致。
9. **依赖闭包检查**：所有相对源码导入在发行树中都有真实目标文件，审批过滤没有移除运行必需模块。
10. **目标启动检查**：同步后的公开仓库安装依赖后可以从 `src/open-start.ts` 启动，不出现模块缺失、导出缺失或初始化异常。

任何一项失败都必须停止，不得继续同步、提交或推送。

### 4.4 阶段 D：同步公开仓库

“同步公开仓库”是把已经通过校验的发行树写入本地公开 Git 仓库，不是把母版目录复制过去。

发布同步允许保留：

- `.git/`
- 本机安装依赖：`node_modules/`、`.venv/`（仅本地，不提交）
- 本机 `.env`（仅本地，不提交）

发布同步不得把以下本机测试态当作公开内容提交：

- 项目注册表
- `workspace` 中的真实项目
- 运行日志、聊天、TASK、REPORT、ledger
- Agent 会话和 checkpoint

如果 `D:\CodeFlowMu-open` 同时被当作本地测试安装，发布同步后必须执行一次“干净首次启动检查”。测试态可以存在于本机，但必须被 Git 忽略且不得影响新发行树。

### 4.5 阶段 E：首次启动

全新 Open 首次启动必须按以下顺序执行：

1. 若注册表没有可用的绝对项目根，且安装目录中的 `projects/newproject/fcop/fcop.json` 不存在，从 `templates/default-project` 复制生成完整兜底项目；旧版 `workspace/newproject` 存在时原地兼容，不搬迁。
2. 如果安装级项目注册表不存在，在**本安装目录内**创建：

```json
{
  "version": 1,
  "activeProjectId": "open-default-newproject",
  "projects": [
    {
      "id": "open-default-newproject",
      "name": "newproject",
      "root": "<本次 Open 安装目录>/projects/newproject"
    }
  ]
}
```

3. 不读取母版注册表，不扫描 `D:\codeflowmu`，不迁移任何旧项目。
4. Panel 显示 `newproject` 为唯一当前项目。
5. 聊天、任务、报告列表为空。
6. 环境检查显示默认项目已经完成 FCoP 初始化，可以直接使用。
7. 默认项目的聊天、任务和报告为空；用户第一次实际操作后才产生运行态。

首次启动不能因为本机以前运行过母版，就自动出现母版项目或母版聊天。

## 5. 标准发版操作顺序

### 5.1 发布前

1. 在母版完成对应 TASK、代码和测试。
2. 确认当前版本号是新的、尚未发布的 Open 版本。
3. 在发布面板勾选本次允许公开的功能组并保存。
4. 提交母版 Git；运行态 ledger/workspace 噪声必须由构建器识别并排除。

### 5.2 构建

面板“构建本地开源版本”对应：

```bash
npm run build:open-dev-team
```

必须得到：

```text
release/open-dev-team/CodeFlowMu
```

构建器会删除旧发行树并从零生成。不得手工把 `D:\CodeFlowMu-open` 或母版 `workspace` 复制到发行树。

### 5.3 校验

```bash
npm run verify:open-dev-team
npm run open:version:check
```

两项都通过才允许进入同步。

### 5.4 安全同步

安全同步的来源只能是：

```text
release/open-dev-team/CodeFlowMu
```

目标是本地公开 Git 仓库。同步器必须：

- 更新应用源码和发布模板。
- 保留 `.git`、本机依赖和本机密钥文件。
- 不把母版目录或母版运行态复制到公开仓库。
- 不把公开仓库本机测试产生的 workspace 数据加入 Git。

### 5.5 公开仓库校验

同步后必须运行目标仓库校验，并人工确认 Git diff：

```text
允许：源码、文档、模板、版本文件
禁止：聊天、任务、报告、日志、真实 workspace、项目注册表、密钥
```

### 5.6 提交与推送

只有前面全部通过才允许：

1. 提交公开仓库。
2. 推送 GitHub。
3. 创建 Release 或发布包。

任一步失败都停止，不得“先推上去再修”。

## 6. 首次安装与升级必须分开

### 6.1 首次安装

首次安装的定义：安装目录内没有 Open 自己的项目注册表和运行状态。

行为：

- 创建全新的 `newproject` 注册表。
- 不迁移母版项目。
- 不显示任何旧聊天或旧 TASK。

### 6.2 用户升级

用户升级的定义：用户已经在同一个 Open 安装中主动添加并使用过项目。

升级可以保留：

- 用户项目目录
- 用户主动登记的 Open 项目列表
- `.env`、依赖和虚拟环境

但必须满足：

- 注册表是 Open 安装自己的注册表，而不是母版全局注册表。
- 每个项目都是用户在 Open 中主动添加的。
- 升级保留项永远不进入 Git 发布包。

如果发布工具无法可靠区分“公开仓库测试态”和“真实用户升级态”，必须选择更安全的行为：发布目标使用干净首次启动；用户升级由独立 updater 处理，不得混用一个同步按钮。

## 7. 多项目规则

首次启动只有 `newproject`，但 Open 仍然支持多项目：

1. 用户在 Panel 中主动添加项目目录。
2. 用户点击“设为当前”或使用顶部项目下拉框。
3. Panel `active.root` 成为唯一真相源。
4. Runtime 停止旧项目会话并热重载。
5. MCP `FCOP_PROJECT_DIR`、Agent cwd、Watcher、ledger 和聊天全部切到新根。
6. 切换后不得继续显示旧项目聊天或任务。

多项目支持不等于自动导入母版项目。

### 7.1 独立项目、已有项目与业务工作区

三个动作不得混用：

| 动作 | 入口 | 是否创建目录 | 是否 FCoP 初始化 | 是否登记/切换当前项目 |
|---|---|---|---|---|
| 新建独立项目 | 设置 → 项目 → 新建独立项目 | 是，目录须不存在或为空 | 是 | 是，用户确认后切换 |
| 添加已有项目 | 设置 → 项目 → 添加已有项目 | 否，目录必须已存在 | 缺失时由环境预检初始化 | 用户点击“设为当前” |
| 创建业务工作区 | PM `new_workspace` | 在当前项目的 `workspace/<slug>` 创建 | 否 | 否 |

“新建独立项目”必须由母版控制面完成 `mkdir → FCoP init → registry add → explicit switch`。
切换是显式用户动作；不得让正在旧项目执行的 Agent/TASK 自行切换，因为项目切换会
停止旧 Runtime/Watcher、重绑 MCP 与 ledger，旧任务的证据链不能跨项目迁移。

## 8. Open 自保护壳规则

Open 是 AI 开发工具，不能采用传统软件“先收回工具权限、再逐项放行”的方式保护自身。
Open Agent 保持正常工具能力；工具自身安全由应用内 **Install Integrity Shell** 负责。

自保护范围：

```text
codeflowmu-shell/
codeflowmu-desktop/
packages/
docs/
skills/
templates/
fcop/adopted/
发行版根目录的启动、版本、清单和包配置文件
```

不属于自保护范围的运行态包括 `workspace/`、项目内 `fcop/`、安装根遗留/兼容
`fcop/ledger`、运行日志、项目注册表、依赖缓存和用户配置。它们必须保持正常可写。
禁止保护整个安装根 `fcop/`，否则 ledger 重建与自保护删除会形成循环。

自保护壳必须：

1. 在 Runtime 和 Agent 启动前读取受保护文件，建立内存基线与 SHA-256。
2. 监控受保护目录，并用周期审计兜底，不能只依赖命令字符串识别。
3. 已有文件被改写、删除或被链接替换时，自动恢复启动基线。
4. 受保护目录中新出现的代码文件自动删除。
5. 每次恢复或删除都输出安全事件，供 Panel 和日志审计。
6. 不因普通项目内编辑或 Shell 写入取消整个 Agent 会话。

该机制保护的是“运行中的 Open 不被自己的 Agent 改坏”，不是对本机操作系统管理员或
主动停止应用后的人工篡改提供 DRM。升级由发行工具在 Open 停止后替换安装代码。

### 8.1 功能等价优先级

Open 的安全边界只能限制“写到哪里”，不得删除正常项目开发所需的能力。相同的 TASK、
相同的团队配置和相同的模型，在母版与 Open 上必须形成等价的协作链：

```text
ADMIN → PM → DEV → QA → OPS → PM → ADMIN
```

以下行为属于发版阻断缺陷：

- 为保护安装目录而让 PM 无法创建受控工作区或派发子任务；
- 为保护安装目录而让 DEV / QA / OPS 无法写 Panel 当前项目；
- Open 专属启动参数导致 TASK 永久停在 inbox；
- 工具策略要求使用某个 MCP 工具，但该角色的工具 profile 未暴露该工具；
- 一次可恢复的工具拒绝导致整个父任务永久失去继续执行入口；
- 用巡检聊天代替正式 TASK 会话，或反复写 in_progress REPORT 而不派单。

发布时不得以“安全限制”为理由接受功能瘫痪。正确做法是保持 Agent 工具能力完整，
由应用内自保护壳恢复安装代码；不得再用权限缩减代替代码保护。

### 8.2 三层目录权限模型

| 区域 | 示例 | Agent 权限 |
|---|---|---|
| 工具安装根 | `D:\CodeFlowMu-open\packages`、`codeflowmu-shell`、`codeflowmu-desktop` | 全角色只读 |
| 当前项目根 | `D:\CodeFlowMu-open\projects\codedaysign`、旧版登记绝对路径或外部项目 | 按角色完整工作 |
| 非当前项目/母版 | `D:\codeflowmu`、项目 A（当前为 B） | 全角色禁止写 |

项目位于 Open 安装目录下的 `workspace/<project>` 时，它仍是独立的当前项目根，
不得因为父目录是安装根而整体只读。边界判断必须使用真实路径，并防止通过
`..`、junction、symlink、绝对路径或 Shell 子进程越界。

### 8.3 角色能力矩阵

| 角色 | 当前项目允许 | 工具安装根 |
|---|---|---|
| PM | `new_workspace`、`list_workspaces`、TASK/REPORT/治理 MCP；工具能力不被 Open 削减，协议要求实现工作交给下游 | 自保护壳恢复改动 |
| DEV | 实现业务代码、测试、构建所需读写和 Shell | 自保护壳恢复改动 |
| QA | 测试代码、证据和必要测试脚本读写 | 自保护壳恢复改动 |
| OPS | 构建、检查、证据和通用部署配置读写 | 自保护壳恢复改动 |
| EVAL | 观察与受控证据写入 | 自保护壳恢复改动 |

PM 创建工作区只能使用 `new_workspace`，不得退回 Python、PowerShell、CMD 或编辑
工具创建目录和元数据。`new_workspace` 必须属于 PM 的 leader tool profile，且
策略层和 fallback 层同时允许。工作区创建后，PM 必须在同一轮调用 `write_task`，
不能把“目录已创建”当作任务完成。

### 8.4 协议约束与代码保护的职责

1. **FCoP 协议层**负责角色分工、派单、回执和验收；它不能被当成文件系统安全沙箱。
2. **自保护壳**负责发行代码不可持久修改；它不限制业务项目开发能力。
3. **提示与日志**负责告知 Agent 边界并留下审计证据；提示本身不是安全边界。

禁止再以正则命令分类器或 SDK `tool_call=running` 后取消会话作为 Open 的主要保护。
这类机制既可能在命令已经开始后才生效，也会把可恢复的误操作升级成整条任务失败。

### 8.5 功能等价冒烟测试（发布必跑）

每个 Open 候选版本必须在全新测试项目执行一次最小 Cold Path：

1. ADMIN 发布一个要求创建简单静态页的 TASK。
2. 父任务从 inbox 进入 active，并绑定 PM 正式任务会话。
3. PM 通过 `new_workspace` 创建 `workspace/<slug>`。
4. PM 通过 `write_task` 生成带正确 `parent` 和 `thread_key` 的 DEV 子任务。
5. DEV 能在当前项目内创建代码和 REPORT。
6. PM 在 DEV 回执后派发 QA；QA 独立回执。
7. PM 派发 OPS；OPS 独立回执。
8. 三条支线均完成后，PM 向 ADMIN 提交最终汇总。
9. 全流程中篡改安装代码必须被自保护壳恢复，且安装根 Git diff 不得留下 Agent 修改。

Windows 上的 TASK 唤醒不得只依赖一次文件系统 `add` 事件。Runtime 必须同时运行周期性
inbox 对账：扫描合法 TASK、确认 frontmatter 仍为 `state: inbox`，再统一进入 dispatch
control plane。监听事件与周期对账并发时，claim/lifecycle 幂等门必须保证同一 TASK 只启动
一次。任何 PM 子任务在 inbox 停留超过一个对账周期且目标 Agent idle，均判定为发版阻断。
API 立即派发、watcher、周期对账和恢复队列可能属于不同 `TaskDispatcher` 实例；同一进程
必须共享规范化绝对路径 claim 锁。锁不得只存在于单个实例，否则会重复执行 inbox→active、
启动多个 Agent 会话，严重时把 TASK 竞争成 0 字节。

验收证据至少包含：TASK 路径、REPORT 路径、session 记录、角色 todo 视图、运行日志和
安装根 `git status --short`。少任一环，Open 不得发版。

## 9. 发布验收清单

### 9.1 静态产物

- [ ] 所有新增源码文件已经加入母版 Git，不存在运行依赖未跟踪文件。
- [ ] 每个新增相对 import 的目标文件均登记在已批准 change group。
- [ ] 构建完成和审批过滤完成后，相对 import/export/dynamic import 依赖闭包检查为零缺失。
- [ ] `web-panel.ts`、`main.ts`、`open-start.ts` 等启动主链的全部本地模块均存在于发行树。
- [ ] 发行树由空目录重新生成。
- [ ] 发行树包含完整的 `templates/default-project` 初始化模板，不包含正在运行的 `projects/newproject` 或旧版 `workspace/newproject`。
- [ ] 不存在项目注册表。
- [ ] 不存在聊天、TASK、REPORT、ledger、日志和附件。
- [ ] 不存在密钥和私有配置。
- [ ] 启动器不包含母版全局注册表迁移逻辑。

### 9.2 干净首次启动

- [ ] 在新目录解压/clone，不复用旧安装目录。
- [ ] 启动后项目下拉框只有 `newproject`。
- [ ] 当前根位于本次 Open 安装目录下。
- [ ] 聊天为空。
- [ ] 任务和报告为空。
- [ ] 环境检查显示 `newproject` 已初始化且可直接使用，不引用旧项目。
- [ ] 第一次聊天或派单产生的文件只写入 `newproject`。
- [ ] Runtime 数据目录为当前项目 `.codeflowmu/runtime`，全新安装不读取同名旧项目的 agent/session。

### 9.3 多项目与沙箱

- [ ] 用户主动添加项目 A 后可切换到 A。
- [ ] A → B → A 后 Runtime/MCP/Watcher/聊天均一致。
- [ ] Agent 写当前项目成功。
- [ ] Open 自保护壳在 Runtime 前启动并建立代码基线。
- [ ] 修改/删除已有工具代码会自动恢复。
- [ ] 在受保护目录新增代码文件会自动删除。
- [ ] `workspace/<project>` 的业务写入不受自保护壳影响。
- [ ] PM leader profile 包含 `new_workspace`、`list_workspaces` 和 `write_task`。
- [ ] 默认项目及切换后的已有项目包含公开 `windows-use`、`browser-use` Skill 包，catalog 缺包为 0。
- [ ] 全新默认项目同时包含 `docs/skills/agent-skills.manifest.json` source-of-truth 与 `.codeflowmu` projection，catalog 不得 404。
- [ ] PM 使用受控 MCP 创建工作区后能在同一轮派发 DEV。
- [ ] 故意漏掉一次文件监听事件后，周期对账仍能将 inbox TASK 自动派发。
- [ ] 同一 TASK 不会因 watcher 与周期对账同时命中而启动两个 Agent 会话。
- [ ] API 创建 TASK 与 watcher 同时命中时只产生一个 session，物理 TASK 非 0 字节且 frontmatter 完整。
- [ ] 每个子任务只生成一份有效最终 REPORT；fallback 不得留下重复或缺字段回执。
- [ ] REPORT 幂等键须把长 task_id（含 `-PM-to-DEV`）与短 task_id（数字前缀）规范为同一任务。
- [ ] PM 向 ADMIN 提交 `status=done` 的最终 REPORT 后，系统自动生成 EVAL 旁路观察；“生成/刷新 EVAL”按钮只作为失败重试和人工重新评估入口。
- [ ] EVAL 生成失败必须保留可见错误并允许重试，不得静默卡在“待生成 EVAL”。
- [ ] 未配置真实 AI Provider 时，`sdk-fake-*` 测试适配器不得消费正式 TASK；任务留在 inbox，并提示用户先在设置中配置 Cursor。
- [ ] “新建独立项目”和“添加已有项目”完成投影后，项目内同时存在 PM Skills 与 Agent Playbook 两份 manifest；不得只依赖宿主目录回退读取。
- [ ] 相同的 QA/OPS `waiting_dependency` 日志与 Panel 事件必须节流；周期 inbox 对账不得每轮重复刷屏。
- [ ] Open 对官方演示 Gateway 的 PWA 版本检查只读；后端拒绝远程发布，Panel 不显示“发布到 Gateway”按钮。
- [ ] QA 门禁从任务正文提取 `workspace/.../index.html` 时保留完整扩展名并正确验证产物。
- [ ] 子任务 `thread_key` 即使写错，只要 `parent` 正确，面板仍按强父子关系显示 DEV/QA/OPS，不得显示 0。
- [ ] DEV→QA→OPS 最小 Cold Path 完整闭环，与母版行为等价。
- [ ] 自保护恢复不会取消正常项目任务，安装根不留下文件副作用。

### 9.4 发布动作

- [ ] 发行校验全部通过。
- [ ] 在同步后的公开仓库执行依赖安装并真实运行 `npm start`，Shell、Runtime、Panel 均完成加载。
- [ ] 目标仓库启动日志不存在 `ERR_MODULE_NOT_FOUND`、缺少导出或模块初始化失败。
- [ ] 公开仓库 diff 不包含本机运行态。
- [ ] 提交信息引用对应 TASK。
- [ ] 推送前再次校验公开仓库。

## 10. 常见错误与处理

| 现象 | 原因 | 发布是否继续 |
|---|---|---|
| 新版出现母版项目 | 启动器迁移/读取了母版注册表 | 立即停止 |
| 新版出现旧聊天 | 当前根指向旧项目，或 Runtime 数据目录复用了全局同名缓存 | 立即停止 |
| `newproject` 不存在 | 默认模板未生成或首次启动复制失败 | 立即停止 |
| `newproject` 未初始化 | 模板生成未调用 FCoP init，或模板被发布过滤器移除 | 立即停止 |
| 构建目录有真实 workspace | 构建器复制了运行目录 | 立即停止 |
| 校验报告 dirty source | 母版尚未形成可审计 commit | 先提交母版 |
| 版本不一致 | 版本控制器未完整更新各组件 | 先修版本 |
| 未批准差异 | 功能组未获 ADMIN 授权 | 不得绕过审批 |
| `ERR_MODULE_NOT_FOUND` | 入口文件已发布，但它新增的相对依赖未登记、被审批过滤移除或未同步到目标仓库 | 立即停止；补齐 change group、依赖闭包校验和目标启动冒烟后重新构建 |
| PM 已写子任务但目标 Agent 一直 idle | Windows 文件监听漏事件，且缺少 inbox 周期对账 | 立即停止，修复 Runtime |
| 同一子任务出现两份 REPORT | MCP 正常写入与 fallback 同时落盘，或 task_id 规范化不一致 | 立即停止，修复幂等与 schema |
| QA 显示 artifact not found，但文件实际存在 | 任务正文路径提取丢失 `.html` 等扩展名 | 立即停止，修复路径解析 |

## 11. 本次问题的判定

本次出现 `flowday-sign` 和旧聊天，不是发行树打包了聊天，而是首次启动器执行了错误的兼容迁移：

```text
母版全局项目注册表
  → Open 安装级项目注册表
  → 自动选中 flowday-sign
  → Panel 读取 flowday-sign 原有聊天和 FCoP 状态
```

这违反“首次安装完全独立”规则。正确链路应为：

```text
全新 Open 安装
  → 创建本安装自己的 newproject 注册表
  → 从干净模板生成已初始化 newproject
  → 空聊天 / 空任务 / 可直接使用
  → 用户直接使用或主动添加其他项目
```

## 12. 最终硬规则

> 开源发布只发布产品能力，不发布任何一次运行的记忆。

- 母版可以生成 Open 源码，但不能给 Open 注入项目状态。
- 构建目录必须每次从零生成。
- 首次启动不得迁移母版注册表。
- 新版默认项目必须完成干净初始化，但不得包含任何历史运行数据。
- 聊天、TASK、REPORT、ledger 和 workspace 产品数据永远不进入发行包。
- 多项目只能由 Open 用户主动添加。
- Open 不通过削减 Agent 工具权限保护自身；发行代码由应用内自保护壳维持启动基线。
