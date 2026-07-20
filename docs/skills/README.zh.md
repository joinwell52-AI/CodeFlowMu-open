# CodeFlowMu Skill 文档

本目录存放 CodeFlowMu Agent Playbook skills 的长文档。

这里负责说明契约、映射、边界、角色 Playbook 和方法论。这里不是 Agent 宿主直接加载的 skill 包目录。

## 目录关系

```text
.codeflowmu/agent-skills.manifest.json  # 本地/runtime 投影副本
docs/skills/agent-skills.manifest.json  # 稳定 source-of-truth 总表
docs/skills/                            # 长说明、契约、映射、方法论
skills/*/SKILL.md                       # Agent 可直接加载复用的紧凑 skill 包
```

`docs/skills/` 解释一个 skill 为什么存在、如何贴合 CodeFlowMu/FCoP、边界是什么。`skills/` 则放紧凑的 `SKILL.md`，供 Codex、Claude、Cursor、Copilot 等 Agent 宿主加载使用。

`docs/skills/agent-skills.manifest.json` 是稳定的 source-of-truth。`.codeflowmu/agent-skills.manifest.json` 是本地/runtime 投影副本；干净初始化删除 `.codeflowmu/` 时它会丢。Shell 启动时会通过 `plantAgentSkillsManifestIfMissing(projectRoot)` 在投影缺失时从 `docs/skills/agent-skills.manifest.json` 自动恢复。如果两者都缺失，Shell 只打 warn，不生成空 manifest。

## 顶层文档

- `skill-layers.md`：MCP Skill 与 Agent Playbook Skill 两层模型。
- `common-skills.md`：十六个通用 Playbook skill，包含网页 Playwright 检查、代码搜索定位、本地命令验证、测试范围选择等基础技能。
- `pm-skills-mapping.md`：现有 PM runtime skills 映射关系。
- `role-skills.md`：角色和 persona skill 总览。
- `forbidden-v1.md`：v1 禁止注册/自动化的能力。
- `write-report-contract.md`：REPORT 共享契约。
- `detect-blocked-contract.md`：blocked 状态共享契约。
- `safe-public-draft.md`：Issue 草稿与公开提交安全边界。
- `external-skill-sources.md`：外部 GitHub skill 来源和吸收原则。
- `agent-skills.manifest.json`：Agent Playbook skills 的稳定 source-of-truth 总表。

## Playbook 分组

- `pm-playbook/`：产品经理 skills。
- `technical-manager-playbook/`：技术经理协调 skills。
- `architect-playbook/`：架构师设计与边界审查 skills。
- `dev-playbook/`：DEV 实现 skills。
- `qa-playbook/`：QA 验证 skills。
- `ops-playbook/`：OPS 运行与日志诊断 skills。
- `eval-playbook/`：EVAL 观察与晋升建议 skills。
- `ui-playbook/`：UI/UX 设计与可用性 skills。

## 边界

- 这些文档描述行为规范，不创建 runtime API。
- 不要把 Playbook 文档当成 Panel/API 实现。
- 不要从本目录修改 FCoP 正式协议。
- 不要重命名现有 `pm.*` runtime skill ID。
- 不要从这些文档自动提交公开 GitHub Issue、归档任务、删除文件或移动 lifecycle 状态。
