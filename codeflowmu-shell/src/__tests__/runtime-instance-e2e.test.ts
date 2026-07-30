import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { test } from "node:test";

import {
  defaultGatewayEnabled,
  ensureRuntimeInstance,
  runtimeInstanceRegistryPath,
  runtimeInstanceStateRoot,
  runtimeScopedAgentKey,
} from "../runtime-instance.ts";
import { ensureMobileGatewayCredentials } from "../mobile/mobileGatewayConfig.ts";

type ChildMessage = Record<string, unknown>;

interface RunningHolder {
  child: ChildProcessWithoutNullStreams;
  messages: ChildMessage[];
  waitFor(
    predicate: (message: ChildMessage) => boolean,
    timeoutMs?: number,
  ): Promise<ChildMessage>;
  stop(): Promise<void>;
}

const fixture = join(
  dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "runtime-lock-holder.ts",
);

function startHolder(input: {
  projectRoot: string;
  dataDir: string;
  instanceId: string;
  panelPort: number;
}): RunningHolder {
  const child = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      fixture,
      input.projectRoot,
      input.dataDir,
      input.instanceId,
      String(input.panelPort),
    ],
    {
      cwd: process.cwd(),
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  const messages: ChildMessage[] = [];
  const listeners = new Set<() => void>();
  createInterface({ input: child.stdout }).on("line", (line) => {
    try {
      messages.push(JSON.parse(line) as ChildMessage);
      for (const listener of listeners) listener();
    } catch {
      // Ignore non-JSON diagnostics.
    }
  });
  const waitFor = (
    predicate: (message: ChildMessage) => boolean,
    timeoutMs = 8_000,
  ): Promise<ChildMessage> =>
    new Promise((resolve, reject) => {
      const inspect = () => {
        const found = messages.find(predicate);
        if (!found) return;
        cleanup();
        resolve(found);
      };
      const timeout = setTimeout(() => {
        cleanup();
        reject(
          new Error(
            `Timed out waiting for child message. stderr=${child.stderr.read() ?? ""}`,
          ),
        );
      }, timeoutMs);
      const onExit = (code: number | null) => {
        inspect();
        if (!messages.some(predicate)) {
          cleanup();
          reject(new Error(`Runtime holder exited early with code ${code}`));
        }
      };
      const cleanup = () => {
        clearTimeout(timeout);
        listeners.delete(inspect);
        child.off("exit", onExit);
      };
      listeners.add(inspect);
      child.once("exit", onExit);
      inspect();
    });
  return {
    child,
    messages,
    waitFor,
    async stop() {
      if (child.exitCode !== null) return;
      child.stdin.write("STOP\n");
      await new Promise<void>((resolve) => child.once("exit", () => resolve()));
    },
  };
}

test("two npm Runtime instances remain isolated end to end", async () => {
  const sandbox = mkdtempSync(join(tmpdir(), "cf-runtime-e2e-"));
  const rootA = join(sandbox, "stable");
  const rootB = join(sandbox, "candidate");
  const home = join(sandbox, "home");
  mkdirSync(join(rootA, "fcop", "inbox"), { recursive: true });
  mkdirSync(join(rootB, "fcop", "inbox"), { recursive: true });
  const previous = {
    machine: process.env.CODEFLOWMU_MACHINE_ID,
    host: process.env.CODEFLOWMU_HOST_ROOT,
    instance: process.env.CODEFLOWMU_RUNTIME_INSTANCE_ID,
    role: process.env.CODEFLOWMU_INSTANCE_ROLE,
  };
  let holderA: RunningHolder | null = null;
  let holderB: RunningHolder | null = null;
  try {
    process.env.CODEFLOWMU_MACHINE_ID = "runtime-e2e-machine";
    const instanceA = ensureRuntimeInstance({
      hostRoot: rootA,
      projectRoot: rootA,
      panelPort: 18766,
      instanceRole: "stable",
    });
    const instanceB = ensureRuntimeInstance({
      hostRoot: rootB,
      projectRoot: rootB,
      panelPort: 18768,
      instanceRole: "candidate",
    });
    const dataA = runtimeInstanceStateRoot(instanceA.instance_id, home);
    const dataB = runtimeInstanceStateRoot(instanceB.instance_id, home);
    const registryA = runtimeInstanceRegistryPath(instanceA.instance_id, home);
    const registryB = runtimeInstanceRegistryPath(instanceB.instance_id, home);

    assert.notEqual(instanceA.instance_id, instanceB.instance_id);
    assert.notEqual(instanceA.project_root, instanceB.project_root);
    assert.notEqual(registryA, registryB);
    assert.notEqual(dataA, dataB);
    assert.notEqual(join(rootA, "fcop"), join(rootB, "fcop"));
    assert.notEqual(join(dataA, "sessions"), join(dataB, "sessions"));
    assert.notEqual(
      runtimeScopedAgentKey(instanceA.instance_id, "PM-01"),
      runtimeScopedAgentKey(instanceB.instance_id, "PM-01"),
    );
    assert.equal(defaultGatewayEnabled("candidate"), false);

    process.env.CODEFLOWMU_HOST_ROOT = rootA;
    process.env.CODEFLOWMU_RUNTIME_INSTANCE_ID = instanceA.instance_id;
    process.env.CODEFLOWMU_INSTANCE_ROLE = "stable";
    const gatewayA = ensureMobileGatewayCredentials(rootA);
    process.env.CODEFLOWMU_HOST_ROOT = rootB;
    process.env.CODEFLOWMU_RUNTIME_INSTANCE_ID = instanceB.instance_id;
    process.env.CODEFLOWMU_INSTANCE_ROLE = "candidate";
    const gatewayB = ensureMobileGatewayCredentials(rootB);
    assert.notEqual(gatewayA.instance_id, gatewayB.instance_id);
    assert.equal(gatewayB.enabled, false);
    assert.equal(gatewayB.auto_connect, false);

    holderA = startHolder({
      projectRoot: rootA,
      dataDir: dataA,
      instanceId: instanceA.instance_id,
      panelPort: 18766,
    });
    holderB = startHolder({
      projectRoot: rootB,
      dataDir: dataB,
      instanceId: instanceB.instance_id,
      panelPort: 18768,
    });
    await Promise.all([
      holderA.waitFor((message) => message.type === "ready"),
      holderB.waitFor((message) => message.type === "ready"),
    ]);

    writeFileSync(join(rootA, "fcop", "inbox", "TASK-A.md"), "# A\n", "utf8");
    await holderA.waitFor(
      (message) => message.type === "event" && message.filename === "TASK-A.md",
    );
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(
      holderB.messages.some((message) => message.filename === "TASK-A.md"),
      false,
    );

    writeFileSync(join(rootB, "fcop", "inbox", "TASK-B.md"), "# B\n", "utf8");
    await holderB.waitFor(
      (message) => message.type === "event" && message.filename === "TASK-B.md",
    );
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(
      holderA.messages.some((message) => message.filename === "TASK-B.md"),
      false,
    );

    const duplicate = startHolder({
      projectRoot: rootA,
      dataDir: join(sandbox, "other-data"),
      instanceId: "cfm-duplicate",
      panelPort: 18770,
    });
    const duplicateError = await duplicate.waitFor(
      (message) => message.type === "error",
    );
    assert.match(String(duplicateError.message), /already owned/);
    await new Promise<void>((resolve) => {
      if (duplicate.child.exitCode !== null) resolve();
      else duplicate.child.once("exit", () => resolve());
    });
    assert.equal(duplicate.child.exitCode, 23);
  } finally {
    await holderA?.stop().catch(() => undefined);
    await holderB?.stop().catch(() => undefined);
    const restore = (key: string, value: string | undefined) => {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    };
    restore("CODEFLOWMU_MACHINE_ID", previous.machine);
    restore("CODEFLOWMU_HOST_ROOT", previous.host);
    restore("CODEFLOWMU_RUNTIME_INSTANCE_ID", previous.instance);
    restore("CODEFLOWMU_INSTANCE_ROLE", previous.role);
    rmSync(sandbox, { recursive: true, force: true });
  }
});
