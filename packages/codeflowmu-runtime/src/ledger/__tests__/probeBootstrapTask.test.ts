import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  hasProbeBootstrapMarkers,
  isProbeBootstrapLedgerTask,
} from "../probeBootstrapTask.ts";

describe("probeBootstrapTask", () => {
  it("matches thread_key mcp-tool-probe and ISSUE-MCP-PROBE subject", () => {
    assert.equal(
      hasProbeBootstrapMarkers("", {
        subject: "ISSUE-MCP-PROBE sandbox task",
        thread_key: "mcp-tool-probe",
      }),
      true,
    );
    assert.equal(
      isProbeBootstrapLedgerTask({
        sender: "DEV",
        recipient: "DEV",
        filename: "TASK-20260612-023-DEV-to-DEV.md",
        thread_key: "mcp-tool-probe",
        yaml: {
          subject: "ISSUE-MCP-PROBE sandbox task",
          thread_key: "mcp-tool-probe",
        },
      }),
      true,
    );
  });

  it("does not match formal PM→DEV dispatch", () => {
    assert.equal(
      isProbeBootstrapLedgerTask({
        sender: "PM",
        recipient: "DEV",
        filename: "TASK-20260612-027-PM-to-DEV.md",
        thread_key: "panel-task-025",
        yaml: {
          subject: "Panel 修复",
          thread_key: "panel-task-025",
        },
      }),
      false,
    );
  });
});
