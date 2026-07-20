# Decision Matrix: P3.5 self-built interception vs fcop-mcp 1.2.0 governance integration

**Audience**: PM-01 / ADMIN-01
**Author**: DEV-01 (TASK-20260511-022)
**Date**: 2026-05-11 ~20:00 UTC+8
**Spike scope**: read-only verification —`packages/codeflowmu-runtime/src/` business code is untouched; this file is for PM/ADMIN decision only.

---

## §0 TL;DR (30 sec)

**DEV recommendation: A2 —Complementary use, NOT replacement.**

- `fcop_mcp.governance` does NOT replace P3.5's enforcement layer; it is a layered audit/observability primitive (Layer-1 of ADR-0030-bis, see wheel source).
- codeflowmu can adopt the **3 governance atoms** (`resolve_skill` / `_args_hash` / `emit_event`) at any dispatch boundary (e.g. InboxWatcher._gate), bypassing the FastMCP-coupled `FCoPGovernanceMiddleware` class entirely.
- P3.5 (Capability boundary with **enforcement** —block / require approval / route) remains needed for codeflowmu's own use cases where audit-only is insufficient.
- The **upgrade path itself** for fcop-mcp 1.2.0 is currently blocked in this Python 3.12 venv by a pydantic / pydantic-core version conflict introduced during OPS-021's upgrade attempt —see D22-S1 surprise. OPS-021 rolled back to 1.1.0 around 19:47; further integration work depends on OPS resolving the FastMCP dependency stack first.

---

## §1 Dimension matrix

| Dimension | P3.5 self-built interception layer | fcop-mcp 1.2.0 governance integration | DEV note |
|---|---|---|---|
| **Implementation cost** | ~0.5-1 day (skill-resolver table + dispatch-time hook + log appender —3 small TS files paralleling Day 4 InboxWatcher style) | ~0.2 day for the 3-atom integration (skill_resolver + emit_event via pythonia); but +1-2 days to stabilize the FastMCP/pydantic-core stack first (see D22-S1) | Self-built is *faster to start* in current env; fcop-mcp is *cheaper long-term* once OPS-021 succeeds |
| **Maintenance burden** | Owned by codeflowmu team —must track risk-tagging schema drift ourselves | Inherits fcop-mcp upstream (registry yaml + emit_event semantics); risk = upstream-driven changes outside our control | Upstream-owned is normally lower burden, but fcop-mcp 1.2.0 docstring/CHANGELOG sync gap (PM-23) means we cannot trust upstream notifications today |
| **Charter 5 (no reinvention) alignment** | LOW —re-implements a primitive that fcop-mcp now ships | HIGH —Charter 5 explicitly says "永不重发昀; reusing fcop-mcp's `resolve_skill` + `emit_event` + `_args_hash` honors this | Charter 5 strongly prefers integration |
| **Enforcement capability** | FULL —codeflowmu can return BLOCK / REVIEW / ALLOW from the dispatch boundary; can require approval tokens | AUDIT-ONLY —`FCoPGovernanceMiddleware` source explicitly says: "Three things only: find skill →tag risk →write event log. **No blocking. No approval tokens. No policy engine.**" | This is the decisive split —if codeflowmu needs to **block**, fcop-mcp alone is insufficient |
| **pythonia bridge compat** | Independent (TS-native) —no Python required for dispatch-time checks | Verified PASS for `resolve_skill` proxy call (S1 partial PASS at 19:43, before OPS-021 rolled back) | pythonia bridges the 3 atoms cleanly; one minor caveat —FCOP_EVENT_LOG must be set BEFORE Node spawn (pythonia env snapshot timing —see D22-S4) |
| **Risk path** | codeflowmu holds full control of risk schema, can ship out of band of fcop-mcp release cadence | Couples our risk decisions to fcop-mcp release cadence (which has shown 1.2.0 docstring/CHANGELOG sync gaps, PM-23) | Self-built decouples; integration couples |
| **Skill-registry breadth** | We define our own —start tiny, grow to fit codeflowmu's 14 subsystems | fcop-mcp ships 25 entries in wheel yaml (after S3 confirmation; PM TASK-022 §3 quoted 26 —actual is 25) covering its own MCP tools; codeflowmu's 14 subsystems are not covered | Mixed —fcop-mcp's registry doesn't know about codeflowmu's own InboxWatcher/TaskParser/etc. Either way we must add codeflowmu-specific entries |
| **Stability of upgrade path** | n/a —purely in-house | **BLOCKED** today by pydantic-core 2.46.4 vs pydantic 2.41.5 internal-version conflict (D22-S1) | OPS-021 §6 rollback was triggered; integration cannot proceed until FastMCP stack stabilizes |
| **Event log compatibility** | Free design —can be aligned with FCoP later if needed | Already FCoP-compliant (`fcop_events.jsonl`, FCOP_EVENT_LOG env override, append-only JSONL) —directly readable by FCoP Layer-3 audit tools | If we want codeflowmu events visible to fcop_check / FCoP Layer-3 reconcile, integration is the natural choice |

---

## §2 Three integration scenarios analyzed

### A1 —Full integration (replace P3.5 self-built)

`InboxWatcher._gate` calls `fcop_mcp.governance` via pythonia. Decisions are derived from `resolve_skill().risk_level`.

**Pros**: Charter 5 perfection. Single source of truth for risk tagging across codeflowmu + fcop-mcp + future FCoP apps. Free upstream registry updates.

**Cons**: Loses enforcement (governance is audit-only by design —author's explicit choice per ADR-0030-bis, "Blocking adds ×3 complexity for near-zero SMB benefit"). Loses control over codeflowmu-specific risk semantics (e.g. fcop-mcp does not know what "dispatch a TASK to DEV" means; we'd have to add codeflowmu entries via project `skill_registry.yaml`, but then we're maintaining the same data we would've maintained ourselves).

**Verdict**: Sufficient ONLY if codeflowmu accepts "audit is governance" SMB philosophy.

### A2 —Complementary integration (DEV RECOMMENDED)

codeflowmu keeps P3.5's **enforcement-capable** dispatch hook, but adopts fcop-mcp's **3 atoms** as the audit primitive:

```ts
// pseudo-code, would live in InboxWatcher._gate
const meta = await pyGovernance.resolve_skill(toolName);  // pythonia proxy
// codeflowmu's own enforcement policy on meta.risk_level:
if (meta.risk_level === 'Critical' && policy === 'reject') return false;
// Always emit governance event (audit, Charter 5 alignment):
await pyGovernance.emit_event({ type: 'inbox_dispatch', tool: toolName, risk: meta.risk_level, ... });
return true;
```

**Pros**:
- Reuses upstream registry yaml + emit_event format (Charter 5 alignment)
- Keeps codeflowmu's enforcement freedom (block / approval / route)
- Single jsonl audit log compatible with FCoP Layer-3 reconcile tools
- Project-level `fcop/skill_registry.yaml` adds codeflowmu-specific entries (S3 confirmed MERGE semantics)
- Bypasses the FastMCP/mcp.types/pydantic chain entirely by importing `resolve_skill` + `emit_event` from submodules, NOT from `fcop_mcp.governance.__init__` (see S4b note)

**Cons**:
- We still maintain the dispatch hook (~0.5 day work)
- Dependent on fcop-mcp 1.2.0 install path being healthy (currently blocked, D22-S1)

**Verdict**: Best of both worlds. The 3 atoms are tiny, pure-Python, and stable; reusing them costs almost nothing and preserves Charter 5 spirit. The enforcement layer remains codeflowmu's autonomous decision surface.

### A3 —Defer until fcop library 1.2.0+ ships governance natively

The current `fcop_mcp.governance` module is in `fcop-mcp` (the MCP server package), NOT in `fcop` (the protocol library). If a future `fcop 1.2.0+` migrates governance into the library, Charter 5 alignment would be even cleaner (codeflowmu already depends on `fcop`, not `fcop-mcp`).

**Pros**: Lowest dependency footprint (no fcop-mcp install needed). Cleanest architectural story.

**Cons**: No signal from upstream that this is planned. Defers all benefits indefinitely.

**Verdict**: Wait-and-watch ok if A2 cost is too high, but A2's cost is genuinely small.

---

## §3 DEV recommendation: A2 with phased rollout

| Phase | Scope | Trigger |
|---|---|---|
| **Phase 0** | Wait for OPS-021 to stabilize the FastMCP/pydantic stack (or for fcop-mcp 1.2.1+ to relax constraint) | OPS health REPORT confirms fcop-mcp 1.2.0 importable + `npm test` 141/141 still green |
| **Phase 1** | Add a new `GovernanceAtoms` adapter alongside `FcopProjectClient` (pythonia proxy to `resolve_skill` + `emit_event`); wire it ONLY in `InboxWatcher._gate` as a SECOND audit channel, not a decision channel | DEV self-decided ~0.5 day work; reuse `_external/fcop-client.ts` patterns |
| **Phase 2** | Add codeflowmu-specific entries to `fcop/skill_registry.yaml` (project-level override) —start with the 4 wired subsystems (TaskParser/ReviewWriter/NeedsHumanGate/InboxWatcher) | After Phase 1 verified clean |
| **Phase 3 (optional)** | Author codeflowmu's own enforcement policy class that reads governance events for downstream metrics (e.g. count of Sensitive dispatches per hour) | Long-term FCoP Layer-3 alignment |

**Phase 0 is the current blocker** —until OPS resolves the pydantic ecosystem in this venv, no integration work can proceed.

---

## §4 What this spike did NOT verify (transparency)

| Item | Why not |
|---|---|
| Full pythonia bridge for `FCoPGovernanceMiddleware.on_call_tool` end-to-end | The class requires a FastMCP `MiddlewareContext` —we would have to spin up a fastmcp server, which is out of spike scope. S4 above confirmed the 3-atom path works, which is what codeflowmu would actually use. |
| Long-running event-log durability (1000+ events, rotation, etc.) | Spike scope is "is governance reusable?", not "is governance production-hardened?". Phase 1 would add stress testing. |
| `fcop` vs `fcop-mcp` package boundary if both upstream packages ever rename or merge | Upstream concern; revisit when relevant. |
| Whether fcop-mcp 1.2.1+ (or fcop 1.2.0+) relaxes the FastMCP pin (currently `fastmcp>=3.2.0`) | Need a fresh wheel inspection; defer to Phase 0. |

