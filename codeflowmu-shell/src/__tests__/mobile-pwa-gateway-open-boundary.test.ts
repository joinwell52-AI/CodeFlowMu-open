import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  isRemoteGatewayPublishAvailable,
  publishPwaToGateway,
} from "../mobile/mobilePwaGatewayPublish.ts";

test("Open edition keeps Gateway PWA status read-only", async () => {
  const root = await mkdtemp(join(tmpdir(), "codeflowmu-open-pwa-boundary-"));
  const previous = process.env.CODEFLOW_OPEN_EDITION;
  process.env.CODEFLOW_OPEN_EDITION = "1";
  try {
    assert.equal(isRemoteGatewayPublishAvailable(root), false);
    const result = await publishPwaToGateway(root);
    assert.equal(result.ok, false);
    assert.equal(result.error, "OPEN_EDITION_GATEWAY_PUBLISH_DISABLED");
    assert.deepEqual(result.steps, []);
  } finally {
    if (previous === undefined) delete process.env.CODEFLOW_OPEN_EDITION;
    else process.env.CODEFLOW_OPEN_EDITION = previous;
    await rm(root, { recursive: true, force: true });
  }
});
