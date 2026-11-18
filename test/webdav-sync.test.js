const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const {
  SNAPSHOT_SCHEMA,
  ENCRYPTED_MAGIC,
  davUrl,
  defaultConfigPath,
  loadWebdavConfig,
  normalizeWebdavConfig,
  saveWebdavConfig,
  snapshotFilename,
  snapshotFileUrl,
  snapshotListUrl,
  parsePropfindHrefs,
  hrefToFilename,
  encryptSnapshot,
  decryptSnapshot,
  validateSnapshotShape,
  loadSyncState,
  saveSyncState,
  sha256Hex,
} = require("../src/lib/webdav-sync");

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "tokentracker-webdav-"));
}

// Real servers mix namespace prefixes freely (Nextcloud: d:, Apache: D:,
// some proxies: none) — including on the CLOSING tag, which a naive
// indexOf("</href>") parser never finds.
const PROPFIND_SAMPLE = [
  '<?xml version="1.0" encoding="utf-8"?>',
  '<D:multistatus xmlns:D="DAV:">',
  '<D:response><D:href>/dav/tokentracker/</D:href></D:response>',
  '<D:response><D:href>/dav/tokentracker/snapshots/</D:href></D:response>',
  '<d:response><d:href>/dav/tokentracker/snapshots/abc.json</d:href></d:response>',
  '<D:response><D:href>/dav/tokentracker/snapshots/def.json</D:href></D:response>',
  '<response><href>/dav/tokentracker/snapshots/ghi.json?param=1</href></response>',
  '</D:multistatus>',
].join("\n");

test("parsePropfindHrefs extracts hrefs with any (or no) namespace prefix", () => {
  assert.deepEqual(parsePropfindHrefs(PROPFIND_SAMPLE), [
    "/dav/tokentracker/",
    "/dav/tokentracker/snapshots/",
    "/dav/tokentracker/snapshots/abc.json",
    "/dav/tokentracker/snapshots/def.json",
    "/dav/tokentracker/snapshots/ghi.json?param=1",
  ]);
});

test("parsePropfindHrefs returns [] on empty or href-less XML", () => {
  assert.deepEqual(parsePropfindHrefs(""), []);
  assert.deepEqual(parsePropfindHrefs(null), []);
  assert.deepEqual(parsePropfindHrefs("<D:multistatus><D:prop/></D:multistatus>"), []);
});

test("hrefToFilename takes the last path segment and decodes it", () => {
  assert.equal(hrefToFilename("/dav/tokentracker/snapshots/abc.json"), "abc.json");
  assert.equal(hrefToFilename("/dav/tokentracker/snapshots/abc.json?param=1"), "abc.json");
  assert.equal(hrefToFilename("/dav/dir/"), "");
  assert.equal(hrefToFilename(""), "");
  assert.equal(hrefToFilename("/dav/%E4%B8%AD.json"), "中.json");
});

test("davUrl builders lay out one file per machine under tokentracker/snapshots", () => {
  const config = { url: "https://dav.example.com/dav/" };
  assert.equal(davUrl(config, "a", "b"), "https://dav.example.com/dav/a/b");
  assert.equal(snapshotListUrl(config), "https://dav.example.com/dav/tokentracker/snapshots");
  assert.equal(snapshotFileUrl(config, "m1"), "https://dav.example.com/dav/tokentracker/snapshots/m1.json");
  assert.equal(snapshotFilename("m1"), "m1.json");
});

test("encryptSnapshot/decryptSnapshot round-trip, plaintext passthrough, and tamper rejection", () => {
  const payload = Buffer.from(JSON.stringify({ hello: "世界" }), "utf8");
  const encrypted = encryptSnapshot(payload, "passphrase-1");
  assert.ok(encrypted.subarray(0, 4).equals(ENCRYPTED_MAGIC), "encrypted files carry the TTV1 magic");
  assert.notDeepEqual(encrypted, payload);
  assert.deepEqual(decryptSnapshot(encrypted, "passphrase-1"), payload);
  // Wrong passphrase must fail via the GCM auth tag, not return garbage.
  assert.throws(() => decryptSnapshot(encrypted, "passphrase-2"));
  // A plaintext file (migration path) passes through untouched.
  assert.deepEqual(decryptSnapshot(payload, ""), payload);
  // Two encryptions of the same payload differ (random salt+IV).
  assert.notDeepEqual(encryptSnapshot(payload, "p"), encryptSnapshot(payload, "p"));
});

test("validateSnapshotShape gates on the fields pull depends on", () => {
  const good = {
    schema: SNAPSHOT_SCHEMA,
    machine: { id: "m1", name: "box", platform: "win32" },
    sequence: 3,
    rows: [],
  };
  assert.equal(validateSnapshotShape(good), true);
  assert.equal(validateSnapshotShape({ ...good, schema: "other" }), false);
  assert.equal(validateSnapshotShape({ ...good, machine: { name: "box" } }), false);
  assert.equal(validateSnapshotShape({ ...good, sequence: "3" }), false);
  assert.equal(validateSnapshotShape({ ...good, rows: {} }), false);
  assert.equal(validateSnapshotShape(null), false);
});

test("saveWebdavConfig/loadWebdavConfig persist, trim, and honor env overrides", () => {
  const dir = tmpDir();
  const configPath = path.join(dir, "webdav.json");
  const saved = saveWebdavConfig(
    { url: "https://dav.example.com/dav/ ", username: " u ", password: "p", encrypt: "" },
    { configPath },
  );
  assert.equal(saved.url, "https://dav.example.com/dav", "trailing slash trimmed");
  assert.equal(saved.username, "u");

  const loaded = loadWebdavConfig({ configPath, env: {} });
  assert.deepEqual(loaded, { url: "https://dav.example.com/dav", username: "u", password: "p", encrypt: "" });

  const overridden = loadWebdavConfig({
    configPath,
    env: { TT_WEBDAV_URL: "https://other/dav", TT_WEBDAV_PASSWORD: "env-pass", TT_WEBDAV_ENCRYPT: "env-secret" },
  });
  assert.equal(overridden.url, "https://other/dav");
  assert.equal(overridden.password, "env-pass");
  assert.equal(overridden.encrypt, "env-secret");
  assert.equal(overridden.username, "u", "unset env fields fall back to the file");

  assert.throws(() => saveWebdavConfig({ url: "" }, { configPath }), /--url/);
  assert.throws(() => saveWebdavConfig({ url: "ftp://x/" }, { configPath }), /http/);

  const missing = loadWebdavConfig({ configPath: path.join(dir, "nope.json"), env: {} });
  assert.deepEqual(missing, { url: "", username: "", password: "", encrypt: "" });
});

test("sync state round-trips through the state file", () => {
  const dir = tmpDir();
  const statePath = path.join(dir, "webdav.state.json");
  assert.deepEqual(loadSyncState({ statePath }), {});
  saveSyncState({ pushContentSha256: sha256Hex(Buffer.from("x")), etags: { "a.json": "etag-a" } }, { statePath });
  const loaded = loadSyncState({ statePath });
  assert.equal(loaded.pushContentSha256, sha256Hex(Buffer.from("x")));
  assert.deepEqual(loaded.etags, { "a.json": "etag-a" });
});

test("defaultConfigPath lives under ~/.tokentracker", () => {
  assert.ok(defaultConfigPath().includes(path.join(".tokentracker", "webdav.json")));
});
