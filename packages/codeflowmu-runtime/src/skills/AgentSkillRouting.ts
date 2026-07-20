/**
 * Shared Agent Skill Routing prompt block — single source of truth for host adapters.
 *
 * Injected into:
 * - Cursor SDK dispatch: TaskDispatcher role context prefix
 * - Future providers may reuse this provider-neutral routing contract.
 *
 * Cursor IDE manual sessions supplement via `.cursor/rules/codeflowmu-agent-skill-routing.mdc`
 * (Layer Model + numbered rules; keep semantics aligned with this module).
 */

export const AGENT_SKILL_ROUTING_HEADING = "## Agent Skill Routing";

const ROUTING_BODY = `\
- Treat the user/business intent as the trigger. The user does not need to mention skill names or file paths.
- First inspect \`.codeflowmu/agent-skills.manifest.json\`; if it is missing, inspect \`docs/skills/agent-skills.manifest.json\`.
- On Google/Gemini runtime, use workspace tools \`read_file\`, \`grep_files\`, and \`list_dir\` to load the manifest and \`skills/*/SKILL.md\` from disk when needed.
- Load only the relevant \`skills/*/SKILL.md\` pocket manual for the current role, task stage, and problem type.
- Never load or inject the full skill catalog. The manifest is an index, not prompt content.
- Prefer 1-3 matched skills per task; if more match, keep only the highest-signal skills for the role and situation.
- Use \`docs/skills/*\` only when you need long-form contracts, boundary checks, mappings, or playbook rationale.
- Use Playbook skills for how to think and write. Use pm.* / MCP / FCoP tools for how to validate, report, and enter the ledger.
- For PM dispatch work, route technology stack, language, runtime, framework, build-chain, game/prototype, Python, TypeScript, and static HTML/CSS/JS decisions to the relevant PM tech-scope playbook before writing the downstream task.
- Do not announce or attach a skill name in every reply. Mention the loaded skill only when it clarifies a decision, risk, or handoff.
- If no skill fits, continue with the role playbook and note the gap in the REPORT when it matters.`;

/** Runtime / adapter compact routing block (matches former TaskDispatcher._agentSkillRoutingPlaybook). */
export function buildAgentSkillRoutingBlock(): string {
  return `${AGENT_SKILL_ROUTING_HEADING}\n\n${ROUTING_BODY}`;
}

export function hasAgentSkillRoutingInPrompt(text: string): boolean {
  return text.includes(AGENT_SKILL_ROUTING_HEADING);
}

/**
 * Append Agent Skill Routing when absent (idempotent). Used by Gemini adapter and any
 * host that builds systemInstruction outside TaskDispatcher.
 */
export function ensureAgentSkillRoutingInSystemPrompt(systemInstruction: string): string {
  const trimmed = systemInstruction.trim();
  if (!trimmed) {
    return buildAgentSkillRoutingBlock();
  }
  if (hasAgentSkillRoutingInPrompt(trimmed)) {
    return trimmed;
  }
  return `${trimmed}\n\n${buildAgentSkillRoutingBlock()}`;
}
