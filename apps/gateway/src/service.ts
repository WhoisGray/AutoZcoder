import { randomUUID } from "node:crypto";
import {
  MessageAccumulator,
  OpenAITranslator,
  Registry,
  aggregateOpenaiStream,
  anthropicError,
  buildBody,
  buildHeaders,
  defaultFingerprint,
  isBlockCode,
  isModelOverload,
  modelCaps,
  openaiError,
  overloadDelay,
  parseSseEvents,
  parseUpstreamError,
  requestToOpenai,
  retryAfterSeconds,
  sseEvent,
  sseFrame,
  type Fingerprint,
} from "../../../packages/protocols/src/index.ts";
import { Account, PoolManager, type PoolOptions } from "../../../packages/pool/src/index.ts";
import { UsageStore } from "../../../packages/database/src/store.ts";

const STREAM_RETRIES = 2;
const PRELUDE = new Set(["message_start", "ping"]);

type Dict = Record<string, any>;

export class NoAccountsAvailable extends Error {
  constructor() {
    super("no usable Zcode account in the pool");
    this.name = "NoAccountsAvailable";
  }
}

export class UpstreamFailure extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export interface GatewayConfig {
  host: string;
  port: number;
  requireClientKey: boolean;
  adminKey: string;
  clientKeys: { key: string; name: string; rpm: number }[];
  accountsDir: string;
  upstreamBaseUrl: string;
  chatPath: string;
  maxAttempts: number;
  overloadMaxAttempts: number;
  overloadBaseDelaySeconds: number;
  overloadMaxDelaySeconds: number;
  defaultMaxTokens: number;
  defaultEffort: string;
  fingerprint: Fingerprint;
  pool: PoolOptions;
}

export interface UpstreamResponse {
  status: number;
  headers: Record<string, string>;
  text: string;
}

export interface UpstreamRequest {
  url: string;
  headers: Record<string, string>;
  body: Dict;
  signal?: AbortSignal;
}

export interface UpstreamClient {
  send(request: UpstreamRequest): Promise<UpstreamResponse>;
}

export interface ExecuteOptions {
  stream?: boolean;
  signal?: AbortSignal;
}

/** Park duration for a quota rejection. Three strikes with no bucket exhaust the account. */
export function quotaPark(
  account: Account,
  model: string,
  now = Date.now() / 1000,
): { action: "park"; seconds: number } | { action: "exhaust" } {
  const quotas = (account.notes.quotas ?? {}) as Record<string, { remaining?: number; resets_at?: number }>;
  const quota = quotas[model];
  const hasBucket = quota != null && Object.keys(quota).length > 0;
  const remaining = Number(quota?.remaining ?? 0) || 0;
  if (remaining > 0) return { action: "park", seconds: 600 };
  const resetsAt = Number(quota?.resets_at ?? 0) || 0;
  const seconds = hasBucket ? Math.max(1, resetsAt - now) : 0;
  if (seconds <= 1) {
    account.quotaStrikes += 1;
    if (account.quotaStrikes >= 3) return { action: "exhaust" };
    return { action: "park", seconds: 900 };
  }
  return { action: "park", seconds };
}

export interface ChatSuccess {
  ok: true;
  status: 200;
  accountId: string;
  anthropic: Dict;
  openaiSse: string;
  openaiCompletion: Dict;
}

export interface ChatFailure {
  ok: false;
  status: number;
  code: string;
  message: string;
}

export class ChatService {
  pool: PoolManager;
  registry: Registry;
  store: UsageStore;
  upstream: UpstreamClient;
  config: GatewayConfig;
  sleep: (ms: number) => Promise<void>;

  constructor(options: {
    pool: PoolManager;
    registry: Registry;
    store: UsageStore;
    upstream: UpstreamClient;
    config: GatewayConfig;
    sleep?: (ms: number) => Promise<void>;
  }) {
    this.pool = options.pool;
    this.registry = options.registry;
    this.store = options.store;
    this.upstream = options.upstream;
    this.config = options.config;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  private applyError(account: Account, model: string, status: number, code: string, message: string, headers: Record<string, string> = {}) {
    if (isModelOverload(status, code)) return;
    account.errorCount += 1;
    if (status === 401 || code === "authentication_error") {
      this.pool.kill(account, "ZCode token revoked; sign in again");
      return;
    }
    if (status === 405 || isBlockCode(code, status)) {
      this.pool.capModel(account, model, this.config.pool.blockedModelCooldownSeconds ?? 900, {
        code: "UNUSUAL_ACTIVITY",
        message,
      });
      return;
    }
    if (code === "11113" || code === "1005" || status === 402) {
      const plan = quotaPark(account, model);
      if (plan.action === "exhaust") {
        account.state = "exhausted";
        account.lastError = "repeated quota rejection with no visible buckets";
        return;
      }
      this.pool.capModel(account, model, plan.seconds, { code: code === "11113" ? "11113" : "1005", message });
      return;
    }
    if (status === 429 || code === "rate_limit_error") {
      const retry = Number(headerValue(headers, "retry-after") || this.config.pool.cooldownSeconds || 30);
      const seconds = Number.isFinite(retry) ? Math.min(3600, Math.max(1, retry)) : 30;
      this.pool.capModel(account, model, seconds, { code: "MODEL_CAPPED", message });
      return;
    }
    if (status === 403) {
      this.pool.capModel(account, model, 300, { code: "ENTITLEMENT_ERROR", message });
      return;
    }
    if (status === 451) {
      this.pool.capModel(account, model, 600, { code: "GEO_BLOCKED", message: message || "HTTP 451" });
      return;
    }
    if (status >= 500) this.pool.cool(account, this.config.pool.cooldownSeconds ?? 30, "upstream_error");
  }

  async execute(
    payload: Dict,
    model: string,
    dialect: "openai" | "anthropic",
    clientKey: string,
    options: ExecuteOptions = {},
  ): Promise<ChatSuccess | ChatFailure> {
    let body: Dict;
    try {
      body = buildBody(payload, this.config.defaultMaxTokens, modelCaps(model), this.config.defaultEffort);
    } catch (error) {
      return { ok: false, status: 400, code: "invalid_request_error", message: error instanceof Error ? error.message : String(error) };
    }
    const excluded = new Set<string>();
    let overloadTries = 0;
    let streamRetries = 0;
    let last: ChatFailure = { ok: false, status: 503, code: "no_accounts_available", message: "no usable Zcode account in the pool" };
    const started = Date.now();
    for (let attempt = 0; attempt < this.config.maxAttempts; attempt++) {
      if (options.signal?.aborted) return clientDisconnected();
      const account = await this.pool.acquire(model, excluded, (this.config.pool.acquireWaitSeconds ?? 0) * 1000);
      if (!account) break;
      if (options.signal?.aborted) {
        this.pool.release(account);
        return clientDisconnected();
      }
      const headers = buildHeaders(account.accessToken, this.config.fingerprint, randomUUID(), {
        deviceMid: account.notes.device_mid || undefined,
      });
      let response: UpstreamResponse;
      try {
        response = await this.upstream.send({
          url: `${this.config.upstreamBaseUrl.replace(/\/$/, "")}${this.config.chatPath}`,
          headers,
          body,
          signal: options.signal,
        });
      } catch (error) {
        this.pool.release(account);
        if (isClientAbort(error, options.signal)) return clientDisconnected();
        this.pool.cool(account, this.config.pool.cooldownSeconds ?? 30, "transport");
        excluded.add(account.id);
        last = { ok: false, status: 502, code: "transport", message: error instanceof Error ? error.message : "upstream transport error" };
        continue;
      }
      const envelope = response.status === 200 && looksLikeJsonEnvelope(response) ? parseUpstreamError(200, response.text) : null;
      const status = envelope
        ? envelope.code === "11113" || envelope.code === "1005"
          ? 429
          : isModelOverload(502, envelope.code)
            ? 529
            : 502
        : response.status;
      const info = envelope ?? (status !== 200 ? parseUpstreamError(status, response.text) : null);
      if (info) {
        this.applyError(account, model, status, info.code, info.message, response.headers);
        this.record(account, dialect, model, status, started, {}, info.code);
        this.pool.release(account);
        last = { ok: false, status, code: info.code, message: info.message };
        if (isModelOverload(status, info.code) && overloadTries + 1 < this.config.overloadMaxAttempts) {
          overloadTries += 1;
          await this.wait(
            overloadDelay(
              {
                overloadBaseDelaySeconds: this.config.overloadBaseDelaySeconds,
                overloadMaxDelaySeconds: this.config.overloadMaxDelaySeconds,
              },
              overloadTries,
              retryAfterSeconds(response.headers),
            ) * 1000,
            options.signal,
          );
          if (options.signal?.aborted) return clientDisconnected();
          attempt -= 1;
          continue;
        }
        if (rotates(status, info.code)) {
          excluded.add(account.id);
          continue;
        }
        return last;
      }
      const events = parseSseEvents(response.text).filter((event) => event && typeof event === "object") as Dict[];
      const errorIndex = events.findIndex((event) => event.type === "error" || (event.type == null && event.error));
      if (errorIndex >= 0) {
        const err = events[errorIndex]!.error ?? events[errorIndex];
        const code = String(err.code || err.type || "api_error");
        const message = String(err.message || "ZCode stream failed");
        const errorStatus = isModelOverload(502, code) ? 529 : code === "11113" || code === "rate_limit_error" ? 429 : isBlockCode(code) ? 405 : 502;
        const startedMessage = events.slice(0, errorIndex).some((event) => event.type === "message_start");
        this.applyError(account, model, errorStatus, code, message);
        this.record(account, dialect, model, errorStatus, started, {}, code);
        this.pool.release(account);
        last = { ok: false, status: errorStatus, code, message };
        if (!startedMessage) {
          excluded.add(account.id);
          continue;
        }
        return last;
      }
      const accumulator = new MessageAccumulator();
      const translator = new OpenAITranslator(model);
      const frames: string[] = [];
      try {
        for (const event of events) {
          accumulator.feed(event);
          if (dialect !== "anthropic") frames.push(...translator.feed(event).map((chunk) => sseFrame(chunk)));
          if (event.type === "message_stop") break;
        }
        if (!accumulator.stopped) throw new UpstreamFailure(502, "truncated_stream", "ZCode stream ended before message_stop");
      } catch (error) {
        const failure = error instanceof UpstreamFailure ? error : new UpstreamFailure(502, "invalid_stream", "ZCode returned an incomplete or malformed response");
        const outputStarted = events.some((event) => {
          const type = String(event.type ?? "");
          return type !== "" && !PRELUDE.has(type);
        });
        this.record(account, dialect, model, failure.status, started, {}, failure.code);
        this.pool.release(account);
        last = { ok: false, status: failure.status, code: failure.code, message: failure.message };
        const replayable = failure.code === "truncated_stream" && (!options.stream || !outputStarted);
        if (replayable && streamRetries < STREAM_RETRIES) {
          streamRetries += 1;
          attempt -= 1;
          continue;
        }
        return last;
      }
      const message = accumulator.finish();
      if (dialect !== "anthropic") frames.push("data: [DONE]\n\n");
      this.pool.onSuccess(account);
      this.record(account, dialect, model, 200, started, message.usage ?? {}, null);
      this.pool.release(account);
      const openaiSse = frames.join("");
      return {
        ok: true,
        status: 200,
        accountId: account.id,
        anthropic: message,
        openaiSse,
        openaiCompletion: aggregateOpenaiStream(openaiSse, model, `chatcmpl-${randomUUID().replace(/-/g, "").slice(0, 24)}`),
      };
    }
    if (last.code === "no_accounts_available" || excluded.size > 0 && last.status >= 500) {
      const ready = this.pool.readyCount();
      if (ready === 0) return { ok: false, status: 503, code: "no_accounts_available", message: "no usable Zcode account in the pool" };
    }
    return last;
  }

  private record(account: Account, dialect: string, model: string, status: number, started: number, usage: Dict, errorCode: string | null) {
    const prompt = Number(usage.input_tokens ?? usage.prompt_tokens ?? 0);
    const completion = Number(usage.output_tokens ?? usage.completion_tokens ?? 0);
    try {
      this.store.record({
        account_id: account.id,
        client_key: dialect,
        dialect,
        model,
        variant: "anthropic",
        stream: 1,
        status,
        duration_ms: Date.now() - started,
        prompt_tokens: prompt,
        completion_tokens: completion,
        total_tokens: prompt + completion,
        error_code: status === 200 ? null : errorCode,
      });
    } catch {
      /* persistence must not fail the request */
    }
  }

  private async wait(ms: number, signal?: AbortSignal) {
    if (ms <= 0 || signal?.aborted) return;
    if (!signal) {
      await this.sleep(ms);
      return;
    }
    let onAbort: (() => void) | undefined;
    await Promise.race([
      this.sleep(ms),
      new Promise<void>((resolve) => {
        onAbort = () => resolve();
        signal.addEventListener("abort", onAbort, { once: true });
      }),
    ]);
    signal.removeEventListener("abort", onAbort!);
  }
}

function headerValue(headers: Record<string, string>, name: string): string {
  const found = Object.entries(headers).find(([key]) => key.toLowerCase() === name);
  return found?.[1] ?? "";
}

function looksLikeJsonEnvelope(response: UpstreamResponse): boolean {
  const type = headerValue(response.headers, "content-type");
  if (type.includes("text/event-stream")) return false;
  const text = response.text.trim();
  if (!text.startsWith("{")) return false;
  if (type.includes("application/json")) return true;
  return text.includes('"code"') || text.includes('"error"');
}

function rotates(status: number, code: string): boolean {
  if (status === 401 || status === 402 || status === 403 || status === 405 || status === 429 || status === 451) return true;
  if (status >= 500) return true;
  if (code === "11113" || code === "1005") return true;
  return isBlockCode(code, status);
}

function clientDisconnected(): ChatFailure {
  return { ok: false, status: 499, code: "client_disconnected", message: "client disconnected" };
}

function isClientAbort(error: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true;
  return error instanceof Error && error.name === "AbortError";
}

export function failureBody(dialect: "openai" | "anthropic", failure: ChatFailure) {
  if (dialect === "anthropic") return anthropicError(failure.status, failure.code, failure.message);
  return openaiError(failure.status, failure.code, failure.message);
}

export function estimateTokens(body: Dict, model: string): number {
  const payload = requestToOpenai(body, model);
  let chars = 0;
  for (const message of payload.messages ?? []) {
    const content = message.content;
    if (typeof content === "string") chars += content.length;
    else if (Array.isArray(content)) {
      for (const part of content) if (typeof part?.text === "string") chars += part.text.length;
    }
  }
  for (const tool of payload.tools ?? []) chars += JSON.stringify(tool).length;
  return Math.max(1, Math.floor(chars / 4));
}

export function makeConfig(overrides: Partial<GatewayConfig> = {}): GatewayConfig {
  return {
    host: "127.0.0.1",
    port: 8788,
    requireClientKey: true,
    adminKey: "gw-admin-local",
    clientKeys: [{ key: "gw-local-1", name: "local", rpm: 0 }],
    accountsDir: "",
    upstreamBaseUrl: "https://zcode.z.ai/api/v1",
    chatPath: "/zcode-plan/anthropic/v1/messages",
    maxAttempts: 3,
    overloadMaxAttempts: 11,
    overloadBaseDelaySeconds: 2,
    overloadMaxDelaySeconds: 60,
    defaultMaxTokens: 128000,
    defaultEffort: "high",
    fingerprint: defaultFingerprint(),
    pool: { strategy: "drain_first", maxInFlightPerAccount: 4, cooldownSeconds: 30, blockedModelCooldownSeconds: 900, acquireWaitSeconds: 0 },
    ...overrides,
  };
}
