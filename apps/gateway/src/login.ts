import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Account } from "../../../packages/pool/src/account.ts";
import { parseSnapshot, writeSnapshotAtomic } from "../../../packages/pool/src/snapshots.ts";
import { jwtClaims } from "../../../packages/pool/src/credentials.ts";
import { buildHeaders, defaultFingerprint, type Fingerprint } from "../../../packages/protocols/src/headers.ts";

const ALLOWED_HOSTS = new Set(["chat.z.ai", "zcode.z.ai"]);

export interface LoginResponse {
  status: number;
  json: Record<string, any>;
}

export interface LoginClient {
  request(input: { method: "GET" | "POST"; url: string; headers: Record<string, string>; body?: unknown }): Promise<LoginResponse>;
}

export interface LoginStatus {
  state: string;
  verification_url: string | null;
  error: string | null;
  email: string | null;
  expires_at: number;
}

function loginHeaders(token: string, fingerprint: Fingerprint): Record<string, string> {
  const headers = buildHeaders(token, fingerprint);
  delete headers["x-api-key"];
  return headers;
}

function snapshotName(email: string, accountId: string, used: Map<string, string>): string {
  const stripped = (email || accountId || "account").replace(/[^A-Za-z0-9._@-]+/g, "_").replace(/^[._]+|[._]+$/g, "");
  let name = `${stripped || "account"}.txt`;
  const owner = used.get(name);
  if (owner != null && owner !== accountId) {
    const stem = name.slice(0, -4);
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

export class DeviceLogin {
  state = "idle";
  error: string | null = null;
  verificationUrl: string | null = null;
  accountEmail: string | null = null;
  snapshotPath: string | null = null;
  private pollToken: string | null = null;
  private flowId: string | null = null;
  private expiresAt = 0;
  private intervalSec = 2;
  private cancelled = false;
  private tail: Promise<void> | null = null;
  private accountsDir: string;
  private client: LoginClient;
  private baseUrl: string;
  private fingerprint: Fingerprint;
  private onAccount?: (account: Account) => void | Promise<void>;
  private sleep: (ms: number) => Promise<void>;
  private now: () => number;

  constructor(options: {
    accountsDir: string;
    client: LoginClient;
    baseUrl?: string;
    fingerprint?: Fingerprint;
    onAccount?: (account: Account) => void | Promise<void>;
    sleep?: (ms: number) => Promise<void>;
    now?: () => number;
  }) {
    this.accountsDir = options.accountsDir;
    this.client = options.client;
    this.baseUrl = (options.baseUrl ?? "https://zcode.z.ai/api/v1").replace(/\/$/, "");
    this.fingerprint = options.fingerprint ?? defaultFingerprint();
    this.onAccount = options.onAccount;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.now = options.now ?? Date.now;
  }

  status(): LoginStatus {
    return {
      state: this.state,
      verification_url: this.verificationUrl,
      error: this.error,
      email: this.accountEmail,
      expires_at: this.expiresAt,
    };
  }

  cancel() {
    this.cancelled = true;
  }

  async start(): Promise<LoginStatus> {
    try {
      await this.authorize();
    } catch (error) {
      this.fail(error);
      return this.status();
    }
    this.state = "awaiting_user";
    this.tail = this.finish();
    return this.status();
  }

  async run() {
    await this.start();
    if (this.tail) await this.tail;
  }

  private async finish() {
    try {
      const data = await this.poll();
      if (!data) return;
      if (this.cancelled) {
        this.state = "cancelled";
        return;
      }
      this.state = "registering";
      const account = this.register(data);
      if (this.onAccount) await this.onAccount(account);
      this.state = "done";
    } catch (error) {
      this.fail(error);
    } finally {
      this.pollToken = null;
    }
  }

  private fail(error: unknown) {
    if (this.cancelled) {
      this.state = "cancelled";
      return;
    }
    this.state = "error";
    if (!this.error) this.error = error instanceof Error && error.message.startsWith("ZCode") ? error.message : "Login failed";
    this.pollToken = null;
  }

  private async authorize() {
    this.pollToken = randomBytes(32).toString("hex");
    const response = await this.client.request({
      method: "POST",
      url: `${this.baseUrl}/oauth/cli/init`,
      headers: loginHeaders(this.pollToken, this.fingerprint),
      body: { provider: "zai" },
    });
    if (response.status < 200 || response.status >= 300) throw new Error("ZCode did not return a valid login flow");
    const envelope = response.json ?? {};
    const data = envelope.data ?? {};
    if (envelope.code !== 0 || !data.flow_id || !data.authorize_url) throw new Error("ZCode did not return a valid login flow");
    let parsed: URL;
    try {
      parsed = new URL(String(data.authorize_url));
    } catch {
      throw new Error("ZCode returned an unexpected login URL");
    }
    if (parsed.protocol !== "https:" || !parsed.hostname || !ALLOWED_HOSTS.has(parsed.hostname)) {
      throw new Error("ZCode returned an unexpected login URL");
    }
    this.flowId = String(data.flow_id);
    this.verificationUrl = String(data.authorize_url);
    this.expiresAt = Number(data.expires_at || this.now() / 1000 + 300);
    const interval = Number(data.poll_interval_sec || 2);
    this.intervalSec = Math.max(1, Math.min(30, Number.isFinite(interval) ? interval : 2));
  }

  private async poll(): Promise<Record<string, any> | null> {
    while (this.now() / 1000 < this.expiresAt) {
      if (this.cancelled) {
        this.state = "cancelled";
        return null;
      }
      const response = await this.client.request({
        method: "GET",
        url: `${this.baseUrl}/oauth/cli/poll/${encodeURIComponent(this.flowId ?? "")}`,
        headers: loginHeaders(this.pollToken ?? "", this.fingerprint),
      });
      if (response.status < 200 || response.status >= 300) throw new Error("ZCode rejected the login poll");
      const envelope = response.json ?? {};
      if (envelope.code !== 0) throw new Error("ZCode rejected the login poll");
      const data = envelope.data ?? {};
      const status = String(data.status ?? "");
      if (status === "ready" && data.token) return data;
      if (status === "expired" || status === "cancelled" || status === "denied" || status === "error" || status === "failed") {
        this.state = status === "expired" ? "expired" : "error";
        this.error = status === "expired" ? "Login expired" : "Login was not approved";
        return null;
      }
      await this.sleep(this.intervalSec * 1000);
      if (this.cancelled) {
        this.state = "cancelled";
        return null;
      }
    }
    this.state = "expired";
    this.error = "Login expired; start again";
    return null;
  }

  private register(data: Record<string, any>): Account {
    const token = String(data.token ?? "");
    const user = data.user ?? {};
    const claims = jwtClaims(token);
    const ident = String(user.user_id || claims.user_id || claims.sub || "");
    if (!ident) throw new Error("ZCode login returned no account identity");
    const account = new Account(ident);
    account.email = String(user.email ?? "");
    account.accessToken = token;
    account.expiresAt = Number(claims.exp || 0) * 1000;
    account.source = "device-login";
    account.notes = { name: String(user.name ?? ""), device_mid: this.fingerprint.deviceMid };
    fs.mkdirSync(this.accountsDir, { recursive: true });
    const used = new Map<string, string>();
    for (const name of fs.readdirSync(this.accountsDir).filter((item) => item.endsWith(".txt"))) {
      used.set(name, parseSnapshot(fs.readFileSync(path.join(this.accountsDir, name), "utf8")).account_id ?? "");
    }
    const name = snapshotName(account.email, ident, used);
    this.snapshotPath = path.join(this.accountsDir, name);
    writeSnapshotAtomic(this.snapshotPath, {
      account_id: ident,
      email: account.email,
      name: String(user.name ?? ""),
      access_token: token,
      expires_at_ms: String(account.expiresAt),
      device_mid: this.fingerprint.deviceMid,
      source: "ZCode CLI OAuth",
    });
    account.notes.file = name;
    this.accountEmail = account.email;
    return account;
  }
}

export function fetchLoginClient(): LoginClient {
  return {
    async request(input) {
      const response = await fetch(input.url, {
        method: input.method,
        headers: input.headers,
        body: input.body == null ? undefined : JSON.stringify(input.body),
      });
      let json: Record<string, any> = {};
      try {
        json = await response.json();
      } catch {
        json = {};
      }
      return { status: response.status, json };
    },
  };
}
