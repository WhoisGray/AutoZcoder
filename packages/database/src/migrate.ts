import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { inflateRawSync, crc32 } from "node:zlib";
import type { Account } from "../../pool/src/account.ts";
import { decryptCredential, type DecryptOptions } from "../../pool/src/credentials.ts";
import type { PoolOptions } from "../../pool/src/router.ts";
import { accountFromFields, loadAccountsDir, parseSnapshot, writeSnapshotAtomic } from "../../pool/src/snapshots.ts";
import { UsageStore } from "./store.ts";

const USAGE_COLUMNS = [
  "ts",
  "account_id",
  "client_key",
  "dialect",
  "model",
  "variant",
  "stream",
  "status",
  "duration_ms",
  "prompt_tokens",
  "completion_tokens",
  "total_tokens",
  "error_code",
] as const;

const SKIP_WALK = new Set(["node_modules", ".git", "chromium", "browser-profiles", "logs", "screenshots"]);

export interface MigrateOptions {
  source: string;
  destination: string;
  backupDir?: string;
  credentialSecret?: string;
  /** Test seam. Throws after that write so rollback can be observed. */
  crashAfter?: "accounts";
}

export interface MigrateSkip {
  path: string;
  reason: string;
}

export interface MigratedConfig {
  host?: string;
  port?: number;
  requireClientKey?: boolean;
  adminKey?: string;
  clientKeys?: { key: string; name: string; rpm: number }[];
  upstreamBaseUrl?: string;
  chatPath?: string;
  maxAttempts?: number;
  overloadMaxAttempts?: number;
  overloadBaseDelaySeconds?: number;
  overloadMaxDelaySeconds?: number;
  defaultMaxTokens?: number;
  defaultEffort?: string;
  aliases?: Record<string, string>;
  pool?: PoolOptions;
  extras: Record<string, unknown>;
}

export interface MigrateResult {
  backupDir: string;
  configFile: string;
  config: MigratedConfig;
  accountsImported: string[];
  accountsSkipped: MigrateSkip[];
  accountsKept: string[];
  usageRows: number;
  relaysCopied: boolean;
  modelCapsCopied: boolean;
  sealed: string[];
  skipped: MigrateSkip[];
}

type Undo = () => void;

function sameOrInside(parent: string, child: string): boolean {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function posixRel(root: string, file: string): string {
  return path.relative(root, file).split(path.sep).join("/");
}

function safeZipName(name: string): string | null {
  const normalized = name.replaceAll("\\", "/");
  if (!normalized || normalized.startsWith("/") || normalized.includes("\0")) return null;
  const parts = normalized.split("/").filter((part) => part.length > 0 && part !== ".");
  if (parts.length === 0 || parts.some((part) => part === "..")) return null;
  return parts.join("/");
}

function isGeneratorPath(rel: string): boolean {
  const parts = rel.split("/");
  const base = parts[parts.length - 1] ?? "";
  if (base === "relays.json") return false;
  if (base === "pool.json" || base === "pool.json.bak") return true;
  return parts.includes("generator-data") || parts.includes("output") || parts[0] === "generator";
}

function generatorReason(rel: string): string {
  const base = rel.split("/").pop() ?? rel;
  if (base.includes("prox")) return "proxy lists are not imported";
  if (base === "mail_config.json") return "inboxes are not imported";
  if (base === "registered.json" || base === "pending_referral.json" || base === "recovery_accounts.txt" || rel.includes("/results")) {
    return "claim results are not imported";
  }
  return "generator data is not imported";
}

function copyPortableTree(source: string, backupDir: string, skipped: MigrateSkip[]) {
  const walk = (current: string) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      const rel = posixRel(source, full);
      if (entry.isSymbolicLink()) {
        skipped.push({ path: rel, reason: "symlink skipped" });
        continue;
      }
      if (entry.isDirectory()) {
        if (SKIP_WALK.has(entry.name)) {
          skipped.push({ path: rel, reason: "not part of the portable backup" });
          continue;
        }
        if (isGeneratorPath(rel) && entry.name !== "generator-data" && entry.name !== "generator" && entry.name !== "output") {
          skipped.push({ path: rel, reason: generatorReason(rel) });
          continue;
        }
        if (isGeneratorPath(rel) && (entry.name === "results")) {
          skipped.push({ path: rel, reason: generatorReason(rel) });
          continue;
        }
        walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      if (isGeneratorPath(rel)) {
        skipped.push({ path: rel, reason: generatorReason(rel) });
        continue;
      }
      const target = path.join(backupDir, rel);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(full, target);
    }
  };
  fs.mkdirSync(backupDir, { recursive: true });
  walk(source);
}

function readZip(file: string): Map<string, Buffer> {
  const data = fs.readFileSync(file);
  let eocd = -1;
  const min = Math.max(0, data.length - 22 - 65535);
  for (let i = data.length - 22; i >= min; i -= 1) {
    if (data.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("backup zip is not a zip archive");
  const count = data.readUInt16LE(eocd + 10);
  let cursor = data.readUInt32LE(eocd + 16);
  const out = new Map<string, Buffer>();
  for (let n = 0; n < count; n += 1) {
    if (cursor + 46 > data.length || data.readUInt32LE(cursor) !== 0x02014b50) throw new Error("backup zip is not a zip archive");
    const method = data.readUInt16LE(cursor + 10);
    const crc = data.readUInt32LE(cursor + 16);
    const compressedSize = data.readUInt32LE(cursor + 20);
    const uncompressedSize = data.readUInt32LE(cursor + 24);
    const nameLen = data.readUInt16LE(cursor + 28);
    const extraLen = data.readUInt16LE(cursor + 30);
    const commentLen = data.readUInt16LE(cursor + 32);
    const localOffset = data.readUInt32LE(cursor + 42);
    const name = data.subarray(cursor + 46, cursor + 46 + nameLen).toString("utf8");
    cursor += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith("/")) continue;
    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff) throw new Error("backup zip uses an unsupported compression method");
    const localNameLen = data.readUInt16LE(localOffset + 26);
    const localExtraLen = data.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + localNameLen + localExtraLen;
    const compressed = data.subarray(start, start + compressedSize);
    let bytes: Buffer;
    if (method === 0) bytes = Buffer.from(compressed);
    else if (method === 8) bytes = Buffer.from(inflateRawSync(compressed));
    else throw new Error("backup zip uses an unsupported compression method");
    if (bytes.length !== uncompressedSize || (crc32(bytes) >>> 0) !== crc) throw new Error("backup zip entry is corrupted");
    out.set(name, bytes);
  }
  return out;
}

function extractZip(file: string, into: string) {
  const entries = readZip(file);
  const safe = new Map<string, Buffer>();
  for (const [name, bytes] of entries) {
    const cleaned = safeZipName(name);
    if (!cleaned) throw new Error("backup zip path escapes the archive");
    safe.set(cleaned, bytes);
  }
  fs.mkdirSync(into, { recursive: true });
  for (const [name, bytes] of safe) {
    const target = path.resolve(into, name);
    if (!sameOrInside(into, target)) throw new Error("backup zip path escapes the archive");
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, bytes);
  }
}

function stripInlineComment(line: string): string {
  let quote: string | null = null;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]!;
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (ch === "#" && (i === 0 || line[i - 1] === " ")) return line.slice(0, i).trimEnd();
  }
  return line.trimEnd();
}

function parseScalar(raw: string): unknown {
  const text = raw.trim();
  if (text === "~" || text === "null" || text === "Null" || text === "NULL") return null;
  if (text === "true" || text === "True" || text === "TRUE") return true;
  if (text === "false" || text === "False" || text === "FALSE") return false;
  if (/^-?\d+$/.test(text)) return Number(text);
  if (/^-?\d+\.\d+$/.test(text)) return Number(text);
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) return text.slice(1, -1);
  if (text.startsWith("[") && text.endsWith("]")) {
    const inner = text.slice(1, -1).trim();
    if (!inner) return [];
    return inner.split(",").map((part) => parseScalar(part.trim()));
  }
  return text;
}

interface YamlLine {
  indent: number;
  text: string;
}

function yamlLines(text: string): YamlLine[] {
  const lines: YamlLine[] = [];
  for (const raw of text.replace(/^\uFEFF/, "").split(/\r?\n/)) {
    const stripped = stripInlineComment(raw.replaceAll("\t", "  "));
    if (!stripped.trim()) continue;
    const indent = stripped.match(/^ */)?.[0].length ?? 0;
    lines.push({ indent, text: stripped.trim() });
  }
  return lines;
}

function parseYamlValue(lines: YamlLine[], index: number, indent: number): [unknown, number] {
  if (index >= lines.length || lines[index]!.indent < indent) return [{}, index];
  if (lines[index]!.text.startsWith("- ")) return parseYamlList(lines, index, indent);
  const map: Record<string, unknown> = {};
  let cursor = index;
  while (cursor < lines.length && lines[cursor]!.indent === indent && !lines[cursor]!.text.startsWith("- ")) {
    const colon = lines[cursor]!.text.indexOf(":");
    if (colon <= 0) throw new Error("config.yaml could not be parsed");
    const key = lines[cursor]!.text.slice(0, colon).trim();
    const rest = lines[cursor]!.text.slice(colon + 1).trim();
    cursor += 1;
    if (rest) {
      map[key] = parseScalar(rest);
      continue;
    }
    if (cursor < lines.length && lines[cursor]!.indent > indent) {
      const [child, next] = parseYamlValue(lines, cursor, lines[cursor]!.indent);
      map[key] = child;
      cursor = next;
      continue;
    }
    map[key] = null;
  }
  return [map, cursor];
}

function parseYamlList(lines: YamlLine[], index: number, indent: number): [unknown[], number] {
  const list: unknown[] = [];
  let cursor = index;
  while (cursor < lines.length && lines[cursor]!.indent === indent && lines[cursor]!.text.startsWith("- ")) {
    const body = lines[cursor]!.text.slice(2).trim();
    cursor += 1;
    if (!body.includes(":")) {
      list.push(parseScalar(body));
      continue;
    }
    const map: Record<string, unknown> = {};
    const take = (entry: string, next: number): number => {
      const colon = entry.indexOf(":");
      if (colon <= 0) throw new Error("config.yaml could not be parsed");
      const key = entry.slice(0, colon).trim();
      const rest = entry.slice(colon + 1).trim();
      if (rest) {
        map[key] = parseScalar(rest);
        return next;
      }
      if (next < lines.length && lines[next]!.indent > indent) {
        const [child, after] = parseYamlValue(lines, next, lines[next]!.indent);
        map[key] = child;
        return after;
      }
      map[key] = null;
      return next;
    };
    cursor = take(body, cursor);
    while (cursor < lines.length && lines[cursor]!.indent > indent && !lines[cursor]!.text.startsWith("- ")) {
      const entry = lines[cursor]!.text;
      cursor = take(entry, cursor + 1);
    }
    list.push(map);
  }
  return [list, cursor];
}

export function parseConfigYaml(text: string): Record<string, unknown> {
  const lines = yamlLines(text);
  if (lines.length === 0) return {};
  try {
    const [value, next] = parseYamlValue(lines, 0, lines[0]!.indent);
    if (next !== lines.length || !value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("config.yaml could not be parsed");
    }
    return value as Record<string, unknown>;
  } catch (error) {
    if (error instanceof Error && error.message === "config.yaml could not be parsed") throw error;
    throw new Error("config.yaml could not be parsed");
  }
}

function section(src: Record<string, unknown>, key: string): Record<string, unknown> {
  if (!Object.prototype.hasOwnProperty.call(src, key)) return {};
  const value = pull(src, key);
  const map = asMap(value);
  if (!map) throw new Error("config.yaml could not be parsed");
  return map;
}

function asMap(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function pull(map: Record<string, unknown>, key: string): unknown {
  if (!Object.prototype.hasOwnProperty.call(map, key)) return undefined;
  const value = map[key];
  delete map[key];
  return value;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && /^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  return undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function mapConfig(parsed: Record<string, unknown>, skipped: MigrateSkip[]): MigratedConfig {
  const src = JSON.parse(JSON.stringify(parsed)) as Record<string, unknown>;
  if (Object.prototype.hasOwnProperty.call(src, "generator")) {
    skipped.push({ path: "config.yaml#generator", reason: "account generation is not part of this application" });
    delete src.generator;
  }
  const server = section(src, "server");
  const upstream = section(src, "upstream");
  const pool = section(src, "pool");
  const accounts = section(src, "accounts");
  const models = section(src, "models");
  const store = asMap(pull(src, "store"));
  const extras: Record<string, unknown> = { ...src };
  const host = asString(pull(server, "host"));
  const port = asNumber(pull(server, "port"));
  const requireClientKey = asBoolean(pull(server, "require_client_key"));
  const adminKey = asString(pull(server, "admin_key"));
  const rawKeys = pull(server, "client_keys");
  const clientKeys = Array.isArray(rawKeys)
    ? rawKeys.flatMap((item) => {
        const record = asMap(item);
        const key = record ? asString(record.key) : undefined;
        if (!record || !key) return [];
        return [{ key, name: asString(record.name) ?? "client", rpm: asNumber(record.rpm) ?? 0 }];
      })
    : undefined;
  const poolOptions: PoolOptions = {};
  const strategy = asString(pull(pool, "strategy"));
  const cooldownSeconds = asNumber(pull(pool, "cooldown_seconds"));
  const maxInFlight = asNumber(pull(pool, "max_in_flight_per_account"));
  const acquireWait = asNumber(pull(pool, "acquire_wait_seconds"));
  const blocked = asNumber(pull(pool, "blocked_model_cooldown_seconds"));
  if (strategy) poolOptions.strategy = strategy;
  if (cooldownSeconds != null) poolOptions.cooldownSeconds = cooldownSeconds;
  if (maxInFlight != null) poolOptions.maxInFlightPerAccount = maxInFlight;
  if (acquireWait != null) poolOptions.acquireWaitSeconds = acquireWait;
  if (blocked != null) poolOptions.blockedModelCooldownSeconds = blocked;
  const dir = asString(pull(accounts, "dir"));
  if (dir) extras.accounts_dir_source = dir;
  const aliasesRaw = asMap(pull(models, "aliases"));
  const aliases = aliasesRaw
    ? Object.fromEntries(Object.entries(aliasesRaw).filter((entry): entry is [string, string] => typeof entry[1] === "string"))
    : undefined;
  const base = asString(pull(upstream, "base_url"));
  const chat = asString(pull(upstream, "chat_path"));
  const maxAttempts = asNumber(pull(upstream, "max_attempts"));
  const overloadMax = asNumber(pull(upstream, "overload_max_attempts"));
  const overloadBase = asNumber(pull(upstream, "overload_base_delay_seconds"));
  const overloadCap = asNumber(pull(upstream, "overload_max_delay_seconds"));
  const defaultMaxTokens = asNumber(pull(models, "default_max_tokens"));
  const defaultEffort = asString(pull(models, "default_effort"));
  if (Object.keys(server).length) extras.server = server;
  if (Object.keys(upstream).length) extras.upstream = upstream;
  if (Object.keys(pool).length) extras.pool = pool;
  if (Object.keys(accounts).length) extras.accounts = accounts;
  if (store && Object.keys(store).length) extras.store = store;
  if (Object.keys(models).length) extras.models = models;
  const config: MigratedConfig = { extras };
  if (host) config.host = host;
  if (port != null) config.port = port;
  if (requireClientKey != null) config.requireClientKey = requireClientKey;
  if (adminKey) config.adminKey = adminKey;
  if (clientKeys) config.clientKeys = clientKeys;
  if (base) config.upstreamBaseUrl = base;
  if (chat) config.chatPath = chat;
  if (maxAttempts != null) config.maxAttempts = maxAttempts;
  if (overloadMax != null) config.overloadMaxAttempts = overloadMax;
  if (overloadBase != null) config.overloadBaseDelaySeconds = overloadBase;
  if (overloadCap != null) config.overloadMaxDelaySeconds = overloadCap;
  if (defaultMaxTokens != null) config.defaultMaxTokens = defaultMaxTokens;
  if (defaultEffort) config.defaultEffort = defaultEffort;
  if (aliases && Object.keys(aliases).length) config.aliases = aliases;
  if (Object.keys(poolOptions).length) config.pool = poolOptions;
  return config;
}

function readUsage(file: string): Array<Record<string, string | number | null>> {
  if (!fs.existsSync(file)) return [];
  const stat = fs.lstatSync(file);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("usage database could not be read");
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(file, { readOnly: true });
    return db
      .prepare(`SELECT ${USAGE_COLUMNS.join(", ")} FROM usage ORDER BY id`)
      .all() as Array<Record<string, string | number | null>>;
  } catch {
    throw new Error("usage database could not be read");
  } finally {
    db?.close();
  }
}

function writeUsage(file: string, rows: Array<Record<string, string | number | null>>): number {
  if (rows.length === 0 && !fs.existsSync(file)) return 0;
  const store = new UsageStore(file);
  const placeholders = USAGE_COLUMNS.map(() => "?").join(", ");
  const compare = USAGE_COLUMNS.map((column) => `${column} IS ?`).join(" AND ");
  const statement = store.db.prepare(
    `INSERT INTO usage (${USAGE_COLUMNS.join(", ")}) SELECT ${placeholders} WHERE NOT EXISTS (SELECT 1 FROM usage WHERE ${compare})`,
  );
  let inserted = 0;
  try {
    store.db.exec("BEGIN");
    for (const row of rows) {
      const values = USAGE_COLUMNS.map((column) => row[column] ?? null);
      const result = statement.run(...values, ...values);
      inserted += Number(result.changes ?? 0);
    }
    store.db.exec("COMMIT");
    return inserted;
  } catch {
    try {
      store.db.exec("ROLLBACK");
    } catch {
      /* the transaction may already be closed */
    }
    throw new Error("usage database could not be read");
  } finally {
    store.close();
  }
}

function snapshotFields(account: Account, original: Record<string, string>): Record<string, string> {
  return {
    ...original,
    account_id: account.id,
    email: account.email,
    name: String(account.notes.name ?? original.name ?? ""),
    access_token: account.accessToken,
    refresh_token: account.refreshToken,
    expires_at_ms: account.expiresAt ? String(account.expiresAt) : (original.expires_at_ms ?? ""),
    plan: String(account.notes.plan ?? original.plan ?? ""),
    device_mid: String(account.notes.device_mid ?? original.device_mid ?? ""),
  };
}

function snapshotFileName(account: Account, used: Set<string>): string {
  const label = (account.email || account.id || "account").replace(/[^A-Za-z0-9._@-]+/g, "_").replace(/^_+|_+$/g, "") || "account";
  let name = `${label}.txt`;
  if (used.has(name)) name = `${label}.${account.id.replace(/[^A-Za-z0-9._@-]+/g, "_")}.txt`;
  used.add(name);
  return name;
}

function remember(file: string, undo: Undo[], write: () => void) {
  const had = fs.existsSync(file);
  const prev = had ? fs.readFileSync(file) : null;
  const mode = had ? fs.statSync(file).mode : 0;
  write();
  undo.push(() => {
    if (had && prev) fs.writeFileSync(file, prev, { mode });
    else fs.rmSync(file, { force: true });
  });
}

interface PreparedAccount {
  account: Account;
  file: string;
  fields: Record<string, string>;
}

function prepareAccounts(root: string, options: DecryptOptions, accountsSkipped: MigrateSkip[], sealed: string[], skipped: MigrateSkip[]): PreparedAccount[] {
  const directory = path.join(root, "accounts");
  if (!fs.existsSync(directory)) return [];
  const prepared: PreparedAccount[] = [];
  const byId = new Map<string, PreparedAccount>();
  for (const name of fs.readdirSync(directory).sort()) {
    const full = path.join(directory, name);
    const rel = `accounts/${name}`;
    const stat = fs.lstatSync(full);
    if (stat.isSymbolicLink()) {
      skipped.push({ path: rel, reason: "symlink skipped" });
      continue;
    }
    if (stat.isDirectory()) {
      accountsSkipped.push({ path: rel, reason: "nested account files are not imported" });
      continue;
    }
    if (!name.endsWith(".txt") || !stat.isFile()) continue;
    const fields = parseSnapshot(fs.readFileSync(full, "utf8"));
    if (!fields.access_token) {
      accountsSkipped.push({ path: rel, reason: "missing access_token" });
      continue;
    }
    if (fields.expires_at_ms && !/^\d+$/.test(fields.expires_at_ms)) {
      accountsSkipped.push({ path: rel, reason: "bad expires_at_ms" });
      continue;
    }
    const account = accountFromFields(fields, name);
    if (!account) {
      accountsSkipped.push({ path: rel, reason: "missing access_token" });
      continue;
    }
    if (account.accessToken.startsWith("enc:v1:")) {
      try {
        const plain = decryptCredential(account.accessToken, options);
        if (typeof plain !== "string" || !plain) throw new Error("sealed");
        account.accessToken = plain;
      } catch {
        sealed.push(rel);
      }
    }
    prepared.push({ account, file: name, fields });
  }
  const winners: PreparedAccount[] = [];
  for (const item of prepared) {
    const prev = byId.get(item.account.id);
    if (!prev || item.account.expiresAt > prev.account.expiresAt) {
      if (prev) accountsSkipped.push({ path: `accounts/${prev.file}`, reason: "older snapshot for the same account" });
      byId.set(item.account.id, item);
    } else {
      accountsSkipped.push({ path: `accounts/${item.file}`, reason: "older snapshot for the same account" });
    }
  }
  for (const item of byId.values()) winners.push(item);
  return winners;
}

function readOptionalFile(root: string, rel: string): Buffer | null {
  const full = path.join(root, rel);
  if (!fs.existsSync(full)) return null;
  const stat = fs.lstatSync(full);
  if (stat.isSymbolicLink() || !stat.isFile()) return null;
  return fs.readFileSync(full);
}

/**
 * Copy a legacy install or backup zip into a new data directory.
 * The source is only read. Generator proxies, inboxes, and claim results are not imported.
 * A failed write deletes a destination this call created, or restores files this call replaced.
 */
export function migrateLegacy(options: MigrateOptions): MigrateResult {
  const sourceInput = path.resolve(options.source);
  const destination = path.resolve(options.destination);
  if (!fs.existsSync(sourceInput)) throw new Error("source is missing");
  const sourceStat = fs.lstatSync(sourceInput);
  if (sourceStat.isSymbolicLink()) throw new Error("source is missing");
  if (sameOrInside(sourceInput, destination) || sameOrInside(destination, sourceInput)) {
    throw new Error("source and destination must be separate directories");
  }
  if (fs.existsSync(destination) && !fs.statSync(destination).isDirectory()) throw new Error("destination is not a directory");
  const backupDir = path.resolve(options.backupDir ?? fs.mkdtempSync(path.join(os.tmpdir(), "azc-source-backup-")));
  if (
    sameOrInside(sourceInput, backupDir) ||
    sameOrInside(backupDir, sourceInput) ||
    sameOrInside(destination, backupDir) ||
    sameOrInside(backupDir, destination)
  ) {
    throw new Error("backup directory must be outside the source and the destination");
  }

  const skipped: MigrateSkip[] = [];
  const accountsSkipped: MigrateSkip[] = [];
  const sealed: string[] = [];
  let readRoot = sourceInput;
  let extractDir: string | null = null;
  if (sourceStat.isFile()) {
    if (!sourceInput.endsWith(".zip")) throw new Error("source file must be a .zip backup");
    fs.mkdirSync(backupDir, { recursive: true });
    const backupZip = path.join(backupDir, path.basename(sourceInput));
    fs.copyFileSync(sourceInput, backupZip);
    extractDir = fs.mkdtempSync(path.join(os.tmpdir(), "azc-zip-"));
    try {
      extractZip(backupZip, extractDir);
    } catch (error) {
      fs.rmSync(extractDir, { recursive: true, force: true });
      throw error;
    }
    readRoot = extractDir;
  } else if (!sourceStat.isDirectory()) {
    throw new Error("source is missing");
  } else {
    copyPortableTree(sourceInput, backupDir, skipped);
    readRoot = backupDir;
  }

  try {
    const configText = readOptionalFile(readRoot, "config.yaml");
    let parsed: Record<string, unknown> = {};
    if (configText) {
      try {
        parsed = parseConfigYaml(configText.toString("utf8"));
      } catch {
        throw new Error("config.yaml could not be parsed");
      }
    }
    const config = mapConfig(parsed, skipped);
    const accounts = prepareAccounts(
    readRoot,
    options.credentialSecret ? { secret: options.credentialSecret } : {},
    accountsSkipped,
    sealed,
    skipped,
  );
    const relay = readOptionalFile(readRoot, "generator-data/relays.json") ?? readOptionalFile(readRoot, "relays.json");
    const caps = readOptionalFile(readRoot, "model-caps.json");
    const usage = readUsage(path.join(readRoot, "gateway.db"));
    if (extractDir) {
      const noteSkipped = (rel: string) => {
        if (!isGeneratorPath(rel) || rel.endsWith("/")) return;
        skipped.push({ path: rel, reason: generatorReason(rel) });
      };
      const walkExtract = (current: string) => {
        for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
          const full = path.join(current, entry.name);
          const rel = posixRel(extractDir!, full);
          if (entry.isDirectory()) walkExtract(full);
          else noteSkipped(rel);
        }
      };
      walkExtract(extractDir);
    }

    const createdDest = !fs.existsSync(destination);
    const undo: Undo[] = [];
    fs.mkdirSync(destination, { recursive: true });
    try {
      const configFile = path.join(destination, "config.json");
      remember(configFile, undo, () => {
        fs.writeFileSync(configFile, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
        fs.chmodSync(configFile, 0o600);
      });
      const accountsImported: string[] = [];
      const accountsKept: string[] = [];
      const existing = new Map(loadAccountsDir(path.join(destination, "accounts")).map((account) => [account.id, account]));
      const used = new Set<string>();
      const accountsDir = path.join(destination, "accounts");
      for (const item of accounts) {
        const prev = existing.get(item.account.id);
        if (prev && item.account.expiresAt <= prev.expiresAt) {
          accountsKept.push(item.account.id);
          continue;
        }
        fs.mkdirSync(accountsDir, { recursive: true });
        const file = path.join(accountsDir, snapshotFileName(item.account, used));
        remember(file, undo, () => {
          writeSnapshotAtomic(file, snapshotFields(item.account, item.fields));
          fs.chmodSync(file, 0o600);
        });
        accountsImported.push(item.account.id);
      }
      if (options.crashAfter === "accounts") throw new Error("migration stopped for rollback");
      let relaysCopied = false;
      if (relay) {
        const file = path.join(destination, "relays.json");
        remember(file, undo, () => {
          fs.writeFileSync(file, relay, { mode: 0o600 });
          fs.chmodSync(file, 0o600);
        });
        relaysCopied = true;
      }
      let modelCapsCopied = false;
      if (caps) {
        const file = path.join(destination, "model-caps.json");
        remember(file, undo, () => {
          fs.writeFileSync(file, caps, { mode: 0o600 });
        });
        modelCapsCopied = true;
      }
      const usageRows = writeUsage(path.join(destination, "gateway.db"), usage);
      return {
        backupDir,
        configFile,
        config,
        accountsImported,
        accountsSkipped,
        accountsKept,
        usageRows,
        relaysCopied,
        modelCapsCopied,
        sealed,
        skipped,
      };
    } catch (error) {
      if (createdDest) fs.rmSync(destination, { recursive: true, force: true });
      else for (const step of undo.reverse()) step();
      throw error;
    }
  } finally {
    if (extractDir) fs.rmSync(extractDir, { recursive: true, force: true });
  }
}

export function publicMigration(result: MigrateResult) {
  const { adminKey, clientKeys, ...rest } = result.config;
  return {
    backupDir: result.backupDir,
    configFile: result.configFile,
    accountsImported: result.accountsImported,
    accountsSkipped: result.accountsSkipped,
    accountsKept: result.accountsKept,
    usageRows: result.usageRows,
    relaysCopied: result.relaysCopied,
    modelCapsCopied: result.modelCapsCopied,
    sealed: result.sealed,
    skipped: result.skipped,
    config: {
      ...rest,
      admin_key_hint: adminKey ? `…${adminKey.slice(-4)}` : "",
      client_keys: (clientKeys ?? []).map((entry) => ({ name: entry.name, hint: `…${entry.key.slice(-4)}`, rpm: entry.rpm })),
    },
  };
}

