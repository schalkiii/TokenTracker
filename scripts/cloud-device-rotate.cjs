#!/usr/bin/env node
"use strict";

/**
 * Cloud device-slot rotation for accounts on the free tier (machine_limit=1).
 *
 * Problem: the free cloud plan allows a single ACTIVE machine. Two machines
 * that both need to upload must take turns; the cloud UI only exposes
 * per-device pause ("remove-device") / resume buttons.
 *
 * This script automates the turn-taking. Run it on a schedule (hourly is a
 * good fit — see scripts/setup-cloud-rotate-task.ps1):
 *
 *   1. Read the local upload throttle. If the cloud upload window has not
 *      reopened yet, exit 0 WITHOUT touching any device — an upload that is
 *      not due must not evict the other machine mid-window.
 *   2. Read the 429 backoff marker. A cloud_sync_throttled answer earlier in
 *      the day means the account's daily quota is already spent (possibly by
 *      the OTHER machine) — exit 0 without touching any device either, so
 *      hourly ticks don't evict the slot holder pointlessly all day.
 *   3. Sleep a deterministic per-host jitter (≤15 min). Two machines whose
 *      upload windows opened in the same hour would otherwise race on every
 *      tick; the jitter de-synchronizes them without any coordination.
 *   4. Wait for the local dashboard server (default 127.0.0.1:7681).
 *   5. Mint the account access token via the local API.
 *   6. `tokentracker-billing?action=devices` — list registered machines.
 *   7. remove-device every ACTIVE machine that is not this one (frees the
 *      slot; this is what the cloud settings UI's per-device button does).
 *   8. resume-device THIS machine if the other machine's rotation paused it.
 *   9. Trigger `/functions/tokentracker-local-sync` with {drain:true} so the
 *      backlog (including the other machine's gap days) uploads now.
 *  10. A 429 `cloud_sync_throttled` answer means today's quota is already
 *      spent — record the backoff marker and exit 0. Losing the device slot
 *      mid-flight is likewise a graceful exit; the next hourly tick retries.
 *
 * The same file works on every machine of the account: it identifies "self"
 * by hostname (override with --self-name or TT_ROTATE_SELF_NAME when the
 * registered device name differs from the host name).
 *
 * Deployment notes for machines behind endpoint-security agents that break
 * node child spawns / stdout (e.g. Sangfor — see
 * docs/ops/sangfor-endpoint-interference.md): the script only talks HTTP and
 * avoids child processes on the hot path, and logs through BOTH fs and a
 * bounded `cmd /c echo` append so humans can read the log either way.
 *
 * Usage:
 *   node scripts/cloud-device-rotate.cjs [--local-url http://127.0.0.1:7681]
 *                                        [--self-name HOSTNAME]
 *                                        [--log /path/to/rotate.log]
 *   Environment: TT_ROTATE_LOCAL_URL / TT_ROTATE_SELF_NAME / TT_ROTATE_LOG
 *                override the flags; TT_ROTATE_WAIT_MINUTES (default 10)
 *                bounds how long to wait for the local server.
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const cp = require("node:child_process");

const { DEFAULT_BASE_URL, DEFAULT_ANON_KEY } = require("../src/lib/runtime-config");
const { functionUrlFor } = require("../src/lib/function-url");

const BILLING_URL = functionUrlFor(DEFAULT_BASE_URL, "tokentracker-billing");

function parseArgs(argv) {
  const opts = {
    localUrl: process.env.TT_ROTATE_LOCAL_URL || "http://127.0.0.1:7681",
    selfName: process.env.TT_ROTATE_SELF_NAME || "",
    logFile: process.env.TT_ROTATE_LOG || "",
    waitMinutes: Number(process.env.TT_ROTATE_WAIT_MINUTES) || 10,
  };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--local-url" && argv[i + 1]) opts.localUrl = argv[++i];
    else if (argv[i] === "--self-name" && argv[i + 1]) opts.selfName = argv[++i];
    else if (argv[i] === "--log" && argv[i + 1]) opts.logFile = argv[++i];
    else if (argv[i] === "--help" || argv[i] === "-h") opts.help = true;
    else throw new Error(`Unknown argument: ${argv[i]}`);
  }
  opts.localUrl = opts.localUrl.replace(/\/$/, "");
  return opts;
}

function trackerDir(opts) {
  return path.join(os.homedir(), ".tokentracker");
}

function log(opts, line) {
  const stamp = `[${new Date().toISOString().replace("T", " ").slice(0, 19)}] ${line}`;
  try {
    fs.appendFileSync(opts.logFile, stamp + "\n");
  } catch (_e) {
    /* best effort — the cmd append below is the human-readable channel */
  }
  // Plaintext channel: files written directly by node are transparently
  // encrypted by some endpoint-security agents (TSD at-rest encryption), so
  // mirror each line through cmd's echo, which stays readable. Bounded so a
  // wedged child can never stall the rotation.
  try {
    cp.spawnSync("cmd", ["/c", "echo", stamp, ">>", opts.logFile], {
      windowsHide: true,
      timeout: 8000,
    });
  } catch (_e) {
    /* non-Windows or cmd missing — the fs append above already ran */
  }
  process.stderr.write(stamp + "\n");
}

const norm = (s) => String(s || "").trim().toLowerCase();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Deterministic per-host delay in [0, maxMs): the same host always gets the
// same offset (stable across ticks) while two hosts almost never collide.
function stableJitterMs(name, maxMs) {
  let hash = 0;
  for (const ch of String(name || "")) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return maxMs > 0 ? hash % Math.ceil(maxMs) : 0;
}

// An account-level cloud_sync_throttled answer means today's upload quota is
// already spent (possibly by the OTHER machine's rotation). Remember it so
// subsequent hourly ticks back off instead of pointlessly evicting the slot
// holder. 20h (not 24h): if the quota reopens later than that, one extra
// probe simply refreshes the marker.
const FOUR29_BACKOFF_MS = 20 * 60 * 60 * 1000;

function backoffRemainingMs(marker, nowMs) {
  const at = Number(marker && marker.at) || 0;
  if (!at) return 0;
  const remaining = at + FOUR29_BACKOFF_MS - nowMs;
  return remaining > 0 ? remaining : 0;
}

function readFour29Marker(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, "rotate.last429.json"), "utf8"));
  } catch (_e) {
    return null;
  }
}

function writeFour29Marker(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "rotate.last429.json"), JSON.stringify({ at: Date.now() }) + "\n");
  } catch (_e) {
    /* the marker is an optimization — losing it only costs a redundant probe */
  }
}

async function jfetch(url, init = {}, timeoutMs = 30000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    const text = await res.text();
    let body = null;
    try {
      body = JSON.parse(text);
    } catch (_e) {
      body = { _raw: text.slice(0, 300) };
    }
    return { status: res.status, ok: res.ok, body };
  } finally {
    clearTimeout(timer);
  }
}

// The upload window reopens at last success/backoff + interval. Reading the
// local throttle keeps the rotation a no-op until an upload is actually due.
function uploadNotDueYet(dir) {
  try {
    const state = JSON.parse(fs.readFileSync(path.join(dir, "tracker", "upload.throttle.json"), "utf8"));
    const next = Math.max(Number(state.nextAllowedAtMs) || 0, Number(state.backoffUntilMs) || 0);
    if (next > Date.now() + 60_000) {
      return new Date(next).toISOString().replace("T", " ").slice(0, 16) + "Z";
    }
  } catch (_e) {
    /* missing/corrupt file — treat as due and let the cloud answer decide */
  }
  return null;
}

async function waitForLocalServer(opts) {
  const deadline = Date.now() + opts.waitMinutes * 60_000;
  while (Date.now() < deadline) {
    try {
      const res = await jfetch(`${opts.localUrl}/api/local-auth`, {}, 5000);
      if (res.ok && res.body && res.body.token) return res.body.token;
    } catch (_e) {
      /* server not up yet (boot race with the autostart) — keep waiting */
    }
    await sleep(20_000);
  }
  throw new Error(`local dashboard at ${opts.localUrl} did not become ready within ${opts.waitMinutes} minutes`);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.error(fs.readFileSync(__filename, "utf8").split("*/")[0]);
    process.exit(0);
  }
  if (!opts.logFile) opts.logFile = path.join(trackerDir(opts), "rotate.log");
  const selfName = () => norm(opts.selfName || os.hostname());

  log(opts, `=== rotate start (host=${os.hostname()}) ===`);

  const notDue = uploadNotDueYet(trackerDir(opts));
  if (notDue) {
    log(opts, `upload window not open yet (next ${notDue}); skipping rotation this round`);
    process.exit(0);
  }

  const backoff = backoffRemainingMs(readFour29Marker(trackerDir(opts)), Date.now());
  if (backoff > 0) {
    log(
      opts,
      `daily cloud quota already known to be spent; next attempt after ` +
        new Date(Date.now() + backoff).toISOString().replace("T", " ").slice(0, 16) + "Z",
    );
    process.exit(0);
  }

  const jitterMs = stableJitterMs(os.hostname(), 15 * 60_000);
  if (jitterMs > 0) {
    log(opts, `waiting ${Math.round(jitterMs / 1000)}s host jitter to avoid same-tick contention`);
    await sleep(jitterMs);
  }

  const localToken = await waitForLocalServer(opts);
  const localHeaders = {
    "Content-Type": "application/json",
    "x-tokentracker-local-auth": localToken,
    Origin: opts.localUrl,
  };

  const auth = await jfetch(`${opts.localUrl}/api/auth/refresh`, {
    method: "POST",
    headers: localHeaders,
    body: "{}",
  });
  const accessToken = auth.body && auth.body.accessToken;
  if (!accessToken) {
    throw new Error(`account session refresh failed: HTTP ${auth.status} ${JSON.stringify(auth.body).slice(0, 200)}`);
  }
  const cloudHeaders = {
    Authorization: `Bearer ${accessToken}`,
    apikey: DEFAULT_ANON_KEY,
    Accept: "application/json",
  };

  const devices = await jfetch(`${BILLING_URL}?action=devices`, { headers: cloudHeaders });
  if (!devices.ok || !Array.isArray(devices.body && devices.body.machines)) {
    throw new Error(`device list failed: HTTP ${devices.status} ${JSON.stringify(devices.body).slice(0, 200)}`);
  }
  const machines = devices.body.machines;
  log(
    opts,
    `machines: ${machines.map((m) => `${m.name}(${m.status})`).join(", ")} limit=${devices.body.machine_limit}`,
  );

  for (const machine of machines) {
    if (norm(machine.name) === selfName()) continue;
    if (machine.status !== "active") continue;
    const res = await jfetch(`${BILLING_URL}?action=remove-device`, {
      method: "POST",
      headers: { ...cloudHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ machine_id: machine.machine_id }),
    });
    if (res.ok) log(opts, `freed slot by pausing ${machine.name} (${machine.machine_id})`);
    else log(opts, `pause ${machine.name} failed: HTTP ${res.status} ${JSON.stringify(res.body).slice(0, 150)}`);
  }

  const self = machines.find((m) => norm(m.name) === selfName());
  if (self && self.status === "paused") {
    const res = await jfetch(`${BILLING_URL}?action=resume-device`, {
      method: "POST",
      headers: { ...cloudHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ machine_id: self.machine_id }),
    });
    if (res.ok) log(opts, `resumed ${self.name} into the sync slot`);
    else log(opts, `resume self failed: HTTP ${res.status} ${JSON.stringify(res.body).slice(0, 150)}`);
  } else if (self && self.status === "active") {
    log(opts, `${self.name} already holds the sync slot`);
  } else if (!self) {
    log(opts, "this machine is not registered yet (first upload will register it)");
  }

  const sync = await jfetch(
    `${opts.localUrl}/functions/tokentracker-local-sync`,
    { method: "POST", headers: localHeaders, body: JSON.stringify({ drain: true }) },
    300_000,
  );
  const out = sync.body || {};
  const summary = String(out.stdout || out.error || "").trim().replace(/\n/g, " | ").slice(0, 300);
  log(opts, `sync: ok=${out.ok} HTTP ${sync.status} ${summary}`);
  if (sync.status === 429 || out.code === "cloud_sync_throttled") {
    writeFour29Marker(trackerDir(opts));
    log(opts, "daily cloud quota already spent; backing off ~20h before touching devices again");
    log(opts, "=== rotate done (throttled) ===");
    process.exit(0);
  }
  if (!sync.ok || out.ok !== true) {
    const code = String(out.code || "");
    if (/machine|limit/i.test(code)) {
      // The other machine's rotation re-took the single slot mid-flight.
      // Harmless: nothing was uploaded, the queue offset did not move, and
      // the next hourly tick retries from the jitter.
      log(opts, `lost the device slot mid-flight (${code || "slot conflict"}); retrying next tick`);
      log(opts, "=== rotate done (lost race) ===");
      process.exit(0);
    }
    throw new Error("sync did not succeed — see log above");
  }
  log(opts, "=== rotate done ===");
  process.exit(0);
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`cloud-device-rotate failed: ${error && error.message ? error.message : error}\n`);
    process.exit(1);
  });
}

module.exports = { stableJitterMs, backoffRemainingMs };
