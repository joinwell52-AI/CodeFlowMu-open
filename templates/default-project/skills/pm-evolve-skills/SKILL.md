---
name: pm-evolve-skills
description: Discover, learn, validate, and retain capabilities that the PM needs but does not yet have. Use whenever a request needs unfamiliar domain knowledge, a missing tool or workflow, a new MCP capability, a new Skill, or stronger evidence than the PM can currently produce.
---

# PM Skill Evolution

Treat capability gaps as work to resolve, not as a reason to guess or immediately hand the problem back to ADMIN.

## Workflow

1. State the required capability precisely. Distinguish missing knowledge, missing procedure, missing tool access, and missing permission.
2. Inventory what is already available:
   - MCP tools and their schemas.
   - `.codeflowmu/agent-skills.manifest.json`.
   - Relevant `skills/*/SKILL.md` packages.
   - Repository code, tests, docs, examples, and prior evidence.
   - Use `skill_search` to search the local library, GitHub, and the public web when the capability is not already known.
3. Select the smallest credible learning source. Prefer source code, tests, official documentation, and proven local examples.
4. Load only the relevant Skill or documentation. Do not flood context with the whole catalog.
   - Use `skill_learn` with selected local skill ids and source URLs to build a traceable learning pack.
5. Learn by doing: run a minimal experiment, build a small example, inspect a real artifact, or execute a reversible probe.
6. Verify the result against an explicit expectation. Record failures and uncertainty honestly.
7. Apply the capability to the current problem.
8. Retain reusable learning:
   - Update or create a focused Skill when the procedure will recur.
   - Add a template or example when structure matters.
   - Record a proposal when installation, permission, or architectural change requires approval.
   - Use `skill_publish` only after a real validation succeeds. Include validation evidence and source URLs; do not overwrite an existing Skill implicitly.
9. Reuse retained knowledge on later tasks instead of rediscovering it.

## Product / UI capability gaps

Weak product planning is a capability gap. If PM cannot confidently define product positioning, user value, information architecture, interaction flow, visual direction, mobile/PWA/Gateway delivery boundary, or acceptance evidence, PM must:

1. Load `pm-product-design-brief`.
2. Check the relevant UI playbook packages:
   - `ui-requirements`
   - `ui-information-architecture`
   - `ui-visual-consistency`
   - `ui-usability-acceptance`
3. Inspect nearby successful product examples or reports before dispatch.
4. Produce a concrete design brief, then dispatch DEV / QA / OPS.
5. If the pattern will recur, refine the Playbook or create a smaller reusable template after validation.

## Capability Decision

- `available`: load and use the existing capability.
- `learnable_now`: study and validate it within the current task.
- `creatable`: create a focused Skill, helper, or template and validate it.
- `installable`: use the approved plugin/skill installation path.
- `permission_blocked`: explain the exact permission or ADMIN decision required.
- `not_yet_verified`: do not claim competence; continue research or report the limitation.

## Evidence Contract

- Capability required
- Sources inspected
- Skill or tool selected
- Validation performed
- Result and remaining uncertainty
- Reusable artifact retained, when applicable

## Guardrails

- Do not equate reading with learning; validation is required.
- Do not install or create broad capabilities when a smaller local procedure suffices.
- Do not claim a tool exists until its registry or schema is inspected.
- Do not fabricate successful experiments or conceal failed attempts.
