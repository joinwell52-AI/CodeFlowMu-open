import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  formatLocalShortDateTime,
  getLocalTimezone,
  hasExplicitOffset,
  resolveEnvelopeTimestamps,
  toLocalIsoString,
  toUtcIsoString,
} from "../local-iso.ts";

describe("local-iso", () => {
  it("toLocalIsoString uses numeric offset not Z", () => {
    const d = new Date("2026-05-31T14:26:47.000Z");
    const s = toLocalIsoString(d);
    assert.match(s, /[+-]\d{2}:\d{2}$/);
    assert.doesNotMatch(s, /Z$/);
  });

  it("toUtcIsoString ends with Z for created_at_utc", () => {
    const s = toUtcIsoString(new Date("2026-05-31T14:26:47.000Z"));
    assert.match(s, /Z$/);
    assert.doesNotMatch(s, /[+-]\d{2}:\d{2}$/);
  });

  it("hasExplicitOffset accepts offset and Z", () => {
    assert.equal(hasExplicitOffset("2026-05-31T22:26:47+08:00"), true);
    assert.equal(hasExplicitOffset("2026-05-31T14:26:47Z"), true);
    assert.equal(hasExplicitOffset("2026-05-31 22:26:47"), false);
  });

  it("resolveEnvelopeTimestamps prefers frontmatter offset fields", () => {
    const ts = resolveEnvelopeTimestamps(
      {
        created_at: "2026-05-31T22:26:47+08:00",
        updated_at: "2026-05-31T23:00:00+08:00",
        timezone: "Asia/Shanghai",
        created_at_utc: "2026-05-31T14:26:47Z",
      },
      0,
    );
    assert.equal(ts.created_at, "2026-05-31T22:26:47+08:00");
    assert.equal(ts.updated_at, "2026-05-31T23:00:00+08:00");
    assert.equal(ts.timezone, "Asia/Shanghai");
    assert.equal(ts.created_at_utc, "2026-05-31T14:26:47Z");
  });

  it("resolveEnvelopeTimestamps falls back from mtime with offset", () => {
    const mtime = new Date("2026-05-31T14:26:47.000Z").getTime();
    const ts = resolveEnvelopeTimestamps({}, mtime);
    assert.match(ts.created_at, /[+-]\d{2}:\d{2}$/);
    assert.match(ts.updated_at, /[+-]\d{2}:\d{2}$/);
    assert.ok(ts.timezone.length > 0);
    assert.match(ts.created_at_utc, /Z$/);
  });

  it("formatLocalShortDateTime renders MM/DD HH:mm", () => {
    const d = new Date("2026-05-31T22:26:47+08:00");
    const s = formatLocalShortDateTime(d);
    assert.match(s, /^\d{2}\/\d{2} \d{2}:\d{2}$/);
  });

  it("getLocalTimezone returns non-empty IANA or fallback", () => {
    assert.ok(getLocalTimezone().length > 0);
  });
});
