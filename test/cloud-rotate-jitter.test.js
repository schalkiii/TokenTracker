const assert = require("node:assert/strict");
const { test } = require("node:test");

const { stableJitterMs, backoffRemainingMs } = require("../scripts/cloud-device-rotate.cjs");

test("stableJitterMs is deterministic, bounded, and de-synchronizes hosts", () => {
  const maxMs = 15 * 60_000;
  // Deterministic: the same host gets the same offset on every tick.
  assert.equal(stableJitterMs("QI-SHAO-L", maxMs), stableJitterMs("QI-SHAO-L", maxMs));
  // Bounded to [0, maxMs).
  for (const host of ["QI-SHAO-L", "Thunderobot", "", "主机-01"]) {
    const jitter = stableJitterMs(host, maxMs);
    assert.ok(jitter >= 0 && jitter < maxMs, `${host}: ${jitter} out of range`);
  }
  // The whole point: two machines sharing one slot land on different offsets.
  assert.notEqual(stableJitterMs("QI-SHAO-L", maxMs), stableJitterMs("Thunderobot", maxMs));
  assert.equal(stableJitterMs("any", 0), 0);
});

test("backoffRemainingMs blocks for ~20h after a 429 marker, then expires", () => {
  const now = Date.parse("2026-11-18T12:00:00Z");
  assert.equal(backoffRemainingMs(null, now), 0, "no marker → no backoff");
  assert.equal(backoffRemainingMs({}, now), 0, "marker without a timestamp → no backoff");
  assert.equal(backoffRemainingMs({ at: 0 }, now), 0);

  const fresh = backoffRemainingMs({ at: now }, now);
  assert.ok(fresh > 19 * 60 * 60 * 1000 && fresh <= 20 * 60 * 60 * 1000, `fresh marker: ${fresh}ms`);

  const stale = backoffRemainingMs({ at: now - 20 * 60 * 60 * 1000 - 1 }, now);
  assert.equal(stale, 0, "expired marker → no backoff");
});
