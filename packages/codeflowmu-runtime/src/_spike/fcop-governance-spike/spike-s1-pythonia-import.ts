/**
 * DEV-022 S1 — verify pythonia can import fcop_mcp.governance from Node.
 *
 * Same bridge style as codeflowmu's FcopProjectClient
 * (packages/codeflowmu-runtime/src/_external/fcop-client.ts) — if this spike
 * works, we know the codeflowmu runtime can co-host fcop AND fcop-mcp.governance
 * in the same Python child process.
 *
 * Run from spike dir:
 *   $env:PYTHON_BIN = "C:\Users\Administrator\AppData\Local\Programs\Python\Python312\python.exe"
 *   npx tsx packages/codeflowmu-runtime/src/_spike/fcop-governance-spike/spike-s1-pythonia-import.ts
 *
 * FCOP_EVENT_LOG is redirected to $env:TEMP\fcop-spike-events\s1-pythonia.jsonl
 * so cwd never gets a fcop_events.jsonl.
 */
// @ts-ignore — pythonia ships its own types; runtime import only.
import { python } from "pythonia";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs/promises";

async function main(): Promise<void> {
  const spikeEvents = path.join(os.tmpdir(), "fcop-spike-events");
  await fs.mkdir(spikeEvents, { recursive: true });
  const eventLog = path.join(spikeEvents, "s1-pythonia.jsonl");
  try {
    await fs.unlink(eventLog);
  } catch {
    /* ignore */
  }
  process.env.FCOP_EVENT_LOG = eventLog;

  console.log("=".repeat(72));
  console.log("S1 — pythonia bridge into fcop_mcp.governance (Node side)");
  console.log("=".repeat(72));
  console.log(`PYTHON_BIN: ${process.env.PYTHON_BIN ?? "(unset — pythonia default)"}`);
  console.log(`FCOP_EVENT_LOG: ${eventLog}`);

  try {
    // 1. Import the governance package.
    const governance = await python("fcop_mcp.governance");

    // 2. Probe the 5 named exports (proxy access).
    const FCoPGovernanceMiddleware = await governance.FCoPGovernanceMiddleware;
    const resolve_skill = await governance.resolve_skill;
    const SkillMeta = await governance.SkillMeta;
    const load_registry_yaml = await governance.load_registry_yaml;
    const emit_event = await governance.emit_event;

    console.log("\nExport probes:");
    console.log(`  FCoPGovernanceMiddleware: ${typeof FCoPGovernanceMiddleware} (proxy OK)`);
    console.log(`  resolve_skill:            ${typeof resolve_skill} (proxy OK)`);
    console.log(`  SkillMeta:                ${typeof SkillMeta} (proxy OK)`);
    console.log(`  load_registry_yaml:       ${typeof load_registry_yaml} (proxy OK)`);
    console.log(`  emit_event:               ${typeof emit_event} (proxy OK)`);

    // 3. Call resolve_skill via the proxy.
    const meta = await resolve_skill("write_task");
    const tool = await meta.tool;
    const risk = await meta.risk_level;
    const category = await meta.category;
    console.log(`\nresolve_skill('write_task') via pythonia:`);
    console.log(`  tool       = ${tool}`);
    console.log(`  risk_level = ${risk}`);
    console.log(`  category   = ${category}`);

    // 4. Call emit_event via the proxy (writes to FCOP_EVENT_LOG).
    await emit_event({
      type: "spike_test",
      spike_id: "S1",
      bridge: "pythonia",
      note: "Node->Python proxy call to fcop_mcp.governance.emit_event",
    });
    const logBody = await fs.readFile(eventLog, "utf8");
    console.log(`\nemit_event wrote ${logBody.trim().length} bytes back via pythonia.`);
    console.log(`  contents: ${logBody.trim()}`);

    // 5. Coexistence sanity — same process can still drive fcop.Project.
    const fcop = await python("fcop");
    const fcopVersion = await fcop.__version__;
    const ProjectClass = await fcop.Project;
    const proj = await ProjectClass("d:/CodeFlowMu");
    const layout = await proj.workspace_layout;
    console.log(`\nCo-load sanity:`);
    console.log(`  fcop.__version__       = ${fcopVersion}`);
    console.log(`  Project.workspace_layout = ${layout}`);

    console.log("\nS1 result: PASS — pythonia bridges all 5 exports + co-loads fcop.");
  } finally {
    // shut down the python child process; required for pythonia
    python.exit();
  }
}

main().catch((err) => {
  console.error("S1 FAILED:", err);
  python.exit?.();
  process.exit(1);
});

