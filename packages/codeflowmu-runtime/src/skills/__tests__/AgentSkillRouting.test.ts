import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  AGENT_SKILL_ROUTING_HEADING,
  buildAgentSkillRoutingBlock,
  ensureAgentSkillRoutingInSystemPrompt,
  hasAgentSkillRoutingInPrompt,
} from "../AgentSkillRouting.ts";
import { ensurePmCoreCapabilitiesInSystemPrompt } from "../../pm/PmCoreCapabilities.ts";

describe("AgentSkillRouting", () => {
  it("buildAgentSkillRoutingBlock includes heading and manifest paths", () => {
    const block = buildAgentSkillRoutingBlock();
    assert.ok(block.includes(AGENT_SKILL_ROUTING_HEADING));
    assert.ok(block.includes(".codeflowmu/agent-skills.manifest.json"));
    assert.ok(block.includes("docs/skills/agent-skills.manifest.json"));
    assert.ok(block.includes("skills/*/SKILL.md"));
    assert.ok(block.includes("technology stack"));
    assert.ok(block.includes("Python"));
    assert.ok(block.includes("TypeScript"));
    assert.ok(block.includes("static HTML/CSS/JS"));
  });

  it("ensureAgentSkillRoutingInSystemPrompt is idempotent", () => {
    const base = "You are PM.\n\n" + buildAgentSkillRoutingBlock();
    const once = ensureAgentSkillRoutingInSystemPrompt(base);
    const twice = ensureAgentSkillRoutingInSystemPrompt(once);
    assert.equal(once, twice);
    assert.equal((once.match(/## Agent Skill Routing/g) ?? []).length, 1);
  });

  it("ensureAgentSkillRoutingInSystemPrompt appends when missing", () => {
    const roleOnly = "You are DEV (role: DEV).";
    const out = ensureAgentSkillRoutingInSystemPrompt(roleOnly);
    assert.ok(hasAgentSkillRoutingInPrompt(out));
    assert.ok(out.startsWith(roleOnly));
  });

  it("ensureAgentSkillRoutingInSystemPrompt on empty returns block only", () => {
    const out = ensureAgentSkillRoutingInSystemPrompt("");
    assert.equal(out, buildAgentSkillRoutingBlock());
  });

  it("keeps PM core capabilities separate from contextual routing", () => {
    const routed = ensureAgentSkillRoutingInSystemPrompt("You are PM-01.");
    const withCore = ensurePmCoreCapabilitiesInSystemPrompt(routed);

    assert.match(withCore, /PM Core Capabilities \(Always On\)/);
    assert.match(withCore, /pm-solve-problems/);
    assert.match(withCore, /pm-evolve-skills/);
    assert.match(withCore, /Prefer 1-3 matched skills per task/);
  });
});
