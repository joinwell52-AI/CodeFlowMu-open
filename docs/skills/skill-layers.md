# CodeFlowMu Skill Layers

CodeFlowMu uses two skill layers that must not be mixed.

## MCP Skill

MCP Skill is the tool registration layer. It declares callable tools, schemas, permissions, write boundaries, and risk levels. Examples include `fcop.write_task`, `fcop.read_task`, and `fcop.write_report`.

MCP tools execute controlled operations. They must not decide PM, EVAL, or ADMIN governance outcomes on their own.

## Agent Playbook Skill

Agent Playbook Skill is the behavior layer. It defines how an agent should read context, write reports, attach evidence, classify blocked work, and respect lifecycle authority.

The global playbook manifest is `.codeflowmu/agent-skills.manifest.json`. Long-form playbooks live under `docs/skills/`. Reusable cross-agent skill packages live under `skills/*/SKILL.md`.

## Flow

```text
Agent judgment
-> Playbook Skill orchestration
-> MCP Skill / fcop-mcp execution
-> FCoP files landed on disk
-> CodeFlowMu UI displays state for ADMIN control
```

## Boundaries

- Agents may judge and plan, but persistent changes must land through controlled files or tools.
- FCoP files are durable coordination state, not chat memory.
- CodeFlowMu UI is the ADMIN control surface.
- MCP must not submit public GitHub issues for ADMIN.
- MCP must not archive, delete, or move lifecycle state unless the authorized lifecycle operation is explicitly requested by the permitted role.
- Playbook docs may describe behavior; they do not create runtime APIs or Panel buttons.
