import assert from "node:assert/strict";
import { createCipheriv, createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { deflateRawSync, crc32 } from "node:zlib";
import { UsageStore } from "./store.ts";
import { migrateLegacy, publicMigration } from "./migrate.ts";
import { PoolManager } from "../../pool/src/router.ts";
import { Registry } from "../../protocols/src/registry.ts";
import { createGateway, makeConfig } from "../../../apps/gateway/src/server.ts";
import { ChatService } from "../../../apps/gateway/src/service.ts";

const TOKEN = "secret-token-zzzz";
const NEWER = "secret-token-9999";

function fingerprint(dir: string): string {
  const lines: string[] = [];
  const walk = (current: string) => {
    for (const name of fs.readdirSync(current).sort()) {
      const full = path.join(current, name);
      const stat = fs.lstatSync(full);
      const rel = path.relative(dir, full).split(path.sep).join("/");
      if (stat.isSymbolicLink()) lines.push(`link ${rel} ${fs.readlinkSync(full)}`);
      else if (stat.isDirectory()) walk(full);
      else lines.push(`file ${rel} ${stat.mode & 0o777} ${createHash("sha256").update(fs.readFileSync(full)).digest("hex")}`);
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return lines.join("\n");
}

function seal(plaintext: string, secret = "test-secret"): string {
  const key = createHash("sha256").update(secret, "utf8").digest();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return `enc:v1:${iv.toString("base64url")}.${cipher.getAuthTag().toString("base64url")}.${ciphertext.toString("base64url")}`;
}

function writeUsageDb(file: string, accountId = "usr-1") {
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE usage (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts REAL NOT NULL,
    account_id TEXT,
    client_key TEXT,
    dialect TEXT,
    model TEXT,
    variant TEXT,
    stream INTEGER,
    status INTEGER,
    duration_ms REAL,
    prompt_tokens INTEGER,
    completion_tokens INTEGER,
    total_tokens INTEGER,
    error_code TEXT
  )`);
  db.prepare(
    `INSERT INTO usage (ts, account_id, client_key, dialect, model, variant, stream, status, duration_ms, prompt_tokens, completion_tokens, total_tokens, error_code)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(1_700_000_000, accountId, "client-test-key", "openai", "GLM-5.3", null, 0, 200, 12, 3, 4, 7, null);
  db.close();
}

function accountFile(id: string, token: string, expires: number, email = "one@example.test"): string {
  return `account_id: ${id}\nemail: ${email}\naccess_token: ${token}\nexpires_at_ms: ${expires}\n`;
}

function packZip(files: { name: string; data: Buffer }[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.name);
    const compressed = deflateRawSync(file.data);
    const crc = crc32(file.data) >>> 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(file.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(file.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    const localFull = Buffer.concat([local, name, compressed]);
    locals.push(localFull);
    centrals.push(Buffer.concat([central, name]));
    offset += localFull.length;
  }
  const centralBuf = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBuf, end]);
}

function treeText(dir: string): string {
  if (!fs.existsSync(dir)) return "";
  let out = "";
  const walk = (current: string) => {
    for (const name of fs.readdirSync(current)) {
      const full = path.join(current, name);
      const stat = fs.lstatSync(full);
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) walk(full);
      else out += fs.readFileSync(full);
    }
  };
  walk(dir);
  return out;
}

function readDest(dir: string): string {
  const accounts = path.join(dir, "accounts");
  if (!fs.existsSync(accounts)) return "";
  return fs.readdirSync(accounts).map((name) => fs.readFileSync(path.join(accounts, name), "utf8")).join("\n");
}

test("a legacy directory imports config, accounts, usage, and relays without touching the source", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "azc-legacy-"));
  const source = path.join(root, "source");
  const destination = path.join(root, "dest");
  const backup = path.join(root, "backup");
  fs.mkdirSync(path.join(source, "accounts"), { recursive: true });
  fs.mkdirSync(path.join(source, "generator-data", "results"), { recursive: true });
  fs.writeFileSync(
    path.join(source, "config.yaml"),
    "server:\n  host: 127.0.0.1\n  port: 8788\n  admin_key: legacy-admin-key\n  client_keys:\n    - key: legacy-client-key\n      name: local\npool:\n  strategy: least_in_flight\n  balance_poll_seconds: 60\nobservability:\n  sink: file\ngenerator:\n  claim: false\n  invite_code: \"not-a-claim-code\"\n",
  );
  fs.writeFileSync(path.join(source, "accounts", "one.txt"), accountFile("usr-1", TOKEN, 5_000));
  fs.writeFileSync(path.join(source, "accounts", "bad.txt"), "account_id: usr-bad\nexpires_at_ms: soon\naccess_token: secret-token-zzzz\n");
  fs.writeFileSync(path.join(source, "accounts", "empty.txt"), "account_id: usr-empty\n");
  writeUsageDb(path.join(source, "gateway.db"));
  fs.chmodSync(path.join(source, "gateway.db"), 0o444);
  const relay = JSON.stringify({ relays: [{ id: "relay-1", url: "https://example.test/relay", provider: "cloudflare" }], active_url: "https://example.test/relay" });
  fs.writeFileSync(path.join(source, "generator-data", "relays.json"), relay);
  fs.writeFileSync(path.join(source, "generator-data", "proxies.txt"), "203.0.113.5:1080\n");
  fs.writeFileSync(path.join(source, "generator-data", "mail_config.json"), JSON.stringify({ inbox_secret: "not-a-real-inbox-secret" }));
  fs.writeFileSync(path.join(source, "generator-data", "registered.json"), JSON.stringify({ claims: ["not-a-claim"] }));
  fs.writeFileSync(path.join(source, "generator-data", "results", "one.json"), JSON.stringify({ ok: true }));
  fs.writeFileSync(path.join(source, "model-caps.json"), JSON.stringify({ "GLM-5.3": {} }));
  fs.writeFileSync(path.join(source, "pool.json"), "{\"accounts\":[]}\n");
  const outside = path.join(root, "outside.txt");
  fs.writeFileSync(outside, accountFile("usr-link", TOKEN, 9));
  fs.symlinkSync(outside, path.join(source, "accounts", "linked.txt"));
  const before = fingerprint(source);
  const result = migrateLegacy({ source, destination, backupDir: backup });
  assert.equal(fingerprint(source), before);
  assert.equal(fs.existsSync(path.join(source, "gateway.db-wal")), false);
  assert.equal((fs.statSync(path.join(source, "gateway.db")).mode & 0o777) === 0o444, true);
  assert.equal(result.config.host, "127.0.0.1");
  assert.equal(result.config.port, 8788);
  assert.equal(result.config.adminKey, "legacy-admin-key");
  assert.equal(result.config.clientKeys?.[0]?.key, "legacy-client-key");
  assert.equal(result.config.pool?.strategy, "least_in_flight");
  assert.equal((result.config.extras.observability as { sink: string }).sink, "file");
  assert.equal((result.config.extras.pool as { balance_poll_seconds: number }).balance_poll_seconds, 60);
  assert.equal(JSON.stringify(result.config).includes("not-a-claim-code"), false);
  assert.equal(result.accountsImported.includes("usr-1"), true);
  assert.equal(result.accountsSkipped.some((item) => item.reason === "bad expires_at_ms"), true);
  assert.equal(result.accountsSkipped.some((item) => item.reason === "missing access_token"), true);
  assert.equal(result.skipped.some((item) => item.path === "generator-data/proxies.txt" && item.reason === "proxy lists are not imported"), true);
  assert.equal(result.skipped.some((item) => item.path === "generator-data/mail_config.json"), true);
  assert.equal(result.skipped.some((item) => item.path === "accounts/linked.txt" && item.reason === "symlink skipped"), true);
  assert.equal(result.usageRows, 1);
  assert.equal(result.relaysCopied, true);
  assert.equal(result.modelCapsCopied, true);
  const dumped = readDest(destination);
  assert.equal(dumped.includes(TOKEN), true);
  assert.equal(dumped.includes("usr-link"), false);
  const tree = treeText(destination);
  assert.equal(tree.includes("203.0.113.5"), false);
  assert.equal(tree.includes("not-a-real-inbox-secret"), false);
  assert.equal(tree.includes("not-a-claim"), false);
  assert.equal(fs.readFileSync(path.join(destination, "config.json"), "utf8").includes("not-a-real-inbox-secret"), false);
  assert.equal(fs.readFileSync(path.join(destination, "config.json"), "utf8").includes("not-a-claim-code"), false);
  assert.equal(fs.readFileSync(path.join(destination, "relays.json"), "utf8"), relay);
  assert.equal((fs.statSync(path.join(destination, "config.json")).mode & 0o777) === 0o600, true);
  assert.equal(fs.existsSync(path.join(backup, "generator-data", "proxies.txt")), false);
  assert.equal(fs.existsSync(path.join(backup, "generator-data", "relays.json")), true);
  const store = new UsageStore(path.join(destination, "gateway.db"));
  try {
    assert.equal(store.summary().requests, 1);
  } finally {
    store.close();
  }
  const again = migrateLegacy({ source, destination, backupDir: path.join(root, "backup-2") });
  assert.equal(again.usageRows, 0);
  assert.equal(again.accountsKept.includes("usr-1"), true);
  const storeAgain = new UsageStore(path.join(destination, "gateway.db"));
  try {
    assert.equal(storeAgain.summary().requests, 1);
  } finally {
    storeAgain.close();
  }
});

test("a newer snapshot replaces the same account and an older one does not", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "azc-legacy-age-"));
  const first = path.join(root, "first");
  const second = path.join(root, "second");
  const third = path.join(root, "third");
  const destination = path.join(root, "dest");
  for (const [dir, token, expires] of [
    [first, TOKEN, 1_000],
    [second, NEWER, 500],
    [third, NEWER, 5_000],
  ] as const) {
    fs.mkdirSync(path.join(dir, "accounts"), { recursive: true });
    fs.writeFileSync(path.join(dir, "accounts", "one.txt"), accountFile("usr-1", token, expires));
  }
  migrateLegacy({ source: first, destination, backupDir: path.join(root, "b1") });
  const older = migrateLegacy({ source: second, destination, backupDir: path.join(root, "b2") });
  assert.deepEqual(older.accountsKept, ["usr-1"]);
  assert.equal(readDest(destination).includes(TOKEN), true);
  assert.equal(readDest(destination).includes(NEWER), false);
  const newer = migrateLegacy({ source: third, destination, backupDir: path.join(root, "b3") });
  assert.deepEqual(newer.accountsImported, ["usr-1"]);
  assert.equal(readDest(destination).includes(NEWER), true);
  assert.equal(readDest(destination).includes(`expires_at_ms: 5000`), true);
});

test("a sealed credential stays sealed when the key does not match", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "azc-legacy-seal-"));
  const source = path.join(root, "source");
  const destination = path.join(root, "dest");
  fs.mkdirSync(path.join(source, "accounts"), { recursive: true });
  const blob = seal(TOKEN);
  fs.writeFileSync(path.join(source, "accounts", "one.txt"), accountFile("usr-seal", blob, 5_000, "seal@example.test"));
  const kept = migrateLegacy({ source, destination, backupDir: path.join(root, "backup") });
  assert.deepEqual(kept.sealed, ["accounts/one.txt"]);
  const sealedText = readDest(destination);
  assert.equal(sealedText.includes("enc:v1:"), true);
  assert.equal(sealedText.includes(TOKEN), false);
  assert.equal(JSON.stringify(kept).includes(TOKEN), false);
  const opened = path.join(root, "opened");
  const decrypted = migrateLegacy({
    source,
    destination: opened,
    backupDir: path.join(root, "backup-open"),
    credentialSecret: "test-secret",
  });
  assert.deepEqual(decrypted.sealed, []);
  const plain = readDest(opened);
  assert.equal(plain.includes(TOKEN), true);
  assert.equal(plain.includes("enc:v1:"), false);
  assert.equal(JSON.stringify(decrypted).includes(TOKEN), false);
});

test("a failed step removes a new data directory and leaves the source unchanged", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "azc-legacy-fail-"));
  const source = path.join(root, "source");
  const destination = path.join(root, "dest");
  fs.mkdirSync(path.join(source, "accounts"), { recursive: true });
  fs.writeFileSync(path.join(source, "accounts", "one.txt"), accountFile("usr-1", TOKEN, 5_000));
  fs.writeFileSync(path.join(source, "gateway.db"), "not a database");
  const before = fingerprint(source);
  assert.throws(() => migrateLegacy({ source, destination, backupDir: path.join(root, "backup") }), /usage database could not be read/);
  assert.equal(fs.existsSync(destination), false);
  assert.equal(fingerprint(source), before);
  fs.rmSync(path.join(source, "gateway.db"));
  const afterRemoval = fingerprint(source);
  const existing = path.join(root, "existing");
  fs.mkdirSync(existing, { recursive: true });
  fs.writeFileSync(path.join(existing, "keep.txt"), "stay");
  assert.throws(
    () => migrateLegacy({ source, destination: existing, backupDir: path.join(root, "backup-2"), crashAfter: "accounts" }),
    /migration stopped for rollback/,
  );
  assert.equal(fs.readFileSync(path.join(existing, "keep.txt"), "utf8"), "stay");
  assert.equal(fs.existsSync(path.join(existing, "config.json")), false);
  assert.equal(readDest(existing).includes(TOKEN), false);
  assert.equal(fingerprint(source), afterRemoval);
});

test("a backup zip restores the portable files and rejects a path that escapes", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "azc-legacy-zip-"));
  const dbFile = path.join(root, "gateway.db");
  writeUsageDb(dbFile, "usr-zip");
  const zip = path.join(root, "legacy.zip");
  fs.writeFileSync(
    zip,
    packZip([
      { name: "config.yaml", data: Buffer.from("server:\n  host: 127.0.0.1\n  port: 9\n") },
      { name: "accounts/one.txt", data: Buffer.from(accountFile("usr-zip", TOKEN, 5_000)) },
      { name: "gateway.db", data: fs.readFileSync(dbFile) },
      { name: "generator-data/relays.json", data: Buffer.from("{\"relays\":[]}\n") },
      { name: "generator-data/proxies.txt", data: Buffer.from("203.0.113.9:1\n") },
    ]),
  );
  const zipHash = createHash("sha256").update(fs.readFileSync(zip)).digest("hex");
  const destination = path.join(root, "dest");
  const result = migrateLegacy({ source: zip, destination, backupDir: path.join(root, "backup") });
  assert.equal(result.accountsImported.includes("usr-zip"), true);
  assert.equal(result.usageRows, 1);
  assert.equal(result.relaysCopied, true);
  assert.equal(result.skipped.some((item) => item.path === "generator-data/proxies.txt"), true);
  assert.equal(readDest(destination).includes(TOKEN), true);
  assert.equal(fs.readFileSync(path.join(destination, "relays.json"), "utf8").includes("203.0.113.9"), false);
  assert.equal(createHash("sha256").update(fs.readFileSync(zip)).digest("hex"), zipHash);
  assert.equal(createHash("sha256").update(fs.readFileSync(path.join(root, "backup", "legacy.zip"))).digest("hex"), zipHash);
  const canary = `azc-migrate-escape-${process.pid}.txt`;
  const canaryPath = path.join(os.tmpdir(), canary);
  fs.rmSync(canaryPath, { force: true });
  const hostile = path.join(root, "hostile.zip");
  fs.writeFileSync(
    hostile,
    packZip([
      { name: "config.yaml", data: Buffer.from("server:\n  host: 127.0.0.1\n") },
      { name: `../${canary}`, data: Buffer.from("nope") },
    ]),
  );
  assert.throws(() => migrateLegacy({ source: hostile, destination: path.join(root, "nope"), backupDir: path.join(root, "backup-bad") }), /escapes the archive/);
  assert.equal(fs.existsSync(canaryPath), false);
  assert.equal(fs.existsSync(path.join(root, "nope")), false);
});

test("the checked-in example config keeps unknown keys and drops generator settings", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "azc-legacy-example-"));
  const source = path.join(root, "source");
  fs.mkdirSync(source, { recursive: true });
  fs.copyFileSync(path.resolve(import.meta.dirname, "../../../config.example.yaml"), path.join(source, "config.yaml"));
  const result = migrateLegacy({ source, destination: path.join(root, "dest"), backupDir: path.join(root, "backup") });
  assert.equal(result.config.host, "127.0.0.1");
  assert.equal(result.config.port, 8788);
  assert.equal(result.config.upstreamBaseUrl, "https://zcode.z.ai/api/v1");
  assert.equal(result.config.pool?.strategy, "drain_first");
  assert.equal(result.config.pool?.blockedModelCooldownSeconds, 900);
  assert.equal(result.config.defaultEffort, "high");
  assert.equal(result.config.defaultMaxTokens, 128000);
  assert.equal(result.config.aliases?.["glm-5.3-flash"], "GLM-5.3-Flash");
  assert.equal(result.config.clientKeys?.[0]?.name, "local");
  assert.equal((result.config.extras.pool as { balance_poll_seconds: number }).balance_poll_seconds, 60);
  assert.equal(result.config.extras.accounts_dir_source, "./accounts");
  assert.equal((result.config.extras.upstream as { timeout_read: number }).timeout_read, 600);
  const written = fs.readFileSync(path.join(root, "dest", "config.json"), "utf8");
  assert.equal(written.includes("MT9GNDQ8"), false);
  assert.equal(written.includes("captcha"), false);
  assert.equal(result.skipped.some((item) => item.path === "config.yaml#generator"), true);
});

test("the admin migrate route reloads accounts and does not return secrets", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "azc-legacy-http-"));
  const source = path.join(root, "source");
  const destination = path.join(root, "dest");
  fs.mkdirSync(path.join(source, "accounts"), { recursive: true });
  fs.writeFileSync(
    path.join(source, "config.yaml"),
    "server:\n  admin_key: legacy-admin-key\n  client_keys:\n    - key: legacy-client-key\n      name: legacy\n",
  );
  fs.writeFileSync(path.join(source, "accounts", "one.txt"), accountFile("usr-http", NEWER, 5_000));
  const logs: string[] = [];
  const config = makeConfig({
    accountsDir: path.join(destination, "accounts"),
    adminKey: "admin-test-key",
    clientKeys: [{ key: "client-test-key", name: "local", rpm: 0 }],
  });
  const store = new UsageStore(path.join(destination, "gateway.db"));
  const service = new ChatService({
    pool: new PoolManager([], config.pool),
    registry: new Registry(),
    store,
    upstream: { async send() { throw new Error("unused"); } },
    config,
  });
  const server = createGateway({ config, service, logs, dataDir: destination });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  const port = address && typeof address === "object" ? address.port : 0;
  const base = `http://127.0.0.1:${port}`;
  try {
    const denied = await fetch(`${base}/admin/migrate`, {
      method: "POST",
      headers: { authorization: "Bearer client-test-key", "content-type": "application/json" },
      body: JSON.stringify({ source }),
    });
    assert.equal(denied.status, 403);
    const response = await fetch(`${base}/admin/migrate`, {
      method: "POST",
      headers: { authorization: "Bearer admin-test-key", "content-type": "application/json" },
      body: JSON.stringify({ source }),
    });
    const body = await response.json();
    assert.equal(response.status, 200);
    const text = JSON.stringify(body);
    assert.equal(text.includes(NEWER), false);
    assert.equal(text.includes("legacy-admin-key"), false);
    assert.equal(text.includes("legacy-client-key"), false);
    assert.equal(body.accountsImported.includes("usr-http"), true);
    assert.equal(body.config.admin_key_hint, "…-key");
    assert.equal(logs.join("\n").includes(NEWER), false);
    assert.equal(logs.join("\n").includes("legacy-admin-key"), false);
    const listed = await fetch(`${base}/admin/accounts`, { headers: { authorization: "Bearer admin-test-key" } });
    const accounts = await listed.json();
    assert.equal(accounts.accounts[0].id, "usr-http");
    assert.equal(JSON.stringify(accounts).includes(NEWER), false);
    assert.equal(publicMigration(migrateLegacy({ source, destination: path.join(root, "other"), backupDir: path.join(root, "b") })).config.admin_key_hint, "…-key");
  } finally {
    store.close();
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});
