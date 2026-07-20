/**
 * Mobile Gateway Client unit tests — TASK-003
 */

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import { saveMobileGatewayConfig } from "../mobile/mobileGatewayConfig.ts";
import {
  classifyForwardLog,
  getMobileGatewayStatus,
  isMobileApiForwardPath,
  reconnectMobileGatewayClient,
  resetMobileGatewayClientForTests,
  startMobileGatewayClient,
  stopMobileGatewayClient,
} from "../mobile/mobileGatewayClient.ts";

const WS_OPEN = 1;

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class MockWebSocket {
  static readonly OPEN = WS_OPEN;

  readyState = 0;
  readonly url: string;
  sent: string[] = [];
  closed = false;

  private readonly listeners = new Map<string, Set<(ev: unknown) => void>>();

  constructor(url: string) {
    this.url = url;
    queueMicrotask(() => {
      this.readyState = WS_OPEN;
      this.emit("open", {});
    });
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closed = true;
    this.readyState = 3;
    this.emit("close", {});
  }

  addEventListener(type: string, listener: (ev: unknown) => void): void {
    if (!this.listeners.has(type)) {
      this.listeners.set(type, new Set());
    }
    this.listeners.get(type)!.add(listener);
  }

  emit(type: string, ev: unknown): void {
    for (const fn of this.listeners.get(type) ?? []) {
      fn(ev);
    }
  }

  simulateMessage(data: Record<string, unknown>): void {
    this.emit("message", { data: JSON.stringify(data) });
  }
}

function makeProjectWithGatewayConfig(): string {
  const root = mkdtempSync(join(tmpdir(), "cf-gw-client-"));
  mkdirSync(join(root, ".codeflowmu"), { recursive: true });
  saveMobileGatewayConfig(root, {
    enabled: true,
    mode: "local_gateway",
    gateway_url: "ws://127.0.0.1:5262/gateway/pc",
    public_base_url: "http://127.0.0.1:5262",
    instance_id: "pc_test_inst",
    instance_secret: "secret_test_redact_me",
    auto_connect: true,
  });
  return root;
}

function makeProjectWithConfig(config: Parameters<typeof saveMobileGatewayConfig>[1]): string {
  const root = mkdtempSync(join(tmpdir(), "cf-gw-client-"));
  mkdirSync(join(root, ".codeflowmu"), { recursive: true });
  saveMobileGatewayConfig(root, config);
  return root;
}

afterEach(() => {
  stopMobileGatewayClient();
  resetMobileGatewayClientForTests();
});

test("isMobileApiForwardPath allows only /api/v2/mobile/*", () => {
  assert.equal(isMobileApiForwardPath("/api/v2/mobile/bootstrap"), true);
  assert.equal(isMobileApiForwardPath("/api/v2/mobile/panel/status"), true);
  assert.equal(isMobileApiForwardPath("/api/v2/other"), false);
  assert.equal(isMobileApiForwardPath("/health"), false);
});

test("does not connect or retry an unconfigured Gateway", async () => {
  const root = makeProjectWithConfig({
    enabled: true,
    mode: "official_demo_limited",
    gateway_url: "wss://example.invalid/codeflowmu/gateway/pc",
    public_base_url: "https://example.invalid/codeflowmu",
    instance_id: "pc_unconfigured",
    instance_secret: "secret_unconfigured",
    auto_connect: true,
  });
  let connectCount = 0;
  const WebSocketImpl = class extends MockWebSocket {
    constructor(url: string) {
      super(url);
      connectCount += 1;
    }
  };

  startMobileGatewayClient({
    projectRoot: root,
    panelPort: 5999,
    WebSocketImpl: WebSocketImpl as unknown as typeof MockWebSocket,
  });

  await wait(20);
  assert.equal(connectCount, 0);
  assert.equal(getMobileGatewayStatus().last_error, "GATEWAY_UNCONFIGURED");
});

test("client sends pc_hello and becomes online after pc_hello_ack", async () => {
  const root = makeProjectWithGatewayConfig();
  let ws = null as unknown as MockWebSocket;
  const WebSocketImpl = class extends MockWebSocket {
    constructor(url: string) {
      super(url);
      ws = this;
    }
  };

  const logs: string[] = [];
  startMobileGatewayClient({
    projectRoot: root,
    panelPort: 5999,
    WebSocketImpl: WebSocketImpl as unknown as typeof MockWebSocket,
    log: (msg) => logs.push(msg),
  });

  await wait(20);
  assert.ok(ws);
  const helloRaw = ws!.sent.find((line) => {
    try {
      return (JSON.parse(line) as { type?: string }).type === "pc_hello";
    } catch {
      return false;
    }
  });
  assert.ok(helloRaw);
  const hello = JSON.parse(helloRaw!) as {
    type: string;
    instance_id: string;
    instance_secret: string;
  };
  assert.equal(hello.type, "pc_hello");
  assert.equal(hello.instance_id, "pc_test_inst");
  assert.equal(hello.instance_secret, "secret_test_redact_me");

  ws!.simulateMessage({ type: "pc_hello_ack", ok: true });
  const st = getMobileGatewayStatus();
  assert.equal(st.online, true);
  assert.equal(st.instance_id, "pc_test_inst");
  assert.ok(st.last_connected_at);
  assert.equal(st.last_error, null);

  for (const line of logs) {
    assert.equal(line.includes("secret_test_redact_me"), false);
  }
});

test("http_request forwards mobile paths to local panel", async () => {
  const root = makeProjectWithGatewayConfig();
  let ws = null as unknown as MockWebSocket;
  const WebSocketImpl = class extends MockWebSocket {
    constructor(url: string) {
      super(url);
      ws = this;
    }
  };

  const fetchCalls: { url: string; method: string }[] = [];
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    fetchCalls.push({ url: String(url), method: init?.method ?? "GET" });
    return new Response(JSON.stringify({ ok: true, forwarded: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  const httpResponses: string[] = [];
  startMobileGatewayClient({
    projectRoot: root,
    panelPort: 5888,
    WebSocketImpl: WebSocketImpl as unknown as typeof MockWebSocket,
    fetchImpl,
  });

  await wait(20);
  assert.ok(ws);
  ws!.simulateMessage({ type: "pc_hello_ack", ok: true });

  const captureSend = ws!.send.bind(ws);
  ws!.send = (data: string) => {
    const parsed = JSON.parse(data) as { type?: string };
    if (parsed.type === "http_response") {
      httpResponses.push(data);
    }
    captureSend(data);
  };

  ws!.simulateMessage({
    type: "http_request",
    request_id: "req-mobile-1",
    method: "GET",
    path: "/api/v2/mobile/bootstrap",
  });

  await wait(30);
  assert.equal(fetchCalls.length, 1);
  assert.equal(fetchCalls[0]!.url, "http://127.0.0.1:5888/api/v2/mobile/bootstrap");
  assert.equal(fetchCalls[0]!.method, "GET");

  const mobileResp = httpResponses.find((line) => {
    const body = JSON.parse(line) as { request_id?: string };
    return body.request_id === "req-mobile-1";
  });
  assert.ok(mobileResp);
  const parsedResp = JSON.parse(mobileResp!) as { status: number; body: { forwarded?: boolean } };
  assert.equal(parsedResp.status, 200);
  assert.equal(parsedResp.body.forwarded, true);
});

test("http_request rejects non-mobile paths with 403", async () => {
  const root = makeProjectWithGatewayConfig();
  let ws = null as unknown as MockWebSocket;
  const WebSocketImpl = class extends MockWebSocket {
    constructor(url: string) {
      super(url);
      ws = this;
    }
  };

  let fetchCount = 0;
  const fetchImpl = (async () => {
    fetchCount += 1;
    return new Response("{}", { status: 200 });
  }) as typeof fetch;

  const httpResponses: string[] = [];
  startMobileGatewayClient({
    projectRoot: root,
    panelPort: 5888,
    WebSocketImpl: WebSocketImpl as unknown as typeof MockWebSocket,
    fetchImpl,
  });

  await wait(20);
  assert.ok(ws);
  ws!.simulateMessage({ type: "pc_hello_ack", ok: true });

  const captureSend = ws!.send.bind(ws);
  ws!.send = (data: string) => {
    const parsed = JSON.parse(data) as { type?: string };
    if (parsed.type === "http_response") {
      httpResponses.push(data);
    }
    captureSend(data);
  };

  ws!.simulateMessage({
    type: "http_request",
    request_id: "req-forbidden",
    method: "GET",
    path: "/api/v2/admin/secret",
  });

  await wait(20);
  assert.equal(fetchCount, 0);
  const forbidden = httpResponses.find((line) => {
    const body = JSON.parse(line) as { request_id?: string };
    return body.request_id === "req-forbidden";
  });
  assert.ok(forbidden);
  const parsed = JSON.parse(forbidden!) as { status: number; body: { error?: string } };
  assert.equal(parsed.status, 403);
  assert.equal(parsed.body.error, "FORBIDDEN");
});

test("pong updates last_seen_at", async () => {
  const root = makeProjectWithGatewayConfig();
  let ws = null as unknown as MockWebSocket;
  const WebSocketImpl = class extends MockWebSocket {
    constructor(url: string) {
      super(url);
      ws = this;
    }
  };

  startMobileGatewayClient({
    projectRoot: root,
    panelPort: 5999,
    WebSocketImpl: WebSocketImpl as unknown as typeof MockWebSocket,
  });

  await wait(20);
  assert.ok(ws);
  ws!.simulateMessage({ type: "pc_hello_ack", ok: true });
  assert.equal(getMobileGatewayStatus().last_seen_at, null);

  ws!.simulateMessage({ type: "pong" });
  assert.ok(getMobileGatewayStatus().last_seen_at);
});

test("reconnects after websocket close when auto_connect is enabled", async () => {
  const root = makeProjectWithGatewayConfig();
  let connectCount = 0;
  const WebSocketImpl = class extends MockWebSocket {
    constructor(url: string) {
      super(url);
      connectCount += 1;
    }
  };

  startMobileGatewayClient({
    projectRoot: root,
    panelPort: 5999,
    WebSocketImpl: WebSocketImpl as unknown as typeof MockWebSocket,
  });

  await wait(20);
  assert.equal(connectCount, 1);

  const first = connectCount;
  const sockets: MockWebSocket[] = [];
  const TrackingWs = class extends MockWebSocket {
    constructor(url: string) {
      super(url);
      connectCount += 1;
      sockets.push(this);
    }
  };

  stopMobileGatewayClient();
  resetMobileGatewayClientForTests();

  startMobileGatewayClient({
    projectRoot: root,
    panelPort: 5999,
    WebSocketImpl: TrackingWs as unknown as typeof MockWebSocket,
  });

  await wait(20);
  assert.ok(sockets[0]);
  sockets[0]!.close();

  await wait(6200);
  assert.ok(connectCount >= first + 2);
});

test("classifyForwardLog applies 800ms slow threshold and error codes", () => {
  assert.equal(classifyForwardLog(200, 799, {}), null);
  const slow = classifyForwardLog(200, 800, {});
  assert.ok(slow);
  assert.equal(slow!.level, "slow");
  const timeout = classifyForwardLog(504, 100, {});
  assert.equal(timeout!.level, "timeout");
  assert.equal(timeout!.message, "PC_TIMEOUT");
  const forwardFail = classifyForwardLog(502, 50, { error: "LOCAL_FORWARD_FAILED" });
  assert.equal(forwardFail!.level, "error");
  assert.equal(forwardFail!.message, "LOCAL_FORWARD_FAILED");
});

test("reconnectMobileGatewayClient emits required gateway log messages", async () => {
  const root = makeProjectWithGatewayConfig();
  const WebSocketImpl = class extends MockWebSocket {
    constructor(url: string) {
      super(url);
    }
  };

  const gwLogs: { level: string; message: string }[] = [];
  startMobileGatewayClient({
    projectRoot: root,
    panelPort: 5999,
    WebSocketImpl: WebSocketImpl as unknown as typeof MockWebSocket,
    writeGatewayLog: (input) => {
      gwLogs.push({ level: input.level, message: input.message });
    },
  });

  await wait(20);
  const result = await reconnectMobileGatewayClient();
  assert.equal(result.ok, true);
  await wait(450);

  const messages = gwLogs.map((e) => e.message);
  assert.ok(messages.includes("reconnect requested by ADMIN"));
  assert.ok(messages.includes("reconnect stopped old client"));
  assert.ok(messages.includes("reconnect started"));
});
