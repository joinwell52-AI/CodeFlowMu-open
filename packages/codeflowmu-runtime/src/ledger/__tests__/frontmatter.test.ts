import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  inferReportTaskIdFromBody,
  inferReportTaskIdFromFilename,
  inferTaskParentFromBody,
  parseMarkdownFrontmatter,
  resolveReportTaskIdFromContent,
} from "../frontmatter.ts";

describe("parseMarkdownFrontmatter", () => {
  it("parses CRLF frontmatter (Windows write_report output)", () => {
    const raw =
      "---\r\nprotocol: fcop\r\nsender: PM\r\nrecipient: ADMIN\r\n" +
      'created_at_utc: "2026-06-06T12:10:56Z"\r\n---\r\n\r\n# body\r\n';
    const fm = parseMarkdownFrontmatter(raw);
    assert.equal(fm.sender, "PM");
    assert.equal(fm.recipient, "ADMIN");
  });
});

describe("report task id inference", () => {
  it("prefers 主任务 label over earlier child TASK in body", () => {
    const raw = `---
protocol: fcop
sender: PM
recipient: ADMIN
status: done
---

## 执行结果

thread_key: \`panel-task-001\`
主任务: \`TASK-20260608-001\`

子任务 TASK-20260608-002-PM-to-OPS 已完成
`;
    assert.equal(inferReportTaskIdFromBody(raw), "TASK-20260608-001");
    assert.equal(
      resolveReportTaskIdFromContent({}, raw),
      "TASK-20260608-001",
    );
  });

  it("infers short TASK id from title line in body", () => {
    const raw = `---
protocol: fcop
sender: PM
recipient: ADMIN
status: done
---

# FCoP 系统自检 (TASK-20260606-006)

正文
`;
    assert.equal(inferReportTaskIdFromBody(raw), "TASK-20260606-006");
    assert.equal(
      resolveReportTaskIdFromContent({}, raw),
      "TASK-20260606-006",
    );
  });

  it("infers parent TASK from 父任务引用 label in task body", () => {
    const raw = `---
protocol: fcop
sender: PM
recipient: DEV
task_id: TASK-20260607-001-PM-to-DEV
---

**父任务引用：** TASK-20260606-013

## 返工
`;
    assert.equal(
      inferTaskParentFromBody(raw, "TASK-20260607-001-PM-to-DEV"),
      "TASK-20260606-013",
    );
  });

  it("does not infer self task id as parent", () => {
    const raw = `---
task_id: TASK-20260606-013-ADMIN-to-PM
---

父任务引用： TASK-20260606-013
`;
    assert.equal(
      inferTaskParentFromBody(raw, "TASK-20260606-013-ADMIN-to-PM"),
      "",
    );
  });

  it("infers parent from references: label", () => {
    const raw = `---
protocol: fcop
---

references: TASK-20260606-007

正文
`;
    assert.equal(
      inferTaskParentFromBody(raw, "TASK-20260607-002-PM-to-QA"),
      "TASK-20260606-007",
    );
  });

  it("infers parent from parent task: English label", () => {
    const raw = `---
protocol: fcop
sender: PM
recipient: DEV
---

**Parent task:** TASK-20260606-014

## Rework
`;
    assert.equal(
      inferTaskParentFromBody(raw, "TASK-20260607-003-PM-to-DEV"),
      "TASK-20260606-014",
    );
  });

  it("prefers frontmatter task_id over body", () => {
    const raw = `---
task_id: TASK-20260531-001-ADMIN-to-PM
---

# Title (TASK-20260606-006)
`;
    assert.equal(
      resolveReportTaskIdFromContent(
        { task_id: "TASK-20260531-001-ADMIN-to-PM" },
        raw,
      ),
      "TASK-20260531-001-ADMIN-to-PM",
    );
  });

  it("infers TASK id from PM-to-ADMIN report filename when body is ack-only", () => {
    assert.equal(
      inferReportTaskIdFromFilename("REPORT-20260608-004-PM-to-ADMIN.md"),
      "TASK-20260608-004",
    );
    assert.equal(
      inferReportTaskIdFromFilename(
        "fcop/reports/REPORT-20260608-001-PM-to-ADMIN.md",
      ),
      "TASK-20260608-001",
    );
    assert.equal(
      inferReportTaskIdFromFilename("REPORT-20260608-003-OPS-to-PM.md"),
      "",
    );
    const ack = `---
protocol: fcop
sender: PM
recipient: ADMIN
---

已收到任务，正在分析并派发。
`;
    assert.equal(
      resolveReportTaskIdFromContent({}, ack, "REPORT-20260608-004-PM-to-ADMIN.md"),
      "TASK-20260608-004",
    );
  });
});
