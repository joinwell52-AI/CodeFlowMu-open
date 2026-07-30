import { randomBytes } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve as pathResolve } from "node:path";

import { currentMachineBinding } from "./machine-identity.ts";

export interface RuntimeInstanceRecord {
  version: 1;
  instance_id: string;
  instance_role: string;
  host_root: string;
  project_root: string;
  panel_port: number;
  machine_binding: string;
  created_at: string;
  updated_at: string;
}

export interface RuntimeLaunchArgs {
  instanceRole?: string;
  projectRoot?: string;
  panelPort?: number;
  dataDir?: string;
  registryPath?: string;
  noGateway: boolean;
}

export function parseRuntimeLaunchArgs(
  argv = process.argv.slice(2),
  cwd = process.cwd(),
): RuntimeLaunchArgs {
  const out: RuntimeLaunchArgs = { noGateway: false };
  const takeValue = (
    arg: string,
    index: number,
  ): { value: string | undefined; next: number } => {
    const eq = arg.indexOf("=");
    if (eq > 0) return { value: arg.slice(eq + 1), next: index };
    return { value: argv[index + 1], next: index + 1 };
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--no-gateway") {
      out.noGateway = true;
      continue;
    }
    const key = arg.split("=", 1)[0] ?? "";
    if (!["--instance", "--project-root", "--panel-port", "--data-dir", "--registry"].includes(key)) {
      continue;
    }
    const { value, next } = takeValue(arg, i);
    i = next;
    if (!value?.trim()) continue;
    if (key === "--instance") out.instanceRole = value.trim();
    if (key === "--project-root") out.projectRoot = pathResolve(cwd, value.trim());
    if (key === "--data-dir") out.dataDir = pathResolve(cwd, value.trim());
    if (key === "--registry") out.registryPath = pathResolve(cwd, value.trim());
    if (key === "--panel-port") {
      const port = Number(value);
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error(`Invalid --panel-port: ${value}`);
      }
      out.panelPort = port;
    }
  }
  return out;
}

export function runtimeInstancePath(hostRoot: string): string {
  return join(pathResolve(hostRoot), ".codeflowmu", "instance.json");
}

function normalizePathForIdentity(value: string): string {
  const resolved = pathResolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function safeToken(value: string, fallback: string): string {
  const token = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
  return token || fallback;
}

function generateRuntimeInstanceId(hostRoot: string, role: string): string {
  const rootName = safeToken(pathResolve(hostRoot).split(/[\\/]/).pop() || "", "core");
  const roleName = safeToken(role, "stable");
  return `cfm-${rootName}-${roleName}-${randomBytes(6).toString("hex")}`;
}

export function loadRuntimeInstance(hostRoot: string): RuntimeInstanceRecord | null {
  const filePath = runtimeInstancePath(hostRoot);
  if (!existsSync(filePath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8")) as Partial<RuntimeInstanceRecord>;
    if (
      parsed.version !== 1 ||
      typeof parsed.instance_id !== "string" ||
      !parsed.instance_id.trim() ||
      typeof parsed.instance_role !== "string" ||
      typeof parsed.host_root !== "string" ||
      typeof parsed.project_root !== "string" ||
      typeof parsed.panel_port !== "number" ||
      typeof parsed.machine_binding !== "string"
    ) {
      return null;
    }
    return {
      version: 1,
      instance_id: parsed.instance_id.trim(),
      instance_role: parsed.instance_role.trim() || "stable",
      host_root: pathResolve(parsed.host_root),
      project_root: pathResolve(parsed.project_root),
      panel_port: parsed.panel_port,
      machine_binding: parsed.machine_binding,
      created_at: typeof parsed.created_at === "string" ? parsed.created_at : "",
      updated_at: typeof parsed.updated_at === "string" ? parsed.updated_at : "",
    };
  } catch {
    return null;
  }
}

export function runtimeInstanceBelongsHere(
  instance: RuntimeInstanceRecord,
  hostRoot: string,
  machineBinding = currentMachineBinding(),
): boolean {
  return (
    instance.machine_binding === machineBinding &&
    normalizePathForIdentity(instance.host_root) === normalizePathForIdentity(hostRoot)
  );
}

function pidIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function withRuntimeInstanceFileLock<T>(
  hostRoot: string,
  action: () => T,
): T {
  const lockPath = join(hostRoot, ".codeflowmu", "instance.init.lock");
  mkdirSync(dirname(lockPath), { recursive: true });
  const waitCell = new Int32Array(new SharedArrayBuffer(4));
  let acquired = false;
  for (let attempt = 0; attempt < 80; attempt++) {
    try {
      const fd = openSync(lockPath, "wx");
      try {
        writeFileSync(fd, `${process.pid}\n`, "utf8");
      } finally {
        closeSync(fd);
      }
      acquired = true;
      break;
    } catch (error) {
      let owner = 0;
      try {
        owner = Number(readFileSync(lockPath, "utf8").trim());
      } catch {
        // An incomplete lock write is treated as stale on the next pass.
      }
      if (!pidIsAlive(owner)) {
        rmSync(lockPath, { force: true });
        continue;
      }
      if (attempt === 79) {
        throw new Error(
          `Timed out waiting for Runtime instance initialization lock: ${lockPath}`,
          { cause: error },
        );
      }
      Atomics.wait(waitCell, 0, 0, 25);
    }
  }
  if (!acquired) {
    throw new Error(`Unable to initialize Runtime instance at ${hostRoot}`);
  }
  try {
    return action();
  } finally {
    try {
      const owner = Number(readFileSync(lockPath, "utf8").trim());
      if (owner === process.pid) rmSync(lockPath, { force: true });
    } catch {
      // Another recovery path already removed the temporary lock.
    }
  }
}

export function ensureRuntimeInstance(input: {
  hostRoot: string;
  projectRoot: string;
  panelPort: number;
  instanceRole?: string;
}): RuntimeInstanceRecord {
  const hostRoot = pathResolve(input.hostRoot);
  const projectRoot = pathResolve(input.projectRoot);
  const machineBinding = currentMachineBinding();
  return withRuntimeInstanceFileLock(hostRoot, () => {
    const existing = loadRuntimeInstance(hostRoot);
    const belongsHere = existing
      ? runtimeInstanceBelongsHere(existing, hostRoot, machineBinding)
      : false;
    const now = new Date().toISOString();
    const role =
      input.instanceRole?.trim() ||
      (belongsHere ? existing!.instance_role : "stable");
    const record: RuntimeInstanceRecord = {
      version: 1,
      instance_id: belongsHere
        ? existing!.instance_id
        : generateRuntimeInstanceId(hostRoot, role),
      instance_role: role,
      host_root: hostRoot,
      project_root: projectRoot,
      panel_port: input.panelPort,
      machine_binding: machineBinding,
      created_at:
        belongsHere && existing!.created_at ? existing!.created_at : now,
      updated_at: now,
    };
    writeFileSync(
      runtimeInstancePath(hostRoot),
      `${JSON.stringify(record, null, 2)}\n`,
      "utf8",
    );
    return record;
  });
}

export function updateRuntimeInstanceProjectRoot(
  hostRoot: string,
  projectRoot: string,
): RuntimeInstanceRecord | null {
  const existing = loadRuntimeInstance(hostRoot);
  if (!existing || !runtimeInstanceBelongsHere(existing, hostRoot)) return null;
  const updated: RuntimeInstanceRecord = {
    ...existing,
    project_root: pathResolve(projectRoot),
    updated_at: new Date().toISOString(),
  };
  writeFileSync(runtimeInstancePath(hostRoot), `${JSON.stringify(updated, null, 2)}\n`, "utf8");
  return updated;
}

export function runtimeInstanceStateRoot(
  instanceId: string,
  home = homedir(),
): string {
  return join(home, ".codeflowmu", "instances", safeToken(instanceId, "default"));
}

export function runtimeInstanceRegistryPath(
  instanceId: string,
  home = homedir(),
): string {
  return join(runtimeInstanceStateRoot(instanceId, home), "projects-registry.json");
}

export function runtimeScopedAgentKey(
  instanceId: string,
  agentId: string,
): string {
  return `${instanceId.trim()}:${agentId.trim()}`;
}

export function defaultGatewayEnabled(instanceRole: string): boolean {
  return instanceRole.trim().toLowerCase() === "stable";
}
