# adopted/pending · 已采用 · 运行时生效 · 待 ADMIN 决定是否并入正式版

本目录存放 **已采用 · 运行时生效 · 待 ADMIN 决定是否并入正式版** 的补充条款：CodeFlowMu 运行时须遵守；正式 FCoP bundled 规则版本号不变（当前 **3.2.5**）。

> **版本边界（ADMIN 定调）**：`fcop/adopted/pending/` 条款 **已采用并在 CodeFlowMu 运行时生效**；是否并入正式 FCoP 版本（如计划字段 `target_version: 3.2.6` 或后续版本），由 **ADMIN 决定**。

| 字段 | 含义 |
|---|---|
| `status: adopted-pending-release` | **已采用 · 运行时生效 · 待 ADMIN 决定是否并入正式版**（非 bundled 正式 SemVer 发布） |
| `runtime_effective: true` | 当前 CodeFlowMu Agent / PM 运行时须加载并遵守 |
| `current_protocol` | 对照用正式协议版本（**不**修改 bundled 规则版本号） |
| `target_version` | 计划吸收目标（如 `3.2.6`），**可变更**；是否发布由 ADMIN 决定 |
| `admin_review_required_for_release` | 进入正式 FCoP SemVer 前须 ADMIN 审批 |

**规则：**

- **不**修改 `.cursor/rules/fcop-rules.mdc` 等 bundled 正式规则；**不**为 pending 单独 bump 正式包版本。
- 条款可被修改、合并或撤回；以磁盘文件 + frontmatter 为准。
- CodeFlowMu 构造 Agent prompt 时会注入 `runtime_effective: true` 的摘要（见 `codeflowmu-shell/src/fcop-adopted-pending.ts`）。
- `redeploy_rules()` **不**覆盖本目录——pending 与 bundled 规则分轨维护。
