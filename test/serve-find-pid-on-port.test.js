const assert = require("node:assert/strict");
const { test } = require("node:test");

const { parseNetstatListeningPids } = require("../src/commands/serve");

const SAMPLE = [
  "",
  "Active Connections",
  "",
  "  Proto  Local Address          Foreign Address        State           PID",
  "  TCP    127.0.0.1:7681         0.0.0.0:0              LISTENING       16964",
  "  TCP    127.0.0.1:7681         127.0.0.1:52114        ESTABLISHED     16964",
  "  TCP    [::1]:7681             [::]:0                 LISTENING       16964",
  "  TCP    127.0.0.1:52114        127.0.0.1:7681         ESTABLISHED     42100",
  "  TCP    0.0.0.0:7680           0.0.0.0:0              LISTENING       1188",
  "  TCP    127.0.0.1:7681.0       0.0.0.0:0              LISTENING       777",
  "  TCP    127.0.0.1:17681        0.0.0.0:0              LISTENING       999",
].join("\r\n");

test("parseNetstatListeningPids collects pids of LISTENING sockets on the port", () => {
  assert.deepEqual(parseNetstatListeningPids(SAMPLE, 7681), [16964]);
});

test("parseNetstatListeningPids matches the exact port, not a suffix", () => {
  assert.deepEqual(parseNetstatListeningPids(SAMPLE, 17681), [999]);
  assert.deepEqual(parseNetstatListeningPids(SAMPLE, 7680), [1188]);
});

test("parseNetstatListeningPids ignores sockets that merely connect to the port", () => {
  // The ESTABLISHED row from pid 42100 has 7681 as its REMOTE endpoint and
  // must not be reported (same rationale as lsof's `-sTCP:LISTEN`).
  assert.ok(!parseNetstatListeningPids(SAMPLE, 7681).includes(42100));
});

test("parseNetstatListeningPids handles LF-only output and IPv6 local addresses", () => {
  const lf = "  TCP    [::1]:9999             [::]:0                 LISTENING       42\n";
  assert.deepEqual(parseNetstatListeningPids(lf, 9999), [42]);
  assert.deepEqual(parseNetstatListeningPids(lf, 9998), []);
});

test("parseNetstatListeningPids fails closed on bad input or bad port", () => {
  assert.deepEqual(parseNetstatListeningPids("", 7681), []);
  assert.deepEqual(parseNetstatListeningPids(null, 7681), []);
  assert.deepEqual(parseNetstatListeningPids(SAMPLE, 0), []);
  assert.deepEqual(parseNetstatListeningPids(SAMPLE, -1), []);
  assert.deepEqual(parseNetstatListeningPids(SAMPLE, "7681;rm -rf /"), []);
});

test("parseNetstatListeningPids skips malformed local addresses", () => {
  // `127.0.0.1:7681.0` is not a valid address:port pair — the row must be
  // dropped rather than mis-parsed as port 7681 (or 0).
  const malformed = "  TCP    127.0.0.1:7681.0       0.0.0.0:0              LISTENING       777\r\n";
  assert.deepEqual(parseNetstatListeningPids(malformed, 7681), []);
  assert.deepEqual(parseNetstatListeningPids(malformed, 0), []);
});
