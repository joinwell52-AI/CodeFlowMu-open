/**
 * Shell Gateway Client — connects PC Shell to CodeFlowMu Gateway (TASK-003).
 */

import {
  ensureMobileGatewayCredentials,
  type MobileGatewayConfig,
} from "./mobileGatewayConfig.ts";
import type { GatewayLogLevel, GatewayLogWriteInput } from "../gateway-log.ts";

const PING_INTERVAL_MS = 20_000;
const RECONNECT_BASE_MS = 3_000;
const RECONNECT_MAX_MS = 30_000;
const MAX_RECONNECT_ATTEMPTS = 5;
const LOG_RATE_LIMIT_MS = 5_000; // suppress identical logs within this window
const RECONNECT_JITTER_MS = 3_000; // add random jitter to backoff
const MANUAL_RECONNECT_DELAY_MS = 400;

export interface MobileGatewayStatus {
  online: boolean;
  reconnecting: boolean;
  instance_id: string | null;
  last_connected_at: string | null;
  last_seen_at: string | null;
  last_error: string | null;
  gateway_url: string | null;
}

export interface GatewayHttpRequest {
  type: "http_request";
  request_id: string;
  method: string;
  path: string;
  headers?: Record<string, string>;
  body?: unknown;
}

type WebSocketLike = {
  readonly readyState: number;
  send(data: string): void;
  close(): void;
  addEventListener(type: string, listener: (ev: unknown) => void): void;
  removeEventListener?(type: string, listener: (ev: unknown) => void): void;
};

type WebSocketCtor = new (
  url: string,
  protocols?: string | string[],
) => WebSocketLike;

export type GatewayLogWriter = (input: GatewayLogWriteInput) => void;

export type StartMobileGatewayClientOptions = {
  projectRoot: string;
  panelPort: number;
  WebSocketImpl?: WebSocketCtor;
  fetchImpl?: typeof fetch;
  log?: (msg: string) => void;
  writeGatewayLog?: GatewayLogWriter;
};

const OPEN = 1;
const SLOW_REQUEST_MS = 800;

let status: MobileGatewayStatus = {
  online: false,
  reconnecting: false,
  instance_id: null,
  last_connected_at: null,
  last_seen_at: null,
  last_error: null,
  gateway_url: null,
};

let activeWs: WebSocketLike | null = null;
let pingTimer: ReturnType<typeof setInterval> | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectAttempt = 0;
let stopped = true;
let savedStartOptions: StartMobileGatewayClientOptions | null = null;

type RuntimeState = {
  projectRoot: string;
  panelPort: number;
  config: MobileGatewayConfig;
  WebSocketImpl: WebSocketCtor;
  fetchImpl: typeof fetch;
  log: (msg: string) => void;
  writeGatewayLog?: GatewayLogWriter;
};

let runtime: RuntimeState | null = null;

const SECRET_RE = /secret_[a-zA-Z0-9_-]+/g;

// Simple log deduper to avoid rapid identical messages flooding logs
let _lastLogMessage: string | null = null;
let _lastLogTs = 0;

function emitInfoOnce(
  writeLog: GatewayLogWriter | undefined,
  log: (msg: string) => void,
  message: string,
  extra?: Omit<GatewayLogWriteInput, "level" | "message">,
): void {
  try {
    const now = Date.now();
    if (message === _lastLogMessage && now - _lastLogTs < LOG_RATE_LIMIT_MS) {
      return;
    }
    _lastLogMessage = message;
    _lastLogTs = now;
    emitGatewayLog(writeLog, "info", message, extra);
    log(`[mobile-gateway] ${redactLog(message)}`);
  } catch {
    // best-effort
  }
}

function redactLog(msg: string): string {
  return msg.replace(SECRET_RE, "secret_***");
}

function logInfo(log: (msg: string) => void, msg: string): void {
  log(`[mobile-gateway] ${redactLog(msg)}`);
}

function emitGatewayLog(
  writeLog: GatewayLogWriter | undefined,
  level: GatewayLogLevel,
  message: string,
  extra?: Omit<GatewayLogWriteInput, "level" | "message">,
): void {
  if (!writeLog) return;
  writeLog({ level, message, ...extra });
}

function responseErrorCode(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const err = (body as Record<string, unknown>).error;
  return typeof err === "string" ? err : null;
}

export function classifyForwardLog(
  status: number,
  durationMs: number,
  body: unknown,
): { level: GatewayLogLevel; message: string } | null {
  const errCode = responseErrorCode(body);
  if (errCode === "LOCAL_FORWARD_FAILED") {
    return { level: "error", message: "LOCAL_FORWARD_FAILED" };
  }
  if (status === 504 || errCode === "PC_TIMEOUT") {
    return { level: "timeout", message: "PC_TIMEOUT" };
  }
  if (durationMs >= SLOW_REQUEST_MS && status >= 200 && status < 300) {
    return { level: "slow", message: `slow request ${durationMs}ms` };
  }
  return null;
}

export function isMobileApiForwardPath(path: string): boolean {
  return path.startsWith("/api/v2/mobile/");
}

export function isMobileGatewayOnline(): boolean {
  return status.online;
}

export function getMobileGatewayStatus(): MobileGatewayStatus {
  return { ...status };
}

function clearPingTimer(): void {
  if (pingTimer) {
    clearInterval(pingTimer);
    pingTimer = null;
  }
}

function clearReconnectTimer(): void {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

function setOffline(lastError: string | null): void {
  status = {
    ...status,
    online: false,
    last_error: lastError,
  };
}

function scheduleReconnect(): void {
  if (stopped || !runtime?.config.auto_connect || !runtime.config.enabled) {
    return;
  }
  if (reconnectAttempt >= MAX_RECONNECT_ATTEMPTS) {
    clearReconnectTimer();
    status = { ...status, reconnecting: false, last_error: "GATEWAY_UNAVAILABLE" };
    emitInfoOnce(runtime.writeGatewayLog, runtime.log, "gateway unavailable; automatic reconnect stopped");
    return;
  }
  clearReconnectTimer();
  status = { ...status, reconnecting: true };
  // rate-limited log + jittered exponential backoff
  emitInfoOnce(runtime.writeGatewayLog, runtime.log, "reconnecting");
  const base = RECONNECT_BASE_MS * 2 ** reconnectAttempt;
  const jitter = Math.floor(Math.random() * RECONNECT_JITTER_MS);
  const delay = Math.min(base + jitter, RECONNECT_MAX_MS);
  reconnectAttempt += 1;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    if (!stopped && runtime) {
      connectWs(runtime);
    }
  }, delay);
  reconnectTimer.unref();
}

async function forwardHttpRequest(
  req: GatewayHttpRequest,
  rt: RuntimeState,
): Promise<{
  type: "http_response";
  request_id: string;
  status: number;
  headers: Record<string, string>;
  body: unknown;
}> {
  const path = req.path ?? "";
  if (!isMobileApiForwardPath(path)) {
    return {
      type: "http_response",
      request_id: req.request_id,
      status: 403,
      headers: { "content-type": "application/json" },
      body: { ok: false, error: "FORBIDDEN" },
    };
  }

  const url = `http://127.0.0.1:${rt.panelPort}${path}`;
  const method = (req.method ?? "GET").toUpperCase();
  const headers = new Headers();
  const srcHeaders = req.headers ?? {};
  for (const [k, v] of Object.entries(srcHeaders)) {
    if (v) {
      headers.set(k, v);
    }
  }

  let body: BodyInit | undefined;
  if (req.body !== undefined && req.body !== null && method !== "GET" && method !== "HEAD") {
    if (typeof req.body === "string") {
      body = req.body;
    } else {
      body = JSON.stringify(req.body);
      if (!headers.has("content-type")) {
        headers.set("content-type", "application/json");
      }
    }
  }

  const started = Date.now();
  try {
    const resp = await rt.fetchImpl(url, { method, headers, body });
    const durationMs = Date.now() - started;
    const contentType = resp.headers.get("content-type") ?? "";
    let respBody: unknown;
    if (contentType.includes("application/json")) {
      try {
        respBody = await resp.json();
      } catch {
        respBody = await resp.text();
      }
    } else if (contentType.startsWith("text/") || contentType.includes("json")) {
      respBody = await resp.text();
    } else {
      const buf = await resp.arrayBuffer();
      respBody = Buffer.from(buf).toString("base64");
    }
    const outHeaders: Record<string, string> = {};
    resp.headers.forEach((value, key) => {
      outHeaders[key] = value;
    });
    const classified = classifyForwardLog(resp.status, durationMs, respBody);
    if (classified) {
      const detail =
        classified.level === "error" && respBody && typeof respBody === "object"
          ? (respBody as Record<string, unknown>).detail
          : undefined;
      emitGatewayLog(rt.writeGatewayLog, classified.level, classified.message, {
        method,
        path,
        status: resp.status,
        durationMs,
        request_id: req.request_id,
        detail: typeof detail === "string" ? detail : undefined,
      });
    }
    return {
      type: "http_response",
      request_id: req.request_id,
      status: resp.status,
      headers: outHeaders,
      body: respBody,
    };
  } catch (err) {
    const durationMs = Date.now() - started;
    const detail = err instanceof Error ? err.message : String(err);
    emitGatewayLog(rt.writeGatewayLog, "error", "LOCAL_FORWARD_FAILED", {
      method,
      path,
      status: 502,
      durationMs,
      request_id: req.request_id,
      detail,
    });
    return {
      type: "http_response",
      request_id: req.request_id,
      status: 502,
      headers: { "content-type": "application/json" },
      body: {
        ok: false,
        error: "LOCAL_FORWARD_FAILED",
        detail,
      },
    };
  }
}

function handleMessage(raw: string, rt: RuntimeState): void {
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return;
  }
  const type = data.type;
  if (type === "pc_hello_ack") {
    if (data.ok === true) {
      reconnectAttempt = 0;
      status = {
        ...status,
        online: true,
        reconnecting: false,
        instance_id: rt.config.instance_id,
        last_connected_at: new Date().toISOString(),
        last_error: null,
      };
      const msg = `connected instance_id=${rt.config.instance_id}`;
      emitGatewayLog(rt.writeGatewayLog, "info", msg);
      logInfo(rt.log, msg);
    } else {
      const err = typeof data.error === "string" ? data.error : "HELLO_REJECTED";
      setOffline(err);
      logInfo(rt.log, `pc_hello_ack failed: ${err}`);
      activeWs?.close();
    }
    return;
  }
  if (type === "pong") {
    status = { ...status, last_seen_at: new Date().toISOString() };
    return;
  }
  if (type === "http_request") {
    const httpReq = data as unknown as GatewayHttpRequest;
    void forwardHttpRequest(httpReq, rt).then((resp) => {
      if (activeWs && activeWs.readyState === OPEN) {
        activeWs.send(JSON.stringify(resp));
      }
    });
  }
}

function startPing(ws: WebSocketLike): void {
  clearPingTimer();
  pingTimer = setInterval(() => {
    if (ws.readyState === OPEN) {
      ws.send(JSON.stringify({ type: "ping", ts: Date.now() }));
    }
  }, PING_INTERVAL_MS);
  pingTimer.unref();
}

function connectWs(rt: RuntimeState): void {
  if (stopped || !rt.config.enabled) {
    return;
  }
  clearReconnectTimer();
  if (activeWs) {
    try {
      activeWs.close();
    } catch {
      /* ignore */
    }
    activeWs = null;
  }
  clearPingTimer();

  const url = rt.config.gateway_url;
  status = {
    ...status,
    gateway_url: url,
    instance_id: rt.config.instance_id,
  };

  let ws: WebSocketLike;
  try {
    ws = new rt.WebSocketImpl(url);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    setOffline(msg);
    scheduleReconnect();
    return;
  }

  activeWs = ws;

  const onOpen = () => {
    ws.send(
      JSON.stringify({
        type: "pc_hello",
        instance_id: rt.config.instance_id,
        instance_secret: rt.config.instance_secret,
      }),
    );
    startPing(ws);
  };

  const onMessage = (ev: unknown) => {
    const msgEv = ev as { data?: string | ArrayBuffer };
    const payload = typeof msgEv.data === "string" ? msgEv.data : "";
    if (payload) {
      handleMessage(payload, rt);
    }
  };

  const onClose = (ev?: any) => {
    clearPingTimer();
    if (activeWs === ws) {
      activeWs = null;
    }
    if (stopped) {
      return;
    }
    // capture close code/reason if provided by server
    const code = ev && typeof ev.code === "number" ? ev.code : undefined;
    const reason = ev && typeof ev.reason === "string" ? ev.reason : undefined;
    const closeMsg = code ? `disconnected code=${code} reason=${reason ?? ""}` : "disconnected";
    emitInfoOnce(runtime?.writeGatewayLog, rt.log, closeMsg);
    setOffline((reason && reason.length) ? `${reason}` : status.last_error ?? "DISCONNECTED");
    scheduleReconnect();
  };

  const onError = () => {
    setOffline("WEBSOCKET_ERROR");
  };

  ws.addEventListener("open", onOpen);
  ws.addEventListener("message", onMessage);
  ws.addEventListener("close", (ev) => onClose(ev));
  ws.addEventListener("error", onError);
}

function beginMobileGatewayClient(opts: StartMobileGatewayClientOptions): void {
  stopped = false;

  const config = ensureMobileGatewayCredentials(opts.projectRoot);
  const gatewayUrl = config.gateway_url.trim();
  if (!/^wss?:\/\//i.test(gatewayUrl) || /(?:^|[/:.])example\.invalid(?=[:/]|$)/i.test(gatewayUrl)) {
    status = {
      online: false,
      reconnecting: false,
      instance_id: config.instance_id,
      last_connected_at: null,
      last_seen_at: null,
      last_error: "GATEWAY_UNCONFIGURED",
      gateway_url: config.gateway_url,
    };
    return;
  }
  if (!config.enabled || !config.auto_connect) {
    status = {
      online: false,
      reconnecting: false,
      instance_id: config.instance_id,
      last_connected_at: null,
      last_seen_at: null,
      last_error: config.enabled ? null : "GATEWAY_DISABLED",
      gateway_url: config.gateway_url,
    };
    return;
  }

  const WebSocketImpl = opts.WebSocketImpl ?? (globalThis.WebSocket as WebSocketCtor | undefined);
  if (!WebSocketImpl) {
    status = {
      ...status,
      reconnecting: false,
      instance_id: config.instance_id,
      last_error: "WEBSOCKET_UNAVAILABLE",
      gateway_url: config.gateway_url,
    };
    return;
  }

  runtime = {
    projectRoot: opts.projectRoot,
    panelPort: opts.panelPort,
    config,
    WebSocketImpl,
    fetchImpl: opts.fetchImpl ?? fetch,
    log: opts.log ?? (() => {}),
    writeGatewayLog: opts.writeGatewayLog,
  };
  reconnectAttempt = 0;
  logInfo(runtime.log, `starting client url=${config.gateway_url}`);
  connectWs(runtime);
}

export function startMobileGatewayClient(opts: StartMobileGatewayClientOptions): void {
  savedStartOptions = { ...opts };
  stopMobileGatewayClient();
  beginMobileGatewayClient(opts);
}

export function stopMobileGatewayClient(): void {
  stopped = true;
  clearPingTimer();
  clearReconnectTimer();
  if (activeWs) {
    try {
      activeWs.close();
    } catch {
      /* ignore */
    }
    activeWs = null;
  }
  runtime = null;
  status = {
    ...status,
    online: false,
    reconnecting: false,
  };
  setOffline(null);
}

export async function reconnectMobileGatewayClient(): Promise<{
  ok: boolean;
  error?: string;
}> {
  const opts = savedStartOptions;
  if (!opts) {
    return { ok: false, error: "NOT_STARTED" };
  }
  const writeLog = opts.writeGatewayLog;
  const consoleLog = opts.log ?? (() => {});

  try {
    emitGatewayLog(writeLog, "info", "reconnect requested by ADMIN");
    logInfo(consoleLog, "reconnect requested by ADMIN");

    status = { ...status, reconnecting: true };

    emitGatewayLog(writeLog, "info", "reconnect stopped old client");
    logInfo(consoleLog, "reconnect stopped old client");
    stopMobileGatewayClient();

    await new Promise<void>((resolve) => {
      setTimeout(resolve, MANUAL_RECONNECT_DELAY_MS);
    });

    emitGatewayLog(writeLog, "info", "reconnect started");
    logInfo(consoleLog, "reconnect started");

    beginMobileGatewayClient(opts);
    return { ok: true };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    status = { ...status, reconnecting: false };
    emitGatewayLog(writeLog, "error", "reconnect failed", { detail });
    logInfo(consoleLog, `reconnect failed detail=${detail}`);
    return { ok: false, error: detail };
  }
}

export async function forwardBindToGateway(
  _payload: unknown,
): Promise<{ ok: false; reason: string }> {
  return { ok: false, reason: "GATEWAY_NOT_CONFIGURED" };
}

/** @internal test hook */
export function resetMobileGatewayClientForTests(): void {
  stopMobileGatewayClient();
  savedStartOptions = null;
  status = {
    online: false,
    reconnecting: false,
    instance_id: null,
    last_connected_at: null,
    last_seen_at: null,
    last_error: null,
    gateway_url: null,
  };
}
