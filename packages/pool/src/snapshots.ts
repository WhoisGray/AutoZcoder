import fs from "node:fs";
import path from "node:path";
import { Account } from "./account.ts";

const LINE = /^([a-z_]+):\s*(.*)$/;

export function parseSnapshot(text: string): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const match = LINE.exec(line);
    if (match) fields[match[1]!] = match[2]!.trim();
  }
  return fields;
}

export function accountFromFields(fields: Record<string, string>, filename = ""): Account | null {
  const token = fields.access_token ?? "";
  if (!token) return null;
  const ident = fields.account_id || fields.zcode_user_id || filename.replace(/\.txt$/, "") || "account";
  let expiresAt = 0;
  if (fields.expires_at_ms) {
    if (!/^\d+$/.test(fields.expires_at_ms)) return null;
    expiresAt = Number(fields.expires_at_ms);
  }
  const account = new Account(ident);
  account.email = fields.email ?? "";
  account.accessToken = token;
  account.refreshToken = fields.refresh_token ?? "";
  account.expiresAt = expiresAt;
  account.source = filename ? `accounts/${filename}` : "snapshot";
  account.notes = {
    captured_at: fields.captured_at ?? "",
    name: fields.name ?? "",
    plan: fields.plan ?? "",
    file: filename,
    device_mid: fields.device_mid ?? "",
  };
  return account;
}

export function loadAccountsDir(directory: string): Account[] {
  if (!fs.existsSync(directory)) return [];
  const byId = new Map<string, Account>();
  for (const name of fs.readdirSync(directory).filter((item) => item.endsWith(".txt")).sort()) {
    let account: Account | null = null;
    try {
      account = accountFromFields(parseSnapshot(fs.readFileSync(path.join(directory, name), "utf8")), name);
    } catch {
      continue;
    }
    if (!account) continue;
    const prev = byId.get(account.id);
    if (!prev || account.expiresAt > prev.expiresAt) byId.set(account.id, account);
  }
  return [...byId.values()].sort((a, b) => b.expiresAt - a.expiresAt);
}

const ORDER = ["account_id", "email", "name", "access_token", "refresh_token", "expires_at_ms", "plan", "device_mid"];

export function formatSnapshot(fields: Record<string, string>): string {
  const keys = [...ORDER.filter((key) => fields[key] != null), ...Object.keys(fields).filter((key) => !ORDER.includes(key))];
  return `${keys.map((key) => `${key}: ${fields[key]}`).join("\n")}\n`;
}

export function writeSnapshotAtomic(file: string, fields: Record<string, string>) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, formatSnapshot(fields), { mode: 0o600 });
  fs.renameSync(tmp, file);
}
