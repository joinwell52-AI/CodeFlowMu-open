import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

function readWindowsMachineGuid(): string | null {
  if (process.platform !== "win32") return null;
  try {
    const output = execFileSync(
      "reg",
      [
        "query",
        "HKLM\\SOFTWARE\\Microsoft\\Cryptography",
        "/v",
        "MachineGuid",
      ],
      { encoding: "utf8", windowsHide: true },
    );
    return output.match(/MachineGuid\s+REG_\w+\s+([^\r\n]+)/i)?.[1]?.trim() || null;
  } catch {
    return null;
  }
}

function readUnixMachineId(): string | null {
  for (const filePath of ["/etc/machine-id", "/var/lib/dbus/machine-id"]) {
    try {
      const value = readFileSync(filePath, "utf8").trim();
      if (value) return value;
    } catch {
      // Try the next platform identity source.
    }
  }
  return null;
}

function readOrCreateMachineSeed(): string {
  const stateRoot =
    process.env["CODEFLOWMU_MACHINE_STATE_ROOT"]?.trim() ||
    join(homedir(), ".codeflowmu", "v2");
  const seedPath = join(stateRoot, "machine-id");
  try {
    const existing = readFileSync(seedPath, "utf8").trim();
    if (existing) return existing;
  } catch {
    // Create a machine-local fallback below.
  }

  mkdirSync(dirname(seedPath), { recursive: true });
  const generated = randomBytes(32).toString("hex");
  try {
    writeFileSync(seedPath, `${generated}\n`, { encoding: "utf8", flag: "wx" });
    return generated;
  } catch {
    const raced = readFileSync(seedPath, "utf8").trim();
    if (raced) return raced;
    throw new Error(`Unable to create machine identity at ${seedPath}`);
  }
}

/** Stable, privacy-preserving binding for the current physical/OS installation. */
export function currentMachineBinding(): string {
  const override = process.env["CODEFLOWMU_MACHINE_ID"]?.trim();
  const windowsMachineGuid = override ? null : readWindowsMachineGuid();
  const unixMachineId = override || windowsMachineGuid ? null : readUnixMachineId();
  const source = override
    ? `override:${override}`
    : windowsMachineGuid
      ? `windows:${windowsMachineGuid}`
      : unixMachineId
        ? `unix:${unixMachineId}`
        : `seed:${readOrCreateMachineSeed()}`;
  const digest = createHash("sha256")
    .update(`codeflowmu-machine-v1:${source}`)
    .digest("hex");
  return `machine_${digest.slice(0, 32)}`;
}
