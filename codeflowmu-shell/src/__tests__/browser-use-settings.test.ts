import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  deleteBrowserUseTarget,
  listBrowserUseTargets,
  readBrowserUseCredentials,
  readBrowserUseSettings,
  upsertBrowserUseTarget,
  writeBrowserUseSettings,
} from "../browser-use-settings.ts";
import { upsertWindowsUseTarget, writeWindowsUseAllowedTargetIds, writeWindowsUseSettings } from "../windows-use-settings.ts";

test("Browser Use migrates legacy Windows Use Web targets without exposing passwords", async () => {
  const root = await mkdtemp(join(tmpdir(), "browser-use-migrate-"));
  try {
    writeWindowsUseSettings(root, { enabled: true, alwaysAllowedAppIds: [] });
    upsertWindowsUseTarget(root, {
      id: "legacy-web", name: "Legacy Web", type: "web", target: "https://erp.example.com/", browser: "edge",
      loginMethod: "username_password", loginInstruction: "Use company account.",
    }, { username: "operator", password: "secret" });
    writeWindowsUseAllowedTargetIds(root, ["legacy-web"]);
    const migrated = readBrowserUseSettings(root);
    assert.equal(migrated.migratedFromWindowsUse, true);
    assert.equal(migrated.enabled, true);
    assert.equal(migrated.targets[0]?.browser, "edge");
    const listed = listBrowserUseTargets(root)[0]!;
    assert.equal(listed.username, "operator");
    assert.equal(listed.hasPassword, true);
    assert.equal("password" in listed, false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Browser Use persists Chrome and Edge targets with structured login records", async () => {
  const root = await mkdtemp(join(tmpdir(), "browser-use-target-"));
  try {
    const target = upsertBrowserUseTarget(root, {
      id: "company-erp", name: "Company ERP", description: "Operations portal", url: "https://erp.example.com/",
      browser: "chrome", loginMethod: "username_password_verification_code", verificationChannel: "other",
      loginInstruction: "Wait for image verification.",
      loginProfile: {
        entryUrl: "https://erp.example.com/login",
        usernameLabel: "Account",
        passwordLabel: "Password",
        tenantLabel: "Company",
        tenantValue: "Company A",
        verificationLabel: "Verification code",
        submitLabel: "Sign in",
        successUrlPrefix: "https://erp.example.com/admin/",
        successText: "Dashboard",
      },
    }, { username: "employee", password: "private-value" });
    assert.equal(target.loginProfile.tenantValue, "Company A");
    assert.equal(target.loginProfile.successUrlPrefix, "https://erp.example.com/admin/");
    const saved = writeBrowserUseSettings(root, { enabled: true, allowedTargetIds: ["company-erp", "missing"] });
    assert.deepEqual(saved.allowedTargetIds, ["company-erp"]);
    const credentials = readBrowserUseCredentials(root, target);
    assert.equal(credentials.username, "employee");
    assert.equal(credentials.password, "private-value");
    const env = await readFile(join(root, ".env"), "utf8");
    assert.match(env, /CODEFLOW_BROWSER_TARGET_COMPANY_ERP_PASSWORD="private-value"/);
    assert.equal(deleteBrowserUseTarget(root, "company-erp"), true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Browser Use rejects HTTP and cross-origin success URLs", async () => {
  const root = await mkdtemp(join(tmpdir(), "browser-use-validation-"));
  try {
    assert.throws(() => upsertBrowserUseTarget(root, {
      id: "insecure", name: "Insecure", url: "http://example.com", browser: "chrome", loginMethod: "none",
    }, {}), /HTTPS/i);
    assert.throws(() => upsertBrowserUseTarget(root, {
      id: "cross-origin", name: "Cross Origin", url: "https://example.com", browser: "edge", loginMethod: "none",
      loginProfile: { successUrlPrefix: "https://other.example.com/admin" },
    }, {}), /same approved HTTPS origin/i);
  } finally { await rm(root, { recursive: true, force: true }); }
});
