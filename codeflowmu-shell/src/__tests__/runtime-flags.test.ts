import assert from "node:assert/strict";
import { test } from "node:test";

import { resolveLegacyReviewEngine } from "../runtime-flags.ts";

test("resolveLegacyReviewEngine — false by default", () => {
  assert.equal(resolveLegacyReviewEngine({}), false);
  assert.equal(resolveLegacyReviewEngine({ CODEFLOWMU_LEGACY_REVIEW_ENGINE: undefined }), false);
  assert.equal(resolveLegacyReviewEngine({ CODEFLOWMU_LEGACY_REVIEW_ENGINE: "" }), false);
  assert.equal(resolveLegacyReviewEngine({ CODEFLOWMU_LEGACY_REVIEW_ENGINE: "0" }), false);
  assert.equal(resolveLegacyReviewEngine({ CODEFLOWMU_LEGACY_REVIEW_ENGINE: "true" }), false);
});

test("resolveLegacyReviewEngine — true only when env is exactly 1", () => {
  assert.equal(
    resolveLegacyReviewEngine({ CODEFLOWMU_LEGACY_REVIEW_ENGINE: "1" }),
    true,
  );
});
