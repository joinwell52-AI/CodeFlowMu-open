import { mkdirSync, watch } from "node:fs";
import { join, resolve as pathResolve } from "node:path";

import { acquireRuntimeWriterLocks } from "../../runtime-writer-lock.ts";

const [projectRootArg, dataDirArg, instanceId, panelPortArg] =
  process.argv.slice(2);

if (!projectRootArg || !dataDirArg || !instanceId || !panelPortArg) {
  process.stderr.write("missing runtime-lock-holder arguments\n");
  process.exit(2);
}

const projectRoot = pathResolve(projectRootArg);
const dataDir = pathResolve(dataDirArg);
const inbox = join(projectRoot, "fcop", "inbox");
mkdirSync(inbox, { recursive: true });

try {
  const lock = acquireRuntimeWriterLocks({
    instanceId,
    panelPort: Number(panelPortArg),
    projectRoot,
    dataDir,
    includeFcopLock: true,
  });
  const watcher = watch(inbox, (_event, filename) => {
    if (filename) {
      process.stdout.write(
        `${JSON.stringify({ type: "event", filename: String(filename) })}\n`,
      );
    }
  });
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    watcher.close();
    lock.release();
  };
  process.once("SIGTERM", () => {
    close();
    process.exit(0);
  });
  process.once("SIGINT", () => {
    close();
    process.exit(0);
  });
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (value) => {
    if (value.includes("STOP")) {
      close();
      process.exit(0);
    }
  });
  process.stdout.write(
    `${JSON.stringify({
      type: "ready",
      instance_id: instanceId,
      project_root: projectRoot,
      data_root: dataDir,
      fcop_root: join(projectRoot, "fcop"),
      lock_paths: lock.paths,
    })}\n`,
  );
} catch (error) {
  process.stdout.write(
    `${JSON.stringify({
      type: "error",
      message: error instanceof Error ? error.message : String(error),
    })}\n`,
  );
  process.exit(23);
}
