import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  canonicalReportBasenameFromTmp,
  isCanonicalReportMarkdownFilename,
  isEphemeralCoordinationFilename,
  shouldIgnoreCoordinationWatchPath,
} from "../report-ephemeral.ts";

test("isEphemeralCoordinationFilename: tmp, part, lock, dotfiles", () => {
  assert.equal(isEphemeralCoordinationFilename("REPORT-x.md.tmp"), true);
  assert.equal(isEphemeralCoordinationFilename("REPORT-x.md.1.2.abc.tmp"), true);
  assert.equal(isEphemeralCoordinationFilename("foo.part"), true);
  assert.equal(isEphemeralCoordinationFilename("foo.lock"), true);
  assert.equal(isEphemeralCoordinationFilename(".hidden"), true);
  assert.equal(isEphemeralCoordinationFilename("REPORT-x.md"), false);
});

test("isCanonicalReportMarkdownFilename rejects tmp and pseudo-md", () => {
  assert.equal(
    isCanonicalReportMarkdownFilename("REPORT-20260509-001-DEV-to-PM.md"),
    true,
  );
  assert.equal(
    isCanonicalReportMarkdownFilename("REPORT-20260509-001-DEV-to-PM.md.tmp"),
    false,
  );
  assert.equal(
    isCanonicalReportMarkdownFilename(
      "REPORT-20260509-001-DEV-to-PM.md.123.456.deadbeef.tmp",
    ),
    false,
  );
  assert.equal(
    isCanonicalReportMarkdownFilename("REPORT-20260509-001-DEV-to-PM.md.extra"),
    false,
  );
});

test("canonicalReportBasenameFromTmp: legacy and unique formats", () => {
  assert.equal(
    canonicalReportBasenameFromTmp("REPORT-20260509-001-DEV-to-PM.md.tmp"),
    "REPORT-20260509-001-DEV-to-PM.md",
  );
  assert.equal(
    canonicalReportBasenameFromTmp(
      "REPORT-20260509-001-DEV-to-PM.md.42.1710000000.cafebabe.tmp",
    ),
    "REPORT-20260509-001-DEV-to-PM.md",
  );
  assert.equal(canonicalReportBasenameFromTmp("not-a-report.tmp"), null);
});

test("shouldIgnoreCoordinationWatchPath on nested paths", () => {
  assert.equal(
    shouldIgnoreCoordinationWatchPath("fcop/reports/REPORT-x.md.tmp"),
    true,
  );
  assert.equal(
    shouldIgnoreCoordinationWatchPath("fcop/reports/REPORT-x.md"),
    false,
  );
});
