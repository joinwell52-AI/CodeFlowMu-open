import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import {
  readBrowserUseSettings,
  upsertBrowserUseTarget,
  type BrowserUseLoginProfile,
  type BrowserUseTarget,
} from "./browser-use-settings.ts";

interface RecordingSession {
  projectRoot: string;
  target: BrowserUseTarget;
  browser: Browser;
  context: BrowserContext;
  page: Page;
  detected: BrowserUseLoginProfile;
  events: RecordedLoginEvent[];
}

interface RecordedLoginEvent {
  kind: "open_select" | "select_option";
  text: string;
  label: string;
  at: number;
}

let active: RecordingSession | undefined;

function executable(browser: "chrome" | "edge"): string {
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
  if (!found) throw new Error(`${browser === "edge" ? "Microsoft Edge" : "Google Chrome"} 未安装或无法定位`);
  return found;
}

async function infer(page: Page): Promise<BrowserUseLoginProfile> {
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

export async function startBrowserUseLoginRecording(projectRootInput: string, targetId: string): Promise<Record<string, unknown>> {
  if (active) throw new Error(`已有目标 ${active.target.name} 正在录制，请先完成或取消`);
  const projectRoot = resolve(projectRootInput);
  const target = readBrowserUseSettings(projectRoot).targets.find((item) => item.id === targetId);
  if (!target) throw new Error("Browser Use 目标不存在");
  const browser = await chromium.launch({
    executablePath: executable(target.browser), headless: false,
    args: ["--no-first-run", "--no-default-browser-check"],
  });
  const context = await browser.newContext({ viewport: null, acceptDownloads: false });
  try {
    const page = await context.newPage();
    const entry = target.loginProfile.entryUrl || target.url;
    await page.goto(entry, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await page.waitForTimeout(800);
    await page.bringToFront();
    const events: RecordedLoginEvent[] = [];
    await page.exposeBinding("__cfmRecordLoginEvent", (_source, value: unknown) => {
      if (!value || typeof value !== "object" || events.length >= 100) return;
      const raw = value as Record<string, unknown>;
      const kind = raw["kind"] === "select_option" ? "select_option" : raw["kind"] === "open_select" ? "open_select" : undefined;
      if (!kind) return;
      const text = String(raw["text"] ?? "").trim().slice(0, 300);
      const label = String(raw["label"] ?? "").trim().slice(0, 300);
      if (text || label) events.push({ kind, text, label, at: Date.now() });
    });
    await page.evaluate(`() => {
      if (window.__cfmLoginRecorderInstalled) return;
      window.__cfmLoginRecorderInstalled = true;
      const send = (payload) => { try { window.__cfmRecordLoginEvent(payload); } catch {} };
      const textOf = (element) => String(element?.innerText || element?.textContent || element?.getAttribute?.("aria-label") || "").trim().replace(/\\s+/g, " ").slice(0, 300);
      document.addEventListener("click", (event) => {
        const target = event.target instanceof Element ? event.target : null;
        if (!target) return;
        const option = target.closest('[role="option"],li,[class*="option"],[class*="dropdown-item"],[class*="select-dropdown"]');
        if (option) { send({ kind: "select_option", text: textOf(option), label: option.getAttribute("aria-label") || "" }); return; }
        const control = target.closest('[role="combobox"],[aria-haspopup="listbox"],.el-select,.ant-select,.select2-container,[class*="select"]');
        if (control) send({ kind: "open_select", text: textOf(control), label: control.getAttribute("aria-label") || "" });
      }, true);
      document.addEventListener("change", (event) => {
        const target = event.target;
        if (target instanceof HTMLSelectElement) send({ kind: "select_option", text: String(target.selectedOptions[0]?.textContent || "").trim(), label: target.labels?.[0]?.innerText || target.getAttribute("aria-label") || target.name || "" });
      }, true);
    }`);
    active = { projectRoot, target, browser, context, page, detected: await infer(page), events };
    return { recording: true, targetId: target.id, targetName: target.name, detected: active.detected };
  } catch (error) {
    await browser.close();
    throw error;
  }
}

export async function finishBrowserUseLoginRecording(projectRootInput: string, targetId: string, successText = ""): Promise<Record<string, unknown>> {
  const projectRoot = resolve(projectRootInput);
  if (!active || active.projectRoot !== projectRoot || active.target.id !== targetId) throw new Error("该目标没有进行中的登录录制");
  const { browser, page, target, detected, events } = active;
  try {
    const current = new URL(page.url());
    if (current.origin !== new URL(target.url).origin) throw new Error("登录后页面已离开获准的 HTTPS Origin，不能保存特征");
    const passwordVisible = await page.locator('input[type="password"]').isVisible().catch(() => false);
    const urlChanged = page.url() !== detected.entryUrl;
    const normalizedSuccessText = successText.trim().slice(0, 300);
    const successTextMatched = Boolean(normalizedSuccessText && await page.getByText(normalizedSuccessText, { exact: false }).first().isVisible().catch(() => false));
    if (passwordVisible || (!urlChanged && !successTextMatched)) throw new Error("尚未确认登录成功：请完成登录，确保登录表单已消失，并填写可见的成功页面文字或进入新的成功地址");
    const cleanSuccessUrl = `${current.origin}${current.pathname}`;
    const selected = [...events].reverse().find((event) => event.kind === "select_option" && event.text);
    const opened = selected ? [...events].reverse().find((event) => event.kind === "open_select" && event.at <= selected.at) : undefined;
    const saved = upsertBrowserUseTarget(projectRoot, {
      ...target,
      loginProfile: {
        ...detected,
        tenantLabel: opened?.label || opened?.text || detected.tenantLabel || target.loginProfile.tenantLabel,
        tenantValue: selected?.text || detected.tenantValue || target.loginProfile.tenantValue,
        successUrlPrefix: cleanSuccessUrl,
        successText: normalizedSuccessText,
      },
    }, {});
    return { recording: false, saved: true, target: saved, recordedActions: events.map(({ at: _at, ...event }) => event) };
  } finally {
    active = undefined;
    await browser.close();
  }
}

export async function cancelBrowserUseLoginRecording(projectRootInput: string, targetId?: string): Promise<void> {
  const projectRoot = resolve(projectRootInput);
  if (!active || active.projectRoot !== projectRoot || (targetId && active.target.id !== targetId)) return;
  const browser = active.browser;
  active = undefined;
  await browser.close();
}

export function browserUseLoginRecordingStatus(projectRootInput: string): Record<string, unknown> {
  const projectRoot = resolve(projectRootInput);
  return active && active.projectRoot === projectRoot
    ? { recording: true, targetId: active.target.id, targetName: active.target.name, detected: active.detected, recordedActionCount: active.events.length }
    : { recording: false };
}
