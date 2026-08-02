#!/usr/bin/env node

const { spawn, spawnSync } = require("node:child_process");
const path = require("node:path");

const shellRoot = path.resolve(__dirname, "..");
const rawArgs = process.argv.slice(2);
const openMode = rawArgs.includes("--open");
const checkOnly = rawArgs.includes("--check-only");
const runtimeArgs = rawArgs.filter(
  (arg) => arg !== "--open" && arg !== "--check-only",
);
const requiredModules = [
  "tsx",
  "@codeflowmu/runtime",
  "@cursor/sdk",
  "yaml",
  ...(process.env.CODEFLOWMU_PREFLIGHT_REQUIRE || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean),
];

function findMissingModules() {
  const missing = [];
  for (const moduleName of requiredModules) {
    try {
      require.resolve(moduleName, { paths: [shellRoot] });
    } catch {
      missing.push(moduleName);
    }
  }
  return missing;
}

let missing = findMissingModules();
if (missing.length > 0 && openMode) {
  process.stderr.write(
    `[CodeFlowMu Open preflight] Missing production module(s): ${missing.join(", ")}. ` +
      "Refreshing release dependencies...\n",
  );
  const npmCli = process.env.npm_execpath;
  const npmCommand = npmCli ? process.execPath : "npm";
  const npmArgs = [
    ...(npmCli ? [npmCli] : []),
    "install",
    "--omit=dev",
    "--no-audit",
    "--no-fund",
  ];
  const install = spawnSync(
    npmCommand,
    npmArgs,
    {
      cwd: shellRoot,
      env: process.env,
      stdio: "inherit",
      windowsHide: true,
      shell: !npmCli && process.platform === "win32",
    },
  );
  if (install.error || install.status !== 0) {
    process.stderr.write(
      `[CodeFlowMu Open preflight] Dependency refresh failed${
        install.error ? `: ${install.error.message}` : ` (exit ${install.status})`
      }. Run "npm install --omit=dev" in ${shellRoot} and start again.\n`,
    );
    process.exit(78);
  }
  missing = findMissingModules();
}

if (missing.length > 0) {
  process.stderr.write(
    `[CodeFlowMu preflight] Missing production module(s): ${missing.join(", ")}. ` +
      `Run "npm install --omit=dev" in ${shellRoot} and start again.\n`,
  );
  process.exit(78);
}

if (checkOnly) {
  process.stdout.write(
    `[CodeFlowMu preflight] Production dependencies ready (${requiredModules.join(", ")}).\n`,
  );
  process.exit(0);
}

const runtimeEntry = openMode ? "open-start.ts" : "main.ts";

const child = spawn(
  process.execPath,
  ["--import", "tsx", path.join(shellRoot, "src", runtimeEntry), ...runtimeArgs],
  {
    cwd: shellRoot,
    env: process.env,
    stdio: "inherit",
    windowsHide: true,
  },
);

let receivedSignal = "";
let forceTimer;

function forwardShutdown(signal) {
  if (receivedSignal) {
    child.kill("SIGKILL");
    return;
  }
  receivedSignal = signal;
  // Windows broadcasts Ctrl+C to the attached console process group, so the
  // child receives SIGINT directly. Calling child.kill("SIGINT") there would
  // terminate it immediately and bypass its lock-release handler.
  if (process.platform !== "win32") {
    child.kill(signal);
  }
  forceTimer = setTimeout(() => {
    process.stderr.write(
      `[CodeFlowMu preflight] Runtime did not stop after ${signal}; forcing child exit.\n`,
    );
    child.kill("SIGKILL");
  }, 15_000);
}

process.once("SIGINT", () => forwardShutdown("SIGINT"));
process.once("SIGTERM", () => forwardShutdown("SIGTERM"));

child.once("error", (error) => {
  process.stderr.write(
    `[CodeFlowMu preflight] Unable to launch runtime: ${error.message}\n`,
  );
  process.exitCode = 1;
});

child.once("exit", (code, signal) => {
  if (forceTimer) clearTimeout(forceTimer);
  process.exitCode = code ?? (signal ? 1 : 0);
});
