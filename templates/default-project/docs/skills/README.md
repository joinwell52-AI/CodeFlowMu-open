# CodeFlowMu Skill Documentation

This directory contains long-form documentation for CodeFlowMu Agent Playbook skills.

It explains contracts, mappings, boundaries, role playbooks, and methodology. It is not the directory that agent hosts load directly as skill packages.

## Relationship

```text
.codeflowmu/agent-skills.manifest.json  # local/runtime projection copy
docs/skills/agent-skills.manifest.json  # stable source-of-truth catalog
docs/skills/                            # long-form docs, contracts, mappings, methodology
skills/*/SKILL.md                       # compact reusable skill packages loaded by agents
```

`docs/skills/` explains why a skill exists, how it fits CodeFlowMu/FCoP, and what boundaries apply. `skills/` contains the concise `SKILL.md` instructions an agent can load and use.

`docs/skills/agent-skills.manifest.json` is the durable source-of-truth copy. `.codeflowmu/agent-skills.manifest.json` is a local/runtime projection that may be deleted during clean initialization when `.codeflowmu/` is removed. Shell startup restores the projection copy from `docs/skills/agent-skills.manifest.json` via `plantAgentSkillsManifestIfMissing(projectRoot)` when the projection is missing. If both files are missing, Shell warns and does not create an empty manifest.

## Top-Level Documents

- `skill-layers.md`: MCP Skill vs Agent Playbook Skill.
- `common-skills.md`: sixteen common playbook skills, including browser Playwright checks, code search, local command verification, and test selection.
- `pm-skills-mapping.md`: mapping for existing PM runtime skills.
- `role-skills.md`: role and persona skill catalog.
- `forbidden-v1.md`: skills/actions forbidden in v1.
- `write-report-contract.md`: shared REPORT contract.
- `detect-blocked-contract.md`: blocked-state contract.
- `safe-public-draft.md`: safe issue draft and public-submission boundary.
- `external-skill-sources.md`: external GitHub sources and absorption policy.
- `agent-skills.manifest.json`: stable source-of-truth catalog for Agent Playbook skills.

## Playbook Groups

- `pm-playbook/`: Product manager skills, including technical scope selection before dispatch.
- `technical-manager-playbook/`: Technical manager coordination skills.
- `architect-playbook/`: Architect design and boundary review skills.
- `dev-playbook/`: DEV implementation skills.
- `qa-playbook/`: QA verification skills.
- `ops-playbook/`: OPS runtime and log diagnosis skills.
- `eval-playbook/`: EVAL observation and promotion advice skills.
- `ui-playbook/`: UI/UX design and usability skills.

## Boundaries

- These documents describe behavior; they do not create runtime APIs.
- Do not treat playbook documentation as Panel/API implementation.
- Do not change formal FCoP protocol from this directory.
- Do not rename existing `pm.*` runtime skill IDs.
- Do not submit public GitHub issues, archive tasks, delete files, or move lifecycle state from these docs.
