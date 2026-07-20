/**
 * Mobile Gateway config — adopted server template defaults
 */

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  ensureMobileGatewayCredentials,
  mobileGatewayConfigPath,
} from "../mobile/mobileGatewayConfig.ts";
import { resolveMobilePublicApiBase } from "../mobile/mobileInstance.ts";

function writeAdoptedServerTemplate(
  projectRoot: string,
  body: Record<string, unknown>,
): void {
  const dir = join(projectRoot, "adoptedSource", "gateway");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "mobile-gateway.server.json"),
    `${JSON.stringify(body, null, 2)}\n`,
    "utf8",
  );
}

test("ensureMobileGatewayCredentials prefers adopted server template over local_gateway", () => {
  const root = mkdtempSync(join(tmpdir(), "cf-gw-config-adopted-"));
  writeAdoptedServerTemplate(root, {
    enabled: true,
    mode: "server_gateway",
    gateway_url: "wss://example.test/codeflowmu/gateway/pc",
    public_base_url: "https://example.test/codeflowmu",
    auto_connect: true,
  });

  const config = ensureMobileGatewayCredentials(root);

  assert.equal(config.mode, "server_gateway");
  assert.equal(config.gateway_url, "wss://example.test/codeflowmu/gateway/pc");
  assert.equal(config.public_base_url, "https://example.test/codeflowmu");
  assert.match(config.instance_id, /^pc_/);
  assert.match(config.instance_secret, /^secret_/);

  const saved = JSON.parse(readFileSync(mobileGatewayConfigPath(root), "utf8")) as {
    mode: string;
    gateway_url: string;
  };
  assert.equal(saved.mode, "server_gateway");
  assert.equal(saved.gateway_url, "wss://example.test/codeflowmu/gateway/pc");
});

test("ensureMobileGatewayCredentials falls back to local_gateway without adopted template", () => {
  const root = mkdtempSync(join(tmpdir(), "cf-gw-config-local-"));

  const config = ensureMobileGatewayCredentials(root);

  assert.equal(config.mode, "local_gateway");
  assert.equal(config.gateway_url, "ws://127.0.0.1:5262/gateway/pc");
});

test("open edition migrates endpoint settings to official Gateway and preserves credentials", () => {
  const hostRoot = mkdtempSync(join(tmpdir(), "cf-gw-config-open-host-"));
  const projectRoot = mkdtempSync(join(tmpdir(), "cf-gw-config-open-project-"));
  mkdirSync(join(hostRoot, ".codeflowmu"), { recursive: true });
  writeFileSync(
    join(hostRoot, ".codeflowmu", "mobile-gateway.json"),
    `${JSON.stringify({
      enabled: true,
      mode: "official_demo_limited",
      gateway_url: "wss://ai.chedian.cc/codeflowmu/gateway/pc",
      public_base_url: "https://ai.chedian.cc/codeflowmu",
      auto_connect: true,
    }, null, 2)}\n`,
    "utf8",
  );
  mkdirSync(join(projectRoot, ".codeflowmu"), { recursive: true });
  writeFileSync(
    mobileGatewayConfigPath(projectRoot),
    `${JSON.stringify({
      enabled: true,
      mode: "local_gateway",
      gateway_url: "ws://127.0.0.1:5262/gateway/pc",
      public_base_url: "http://127.0.0.1:5262",
      instance_id: "pc_existing",
      instance_secret: "secret_existing",
      auto_connect: true,
    }, null, 2)}\n`,
    "utf8",
  );

  const previousEdition = process.env.CODEFLOW_OPEN_EDITION;
  const previousHostRoot = process.env.CODEFLOW_OPEN_HOST_ROOT;
  process.env.CODEFLOW_OPEN_EDITION = "1";
  process.env.CODEFLOW_OPEN_HOST_ROOT = hostRoot;
  try {
    const config = ensureMobileGatewayCredentials(projectRoot);
    assert.equal(config.mode, "official_demo_limited");
    assert.equal(config.gateway_url, "wss://ai.chedian.cc/codeflowmu/gateway/pc");
    assert.equal(config.public_base_url, "https://ai.chedian.cc/codeflowmu");
    assert.equal(config.instance_id, "pc_existing");
    assert.equal(config.instance_secret, "secret_existing");

    const saved = JSON.parse(readFileSync(mobileGatewayConfigPath(projectRoot), "utf8"));
    assert.equal(saved.mode, "official_demo_limited");
    assert.equal(saved.instance_id, "pc_existing");
  } finally {
    if (previousEdition === undefined) delete process.env.CODEFLOW_OPEN_EDITION;
    else process.env.CODEFLOW_OPEN_EDITION = previousEdition;
    if (previousHostRoot === undefined) delete process.env.CODEFLOW_OPEN_HOST_ROOT;
    else process.env.CODEFLOW_OPEN_HOST_ROOT = previousHostRoot;
  }
});

test("mother Gateway identity stays fixed when the active development project changes", () => {
  const hostRoot = mkdtempSync(join(tmpdir(), "cf-gw-mother-host-"));
  const adoptedProject = mkdtempSync(join(tmpdir(), "cf-gw-adopted-project-"));
  mkdirSync(join(hostRoot, ".codeflowmu"), { recursive: true });
  writeFileSync(
    join(hostRoot, ".codeflowmu", "mobile-gateway.json"),
    `${JSON.stringify({
      enabled: true,
      mode: "server_gateway",
      gateway_url: "wss://ai.chedian.cc/codeflowmu/gateway/pc",
      public_base_url: "https://ai.chedian.cc/codeflowmu",
      instance_id: "pc_mother_shared",
      instance_secret: "secret_mother_shared",
      auto_connect: true,
    }, null, 2)}\n`,
    "utf8",
  );
  mkdirSync(join(adoptedProject, ".codeflowmu"), { recursive: true });
  writeFileSync(
    join(adoptedProject, ".codeflowmu", "mobile-gateway.json"),
    `${JSON.stringify({
      enabled: true,
      mode: "local_gateway",
      gateway_url: "ws://127.0.0.1:5262/gateway/pc",
      public_base_url: "http://127.0.0.1:5262",
      instance_id: "pc_stale_project",
      instance_secret: "secret_stale_project",
      auto_connect: true,
    }, null, 2)}\n`,
    "utf8",
  );

  const previousHostRoot = process.env.CODEFLOWMU_HOST_ROOT;
  process.env.CODEFLOWMU_HOST_ROOT = hostRoot;
  try {
    const config = ensureMobileGatewayCredentials(adoptedProject);
    assert.equal(config.gateway_url, "wss://ai.chedian.cc/codeflowmu/gateway/pc");
    assert.equal(config.public_base_url, "https://ai.chedian.cc/codeflowmu");
    assert.equal(config.instance_id, "pc_mother_shared");
    assert.equal(
      resolveMobilePublicApiBase(adoptedProject),
      "https://ai.chedian.cc/codeflowmu/m/pc_mother_shared",
    );
    assert.equal(
      mobileGatewayConfigPath(adoptedProject),
      join(hostRoot, ".codeflowmu", "mobile-gateway.json"),
    );
  } finally {
    if (previousHostRoot === undefined) delete process.env.CODEFLOWMU_HOST_ROOT;
    else process.env.CODEFLOWMU_HOST_ROOT = previousHostRoot;
  }
});
