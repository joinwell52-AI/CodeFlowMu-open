import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  readWindowsUseSettings,
  deleteWindowsUseTarget,
  listWindowsUseTargets,
  resolveEffectiveWindowsUseSettings,
  upsertWindowsUseTarget,
  writeWindowsUseAllowedTargetIds,
  writeWindowsUseSettings,
} from "../windows-use-settings.ts";

test("Windows Use settings default to disabled and persist per project", async () => {
  const root = await mkdtemp(join(tmpdir(), "windows-use-settings-"));
  try {
    assert.deepEqual(readWindowsUseSettings(root), {
      version: 1,
      enabled: false,
      alwaysAllowedAppIds: [],
      allowedTargetIds: [],
      targets: [],
      updatedAt: null,
    });
    const saved = writeWindowsUseSettings(root, {
      enabled: true,
      alwaysAllowedAppIds: ["NOTEPAD.EXE", "C:\\Windows\\System32\\mspaint.exe", "notepad.exe"],
    });
    assert.equal(saved.enabled, true);
    assert.deepEqual(saved.alwaysAllowedAppIds, ["mspaint.exe", "notepad.exe"]);
    assert.deepEqual(readWindowsUseSettings(root), saved);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("protected applications cannot be approved", async () => {
  const root = await mkdtemp(join(tmpdir(), "windows-use-protected-"));
  try {
    assert.throws(
      () => writeWindowsUseSettings(root, { enabled: true, alwaysAllowedAppIds: ["powershell.exe"] }),
      /protected applications/i,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("environment overrides enablement and extends the project allowlist", async () => {
  const root = await mkdtemp(join(tmpdir(), "windows-use-effective-"));
  try {
    writeWindowsUseSettings(root, { enabled: false, alwaysAllowedAppIds: ["notepad.exe"] });
    const effective = resolveEffectiveWindowsUseSettings(root, {
      CODEFLOW_WINDOWS_USE_ENABLED: "1",
      CODEFLOW_WINDOWS_USE_ALLOW_APPS: "mspaint.exe",
    });
    assert.equal(effective.enabled, true);
    assert.equal(effective.source, "environment");
    assert.deepEqual(effective.alwaysAllowedAppIds, ["mspaint.exe", "notepad.exe"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("native and web targets keep credentials in local env without returning passwords", async () => {
  const root = await mkdtemp(join(tmpdir(), "windows-use-targets-"));
  try {
    upsertWindowsUseTarget(root, {
      id: "company-client",
      name: "Company Client",
      type: "native",
      target: "C:\\Program Files\\Company\\client.exe",
      loginMethod: "username_password",
    }, { username: "operator", password: "secret-value" });
    upsertWindowsUseTarget(root, {
      id: "company-web",
      name: "Company Web",
      type: "web",
      target: "https://erp.example.com/app",
      browser: "chrome",
      loginMethod: "username_password_verification_code",
      verificationChannel: "sms",
      loginInstruction: "Wait for the administrator to provide the SMS code.",
    }, { username: "web-user", password: "web-secret" });

    const settings = readWindowsUseSettings(root);
    assert.equal(settings.targets.length, 2);
    assert.ok(settings.alwaysAllowedAppIds.includes("client.exe"));
    const targets = listWindowsUseTargets(root);
    assert.equal(targets[0]?.username, "operator");
    assert.equal(targets[0]?.hasPassword, true);
    assert.equal(targets[0]?.requiresUser, false);
    assert.match(targets[0]?.loginSummary ?? "", /账号已保存/);
    assert.equal(targets[1]?.requiresUser, true);
    assert.match(targets[1]?.loginSummary ?? "", /短信/);
    assert.equal("password" in (targets[0] ?? {}), false);
    const env = await readFile(join(root, ".env"), "utf8");
    assert.match(env, /CODEFLOW_WINDOWS_TARGET_COMPANY_CLIENT_PASSWORD="secret-value"/);
    const authorized = writeWindowsUseAllowedTargetIds(root, ["company-web", "missing-target"]);
    assert.deepEqual(authorized.allowedTargetIds, ["company-web"]);

    assert.equal(deleteWindowsUseTarget(root, "company-client"), true);
    const afterDelete = await readFile(join(root, ".env"), "utf8");
    assert.doesNotMatch(afterDelete, /COMPANY_CLIENT_(?:USERNAME|PASSWORD)/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("new targets require an explicit structured login method", async () => {
  const root = await mkdtemp(join(tmpdir(), "windows-use-login-profile-"));
  try {
    assert.throws(() => upsertWindowsUseTarget(root, {
      id: "unknown-login",
      name: "Unknown Login",
      type: "web",
      target: "https://example.com",
    }, {}), /login method must be selected/i);
    upsertWindowsUseTarget(root, {
      id: "qr-login",
      name: "QR Login",
      type: "web",
      target: "https://example.com/qr",
      loginMethod: "qr_code",
      loginInstruction: "Stop on the QR page.",
    }, {});
    const [target] = listWindowsUseTargets(root);
    assert.equal(target?.loginMethod, "qr_code");
    assert.equal(target?.requiresUser, true);
    assert.match(target?.loginSummary ?? "", /扫码/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("native targets reject web URLs even when they end with exe", async () => {
  const root = await mkdtemp(join(tmpdir(), "windows-use-native-url-"));
  try {
    assert.throws(() => upsertWindowsUseTarget(root, {
      id: "wrong-native-target",
      name: "Wrong Native Target",
      type: "native",
      target: "https://example.com/client.exe",
      loginMethod: "none",
    }, {}), /absolute \.exe path/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
