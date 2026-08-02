import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  identifyWindowsShellDialect,
  validateWindowsShellCommand,
  windowsUtf8Prelude,
} from "../WindowsShellDialect.ts";

describe("WindowsShellDialect", () => {
  it("identifies Windows PowerShell 5, PowerShell 7 and cmd", () => {
    assert.equal(
      identifyWindowsShellDialect({
        command: "powershell.exe -Command Get-ChildItem",
        platform: "win32",
      }).dialect,
      "powershell5",
    );
    assert.equal(
      identifyWindowsShellDialect({
        command: "pwsh -Command Get-ChildItem",
        platform: "win32",
      }).dialect,
      "powershell7",
    );
    assert.equal(
      identifyWindowsShellDialect({
        command: "cmd.exe /c echo ok",
        platform: "win32",
      }).dialect,
      "cmd",
    );
  });

  it("rejects && only for PowerShell 5", () => {
    assert.deepEqual(
      validateWindowsShellCommand({
        command: "command1 && command2",
        args: { shell: "powershell.exe" },
        platform: "win32",
      }),
      {
        ok: false,
        dialect: "powershell5",
        reason: "powershell5_unsupported_and_chain",
        next_safe_action:
          "Run the commands as separate tool calls, or use '; if ($LASTEXITCODE -eq 0) { ... }'.",
      },
    );
    assert.equal(
      validateWindowsShellCommand({
        command: "command1 && command2",
        args: { shell: "pwsh.exe" },
        platform: "win32",
      }).ok,
      true,
    );
    assert.equal(
      validateWindowsShellCommand({
        command: "cmd.exe /c command1 && command2",
        platform: "win32",
      }).ok,
      true,
    );
  });

  it("provides an explicit UTF-8 prelude for each Windows dialect", () => {
    assert.match(windowsUtf8Prelude("powershell5"), /OutputEncoding/);
    assert.match(windowsUtf8Prelude("powershell7"), /UTF8Encoding/);
    assert.equal(windowsUtf8Prelude("cmd"), "chcp 65001 > nul");
  });
});
