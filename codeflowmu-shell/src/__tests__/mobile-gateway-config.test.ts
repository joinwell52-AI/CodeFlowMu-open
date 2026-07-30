/**
 * Mobile Gateway config — adopted server template defaults
 */

import assert from "node:assert/strict";
import {
  copyFileSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
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
    join(hostRoot, ".codeflowmu", "mobile-gateway.example.json"),
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
      runtime_instance_id: "cfm-open-existing",
      instance_id: "pc_existing",
      instance_secret: "secret_existing",
      auto_connect: true,
    }, null, 2)}\n`,
    "utf8",
  );

  const previousEdition = process.env.CODEFLOW_OPEN_EDITION;
  const previousHostRoot = process.env.CODEFLOW_OPEN_HOST_ROOT;
  const previousRuntimeInstanceId = process.env.CODEFLOWMU_RUNTIME_INSTANCE_ID;
  process.env.CODEFLOW_OPEN_EDITION = "1";
  process.env.CODEFLOW_OPEN_HOST_ROOT = hostRoot;
  process.env.CODEFLOWMU_RUNTIME_INSTANCE_ID = "cfm-open-existing";
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
    if (previousRuntimeInstanceId === undefined) {
      delete process.env.CODEFLOWMU_RUNTIME_INSTANCE_ID;
    } else {
      process.env.CODEFLOWMU_RUNTIME_INSTANCE_ID = previousRuntimeInstanceId;
    }
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
      runtime_instance_id: "cfm-mother",
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
  const previousRuntimeInstanceId = process.env.CODEFLOWMU_RUNTIME_INSTANCE_ID;
  process.env.CODEFLOWMU_HOST_ROOT = hostRoot;
  process.env.CODEFLOWMU_RUNTIME_INSTANCE_ID = "cfm-mother";
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
    if (previousRuntimeInstanceId === undefined) {
      delete process.env.CODEFLOWMU_RUNTIME_INSTANCE_ID;
    } else {
      process.env.CODEFLOWMU_RUNTIME_INSTANCE_ID = previousRuntimeInstanceId;
    }
  }
});

test("copied mother config rotates credentials on a different machine", () => {
  const sourceHost = mkdtempSync(join(tmpdir(), "cf-gw-source-host-"));
  const copiedHost = mkdtempSync(join(tmpdir(), "cf-gw-copied-host-"));
  const sourceProject = mkdtempSync(join(tmpdir(), "cf-gw-source-project-"));
  const copiedProject = mkdtempSync(join(tmpdir(), "cf-gw-copied-project-"));
  mkdirSync(join(sourceHost, ".codeflowmu"), { recursive: true });
  mkdirSync(join(copiedHost, ".codeflowmu"), { recursive: true });

  const previousHostRoot = process.env.CODEFLOWMU_HOST_ROOT;
  const previousRuntimeInstanceId = process.env.CODEFLOWMU_RUNTIME_INSTANCE_ID;
  try {
    process.env.CODEFLOWMU_HOST_ROOT = sourceHost;
    process.env.CODEFLOWMU_RUNTIME_INSTANCE_ID = "cfm-physical-machine-a";
    const source = ensureMobileGatewayCredentials(sourceProject);

    copyFileSync(
      join(sourceHost, ".codeflowmu", "mobile-gateway.json"),
      join(copiedHost, ".codeflowmu", "mobile-gateway.json"),
    );

    process.env.CODEFLOWMU_HOST_ROOT = copiedHost;
    process.env.CODEFLOWMU_RUNTIME_INSTANCE_ID = "cfm-physical-machine-b";
    const copied = ensureMobileGatewayCredentials(copiedProject);
    assert.notEqual(copied.instance_id, source.instance_id);
    assert.notEqual(copied.instance_secret, source.instance_secret);
    assert.notEqual(copied.runtime_instance_id, source.runtime_instance_id);

    const restarted = ensureMobileGatewayCredentials(copiedProject);
    assert.equal(restarted.instance_id, copied.instance_id);
    assert.equal(restarted.instance_secret, copied.instance_secret);
    assert.equal(restarted.runtime_instance_id, copied.runtime_instance_id);
  } finally {
    if (previousHostRoot === undefined) delete process.env.CODEFLOWMU_HOST_ROOT;
    else process.env.CODEFLOWMU_HOST_ROOT = previousHostRoot;
    if (previousRuntimeInstanceId === undefined) {
      delete process.env.CODEFLOWMU_RUNTIME_INSTANCE_ID;
    } else {
      process.env.CODEFLOWMU_RUNTIME_INSTANCE_ID = previousRuntimeInstanceId;
    }
  }
});

test("separate npm roots on the same machine use separate Gateway identities", () => {
  const port18766Root = mkdtempSync(join(tmpdir(), "cf-gw-port-18766-"));
  const port18768Root = mkdtempSync(join(tmpdir(), "cf-gw-port-18768-"));
  const activeProject = mkdtempSync(join(tmpdir(), "cf-gw-active-project-"));
  mkdirSync(join(port18766Root, ".codeflowmu"), { recursive: true });
  mkdirSync(join(port18768Root, ".codeflowmu"), { recursive: true });

  const previousHostRoot = process.env.CODEFLOWMU_HOST_ROOT;
  const previousRuntimeInstanceId = process.env.CODEFLOWMU_RUNTIME_INSTANCE_ID;
  try {
    process.env.CODEFLOWMU_HOST_ROOT = port18766Root;
    process.env.CODEFLOWMU_RUNTIME_INSTANCE_ID = "cfm-port-18766";
    const port18766 = ensureMobileGatewayCredentials(activeProject);

    copyFileSync(
      join(port18766Root, ".codeflowmu", "mobile-gateway.json"),
      join(port18768Root, ".codeflowmu", "mobile-gateway.json"),
    );

    process.env.CODEFLOWMU_HOST_ROOT = port18768Root;
    process.env.CODEFLOWMU_RUNTIME_INSTANCE_ID = "cfm-port-18768";
    const port18768 = ensureMobileGatewayCredentials(activeProject);
    assert.notEqual(port18768.runtime_instance_id, port18766.runtime_instance_id);
    assert.notEqual(port18768.instance_id, port18766.instance_id);
    assert.notEqual(port18768.instance_secret, port18766.instance_secret);

    const restarted18768 = ensureMobileGatewayCredentials(activeProject);
    assert.equal(restarted18768.instance_id, port18768.instance_id);
    assert.equal(restarted18768.instance_secret, port18768.instance_secret);
  } finally {
    if (previousHostRoot === undefined) delete process.env.CODEFLOWMU_HOST_ROOT;
    else process.env.CODEFLOWMU_HOST_ROOT = previousHostRoot;
    if (previousRuntimeInstanceId === undefined) {
      delete process.env.CODEFLOWMU_RUNTIME_INSTANCE_ID;
    } else {
      process.env.CODEFLOWMU_RUNTIME_INSTANCE_ID = previousRuntimeInstanceId;
    }
  }
});

test("candidate runtime defaults Gateway to disabled", () => {
  const root = mkdtempSync(join(tmpdir(), "cf-gw-candidate-"));
  const previousRuntimeInstanceId = process.env.CODEFLOWMU_RUNTIME_INSTANCE_ID;
  const previousRole = process.env.CODEFLOWMU_INSTANCE_ROLE;
  try {
    process.env.CODEFLOWMU_RUNTIME_INSTANCE_ID = "cfm-candidate";
    process.env.CODEFLOWMU_INSTANCE_ROLE = "candidate";
    const config = ensureMobileGatewayCredentials(root);
    assert.equal(config.enabled, false);
    assert.equal(config.auto_connect, false);
    assert.equal(config.runtime_instance_id, "cfm-candidate");
    const restarted = ensureMobileGatewayCredentials(root);
    assert.equal(restarted.enabled, false);
    assert.equal(restarted.auto_connect, false);
  } finally {
    if (previousRuntimeInstanceId === undefined) {
      delete process.env.CODEFLOWMU_RUNTIME_INSTANCE_ID;
    } else {
      process.env.CODEFLOWMU_RUNTIME_INSTANCE_ID = previousRuntimeInstanceId;
    }
    if (previousRole === undefined) delete process.env.CODEFLOWMU_INSTANCE_ROLE;
    else process.env.CODEFLOWMU_INSTANCE_ROLE = previousRole;
  }
});
