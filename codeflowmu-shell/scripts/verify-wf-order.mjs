import fs from "fs";
import path from "path";
import vm from "vm";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const panelHtml = fs.readFileSync(
  path.join(__dirname, "../../codeflowmu-desktop/panel/index.html"),
  "utf8",
);
const lines = panelHtml.split(/\r?\n/);
// index.html 1-based: 16807..17237 = rpParseTimestampMs .. rpWfEvents (inclusive)
const chunk = lines.slice(16806, 17237).join("\n");
// 17495..17513 = rpReportPrimaryTaskId
const primaryTaskIdFn = lines.slice(17494, 17513).join("\n");

const stubs = `
const _rpRuntimeByTask = new Map();
const ledgerThreads = [];
function taskIsForceArchiveTask() { return false; }
function taskIsWorkflowSealed() { return false; }
function taskDisplayTitle(t, n) { return String(t && t.filename || ""); }
function reportDisplayTitle(r, n) { return String(r && r.filename || ""); }
function reportIdFromFilename(fn) {
  const m = String(fn || "").match(/(REPORT-\\d{8}-\\d{3})/);
  return m ? m[1] : "";
}
function reportFileKey(fn) { return String(fn || "").replace(/\\.md$/i, ""); }
function envelopeTimestampMs(obj) {
  if (!obj || !obj.mtime) return 0;
  const ms = new Date(obj.mtime).getTime();
  return Number.isNaN(ms) ? 0 : ms;
}
function rpLedgerThreadForReport() { return null; }
function _scanTaskIdsIntoSet(v, ids) {
  const m = String(v || "").match(/^(TASK-\\d{8}-\\d{3})/);
  if (m) ids.add(m[1]);
}
function reportLinkedTaskIds(rep) {
  if (!rep) return [];
  const ids = new Set();
  for (const v of [rep.task_id, rep.parent, rep.references, rep.subject_id]) {
    if (Array.isArray(v)) v.forEach((item) => _scanTaskIdsIntoSet(item, ids));
    else _scanTaskIdsIntoSet(v, ids);
  }
  return [...ids];
}
function classifyReportDisplay() { return "valid"; }
function reportKindFromLedger(rep) {
  const route = taskRouteFromFn((rep && rep.filename) || "");
  if (route && /^(DEV|OPS|QA)$/.test(route.sender) && route.recipient === "PM")
    return "worker_to_pm";
  if (route && route.sender === "PM" && route.recipient === "ADMIN") {
    const st = String((rep && rep.status) || "").toLowerCase();
    if (/done|pass|ok|complete|finished|success/.test(st)) return "pm_to_admin_final";
    return "pm_to_admin_ack";
  }
  return "other";
}
function isClosureEligibleReport() { return true; }
function parseSeqNum(fn) {
  const m = String(fn || "").match(/\\d{8}-(\\d{3})/);
  return m ? Number(m[1]) : 0;
}
function taskIdPrefix(fn) {
  const m = (fn || "").match(/^(TASK-\\d{8}-\\d{3})/);
  return m ? m[1] : "";
}
function taskRouteFromFn(fn) {
  const base = String(fn || "").replace(/\\.md$/i, "");
  const parts = base.split("-");
  if (parts.length < 6) return null;
  const kind = (parts[0] || "").toUpperCase();
  if (kind !== "TASK" && kind !== "REPORT") return null;
  if (!/^\\d{8}$/.test(parts[1] || "") || !/^\\d{3}$/.test(parts[2] || "")) return null;
  const toIdx = parts.findIndex((p, i) => i >= 3 && p === "to");
  if (toIdx < 4 || toIdx + 1 >= parts.length) return null;
  const sender = parts.slice(3, toIdx).join("-").toUpperCase();
  if (!sender) return null;
  const recipientParts = [];
  for (let i = toIdx + 1; i < parts.length; i++) {
    const seg = parts[i] || "";
    if (recipientParts.length > 0 && /^[a-z]/.test(seg)) break;
    recipientParts.push(seg);
  }
  if (!recipientParts.length) return null;
  const recipient = recipientParts.join("-").split(".")[0].toUpperCase();
  return { sender, recipient };
}
`;

const ctx = { console, Date, Map, Set, Array, String, Number, Math, RegExp };
vm.createContext(ctx);
vm.runInContext(stubs + primaryTaskIdFn + "\n" + chunk, ctx, {
  filename: "rpWfEvents-chunk.js",
  timeout: 10000,
});

const chain = {
  rootId: "TASK-20260608-007",
  title: "PM-OPS",
  taskTree: [
    {
      depth: 0,
      taskId: "TASK-20260608-007",
      task: {
        filename: "TASK-20260608-007-ADMIN-to-PM.md",
        status: "review",
        mtime: "2026-06-09T01:30:12Z",
      },
    },
    {
      depth: 1,
      taskId: "TASK-20260609-002",
      task: {
        filename: "TASK-20260609-002-PM-to-OPS.md",
        status: "done",
        mtime: "2026-06-09T01:31:00Z",
      },
    },
  ],
  reports: [
    {
      filename: "REPORT-20260609-002-PM-to-ADMIN.md",
      status: "done",
      task_id: "TASK-20260608-007",
      mtime: "2026-06-09T01:33:00Z",
    },
    {
      filename: "REPORT-20260609-005-OPS-to-PM.md",
      status: "done",
      references: ["TASK-20260609-002"],
      mtime: "2026-06-09T01:32:00Z",
    },
  ],
};

const events = ctx.rpWfEvents(chain);
const labels = events.map((e) => `${e.kind}:${e.action}(${e.id})`);
console.log(labels.join(" -> "));
const opsIdx = labels.findIndex((l) => l.includes("OPS"));
const pmIdx = labels.findIndex((l) => /PM 最终|最终汇报/.test(l));
if (opsIdx < 0 || pmIdx < 0) {
  console.error("missing nodes", labels);
  process.exit(1);
}
if (opsIdx > pmIdx) {
  console.error("FAIL: OPS after PM summary", { opsIdx, pmIdx, labels });
  process.exit(1);
}
console.log("OK: OPS receipt before PM summary");

const listOrder = [...chain.reports]
  .sort(ctx.rpCompareReportsByTimeAsc)
  .map((r) => r.filename);
console.log("report list order:", listOrder.join(" -> "));
if (
  listOrder[0] !== "REPORT-20260609-005-OPS-to-PM.md" ||
  listOrder[1] !== "REPORT-20260609-002-PM-to-ADMIN.md"
) {
  console.error("FAIL: reports not ascending by time", listOrder);
  process.exit(1);
}
console.log("OK: report list time ascending");
