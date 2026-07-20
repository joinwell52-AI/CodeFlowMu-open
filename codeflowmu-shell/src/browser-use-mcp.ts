import { existsSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { chromium, type BrowserContext, type Page } from "playwright";
import {
  listBrowserUseTargets,
  readBrowserUseCredentials,
  readBrowserUseSettings,
  upsertBrowserUseTarget,
  type BrowserUseLoginProfile,
  type BrowserUseTarget,
} from "./browser-use-settings.ts";

const projectRoot = resolve(process.env["FCOP_PROJECT_DIR"] || process.cwd());
const contexts = new Map<"chrome" | "edge", BrowserContext>();
const contextLaunches = new Map<"chrome" | "edge", Promise<BrowserContext>>();
const tabs = new Map<string, Page>();
let tabSequence = 0;
let paused = false;
const loginRecordings = new Map<string, { targetId: string; profile: BrowserUseLoginProfile }>();

class BrowserUseError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

function settings() { return readBrowserUseSettings(projectRoot); }
function allowedTargets(): BrowserUseTarget[] {
  const config = settings();
  return config.targets.filter((target) => config.allowedTargetIds.includes(target.id));
}
function targetById(id: unknown): BrowserUseTarget {
  const target = allowedTargets().find((item) => item.id === String(id ?? "").trim().toLowerCase());
  if (!target) throw new BrowserUseError("TARGET_NOT_APPROVED", "Browser target is not approved");
  return target;
}

function browserExecutable(browser: "chrome" | "edge"): string {
  const env = process.env;
  const candidates = browser === "edge"
    ? [
        join(env["PROGRAMFILES(X86)"] || "", "Microsoft", "Edge", "Application", "msedge.exe"),
        join(env["PROGRAMFILES"] || "", "Microsoft", "Edge", "Application", "msedge.exe"),
        join(env["LOCALAPPDATA"] || "", "Microsoft", "Edge", "Application", "msedge.exe"),
      ]
    : [
        join(env["PROGRAMFILES"] || "", "Google", "Chrome", "Application", "chrome.exe"),
        join(env["PROGRAMFILES(X86)"] || "", "Google", "Chrome", "Application", "chrome.exe"),
        join(env["LOCALAPPDATA"] || "", "Google", "Chrome", "Application", "chrome.exe"),
      ];
  const found = candidates.find((candidate) => candidate && existsSync(candidate));
  if (!found) throw new BrowserUseError("BROWSER_NOT_FOUND", `${browser} executable was not found`);
  return found;
}

function browserAvailable(browser: "chrome" | "edge"): boolean {
  try { return existsSync(browserExecutable(browser)); } catch { return false; }
}

function contextIsAlive(context: BrowserContext): boolean {
  try { return context.browser()?.isConnected() !== false; } catch { return false; }
}

function forgetContext(browser: "chrome" | "edge", context?: BrowserContext): void {
  const current = contexts.get(browser);
  if (!context || current === context) contexts.delete(browser);
  for (const [id, page] of tabs) {
    try { if ((!context || page.context() === context) && (page.isClosed() || !contextIsAlive(page.context()))) tabs.delete(id); }
    catch { tabs.delete(id); }
  }
}

async function launchContext(browser: "chrome" | "edge"): Promise<BrowserContext> {
  const userDataDir = join(projectRoot, ".codeflowmu", "runtime", "browser-use-profiles", browser);
  const context = await chromium.launchPersistentContext(userDataDir, {
    executablePath: browserExecutable(browser),
    headless: false,
    viewport: null,
    acceptDownloads: false,
    args: ["--no-first-run", "--no-default-browser-check"],
  });
  contexts.set(browser, context);
  for (const page of context.pages()) registerTab(page, browser);
  context.on("page", (page) => registerTab(page, browser));
  context.on("close", () => forgetContext(browser, context));
  return context;
}

async function ensureContext(browser: "chrome" | "edge"): Promise<BrowserContext> {
  const existing = contexts.get(browser);
  if (existing && contextIsAlive(existing)) return existing;
  if (existing) forgetContext(browser, existing);
  const pending = contextLaunches.get(browser);
  if (pending) return await pending;
  const launch = launchContext(browser).finally(() => contextLaunches.delete(browser));
  contextLaunches.set(browser, launch);
  return await launch;
}

function registerTab(page: Page, browser: "chrome" | "edge"): string {
  for (const [id, item] of tabs) if (item === page) return id;
  const id = `${browser}-${++tabSequence}`;
  tabs.set(id, page);
  page.on("close", () => tabs.delete(id));
  return id;
}

function tabById(id: unknown): Page {
  const page = tabs.get(String(id ?? ""));
  if (!page || page.isClosed()) throw new BrowserUseError("TAB_NOT_FOUND", "Browser tab was not found");
  return page;
}

function targetForUrl(url: string): BrowserUseTarget | undefined {
  let current: URL;
  try { current = new URL(url); } catch { return undefined; }
  return allowedTargets().find((target) => new URL(target.url).origin === current.origin);
}

function sameOrigin(left: string, right: string): boolean {
  try { return new URL(left).origin === new URL(right).origin; } catch { return false; }
}

function isBlankPage(page: Page): boolean {
  const url = page.url();
  return url === "about:blank" || url === "chrome://newtab/" || url === "edge://newtab/";
}

function closedContextError(error: unknown): boolean {
  return /target page, context or browser has been closed|browser has been closed|context has been closed/i.test(error instanceof Error ? error.message : String(error));
}

function assertAllowedPage(page: Page): BrowserUseTarget {
  const target = targetForUrl(page.url());
  if (!target) throw new BrowserUseError("URL_NOT_APPROVED", "Current page origin is not in the Browser Use target allowlist");
  return target;
}

async function snapshot(page: Page, limit = 500): Promise<Array<Record<string, unknown>>> {
  assertAllowedPage(page);
  const query = "a,button,input,textarea,select,[role],h1,h2,h3,label,[aria-haspopup='listbox'],[class*='select'],[class*='dropdown']";
  const collect = new Function("elements", "max", `return elements.map((element, sourceIndex) => {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    const type = String(element.type || "").toLowerCase();
    return {
      sourceIndex,
      visible: rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none",
      id: element.id || "",
      testId: element.getAttribute("data-testid") || "",
      className: String(element.className || "").slice(0, 300),
      tag: element.tagName.toLowerCase(),
      role: element.getAttribute("role") || "",
      text: String(element.innerText || element.getAttribute("aria-label") || "").trim().slice(0, 300),
      ariaLabel: element.getAttribute("aria-label") || "",
      placeholder: element.getAttribute("placeholder") || "",
      name: element.getAttribute("name") || "",
      type,
      enabled: !element.disabled,
      selectedText: element.tagName.toLowerCase() === "select"
        ? String(element.selectedOptions?.[0]?.textContent || "").trim().slice(0, 300)
        : /select|combobox/i.test(String(element.className || "") + " " + String(element.getAttribute("role") || ""))
          ? String(element.querySelector("input")?.value || "").trim().slice(0, 300)
          : undefined,
      valuePresent: type === "password" ? Boolean(element.value) : undefined,
    };
  }).filter((row) => row.visible).slice(0, max)`) as (elements: Element[], max: number) => Array<Record<string, unknown>>;
  const rows = await page.locator(query).evaluateAll(collect, Math.max(1, Math.min(limit, 1000)));
  return rows.map(({ sourceIndex, visible: _visible, id, testId, ...row }) => ({
    selector: id ? `[id=${JSON.stringify(String(id))}]`
      : row["name"] ? `${row["tag"]}[name=${JSON.stringify(String(row["name"]))}]`
      : testId ? `[data-testid=${JSON.stringify(String(testId))}]`
      : `${query} >> nth=${Number(sourceIndex)}`,
    ...row,
  }));
}

async function inferLoginProfile(page: Page): Promise<BrowserUseLoginProfile> {
  assertAllowedPage(page);
  const inspect = new Function("body", `
    const document = body.ownerDocument;
    const visible = (element) => { const rect = element.getBoundingClientRect(); const style = getComputedStyle(element); return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none"; };
    const labelOf = (element) => { const labels = element.labels ? [...element.labels].map((label) => label.innerText.trim()).filter(Boolean) : []; return String(labels[0] || element.getAttribute("aria-label") || element.getAttribute("placeholder") || element.getAttribute("name") || "").trim().slice(0, 300); };
    const inputs = [...document.querySelectorAll("input")].filter(visible);
    const password = inputs.find((input) => String(input.type).toLowerCase() === "password");
    const verification = inputs.find((input) => /验证码|captcha|verification|校验码|动态码/i.test(labelOf(input)));
    const username = inputs.find((input) => input !== password && input !== verification && /账号|帐号|用户|手机|邮箱|user|account|phone|email/i.test(labelOf(input))) || inputs.find((input) => input !== password && input !== verification && ["text", "tel", "email"].includes(String(input.type || "text").toLowerCase()));
    const selects = [...document.querySelectorAll("select")].filter(visible);
    const tenant = selects.find((select) => /公司|企业|租户|组织|门店|company|tenant|organization/i.test(labelOf(select))) || selects[0];
    const combo = [...document.querySelectorAll('[role="combobox"]')].filter(visible)[0];
    const submit = [...document.querySelectorAll('button,input[type="submit"],[role="button"]')].filter(visible).find((element) => /登录|登陆|sign\\s*in|log\\s*in/i.test(String(element.innerText || element.value || element.getAttribute("aria-label") || "")));
    return { entryUrl: location.href, usernameLabel: username ? labelOf(username) : "", passwordLabel: password ? labelOf(password) : "", tenantLabel: tenant ? labelOf(tenant) : String(combo?.getAttribute("aria-label") || "").trim(), tenantValue: tenant ? String(tenant.selectedOptions[0]?.textContent || "").trim().slice(0, 300) : String(combo?.innerText || "").trim().slice(0, 300), verificationLabel: verification ? labelOf(verification) : "", submitLabel: submit ? String(submit.innerText || submit.value || submit.getAttribute("aria-label") || "").trim().slice(0, 300) : "", successUrlPrefix: "", successText: "" };
  `) as (body: Element) => BrowserUseLoginProfile;
  return await page.locator("body").evaluate(inspect);
}

async function validateAfterAction(page: Page): Promise<void> {
  await page.waitForTimeout(150);
  if (!targetForUrl(page.url())) {
    try { await page.goBack({ waitUntil: "domcontentloaded", timeout: 5_000 }); } catch { /* best effort */ }
    throw new BrowserUseError("NAVIGATION_BLOCKED", "Action navigated outside approved Browser Use origins");
  }
}

async function verifyLogin(page: Page, target: BrowserUseTarget): Promise<Record<string, unknown>> {
  assertAllowedPage(page);
  const passwordFields = page.locator('input[type="password"]');
  let loginSurfaceVisible = false;
  for (let index = 0; index < await passwordFields.count(); index++) if (await passwordFields.nth(index).isVisible()) { loginSurfaceVisible = true; break; }
  const successUrlMatched = Boolean(target.loginProfile.successUrlPrefix && page.url().startsWith(target.loginProfile.successUrlPrefix));
  const successTextMatched = Boolean(target.loginProfile.successText && await page.getByText(target.loginProfile.successText, { exact: false }).first().isVisible().catch(() => false));
  return {
    authenticated: !loginSurfaceVisible && (successUrlMatched || successTextMatched),
    url: page.url(), loginSurfaceVisible, successUrlMatched, successTextMatched,
    reason: loginSurfaceVisible ? "login_surface_visible" : (successUrlMatched || successTextMatched ? "success_evidence_matched" : "success_evidence_not_matched"),
  };
}

async function inputBySemantics(page: Page, label: string, kind: "username" | "password" | "verification"): Promise<import("playwright").Locator | undefined> {
  const inputs = page.locator("input");
  const wanted = label.trim().toLowerCase();
  for (let index = 0; index < await inputs.count(); index++) {
    const input = inputs.nth(index);
    if (!(await input.isVisible().catch(() => false))) continue;
    const type = String(await input.getAttribute("type") || "text").toLowerCase();
    const metadata = [await input.getAttribute("aria-label"), await input.getAttribute("placeholder"), await input.getAttribute("name")].filter(Boolean).join(" ").toLowerCase();
    if (kind === "password" && type === "password") return input;
    if (kind === "verification" && /验证码|captcha|verification|校验码|动态码/i.test(metadata)) return input;
    if (kind === "username" && type !== "password" && !/验证码|captcha|verification|校验码|动态码/i.test(metadata) && (!wanted || metadata.includes(wanted) || ["text", "tel", "email", "number"].includes(type))) return input;
  }
  return undefined;
}

async function fillRecordedLogin(page: Page, target: BrowserUseTarget): Promise<Record<string, unknown>> {
  const credentials = readBrowserUseCredentials(projectRoot, target);
  if (!credentials.username) throw new BrowserUseError("CREDENTIALS_MISSING", "Saved target username is missing");
  if (target.loginProfile.usernameLabel) {
    await page.getByPlaceholder(target.loginProfile.usernameLabel, { exact: false }).waitFor({ state: "visible", timeout: 5_000 }).catch(() => undefined);
  }
  const username = await inputBySemantics(page, target.loginProfile.usernameLabel, "username");
  if (!username) throw new BrowserUseError("LOGIN_FIELD_NOT_FOUND", `Username field not found: ${target.loginProfile.usernameLabel || "username"}`);
  await username.fill(credentials.username);
  if (target.loginMethod === "username_password" || target.loginMethod === "username_password_verification_code") {
    await page.getByPlaceholder(target.loginProfile.passwordLabel || "密码", { exact: false }).waitFor({ state: "visible", timeout: 5_000 }).catch(() => undefined);
  }
  const password = await inputBySemantics(page, target.loginProfile.passwordLabel, "password");
  let passwordFilled = false;
  if (password && credentials.password) { await password.fill(credentials.password); passwordFilled = true; }
  if (password && !credentials.password) throw new BrowserUseError("CREDENTIALS_MISSING", "Password field is present but saved password is missing");
  if (target.loginProfile.tenantValue) {
    const clickVisibleTenantOption = async (): Promise<boolean> => {
      const options = page.getByText(target.loginProfile.tenantValue, { exact: true });
      for (let index = 0; index < await options.count(); index++) {
        const option = options.nth(index);
        if (await option.isVisible().catch(() => false)) { await option.click(); return true; }
      }
      return false;
    };
    const selects = page.locator("select");
    let selected = false;
    for (let index = 0; index < await selects.count(); index++) {
      const select = selects.nth(index);
      if (!(await select.isVisible().catch(() => false))) continue;
      try { await select.selectOption({ label: target.loginProfile.tenantValue }); selected = true; break; } catch { /* custom control */ }
    }
    if (!selected) {
      const elementUiSelect = page.locator(".el-select");
      await elementUiSelect.waitFor({ state: "visible", timeout: 3_000 }).catch(() => undefined);
      if (await elementUiSelect.count() === 1) {
        await elementUiSelect.click();
        const option = page.getByText(target.loginProfile.tenantValue, { exact: true });
        await option.waitFor({ state: "visible", timeout: 2_000 }).catch(() => undefined);
        selected = await clickVisibleTenantOption();
      }
    }
    if (!selected) {
      if (await clickVisibleTenantOption()) selected = true;
      else {
        const combo = page.getByRole("combobox").first();
        if (await combo.count() === 1) { await combo.click(); selected = await clickVisibleTenantOption(); }
        if (!selected) {
          const customSelectors = [".el-select", ".ant-select", ".select2-container", "[class*='select']", "[class*='dropdown']"];
          for (const css of customSelectors) {
            const custom = page.locator(css);
            for (let index = 0; index < await custom.count(); index++) {
              const control = custom.nth(index);
              if (!(await control.isVisible().catch(() => false))) continue;
              await control.click().catch(() => undefined);
              await page.waitForTimeout(150);
              if (await clickVisibleTenantOption()) { selected = true; break; }
            }
            if (selected) break;
          }
        }
        if (!selected) {
          const controls = page.locator("div,span,button,[role=combobox],[aria-haspopup]");
          for (let index = 0; index < await controls.count(); index++) {
            const control = controls.nth(index);
            if (!(await control.isVisible().catch(() => false))) continue;
            const text = (await control.innerText().catch(() => "")).trim();
            if (text.length > 80 || !(/公司|企业|租户|组织|请选择|company|tenant/i.test(text))) continue;
            await control.click().catch(() => undefined);
            await page.waitForTimeout(150);
            if (await clickVisibleTenantOption()) { selected = true; break; }
          }
        }
      }
    }
    if (!selected) throw new BrowserUseError("TENANT_OPTION_NOT_FOUND", `Tenant option not found: ${target.loginProfile.tenantValue}`);
  }
  const verification = await inputBySemantics(page, target.loginProfile.verificationLabel, "verification");
  return { usernameFilled: true, passwordFilled, tenantSelected: Boolean(target.loginProfile.tenantValue), verificationRequired: Boolean(verification), verificationSelector: verification ? "semantic-input" : undefined };
}

async function openTargetPage(target: BrowserUseTarget): Promise<{ page: Page; result: Record<string, unknown> }> {
  const desiredUrl = target.loginProfile.entryUrl || target.url;
  for (let attempt = 0; attempt < 2; attempt++) {
    const context = await ensureContext(target.browser);
    try {
      const pages = context.pages().filter((candidate) => !candidate.isClosed());
      let page = pages.find((candidate) => sameOrigin(candidate.url(), desiredUrl));
      const reused = Boolean(page);
      if (!page) {
        page = pages.find(isBlankPage) ?? await context.newPage();
        await page.goto(desiredUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
      }
      const tabId = registerTab(page, target.browser);
      await page.bringToFront();
      return { page, result: { tab_id: tabId, target_id: target.id, browser: target.browser, url: page.url(), title: await page.title(), reused, preserved_state: reused } };
    } catch (error) {
      if (attempt === 0 && closedContextError(error)) { forgetContext(target.browser, context); continue; }
      throw error;
    }
  }
  throw new BrowserUseError("BROWSER_RECONNECT_FAILED", "Browser context could not be reconnected");
}

async function command(name: string, args: Record<string, unknown>): Promise<unknown> {
  if (paused && !["browser.status", "browser.resume", "browser.cancel", "browser.capabilities"].includes(name)) {
    throw new BrowserUseError("BROWSER_USE_PAUSED", "Browser Use is paused for the current MCP session");
  }
  if (name === "browser.capabilities") return { chrome: browserAvailable("chrome"), edge: browserAvailable("edge"), playwright: true, managedProfiles: true, loginRecording: true, paused };
  if (name === "browser.list_targets") return { targets: listBrowserUseTargets(projectRoot).filter((target) => settings().allowedTargetIds.includes(target.id)).map(({ credentialRef: _ref, username, ...target }) => ({ ...target, usernameSaved: Boolean(username) })) };
  if (name === "browser.open_target") {
    const target = targetById(args["target_id"]);
    return (await openTargetPage(target)).result;
  }
  if (name === "browser.list_tabs") {
    return { tabs: await Promise.all([...tabs.entries()].filter(([, page]) => !page.isClosed() && targetForUrl(page.url())).map(async ([id, page]) => ({ tab_id: id, url: page.url(), title: await page.title(), target_id: targetForUrl(page.url())?.id }))) };
  }
  if (name === "browser.snapshot") return { tab_id: String(args["tab_id"]), elements: await snapshot(tabById(args["tab_id"]), Number(args["limit"] ?? 500)) };
  if (name === "browser.find") {
    const query = String(args["query"] ?? "").trim().toLowerCase();
    if (!query) throw new BrowserUseError("QUERY_REQUIRED", "query is required");
    const elements = await snapshot(tabById(args["tab_id"]), 1000);
    return { matches: elements.filter((item) => JSON.stringify(item).toLowerCase().includes(query)).slice(0, 50) };
  }
  if (name === "browser.verify_login") {
    const page = tabById(args["tab_id"]);
    const target = targetById(args["target_id"]);
    if (assertAllowedPage(page).id !== target.id) throw new BrowserUseError("TARGET_TAB_MISMATCH", "tab does not belong to target");
    return await verifyLogin(page, target);
  }
  if (name === "browser.login") {
    const target = targetById(args["target_id"]);
    let page: Page;
    let recovered = false;
    try { page = args["tab_id"] ? tabById(args["tab_id"]) : (await openTargetPage(target)).page; }
    catch (error) {
      if (!(error instanceof BrowserUseError) || error.code !== "TAB_NOT_FOUND") throw error;
      page = (await openTargetPage(target)).page; recovered = true;
    }
    if (assertAllowedPage(page).id !== target.id) throw new BrowserUseError("TARGET_TAB_MISMATCH", "tab does not belong to target");
    const result = await fillRecordedLogin(page, target);
    const tabId = registerTab(page, target.browser);
    return { tab_id: tabId, target_id: target.id, recovered, ...result, next: result.verificationRequired ? "Wait for user to read/confirm the verification code, then call browser.submit_login on this tab_id." : "Call browser.submit_login on this tab_id." };
  }
  if (name === "browser.submit_login") {
    const target = targetById(args["target_id"]);
    const page = tabById(args["tab_id"]);
    if (assertAllowedPage(page).id !== target.id) throw new BrowserUseError("TARGET_TAB_MISMATCH", "tab does not belong to target");
    const code = String(args["verification_code"] ?? "").trim();
    if (!code || code.length > 12) throw new BrowserUseError("VERIFICATION_CODE_REQUIRED", "verification_code is required and must be short");
    const verification = await inputBySemantics(page, target.loginProfile.verificationLabel, "verification");
    if (!verification) throw new BrowserUseError("LOGIN_FIELD_NOT_FOUND", `Verification field not found: ${target.loginProfile.verificationLabel || "verification code"}`);
    await verification.fill(code);
    const submit = page.getByRole("button", { name: target.loginProfile.submitLabel || "登录", exact: false }).last();
    if (await submit.count() !== 1) throw new BrowserUseError("SUBMIT_BUTTON_NOT_FOUND", `Submit button not found: ${target.loginProfile.submitLabel || "login"}`);
    await submit.click();
    await page.waitForTimeout(800);
    return await verifyLogin(page, target);
  }
  if (name === "browser.record_login_start") {
    const page = tabById(args["tab_id"]);
    const target = targetById(args["target_id"]);
    if (assertAllowedPage(page).id !== target.id) throw new BrowserUseError("TARGET_TAB_MISMATCH", "tab does not belong to target");
    await page.waitForTimeout(500);
    const profile = await inferLoginProfile(page);
    loginRecordings.set(String(args["tab_id"]), { targetId: target.id, profile });
    return { recording: true, target_id: target.id, detected: profile, instruction: "Complete one normal login, then call browser.record_login_finish. Password and verification-code values are never recorded." };
  }
  if (name === "browser.record_login_finish") {
    const tabId = String(args["tab_id"] ?? "");
    const page = tabById(tabId);
    const recording = loginRecordings.get(tabId);
    if (!recording) throw new BrowserUseError("LOGIN_RECORDING_NOT_STARTED", "Start login recording on this tab first");
    const target = targetById(recording.targetId);
    if (assertAllowedPage(page).id !== target.id) throw new BrowserUseError("TARGET_TAB_MISMATCH", "tab does not belong to target");
    const successText = String(args["success_text"] ?? "").trim().slice(0, 300);
    const passwordVisible = await page.locator('input[type="password"]').isVisible().catch(() => false);
    const urlChanged = page.url() !== recording.profile.entryUrl;
    const successTextMatched = Boolean(successText && await page.getByText(successText, { exact: false }).first().isVisible().catch(() => false));
    if (passwordVisible || (!urlChanged && !successTextMatched)) throw new BrowserUseError("LOGIN_NOT_VERIFIED", "Login is not verified: finish only after the login form disappears and the URL or success text changes");
    const current = new URL(page.url());
    const saved = upsertBrowserUseTarget(projectRoot, {
      ...target,
      loginProfile: { ...recording.profile, successUrlPrefix: `${current.origin}${current.pathname}`, successText },
    }, {});
    loginRecordings.delete(tabId);
    return { recording: false, saved: true, target_id: saved.id, loginProfile: saved.loginProfile, note: "Review the generated profile in Settings > Browser Use and adjust any custom-component labels if needed." };
  }
  if (name === "browser.click") {
    const page = tabById(args["tab_id"]); assertAllowedPage(page);
    const locator = page.locator(String(args["selector"] ?? ""));
    if (await locator.count() !== 1) throw new BrowserUseError("SELECTOR_NOT_UNIQUE", "selector must match exactly one element");
    await locator.click(); await validateAfterAction(page);
    return { clicked: true, url: page.url(), title: await page.title() };
  }
  if (name === "browser.fill") {
    const page = tabById(args["tab_id"]); assertAllowedPage(page);
    const locator = page.locator(String(args["selector"] ?? ""));
    if (await locator.count() !== 1) throw new BrowserUseError("SELECTOR_NOT_UNIQUE", "selector must match exactly one element");
    const type = await locator.getAttribute("type");
    if (String(type).toLowerCase() === "password") throw new BrowserUseError("PASSWORD_REQUIRES_SECURE_FILL", "Use browser.fill_credentials for password fields");
    await locator.fill(String(args["value"] ?? ""));
    return { filled: true, value_length: String(args["value"] ?? "").length };
  }
  if (name === "browser.fill_credentials") {
    const target = targetById(args["target_id"]); const page = tabById(args["tab_id"]);
    if (assertAllowedPage(page).id !== target.id) throw new BrowserUseError("TARGET_TAB_MISMATCH", "tab does not belong to target");
    const credentials = readBrowserUseCredentials(projectRoot, target);
    if (!credentials.username || !credentials.password) throw new BrowserUseError("CREDENTIALS_MISSING", "Saved target credentials are incomplete");
    const username = page.locator(String(args["username_selector"] ?? ""));
    const password = page.locator(String(args["password_selector"] ?? ""));
    if (await username.count() !== 1 || await password.count() !== 1) throw new BrowserUseError("SELECTOR_NOT_UNIQUE", "credential selectors must each match one field");
    await username.fill(credentials.username); await password.fill(credentials.password);
    return { filled: true, username_length: credentials.username.length, password_present: true };
  }
  if (name === "browser.select") {
    const page = tabById(args["tab_id"]); assertAllowedPage(page);
    const locator = page.locator(String(args["selector"] ?? ""));
    if (await locator.count() !== 1) throw new BrowserUseError("SELECTOR_NOT_UNIQUE", "selector must match exactly one select");
    const selected = await locator.selectOption(String(args["value"] ?? ""));
    return { selected };
  }
  if (name === "browser.upload") {
    const page = tabById(args["tab_id"]); assertAllowedPage(page);
    const values = Array.isArray(args["paths"]) ? args["paths"] : [];
    if (!values.length || values.length > 10) throw new BrowserUseError("UPLOAD_PATHS_INVALID", "paths must contain 1 to 10 files");
    const paths = values.map((value) => isAbsolute(String(value)) ? resolve(String(value)) : resolve(projectRoot, String(value)));
    if (paths.some((path) => !existsSync(path) || !statSync(path).isFile())) throw new BrowserUseError("UPLOAD_FILE_NOT_FOUND", "every upload path must be an existing file");
    const locator = page.locator(String(args["selector"] ?? ""));
    if (await locator.count() !== 1) throw new BrowserUseError("SELECTOR_NOT_UNIQUE", "selector must match exactly one file input");
    await locator.setInputFiles(paths);
    return { attached: true, file_count: paths.length, files: paths.map((path) => path.split(/[\\/]/).pop()) };
  }
  if (name === "browser.wait") {
    const page = tabById(args["tab_id"]); assertAllowedPage(page);
    const timeout = Math.max(0, Math.min(Number(args["timeout_ms"] ?? 10_000), 15_000));
    const selector = String(args["selector"] ?? "");
    if (selector) await page.locator(selector).waitFor({ state: "visible", timeout }); else await page.waitForTimeout(timeout);
    return { waited: true, timeout_ms: timeout };
  }
  if (name === "browser.screenshot") {
    const page = tabById(args["tab_id"]); assertAllowedPage(page);
    return { image_base64: (await page.screenshot({ type: "png", fullPage: args["full_page"] === true })).toString("base64"), mime_type: "image/png", url: page.url() };
  }
  if (name === "browser.cancel") { paused = true; return { paused: true, scope: "current_mcp_session" }; }
  if (name === "browser.status") return { paused, scope: "current_mcp_session" };
  if (name === "browser.resume") { paused = false; return { paused: false, scope: "current_mcp_session" }; }
  throw new BrowserUseError("COMMAND_UNKNOWN", `Unknown Browser Use tool: ${name}`);
}

function tool(name: string, description: string, properties: Record<string, unknown> = {}, required: string[] = []) {
  return { name, description, inputSchema: { type: "object", properties, ...(required.length ? { required } : {}), additionalProperties: false } };
}
const tab = { tab_id: { type: "string", description: "Tab id returned by browser.open_target or browser.list_tabs" } };
const selector = { selector: { type: "string", description: "Exact selector returned by browser.snapshot or browser.find" } };
const tools = [
  tool("browser.capabilities", "Inspect Browser Use Chrome/Edge and managed-profile capabilities."),
  tool("browser.list_targets", "List approved Web targets, browser routing, login characteristics, and credential presence without returning passwords."),
  tool("browser.open_target", "Open or reuse an approved Web target in its configured Chrome or Edge managed profile.", { target_id: { type: "string" } }, ["target_id"]),
  tool("browser.list_tabs", "List controlled tabs whose origins remain approved."),
  tool("browser.snapshot", "Return bounded visible DOM controls with stable selectors. Password values are never returned.", { ...tab, limit: { type: "integer", minimum: 1, maximum: 1000 } }, ["tab_id"]),
  tool("browser.find", "Find visible DOM controls by text, label, placeholder, role, name, or selector metadata.", { ...tab, query: { type: "string" } }, ["tab_id", "query"]),
  tool("browser.verify_login", "Verify authentication using configured success URL/text and absence of a visible password field.", { ...tab, target_id: { type: "string" } }, ["tab_id", "target_id"]),
  tool("browser.login", "Atomically open/recover a recorded target, fill username/password, select its company or tenant, and stop before verification submission.", { ...tab, target_id: { type: "string" } }, ["target_id"]),
  tool("browser.submit_login", "Fill a user-confirmed verification code, submit the recorded login form, and verify the resulting authenticated state.", { ...tab, target_id: { type: "string" }, verification_code: { type: "string", minLength: 1, maxLength: 12 } }, ["tab_id", "target_id", "verification_code"]),
  tool("browser.record_login_start", "Detect semantic login fields before one normal login. Password and verification-code values are never recorded.", { ...tab, target_id: { type: "string" } }, ["tab_id", "target_id"]),
  tool("browser.record_login_finish", "After login succeeds, save the detected login semantics and current success URL for user review.", { ...tab, success_text: { type: "string", description: "Optional visible text that confirms login success" } }, ["tab_id"]),
  tool("browser.click", "Click one exact approved-page DOM element.", { ...tab, ...selector }, ["tab_id", "selector"]),
  tool("browser.fill", "Fill a non-password form field. Use browser.fill_credentials for saved passwords.", { ...tab, ...selector, value: { type: "string" } }, ["tab_id", "selector", "value"]),
  tool("browser.fill_credentials", "Securely fill saved username and password without returning either value.", { ...tab, target_id: { type: "string" }, username_selector: { type: "string" }, password_selector: { type: "string" } }, ["tab_id", "target_id", "username_selector", "password_selector"]),
  tool("browser.select", "Select a native HTML option by value.", { ...tab, ...selector, value: { type: "string" } }, ["tab_id", "selector", "value"]),
  tool("browser.upload", "Attach 1-10 explicitly authorized local files to an approved page file input without opening a Windows dialog.", { ...tab, ...selector, paths: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 10 } }, ["tab_id", "selector", "paths"]),
  tool("browser.wait", "Wait for a selector or a bounded delay without using Shell sleep.", { ...tab, selector: { type: "string" }, timeout_ms: { type: "integer", minimum: 0, maximum: 15000 } }, ["tab_id"]),
  tool("browser.screenshot", "Capture an approved Browser Use page.", { ...tab, full_page: { type: "boolean" } }, ["tab_id"]),
  tool("browser.cancel", "Pause Browser Use for the current MCP session."),
  tool("browser.status", "Read the current Browser Use session pause state."),
  tool("browser.resume", "Resume Browser Use only after explicit user instruction."),
];

function content(payload: Record<string, unknown>, name: string) {
  if (name === "browser.screenshot" && payload["ok"] === true) {
    const result = { ...(payload["result"] as Record<string, unknown>) };
    const data = String(result["image_base64"] || ""); delete result["image_base64"];
    return [{ type: "text", text: JSON.stringify({ ok: true, result }) }, ...(data ? [{ type: "image", data, mimeType: "image/png" }] : [])];
  }
  return [{ type: "text", text: JSON.stringify(payload) }];
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newline = buffer.indexOf("\n");
  while (newline >= 0) {
    const raw = buffer.slice(0, newline); buffer = buffer.slice(newline + 1); newline = buffer.indexOf("\n");
    if (!raw.trim()) continue;
    void (async () => {
      let message: Record<string, unknown> | undefined;
      try {
        message = JSON.parse(raw) as Record<string, unknown>;
        const id = message["id"];
        if (id == null) return;
        const method = message["method"];
        let result: unknown;
        if (method === "initialize") result = { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "codeflowmu-browser-use", version: "0.1.0" } };
        else if (method === "tools/list") result = { tools };
        else if (method === "tools/call") {
          const params = (message["params"] ?? {}) as Record<string, unknown>;
          const name = String(params["name"] ?? "");
          try { result = { content: content({ ok: true, result: await command(name, (params["arguments"] ?? {}) as Record<string, unknown>) }, name), isError: false }; }
          catch (error) { const code = error instanceof BrowserUseError ? error.code : "BROWSER_USE_FAILED"; const text = error instanceof Error ? error.message : String(error); result = { content: content({ ok: false, error: { code, message: text } }, name), isError: true }; }
        } else throw new BrowserUseError("METHOD_NOT_FOUND", `Unsupported MCP method: ${method}`);
        process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
      } catch (error) {
        process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: message?.["id"] ?? null, error: { code: -32603, message: error instanceof Error ? error.message : String(error) } })}\n`);
      }
    })();
  }
});

async function closeContexts(): Promise<void> {
  await Promise.allSettled([...contexts.values()].map((context) => context.close()));
  contexts.clear();
  tabs.clear();
}
let shuttingDown = false;
function shutdown(): void {
  if (shuttingDown) return;
  shuttingDown = true;
  void closeContexts().finally(() => process.exit(0));
}
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
process.stdin.once("end", shutdown);
process.stdin.once("close", shutdown);
