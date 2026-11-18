const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");

// WebDAV backup / cross-machine sync primitives for the `webdav` command.
// Transport (fetch calls, dashboard client) lives in src/commands/webdav.js;
// everything here is pure or local-file so it can be unit-tested without a
// WebDAV server or a running dashboard.
//
// Wire format: one JSON snapshot per machine at
//   <url>/tokentracker/snapshots/<machine-id>.json
// produced by the dashboard's POST /api/local-usage {action:"export"} and
// consumed by {action:"preview"} + {action:"import"} — imported snapshots are
// kept out of the append-only queue and the cloud upload offset, and the
// dashboard already renders imported machines as devices, so WebDAV is only
// the transport. See docs/plans/2026-11-18-webdav-backup-sync-design.md.

const SNAPSHOT_SCHEMA = "tokentracker.local-usage.v1";
// Files start with this magic when at-rest encryption is enabled, so
// encrypted and plaintext snapshots can coexist during migration.
const ENCRYPTED_MAGIC = Buffer.from("TTV1");
const SNAPSHOT_DIR_SEGMENTS = ["tokentracker", "snapshots"];

function defaultConfigPath() {
  return path.join(os.homedir(), ".tokentracker", "webdav.json");
}

function defaultStatePath() {
  return path.join(os.homedir(), ".tokentracker", "webdav.state.json");
}

function trimmedString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function loadWebdavConfig({ configPath = defaultConfigPath(), env = process.env } = {}) {
  let saved = {};
  try {
    saved = JSON.parse(fs.readFileSync(configPath, "utf8"));
  } catch {
    /* first run — the config subcommand (or env) provides everything */
  }
  return {
    url: trimmedString(env.TT_WEBDAV_URL) || trimmedString(saved.url),
    username: trimmedString(env.TT_WEBDAV_USERNAME) || trimmedString(saved.username),
    password: typeof env.TT_WEBDAV_PASSWORD === "string" && env.TT_WEBDAV_PASSWORD
      ? env.TT_WEBDAV_PASSWORD
      : trimmedString(saved.password),
    encrypt: trimmedString(env.TT_WEBDAV_ENCRYPT) || trimmedString(saved.encrypt),
  };
}

function normalizeWebdavConfig(input) {
  const url = trimmedString(input?.url).replace(/\/+$/, "");
  if (url) {
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        throw new Error("protocol");
      }
    } catch {
      throw new Error(`webdav url must be http(s): ${url}`);
    }
  }
  return {
    url,
    username: trimmedString(input?.username),
    password: trimmedString(input?.password),
    encrypt: trimmedString(input?.encrypt),
  };
}

function saveWebdavConfig(config, { configPath = defaultConfigPath() } = {}) {
  const normalized = normalizeWebdavConfig(config);
  if (!normalized.url) throw new Error("webdav config requires --url");
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(normalized, null, 2) + "\n", { mode: 0o600 });
  return normalized;
}

function davUrl(config, ...segments) {
  return [String(config.url || "").replace(/\/+$/, ""), ...segments].join("/");
}

function snapshotListUrl(config) {
  return davUrl(config, ...SNAPSHOT_DIR_SEGMENTS);
}

function snapshotFileUrl(config, machineId) {
  return davUrl(config, ...SNAPSHOT_DIR_SEGMENTS, `${machineId}.json`);
}

function snapshotFilename(machineId) {
  return `${machineId}.json`;
}

// Minimal PROPFIND (Depth: 1) href extraction — avoids an XML dependency.
// Handles any (or no) namespace prefix: <D:href>, <d:href>, <href>, … The
// closing tag must match with the same tolerance; real servers (Nextcloud)
// emit </d:href>, and an indexOf("</href>") parser silently finds nothing.
function parsePropfindHrefs(xml) {
  const text = String(xml || "");
  const hrefs = [];
  for (const match of text.matchAll(/<(?:[a-zA-Z0-9]+:)?href>/gi)) {
    const start = match.index + match[0].length;
    const close = /<\/(?:[a-zA-Z0-9]+:)?href>/i.exec(text.slice(start));
    if (close) {
      const href = text.slice(start, start + close.index).trim();
      if (href) hrefs.push(href);
    }
  }
  return hrefs;
}

// Last path segment of an href: "/dav/tokentracker/snapshots/x.json?query"
// → "x.json"; directories ("/dav/dir/") yield "" (the trailing empty segment
// IS the last segment — filtering it away would misreport "dir" as a file).
function hrefToFilename(href) {
  const clean = String(href || "").split("?")[0];
  const parts = clean.split("/");
  const last = parts[parts.length - 1];
  if (!last) return "";
  try {
    return decodeURIComponent(last);
  } catch {
    return last;
  }
}

// AES-256-GCM with a per-file random salt + IV (scrypt KDF). File layout:
// "TTV1" | 16-byte salt | 12-byte IV | 16-byte tag | ciphertext.
function encryptSnapshot(jsonBytes, passphrase) {
  if (!passphrase) return jsonBytes;
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = crypto.scryptSync(passphrase, salt, 32, { N: 16384, r: 8, p: 1 });
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(jsonBytes), cipher.final()]);
  return Buffer.concat([ENCRYPTED_MAGIC, salt, iv, cipher.getAuthTag(), ciphertext]);
}

function decryptSnapshot(fileBytes, passphrase) {
  if (!fileBytes || !fileBytes.subarray(0, 4).equals(ENCRYPTED_MAGIC)) return fileBytes;
  if (!passphrase) {
    throw new Error("snapshot is encrypted but no passphrase is configured");
  }
  const salt = fileBytes.subarray(4, 20);
  const iv = fileBytes.subarray(20, 32);
  const tag = fileBytes.subarray(32, 48);
  const key = crypto.scryptSync(passphrase, salt, 32, { N: 16384, r: 8, p: 1 });
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(fileBytes.subarray(48)), decipher.final()]);
}

// Cheap shape gate before the file is handed to the dashboard's own (strict)
// preview validation. machine.id must match the filename on pull, so it is
// the one field we cannot do without.
function validateSnapshotShape(snapshot) {
  return Boolean(
    snapshot &&
      typeof snapshot === "object" &&
      snapshot.schema === SNAPSHOT_SCHEMA &&
      snapshot.machine &&
      typeof snapshot.machine.id === "string" &&
      snapshot.machine.id &&
      typeof snapshot.machine.name === "string" &&
      Number.isInteger(snapshot.sequence) &&
      Array.isArray(snapshot.rows),
  );
}

// --- Traffic-gating state ----------------------------------------------------
// ~/.tokentracker/webdav.state.json remembers what was last pushed/pulled so
// an unchanged snapshot is not re-uploaded and an unchanged remote file is not
// re-downloaded (If-None-Match). This matters on metered WebDAV providers
// (坚果云 free tier is ~1 GB/month upload) — the snapshot is monolithic, so
// every PUT is a full-file upload that grows with history.

function loadSyncState({ statePath = defaultStatePath() } = {}) {
  try {
    const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
    return state && typeof state === "object" ? state : {};
  } catch {
    return {};
  }
}

function saveSyncState(state, { statePath = defaultStatePath() } = {}) {
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2) + "\n", { mode: 0o600 });
}

function sha256Hex(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

module.exports = {
  SNAPSHOT_SCHEMA,
  ENCRYPTED_MAGIC,
  defaultConfigPath,
  defaultStatePath,
  loadWebdavConfig,
  normalizeWebdavConfig,
  saveWebdavConfig,
  davUrl,
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
};
