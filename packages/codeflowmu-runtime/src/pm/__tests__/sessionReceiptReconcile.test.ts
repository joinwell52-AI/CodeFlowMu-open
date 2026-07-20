import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  isRecoverableSessionFailure,
  isFirstTurnAbortFailure,
  reconcileSessionReceiptQueue,
} from "../sessionReceiptReconcile.ts";

describe("isRecoverableSessionFailure", () => {
  it("treats TURN_LIMIT as recoverable", () => {
    assert.equal(isRecoverableSessionFailure("TURN_LIMIT", "failed"), true);
  });

  it("treats timeout status as recoverable", () => {
    assert.equal(isRecoverableSessionFailure(null, "timeout"), true);
  });

  it("treats cursor_sdk_first_turn_abort as recoverable", () => {
    assert.equal(
      isRecoverableSessionFailure("ERROR", "failed", {
        failureCategory: "cursor_sdk_first_turn_abort",
        isFirstTurnAbort: true,
      }),
      true,
    );
  });

  it("rejects bare ERROR without first_turn_abort hints", () => {
    assert.equal(isRecoverableSessionFailure("ERROR", "failed"), false);
  });

  it("rejects unknown terminal codes", () => {
    assert.equal(isRecoverableSessionFailure("PERMANENT", "failed"), false);
  });
});

describe("isFirstTurnAbortFailure", () => {
  it("detects category-only hint", () => {
    assert.equal(
      isFirstTurnAbortFailure({ failureCategory: "cursor_sdk_first_turn_abort" }),
      true,
    );
  });
});

describe("reconcileSessionReceiptQueue", () => {
  const baseSummary = {
    lastSessionId: "session-6",
    lastStartedAt: "2026-06-10T10:00:00+08:00",
    lastEndedAt: null,
    lastSessionStatus: null,
    lastFailureCode: null,
    lastFailureCategory: null,
    isFirstTurnAbort: false,
    reportWrittenOnEnd: false,
    sessionUnsettled: true,
    agentRunning: false,
  };

  it("returns recoverable for unsettled session without report", () => {
    const r = reconcileSessionReceiptQueue({
      summary: baseSummary,
      hasReportOnDisk: false,
      latestReportStatus: "",
      workerFailedPersisted: false,
    });
    assert.equal(r.queueState, "recoverable");
    assert.equal(r.suggestedAction, "recover");
  });

  it("returns running when agent is active", () => {
    const r = reconcileSessionReceiptQueue({
      summary: { ...baseSummary, agentRunning: true, sessionUnsettled: false },
      hasReportOnDisk: false,
      latestReportStatus: "",
      workerFailedPersisted: false,
    });
    assert.equal(r.queueState, "running");
  });

  it("returns failed for terminal report", () => {
    const r = reconcileSessionReceiptQueue({
      summary: baseSummary,
      hasReportOnDisk: true,
      latestReportStatus: "blocked",
      workerFailedPersisted: false,
    });
    assert.equal(r.queueState, "failed");
  });

  it("clears when report is done", () => {
    const r = reconcileSessionReceiptQueue({
      summary: baseSummary,
      hasReportOnDisk: true,
      latestReportStatus: "done",
      workerFailedPersisted: false,
    });
    assert.equal(r.queueState, "none");
  });

  it("returns recoverable for first_turn_abort session end without report", () => {
    const r = reconcileSessionReceiptQueue({
      summary: {
        ...baseSummary,
        sessionUnsettled: false,
        lastEndedAt: "2026-06-11T01:46:28+08:00",
        lastSessionStatus: "failed",
        lastFailureCode: "ERROR",
        lastFailureCategory: "cursor_sdk_first_turn_abort",
        isFirstTurnAbort: true,
      },
      hasReportOnDisk: false,
      latestReportStatus: "",
      workerFailedPersisted: true,
    });
    assert.equal(r.queueState, "recoverable");
    assert.equal(r.suggestedAction, "recover");
  });
});
