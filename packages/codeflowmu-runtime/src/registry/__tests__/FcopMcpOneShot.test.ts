import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildStaticGoogleTools,
  fcopStaticSchemaCoverage,
} from "../FcopMcpOneShot.ts";
import { ADMIN_TOOLS, LEADER_TOOLS } from "../../skill/FcopToolProfile.ts";

describe("buildStaticGoogleTools", () => {
  it("declares required parameters for write_report", () => {
    const [tool] = buildStaticGoogleTools(["write_report"]);

    assert.equal(tool?.name, "write_report");
    assert.deepEqual(tool?.parameters.required, [
      "task_id",
      "reporter",
      "recipient",
      "body",
    ]);
    assert.ok(tool?.parameters.properties.task_id);
    assert.ok(tool?.parameters.properties.reporter);
    assert.ok(tool?.parameters.properties.recipient);
    assert.ok(tool?.parameters.properties.body);
  });

  it("declares optional filters for patrol list tools", () => {
    const [tool] = buildStaticGoogleTools(["list_tasks"]);

    assert.equal(tool?.name, "list_tasks");
    assert.equal(tool?.parameters.type, "OBJECT");
    assert.ok(tool?.parameters.properties.recipient);
    assert.ok(tool?.parameters.properties.status);
    assert.equal(tool?.parameters.required, undefined);
  });

  it("declares optional lang for fcop_report (fcop-mcp 3.2.x patrol)", () => {
    const [tool] = buildStaticGoogleTools(["fcop_report"]);

    assert.equal(tool?.name, "fcop_report");
    assert.equal(tool?.parameters.type, "OBJECT");
    assert.ok(tool?.parameters.properties.lang);
    assert.equal(tool?.parameters.properties.role, undefined);
    assert.equal(tool?.parameters.required, undefined);
  });

  it("declares optional lang for fcop_check (no role kwarg)", () => {
    const [tool] = buildStaticGoogleTools(["fcop_check"]);

    assert.equal(tool?.name, "fcop_check");
    assert.ok(tool?.parameters.properties.lang);
    assert.equal(tool?.parameters.properties.role, undefined);
  });

  it("declares scope for fcop_audit", () => {
    const [tool] = buildStaticGoogleTools(["fcop_audit"]);

    assert.equal(tool?.name, "fcop_audit");
    assert.ok(tool?.parameters.properties.scope);
    assert.ok(tool?.parameters.properties.output);
  });

  it("leader profile tools have non-empty parameter schemas", () => {
    const tools = buildStaticGoogleTools([...LEADER_TOOLS]);
    const empty = tools.filter(
      (t) => Object.keys(t.parameters.properties ?? {}).length === 0,
    );
    assert.deepEqual(
      empty.map((t) => t.name),
      [],
      "LEADER_TOOLS must not fall back to empty OBJECT schemas in one-shot mode",
    );
  });

  it("admin profile has static schema for every tool", () => {
    const missing = fcopStaticSchemaCoverage([...ADMIN_TOOLS]);
    assert.deepEqual(
      missing,
      [],
      `ADMIN_TOOLS missing one-shot schemas: ${missing.join(", ")}`,
    );
  });

  it("admin-only init tools declare required fields", () => {
    const adminOnly = ADMIN_TOOLS.filter(
      (name) => !(LEADER_TOOLS as readonly string[]).includes(name),
    );
    const tools = buildStaticGoogleTools(adminOnly);
    const initProject = tools.find((t) => t.name === "init_project");
    assert.ok(initProject);
    assert.deepEqual(initProject?.parameters.required, ["team"]);
    const setDir = tools.find((t) => t.name === "set_project_dir");
    assert.ok(setDir);
    assert.deepEqual(setDir?.parameters.required, ["project_dir"]);
  });
});
