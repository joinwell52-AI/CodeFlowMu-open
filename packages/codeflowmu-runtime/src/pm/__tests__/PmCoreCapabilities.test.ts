import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildPmCoreCapabilitiesBlock,
  ensurePmCoreCapabilitiesInSystemPrompt,
  hasPmCoreCapabilitiesInPrompt,
} from "../PmCoreCapabilities.ts";

describe("PmCoreCapabilities", () => {
  it("keeps problem solving and skill evolution always on", () => {
    const block = buildPmCoreCapabilitiesBlock();
    assert.match(block, /pm-solve-problems/);
    assert.match(block, /pm-evolve-skills/);
    assert.match(block, /pm-product-design-brief/);
    assert.match(block, /product, architecture, UI\/UX/);
    assert.match(block, /Product design gate/);
    assert.match(block, /minimal experiment/);
    assert.match(block, /immediately execute the first meaningful step/);
    assert.match(block, /Do not end with "should I start\?"/);
    assert.match(block, /do not consume the 1-3 contextual skill slots/i);
  });

  it("injects the PM identity core idempotently", () => {
    const once = ensurePmCoreCapabilitiesInSystemPrompt("You are PM-01.");
    const twice = ensurePmCoreCapabilitiesInSystemPrompt(once);

    assert.equal(once, twice);
    assert.ok(hasPmCoreCapabilitiesInPrompt(once));
    assert.equal((once.match(/## PM Core Capabilities \(Always On\)/g) ?? []).length, 1);
  });
});
