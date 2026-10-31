import { createDecipheriv, createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseSnapshot, writeSnapshotAtomic } from "./snapshots.ts";

export interface CredentialFields {
  account_id: string;
  email: string;
  name: string;
  access_token: string;
  expires_at_ms: string;
  source: string;
  captured_at: string;
  device_mid?: string;
}

export interface ImportResult {
  written: number;
  files: string[];
  new_ids: string[];
  emails: string[];
  updated: number;
}

export interface DecryptOptions {
  secret?: string;
  platform?: string;
  home?: string;
  user?: string;
}

export function decryptAesGcm(key: Buffer, nonce: Buffer, ciphertext: Buffer, tag: Buffer): Buffer {
  if (key.length !== 32 || nonce.length !== 12 || tag.length !== 16) {
    throw new Error("Invalid ZCode credential cipher parameters");
  }
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, nonce);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    throw new Error("ZCode credential authentication failed");
  }
}

export function credentialKey(options: DecryptOptions = {}): Buffer {
  const supplied = (options.secret ?? process.env.ZCODE_CREDENTIAL_SECRET ?? "").trim();
  const platform = options.platform ?? process.platform;
  const secret = supplied || `zcode-credential-fallback:${platform}:${options.home ?? os.homedir()}:${options.user ?? os.userInfo().username}`;
  return createHash("sha256").update(secret, "utf8").digest();
}

function decodeUrl(part: string): Buffer {
  return Buffer.from(part, "base64url");
}

export function decryptCredential(value: unknown, options: DecryptOptions = {}): unknown {
  if (typeof value !== "string" || !value.startsWith("enc:v1:")) return value;
  const parts = value.slice("enc:v1:".length).split(".");
  if (parts.length !== 3) throw new Error("Invalid ZCode credential format");
  try {
    const [iv, tag, ciphertext] = parts.map((part) => decodeUrl(part!)) as [Buffer, Buffer, Buffer];
    return decryptAesGcm(credentialKey(options), iv, ciphertext, tag).toString("utf8");
  } catch {
    throw new Error("Cannot decrypt ZCode credentials; use Login with Zcode or set ZCODE_CREDENTIAL_SECRET");
  }
}

export function jwtClaims(token: string): Record<string, unknown> {
  const raw = token.replace(/^workos:/, "");
  const pieces = raw.split(".");
  if (pieces.length !== 3) return {};
  try {
    const claims = JSON.parse(Buffer.from(pieces[1]!, "base64url").toString("utf8"));
    return claims && typeof claims === "object" ? claims : {};
  } catch {
    return {};
  }
}

export function readDeviceMid(file: string): string | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
    const value = parsed?.deviceMid;
    if (typeof value !== "string" || !value.trim()) return null;
    if ([...value].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) >= 127)) return null;
    return value;
  } catch {
    return null;
  }
}

function asUser(value: unknown): Record<string, string> {
  if (typeof value === "string") {
    try {
      return asUser(JSON.parse(value));
    } catch {
      return {};
    }
  }
  if (!value || typeof value !== "object") return {};
  const record = value as Record<string, unknown>;
  return {
    email: typeof record.email === "string" ? record.email : "",
    name: typeof record.name === "string" ? record.name : "",
  };
}

export function readCredentials(file: string, options: DecryptOptions = {}): CredentialFields[] {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    throw new Error("credentials file not found");
  }
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(text.replace(/^\uFEFF/, ""));
  } catch {
    throw new Error("credentials file is not JSON");
  }
  const deviceMid = readDeviceMid(path.join(path.dirname(file), "telemetry-state.json"));
  const token = decryptCredential(data.zcodejwttoken || data.zcodeJWT, options);
  const user = asUser(decryptCredential(data["oauth:zai:user_info"], options) || data.user || {});
  const tokenText = typeof token === "string" ? token : "";
  const current = tokenText ? jwtClaims(tokenText) : {};
  const currentId = String(current.user_id || current.sub || "");
  const candidates = tokenText ? [tokenText] : [];
  for (const [key, value] of Object.entries(data)) {
    if (key.startsWith("account-provider:coding-plan:account:") && key.endsWith(":api-key")) {
      const decrypted = decryptCredential(value, options);
      if (typeof decrypted === "string") candidates.push(decrypted);
    }
  }
  const accounts = new Map<string, CredentialFields & { iat: number }>();
  for (const candidate of candidates) {
    if (!candidate || candidate.split(".").length !== 3) continue;
    const claims = jwtClaims(candidate);
    const ident = String(claims.user_id || claims.sub || "");
    if (!ident) continue;
    const accountUser = ident === currentId ? user : { email: "", name: "" };
    const iat = Number(claims.iat || 0);
    const fields: CredentialFields & { iat: number } = {
      account_id: ident,
      email: accountUser.email,
      name: accountUser.name,
      access_token: candidate,
      expires_at_ms: String(Number(claims.exp || 0) * 1000),
      source: file,
      captured_at: new Date().toISOString(),
      iat,
    };
    if (deviceMid) fields.device_mid = deviceMid;
    const previous = accounts.get(ident);
    if (!previous || iat > previous.iat) accounts.set(ident, fields);
  }
  return [...accounts.values()].map(({ iat: _iat, ...fields }) => fields);
}

function safeName(email: string, fallback: string): string {
  const stripped = (email || fallback || "account").replace(/[^A-Za-z0-9._@-]+/g, "_").replace(/^[._]+|[._]+$/g, "");
  return `${stripped || "account"}.txt`;
}

function snapshotFilename(email: string, accountId: string, used: Map<string, string>): string {
  let name = safeName(email, accountId);
  const owner = used.get(name);
  if (owner != null && owner !== accountId) {
    const stem = name.slice(0, -".txt".length);
    const suffix = (accountId || "x").replaceAll("/", "_").slice(0, 16);
    name = `${stem}.${suffix}.txt`;
    let n = 2;
    while (used.has(name) && used.get(name) !== accountId) {
      name = `${stem}.${suffix}.${n}.txt`;
      n += 1;
    }
  }
  return name;
}

export function importCredentials(file: string, outputDir: string, options: DecryptOptions = {}): ImportResult {
  fs.mkdirSync(outputDir, { recursive: true });
  const used = new Map<string, string>();
  for (const name of fs.readdirSync(outputDir).filter((item) => item.endsWith(".txt"))) {
    used.set(name, parseSnapshot(fs.readFileSync(path.join(outputDir, name), "utf8")).account_id ?? "");
  }
  const known = new Set(used.values());
  const files: string[] = [];
  const newIds: string[] = [];
  const emails: string[] = [];
  for (const fields of readCredentials(file, options)) {
    const name = snapshotFilename(fields.email, fields.account_id, used);
    used.set(name, fields.account_id);
    writeSnapshotAtomic(path.join(outputDir, name), fields);
    files.push(name);
    if (!known.has(fields.account_id)) newIds.push(fields.account_id);
    if (fields.email) emails.push(fields.email);
  }
  return { written: files.length, files, new_ids: newIds, emails, updated: files.length - newIds.length };
}
