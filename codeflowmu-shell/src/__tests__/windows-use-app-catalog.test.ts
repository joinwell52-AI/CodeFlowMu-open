import assert from "node:assert/strict";
import test from "node:test";

import { sanitizeExecutablePickerInitialPath } from "../pick-executable.ts";
import { listCommonWindowsUseAppCandidates } from "../windows-use-app-catalog.ts";
import { resolveWindowsUseHostPath } from "../windows-use-host-client.ts";

test("executable picker never treats a URL as a local path", () => {
  assert.equal(sanitizeExecutablePickerInitialPath("https://cms.example.com/"), "");
  assert.equal(sanitizeExecutablePickerInitialPath("relative\\client.exe"), "");
  assert.equal(
    sanitizeExecutablePickerInitialPath("C:\\Program Files\\Client\\client.exe"),
    "C:\\Program Files\\Client\\client.exe",
  );
});

test("common Windows app catalog only returns installed candidates", () => {
  const existing = new Set([
    "C:\\Windows\\explorer.exe",
    "C:\\Windows\\System32\\notepad.exe",
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  ].map((value) => value.toLowerCase()));
  const candidates = listCommonWindowsUseAppCandidates({
    WINDIR: "C:\\Windows",
    PROGRAMFILES: "C:\\Program Files",
    "PROGRAMFILES(X86)": "C:\\Program Files (x86)",
    LOCALAPPDATA: "C:\\Users\\tester\\AppData\\Local",
  }, (candidate) => existing.has(candidate.toLowerCase()));

  assert.deepEqual(candidates.map((candidate) => candidate.app_id), [
    "explorer.exe",
    "notepad.exe",
    "chrome.exe",
  ]);
  assert.ok(candidates.every((candidate) => candidate.source === "common"));
});

test("Windows Use host remains a mother capability after switching projects", () => {
  const hostPath = resolveWindowsUseHostPath("D:\\external-business-project");
  assert.ok(hostPath, "mother Windows Use host should still resolve");
  assert.match(hostPath, /packages[\\/]codeflowmu-runtime[\\/]src[\\/]windows-use[\\/]host[\\/]windows_use_host\.py$/i);
});
