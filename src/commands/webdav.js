const http = require("node:http");
const crypto = require("node:crypto");

const {
  loadWebdavConfig,
  saveWebdavConfig,
  snapshotListUrl,
  snapshotFileUrl,
  snapshotFilename,
  parsePropfindHrefs,
  hrefToFilename,
  encryptSnapshot,
  decryptSnapshot,
  validateSnapshotShape,
  loadSyncState,
  saveSyncState,
  sha256Hex,
} = require("../lib/webdav-sync");
const { openInBrowser } = require("../lib/browser-auth");

// `tokentracker webdav` — WebDAV backup / cross-machine sync.
//
//   webdav config --url https://dav.example.com/dav/ --username me
//                 --password app-password [--encrypt passphrase]
//   webdav push     export this machine's history → WebDAV
//   webdav pull     import every other machine's history ← WebDAV
//   webdav status   list remote snapshots + local state
//   webdav ui [--port N]  local settings page (127.0.0.1, token-gated)
//
// The heavy lifting (snapshot validation, conflict detection, idempotent
// merge, dashboard rendering of imported devices) is the local dashboard's
// /api/local-usage export/preview/import API, available in tokentracker-cli
// ≥ 1.5.3 — this command is only the WebDAV transport, so it works no matter
// which CLI version serves the dashboard.
//
// All human output goes to stderr: on hosts whose endpoint-security agent
// swallows node stdout (see docs/ops/sangfor-endpoint-interference.md) the
// command must still be operable.

const DEFAULT_LOCAL_URL = "http://127.0.0.1:7681";
// A monolithic snapshot re-uploaded on every run would burn through metered
// WebDAV plans (坚果云 free ≈ 1 GB/month). Skip the PUT when the row content
// is unchanged and we pushed it recently; the weekly refresh re-pushes even
// unchanged content so an externally deleted remote file eventually returns.
const PUSH_SKIP_REFRESH_MS = 7 * 24 * 60 * 60 * 1000;

function log(line) {
  process.stderr.write(`webdav: ${line}\n`);
}

function parseFlags(argv, known) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) throw new Error(`unknown argument: ${arg}`);
    const key = arg.slice(2);
    if (!known.includes(key)) throw new Error(`unknown argument: ${arg}`);
    if (i + 1 >= argv.length) throw new Error(`--${key} requires a value`);
    opts[key] = argv[++i];
  }
  return opts;
}

function parseLocalUrl(opts) {
  const raw = opts["local-url"] || process.env.TT_WEBDAV_LOCAL_URL || DEFAULT_LOCAL_URL;
  return raw.replace(/\/+$/, "");
}

// --- Local dashboard client ---------------------------------------------------

async function jfetch(url, init = {}, timeoutMs = 30_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function localAuth(localUrl) {
  let res;
  try {
    res = await jfetch(`${localUrl}/api/local-auth`, {}, 5_000);
  } catch {
    throw new Error(`dashboard is not running at ${localUrl} (start it with: tokentracker serve)`);
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.token) {
    throw new Error(`local auth failed at ${localUrl}: HTTP ${res.status}`);
  }
  return {
    "Content-Type": "application/json",
    "x-tokentracker-local-auth": body.token,
    Origin: localUrl,
  };
}

async function localUsageAction(headers, localUrl, payload, toleratedErrorCodes = []) {
  const res = await jfetch(`${localUrl}/api/local-usage`, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  });
  const body = await res.json().catch(() => ({}));
  if (res.status === 404) {
    throw new Error(
      `${localUrl}/api/local-usage not found — the dashboard predates v1.5.3; upgrade with: npm i -g tokentracker-cli@latest`,
    );
  }
  if (!res.ok) {
    // e.g. preview of this machine's own snapshot answers 400 self_import —
    // callers that expect it pass its code and branch on { error }.
    if (toleratedErrorCodes.includes(body.code)) return { error: body.code };
    throw new Error(`local-usage ${payload.action} failed: HTTP ${res.status} ${JSON.stringify(body).slice(0, 200)}`);
  }
  return body;
}

// --- WebDAV transport (PUT / GET / MKCOL / PROPFIND only) ---------------------

function davHeaders(config, extra = {}) {
  const basic = Buffer.from(`${config.username}:${config.password}`, "utf8").toString("base64");
  return { Authorization: `Basic ${basic}`, ...extra };
}

async function davFetch(config, url, init = {}, timeoutMs = 30_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    if (res.status === 401) {
      throw new Error("WebDAV authentication failed (401) — check username / app password");
    }
    return res;
  } finally {
    clearTimeout(timer);
  }
}

async function davEnsureDir(config, ...segments) {
  let current = String(config.url).replace(/\/+$/, "");
  for (const segment of segments) {
    current = `${current}/${segment}`;
    const res = await davFetch(config, current, { method: "MKCOL", headers: davHeaders(config) });
    // 405 = already exists; some providers answer 301/302 for existing dirs.
    if (![201, 405, 301, 302].includes(res.status)) {
      throw new Error(`MKCOL ${current} failed: HTTP ${res.status}`);
    }
  }
}

async function davPut(config, url, bytes) {
  const res = await davFetch(config, url, {
    method: "PUT",
    headers: davHeaders(config, { "Content-Type": "application/octet-stream" }),
    body: bytes,
  }, 120_000);
  if (![200, 201, 204].includes(res.status)) {
    throw new Error(`PUT failed: HTTP ${res.status}`);
  }
  return res.headers.get("etag") || "";
}

async function davGet(config, url, etag = "") {
  const headers = davHeaders(config);
  if (etag) headers["If-None-Match"] = etag;
  const res = await davFetch(config, url, { headers }, 60_000);
  if (res.status === 304) return { notModified: true, etag };
  if (!res.ok) {
    if (res.status === 404) return { notFound: true };
    throw new Error(`GET ${url} failed: HTTP ${res.status}`);
  }
  return {
    bytes: Buffer.from(await res.arrayBuffer()),
    etag: res.headers.get("etag") || "",
  };
}

async function davList(config, dirUrl) {
  const res = await davFetch(config, dirUrl, {
    method: "PROPFIND",
    headers: davHeaders(config, { Depth: "1", "Content-Type": "application/xml" }),
    body: '<?xml version="1.0"?><D:propfind xmlns:D="DAV:"><D:prop><D:resourcetype/></D:prop></D:propfind>',
  });
  if (res.status === 404) return [];
  if (res.status !== 207) {
    throw new Error(`PROPFIND failed: HTTP ${res.status} (is the URL a WebDAV endpoint?)`);
  }
  return parsePropfindHrefs(await res.text());
}

// --- Actions (shared by CLI and the ui page) ----------------------------------

function requireConfigured(config) {
  if (!config.url) {
    throw new Error("no WebDAV config — run: tokentracker webdav config --url <dav-url> --username <user> --password <app-password> [--encrypt <passphrase>]");
  }
}

// The snapshot envelope (sequence, exported_at) changes on every export, so
// the change gate hashes the payload rows instead of the serialized file.
function snapshotContentHash(snapshot) {
  return sha256Hex(Buffer.from(JSON.stringify({ machineId: snapshot.machine.id, rows: snapshot.rows }), "utf8"));
}

async function runPush(localUrl, { logLine = log } = {}) {
  const config = loadWebdavConfig();
  requireConfigured(config);
  const headers = await localAuth(localUrl);
  const { snapshot } = await localUsageAction(headers, localUrl, { action: "export" });
  if (!validateSnapshotShape(snapshot)) throw new Error("dashboard export returned an invalid snapshot");

  const jsonBytes = Buffer.from(JSON.stringify(snapshot), "utf8");
  const bytes = config.encrypt ? encryptSnapshot(jsonBytes, config.encrypt) : jsonBytes;
  const contentHash = snapshotContentHash(snapshot);
  const state = loadSyncState();
  if (
    state.pushContentSha256 === contentHash &&
    Number(state.pushedAt || 0) > Date.now() - PUSH_SKIP_REFRESH_MS
  ) {
    logLine(`snapshot unchanged (${snapshot.rows.length} rows) — skipping upload`);
    return { ok: true, skipped: true };
  }

  await davEnsureDir(config, "tokentracker", "snapshots");
  const filename = snapshotFilename(snapshot.machine.id);
  const etag = await davPut(config, snapshotFileUrl(config, snapshot.machine.id), bytes);
  state.pushContentSha256 = contentHash;
  state.pushedAt = Date.now();
  state.pushedMachine = snapshot.machine.name;
  state.etags = { ...(state.etags || {}), [filename]: etag };
  saveSyncState(state);
  logLine(
    `pushed ${snapshot.machine.name}: ${snapshot.rows.length} rows, ` +
      `${bytes.length} bytes${config.encrypt ? " (encrypted)" : ""} → ${filename}`,
  );
  return { ok: true };
}

async function runPull(localUrl, { logLine = log } = {}) {
  const config = loadWebdavConfig();
  requireConfigured(config);
  const headers = await localAuth(localUrl);
  const hrefs = await davList(config, snapshotListUrl(config));
  const files = hrefs.map(hrefToFilename).filter((name) => name.endsWith(".json"));
  if (!files.length) {
    logLine("no snapshots on the server yet");
    return { ok: true };
  }

  const state = loadSyncState();
  state.etags = state.etags || {};
  let imported = 0;
  for (const file of files) {
    const knownEtag = state.etags[file] || "";
    const fetched = await davGet(config, davFileUrl(config, file), knownEtag);
    if (fetched.notModified) continue; // same content as the last pull
    if (fetched.notFound) continue; // deleted between PROPFIND and GET

    let snapshot;
    try {
      snapshot = JSON.parse(decryptSnapshot(fetched.bytes, config.encrypt).toString("utf8"));
    } catch {
      logLine(`${file}: not a snapshot (or wrong passphrase) — skipped`);
      continue;
    }
    if (!validateSnapshotShape(snapshot)) {
      logLine(`${file}: unknown snapshot format — skipped`);
      continue;
    }
    if (file !== snapshotFilename(snapshot.machine.id)) {
      logLine(`${file}: filename does not match the machine id inside — skipped`);
      continue;
    }

    // preview then import; the server rejects self-imports and stale data.
    const preview = await localUsageAction(headers, localUrl, { action: "preview", snapshot }, ["self_import"]);
    if (preview.error === "self_import") {
      logLine(`${snapshot.machine.name}: own snapshot on the server — skipped`);
    } else if (["added", "updated"].includes(preview.action)) {
      await localUsageAction(headers, localUrl, { action: "import", snapshot, token: preview.token });
      logLine(
        `imported ${snapshot.machine.name}: ${snapshot.rows.length} rows ` +
          `(tokens ${preview.before} → ${preview.after})`,
      );
      imported += 1;
    } else {
      logLine(`${snapshot.machine.name}: ${preview.action} (nothing to do)`);
    }
    if (fetched.etag) state.etags[file] = fetched.etag;
  }
  saveSyncState(state);
  return { ok: true, imported };
}

function davFileUrl(config, filename) {
  return `${snapshotListUrl(config)}/${encodeURIComponent(filename)}`;
}

async function runStatus(localUrl, { logLine = log } = {}) {
  const config = loadWebdavConfig();
  requireConfigured(config);
  const hrefs = await davList(config, snapshotListUrl(config));
  const files = hrefs.map(hrefToFilename).filter((name) => name.endsWith(".json"));
  const state = loadSyncState();
  logLine(`server: ${config.url}`);
  logLine(`snapshots: ${files.length ? files.join(", ") : "(none)"}`);
  if (state.pushedAt) {
    logLine(`last push: ${new Date(state.pushedAt).toISOString()} (${state.pushedMachine || "this machine"})`);
  }
  return { ok: true, files, state };
}

// --- Settings page (webdav ui) -------------------------------------------------

function isLoopbackOrigin(value) {
  if (!value) return true; // non-browser clients (curl) send no Origin
  try {
    const url = new URL(String(value));
    return url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]", "::1"].includes(url.hostname);
  } catch {
    return false;
  }
}

const SETTINGS_PAGE = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>TokenTracker · WebDAV 同步</title>
<style>
  body { font-family: system-ui, "Segoe UI", "Microsoft YaHei", sans-serif; background: #0f172a;
         color: #e2e8f0; margin: 0; display: flex; justify-content: center; }
  .card { background: #1e293b; border-radius: 12px; padding: 28px; margin: 40px 16px; max-width: 560px; width: 100%; }
  h1 { font-size: 18px; margin: 0 0 4px; }
  p.sub { color: #94a3b8; font-size: 13px; margin: 0 0 20px; }
  label { display: block; font-size: 13px; color: #94a3b8; margin: 14px 0 4px; }
  input { width: 100%; box-sizing: border-box; padding: 8px 10px; border-radius: 8px; border: 1px solid #334155;
          background: #0f172a; color: #e2e8f0; font-size: 14px; }
  input:focus { outline: 1px solid #38bdf8; }
  .row { display: flex; gap: 10px; margin-top: 22px; flex-wrap: wrap; }
  button { padding: 9px 16px; border-radius: 8px; border: 0; font-size: 14px; cursor: pointer;
           background: #334155; color: #e2e8f0; }
  button.primary { background: #0ea5e9; color: #082f49; font-weight: 600; }
  button:disabled { opacity: .5; cursor: wait; }
  pre { background: #0f172a; border: 1px solid #334155; border-radius: 8px; padding: 12px;
        font-size: 12px; white-space: pre-wrap; word-break: break-all; min-height: 20px; margin-top: 20px; }
  .hint { font-size: 12px; color: #64748b; margin-top: 4px; }
</style>
</head>
<body>
<div class="card">
  <h1>WebDAV 备份与跨设备同步</h1>
  <p class="sub">本机历史推送到 WebDAV,并导入其他设备的快照(不进入本地上传队列,不会重复上云)。</p>
  <label>WebDAV 地址</label>
  <input id="url" placeholder="https://dav.jianguoyun.com/dav/">
  <label>用户名</label>
  <input id="username" placeholder="username@example.com">
  <label>密码 / 应用密码</label>
  <input id="password" type="password" placeholder="留空表示不修改已保存的密码">
  <label>加密口令(可选,推荐)</label>
  <input id="encrypt" type="password" placeholder="留空表示不修改;首次设置需牢记,丢失后备份不可读">
  <div class="hint">加密口令用于云端静态加密(AES-256-GCM)。两台设备必须一致。</div>
  <div class="row">
    <button class="primary" id="save">保存配置</button>
    <button id="push">立即推送</button>
    <button id="pull">立即拉取</button>
    <button id="status">查看状态</button>
  </div>
  <pre id="out">就绪。</pre>
</div>
<script>
const TOKEN = new URLSearchParams(location.search).get("token") || "";
const $ = (id) => document.getElementById(id);
const out = $("out");
const busy = (on) => document.querySelectorAll("button").forEach((b) => (b.disabled = on));
async function api(path, init) {
  const res = await fetch(path, { ...init, headers: { "Content-Type": "application/json", "x-webdav-ui-token": TOKEN } });
  if (!res.ok) throw new Error("HTTP " + res.status + " " + (await res.text()));
  return res.json();
}
async function run(fn) { busy(true); out.textContent = "执行中…"; try { out.textContent = await fn() || "完成。"; }
  catch (e) { out.textContent = "失败:" + e.message; } finally { busy(false); } }
$("save").onclick = () => run(async () => {
  await api("/api/config", { method: "POST", body: JSON.stringify({
    url: $("url").value, username: $("username").value,
    password: $("password").value, encrypt: $("encrypt").value }) });
  $("password").value = ""; $("encrypt").value = "";
  return "配置已保存。";
});
$("push").onclick = () => run(() => api("/api/action", { method: "POST", body: JSON.stringify({ op: "push" }) }).then((r) => r.log));
$("pull").onclick = () => run(() => api("/api/action", { method: "POST", body: JSON.stringify({ op: "pull" }) }).then((r) => r.log));
$("status").onclick = () => run(() => api("/api/action", { method: "POST", body: JSON.stringify({ op: "status" }) }).then((r) => r.log));
api("/api/config").then((c) => {
  $("url").value = c.url || ""; $("username").value = c.username || "";
  out.textContent = c.url ? "已读取现有配置" + (c.hasPassword ? "(密码已保存)" : "(未设密码)") + "。" : "尚未配置。";
});
</script>
</body>
</html>`;

async function cmdUi(opts) {
  const localUrl = parseLocalUrl(opts);
  const token = crypto.randomBytes(16).toString("hex");
  let actionRunning = false;

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const authed = req.headers["x-webdav-ui-token"] === token || url.searchParams.get("token") === token;
    const jsonReply = (status, data) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(data));
    };

    if (!authed || !isLoopbackOrigin(req.headers.origin)) {
      jsonReply(403, { error: "forbidden" });
      return;
    }
    if (req.method === "GET" && url.pathname === "/") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(SETTINGS_PAGE);
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/config") {
      const config = loadWebdavConfig();
      jsonReply(200, {
        url: config.url, username: config.username,
        hasPassword: Boolean(config.password), hasEncrypt: Boolean(config.encrypt),
      });
      return;
    }

    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 64 * 1024) req.destroy();
    });
    req.on("end", async () => {
      let payload = {};
      try {
        payload = body ? JSON.parse(body) : {};
      } catch {
        jsonReply(400, { error: "bad json" });
        return;
      }
      if (req.method === "POST" && url.pathname === "/api/config") {
        try {
          const current = loadWebdavConfig();
          const merged = {
            url: payload.url || current.url,
            username: payload.username ?? current.username,
            password: payload.password ? payload.password : current.password,
            encrypt: payload.encrypt ? payload.encrypt : current.encrypt,
          };
          saveWebdavConfig(merged);
          jsonReply(200, { ok: true });
        } catch (e) {
          jsonReply(400, { error: e.message });
        }
        return;
      }
      if (req.method === "POST" && url.pathname === "/api/action") {
        if (actionRunning) {
          jsonReply(409, { error: "an action is already running" });
          return;
        }
        const lines = [];
        const logLine = (line) => lines.push(line);
        const runners = { push: runPush, pull: runPull, status: runStatus };
        const runner = runners[payload.op];
        if (!runner) {
          jsonReply(400, { error: `unknown op: ${payload.op}` });
          return;
        }
        actionRunning = true;
        try {
          await runner(localUrl, { logLine });
          jsonReply(200, { ok: true, log: lines.join("\n") || "完成。" });
        } catch (e) {
          lines.push(`失败:${e.message}`);
          jsonReply(200, { ok: false, log: lines.join("\n") });
        } finally {
          actionRunning = false;
        }
        return;
      }
      jsonReply(404, { error: "not found" });
    });
  });

  const port = Number(opts.port) || 0;
  server.listen(port, "127.0.0.1", () => {
    const { port: bound } = server.address();
    const pageUrl = `http://127.0.0.1:${bound}/?token=${token}`;
    log(`settings page: ${pageUrl}`);
    log("press Ctrl+C to stop");
    openInBrowser(pageUrl);
  });
}

// --- CLI entry ------------------------------------------------------------------

function printUsage() {
  process.stderr.write(
    [
      "tokentracker webdav — WebDAV backup & cross-machine sync",
      "",
      "Usage:",
      "  tokentracker webdav config --url <dav-url> --username <user> --password <app-password> [--encrypt <passphrase>]",
      "  tokentracker webdav push       # export this machine's history to WebDAV",
      "  tokentracker webdav pull       # import other machines' histories from WebDAV",
      "  tokentracker webdav status     # list remote snapshots and local sync state",
      "  tokentracker webdav ui [--port <n>]  # open the local settings page",
      "",
      "Options:",
      "  --local-url <url>  dashboard base URL (default http://127.0.0.1:7681, env TT_WEBDAV_LOCAL_URL)",
      "",
      "Config is stored in ~/.tokentracker/webdav.json; env overrides:",
      "TT_WEBDAV_URL / TT_WEBDAV_USERNAME / TT_WEBDAV_PASSWORD / TT_WEBDAV_ENCRYPT.",
      "Requires a running dashboard with the device-history snapshot API (v1.5.3+).",
    ].join("\n") + "\n",
  );
}

async function cmdWebdav(argv) {
  const [sub, ...rest] = argv;
  const configFlags = ["url", "username", "password", "encrypt"];
  const uiFlags = ["port"];
  const actionFlags = ["local-url"];

  if (!sub || sub === "-h" || sub === "--help") {
    printUsage();
    process.exitCode = sub ? 0 : 1;
    return;
  }
  if (sub === "config") {
    const opts = parseFlags(rest, [...configFlags, ...actionFlags]);
    const merged = { ...loadWebdavConfig(), ...pickPresent(opts, configFlags) };
    const saved = saveWebdavConfig(merged);
    log(`saved ${saved.url} (username: ${saved.username || "-"}, password: ${saved.password ? "set" : "unset"}, encrypt: ${saved.encrypt ? "set" : "off"})`);
    return;
  }
  if (sub === "ui") {
    cmdUi(parseFlags(rest, [...uiFlags, ...actionFlags]));
    return;
  }
  const runners = { push: runPush, pull: runPull, status: runStatus };
  const runner = runners[sub];
  if (!runner) {
    printUsage();
    process.exitCode = 1;
    return;
  }
  const opts = parseFlags(rest, actionFlags);
  await runner(parseLocalUrl(opts));
}

function pickPresent(opts, keys) {
  const out = {};
  for (const key of keys) {
    if (opts[key] !== undefined) out[key] = opts[key];
  }
  return out;
}

module.exports = { cmdWebdav, runPush, runPull, runStatus };
