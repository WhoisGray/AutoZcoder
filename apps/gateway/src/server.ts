import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import { Account } from "../../../packages/pool/src/account.ts";
import { importCredentials, readCredentials } from "../../../packages/pool/src/credentials.ts";
import { accountFromFields, writeSnapshotAtomic } from "../../../packages/pool/src/snapshots.ts";
import { UNSUPPORTED_FEATURE_MESSAGE, openaiError } from "../../../packages/protocols/src/index.ts";
import { ChatService, estimateTokens, failureBody, makeConfig, type ChatFailure, type GatewayConfig } from "./service.ts";
import { DeviceLogin, fetchLoginClient, type LoginClient } from "./login.ts";

const SSE_HEADERS = {
  "content-type": "text/event-stream; charset=utf-8",
  "cache-control": "no-cache",
  connection: "keep-alive",
  "x-accel-buffering": "no",
};

const UNSUPPORTED = [
  /^\/admin\/accounts\/[^/]+\/claim(?:100m|500m|_start)$/,
  /^\/admin\/claims(?:\/|$)/,
  /^\/admin\/dash\/generator(?:\/|$)/,
  /^\/admin\/dash\/proxy(?:\/|$)/,
  /^\/admin\/dash\/setup(?:\/|$)/,
  /^\/dash\/proxy(?:\/|$)/,
];

function same(a: string, b: string): boolean {
  const left = createHash("sha256").update(a, "utf8").digest();
  const right = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(left, right);
}

function bearer(req: IncomingMessage): string {
  const header = req.headers.authorization ?? "";
  if (header.toLowerCase().startsWith("bearer ")) return header.slice(7).trim();
  const apiKey = req.headers["x-api-key"];
  return (Array.isArray(apiKey) ? apiKey[0] : apiKey ?? "").trim();
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
  });
  res.end(payload);
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 20 * 1024 * 1024) throw new Error("request body exceeds 20 MB");
    chunks.push(buffer);
  }
  if (size === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function validMessages(messages: unknown): boolean {
  return Array.isArray(messages) && messages.length > 0 && messages.every((message) => message && typeof message === "object" && typeof (message as { role?: unknown }).role === "string");
}

export interface GatewayApp {
  config: GatewayConfig;
  service: ChatService;
  logs: string[];
  loginClient?: LoginClient;
}

export function createGateway(app: GatewayApp) {
  const { config, service } = app;
  let activeLogin: DeviceLogin | null = null;
  const log = (line: string) => {
    app.logs.push(`${new Date().toISOString()} ${line}`);
    if (app.logs.length > 200) app.logs.shift();
  };

  function clientName(req: IncomingMessage): string | ChatFailure {
    if (!config.requireClientKey) return "anonymous";
    const supplied = bearer(req);
    if (!supplied) return { ok: false, status: 401, code: "invalid_api_key", message: "missing API key" };
    if (same(config.adminKey, supplied)) return "admin";
    for (const entry of config.clientKeys) {
      if (same(entry.key, supplied)) return entry.name;
    }
    return { ok: false, status: 401, code: "invalid_api_key", message: "invalid API key" };
  }

  function requireAdmin(req: IncomingMessage): ChatFailure | null {
    const supplied = bearer(req);
    if (supplied && same(config.adminKey, supplied)) return null;
    return { ok: false, status: 403, code: "permission_denied", message: "invalid admin key" };
  }

  return createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const path = url.pathname;
    try {
      if (UNSUPPORTED.some((pattern) => pattern.test(path))) {
        sendJson(res, 410, openaiError(410, "feature_not_supported", UNSUPPORTED_FEATURE_MESSAGE));
        return;
      }
      if (req.method === "GET" && path === "/") {
        sendJson(res, 200, {
          name: "zcode-gateway",
          version: "2.0.0-rewrite.0",
          dialects: {
            openai: ["POST /v1/chat/completions", "POST /v1/completions", "GET /v1/models"],
            anthropic: ["POST /v1/messages", "POST /v1/messages/count_tokens"],
          },
          unsupported: ["account generation", "CAPTCHA solving", "promotional credit claims"],
        });
        return;
      }
      if (req.method === "GET" && path === "/health") {
        sendJson(res, 200, { status: "ok" });
        return;
      }
      if (req.method === "GET" && path === "/ready") {
        const ready = service.pool.readyCount();
        sendJson(res, ready ? 200 : 503, { ready: ready > 0, accounts_ready: ready });
        return;
      }
      if (req.method === "GET" && path === "/metrics") {
        const since = url.searchParams.get("since");
        const window = since == null ? 86400 : Number(since) || null;
        sendJson(res, 200, {
          pool: service.pool.snapshot(),
          usage: service.store.summary(window),
          usage_window_s: window,
        });
        return;
      }
      if (req.method === "GET" && (path === "/v1/models" || path === "/models")) {
        const auth = clientName(req);
        if (typeof auth !== "string") return sendJson(res, auth.status, failureBody("openai", auth));
        sendJson(res, 200, { object: "list", data: service.registry.catalogue() });
        return;
      }
      if (req.method === "POST" && path === "/admin/accounts/login") {
        const denied = requireAdmin(req);
        if (denied) return sendJson(res, denied.status, { detail: denied.message });
        if (!config.accountsDir) return sendJson(res, 500, { detail: "accounts directory is not configured" });
        const login = new DeviceLogin({
          accountsDir: config.accountsDir,
          client: app.loginClient ?? fetchLoginClient(),
          baseUrl: config.upstreamBaseUrl,
          fingerprint: config.fingerprint,
          onAccount: (account) => {
            service.pool.upsert(account);
          },
        });
        activeLogin = login;
        const status = await login.start();
        log(`device login ${status.state}`);
        sendJson(res, status.state === "error" ? 502 : 200, status);
        return;
      }
      if (req.method === "GET" && path === "/admin/accounts/login") {
        const denied = requireAdmin(req);
        if (denied) return sendJson(res, denied.status, { detail: denied.message });
        sendJson(res, 200, activeLogin ? activeLogin.status() : { state: "idle", verification_url: null, error: null, email: null, expires_at: 0 });
        return;
      }
      if (req.method === "POST" && path === "/admin/accounts/login/cancel") {
        const denied = requireAdmin(req);
        if (denied) return sendJson(res, denied.status, { detail: denied.message });
        activeLogin?.cancel();
        log("device login cancel requested");
        sendJson(res, 200, activeLogin ? activeLogin.status() : { state: "idle", verification_url: null, error: null, email: null, expires_at: 0 });
        return;
      }
      if (req.method === "GET" && path === "/admin/accounts") {
        const denied = requireAdmin(req);
        if (denied) return sendJson(res, denied.status, { detail: denied.message });
        sendJson(res, 200, { accounts: service.pool.accounts.map((account) => account.toPublic()) });
        return;
      }
      if (req.method === "POST" && path === "/admin/accounts") {
        const denied = requireAdmin(req);
        if (denied) return sendJson(res, denied.status, { detail: denied.message });
        const fields = (await readJson(req)) as Record<string, string>;
        const account = accountFromFields(
          Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, String(value ?? "")])),
        );
        if (!account) return sendJson(res, 400, { detail: "access_token is required" });
        if (config.accountsDir) {
          const name = `${(account.email || account.id).replace(/[^A-Za-z0-9._@-]+/g, "_")}.txt`;
          writeSnapshotAtomic(`${config.accountsDir}/${name}`, {
            account_id: account.id,
            email: account.email,
            access_token: account.accessToken,
            refresh_token: account.refreshToken,
            expires_at_ms: String(account.expiresAt || ""),
          });
          account.notes.file = name;
        }
        service.pool.upsert(account);
        log(`imported account ${account.id}`);
        sendJson(res, 200, { account: account.toPublic() });
        return;
      }
      if (req.method === "POST" && path === "/admin/accounts/import") {
        const denied = requireAdmin(req);
        if (denied) return sendJson(res, denied.status, { detail: denied.message });
        if (!config.accountsDir) return sendJson(res, 500, { detail: "accounts directory is not configured" });
        const body = (await readJson(req)) as { path?: string };
        const requested = typeof body.path === "string" && body.path.trim() ? body.path.trim() : path.join(os.homedir(), ".zcode", "v2", "credentials.json");
        const file = requested === "~" ? os.homedir() : requested.startsWith("~/") ? path.join(os.homedir(), requested.slice(2)) : requested;
        try {
          const result = importCredentials(file, config.accountsDir);
          for (const fields of readCredentials(file)) {
            const account = accountFromFields(fields, `${fields.account_id}.txt`);
            if (!account) continue;
            account.source = "credentials";
            service.pool.upsert(account);
          }
          log(`imported ${result.written} credential account(s)`);
          sendJson(res, 200, result);
        } catch (error) {
          const message = error instanceof Error ? error.message : "cannot import credentials";
          sendJson(res, message === "credentials file not found" ? 404 : 400, { detail: message });
        }
        return;
      }
      const accountMatch = /^\/admin\/accounts\/([^/]+)$/.exec(path);
      if (req.method === "DELETE" && accountMatch) {
        const denied = requireAdmin(req);
        if (denied) return sendJson(res, denied.status, { detail: denied.message });
        sendJson(res, 200, { removed: service.pool.remove(decodeURIComponent(accountMatch[1]!)) });
        return;
      }
      const enableMatch = /^\/admin\/accounts\/([^/]+)\/enable$/.exec(path);
      if (req.method === "POST" && enableMatch) {
        const denied = requireAdmin(req);
        if (denied) return sendJson(res, denied.status, { detail: denied.message });
        const account = service.pool.accounts.find((item) => item.id === decodeURIComponent(enableMatch[1]!));
        if (!account) return sendJson(res, 404, { detail: "account not found" });
        account.state = "ready";
        account.cooldownUntil = 0;
        account.modelCaps = {};
        sendJson(res, 200, { account: account.toPublic() });
        return;
      }
      if (req.method === "GET" && path === "/admin/pool/state") {
        const denied = requireAdmin(req);
        if (denied) return sendJson(res, denied.status, { detail: denied.message });
        sendJson(res, 200, service.pool.snapshot());
        return;
      }
      if (req.method === "GET" && path === "/admin/stats") {
        const denied = requireAdmin(req);
        if (denied) return sendJson(res, denied.status, { detail: denied.message });
        sendJson(res, 200, service.store.summary(86400));
        return;
      }
      if (req.method === "GET" && path === "/admin/dash/settings") {
        const denied = requireAdmin(req);
        if (denied) return sendJson(res, denied.status, { detail: denied.message });
        sendJson(res, 200, {
          host: config.host,
          port: config.port,
          require_client_key: config.requireClientKey,
          admin_key_hint: `…${config.adminKey.slice(-4)}`,
          client_keys: config.clientKeys.map((entry) => ({ name: entry.name, hint: `…${entry.key.slice(-4)}`, rpm: entry.rpm })),
          strategy: config.pool.strategy ?? "drain_first",
          upstream: config.upstreamBaseUrl,
          generator: { supported: false, reason: UNSUPPORTED_FEATURE_MESSAGE },
        });
        return;
      }
      if (req.method === "GET" && path === "/admin/dash/logs") {
        const denied = requireAdmin(req);
        if (denied) return sendJson(res, denied.status, { detail: denied.message });
        sendJson(res, 200, { lines: app.logs });
        return;
      }
      if (req.method === "POST" && (path === "/v1/chat/completions" || path === "/v1/completions" || path === "/v1/messages" || path === "/v1/messages/count_tokens")) {
        const dialect = path.startsWith("/v1/messages") ? "anthropic" : "openai";
        const auth = clientName(req);
        if (typeof auth !== "string") return sendJson(res, auth.status, failureBody(dialect, auth));
        const body = (await readJson(req)) as Record<string, any>;
        if (body.model != null && typeof body.model !== "string") {
          return sendJson(res, 400, failureBody(dialect, { ok: false, status: 400, code: "invalid_request_error", message: "model must be a string" }));
        }
        if (path === "/v1/messages/count_tokens") {
          if (!validMessages(body.messages)) {
            return sendJson(res, 400, failureBody(dialect, { ok: false, status: 400, code: "invalid_request_error", message: "'messages' must be a non-empty list of message objects" }));
          }
          const model = service.registry.resolve(body.model, "anthropic");
          sendJson(res, 200, { input_tokens: estimateTokens(body, model) });
          return;
        }
        let chatBody = body;
        if (path === "/v1/completions") {
          const prompt = Array.isArray(body.prompt) ? body.prompt.map(String).join("\n") : String(body.prompt ?? "");
          chatBody = { model: body.model, messages: [{ role: "user", content: prompt }], stream: Boolean(body.stream), max_tokens: body.max_tokens };
        }
        const messages = chatBody.messages;
        if (!validMessages(messages)) {
          return sendJson(res, 400, failureBody(dialect, { ok: false, status: 400, code: "invalid_request_error", message: "'messages' is required and must be a non-empty list of message objects" }));
        }
        const model = service.registry.resolve(chatBody.model, dialect);
        const payload = dialect === "anthropic" ? { model, _anthropic: { ...chatBody, model } } : { ...chatBody, model };
        const controller = new AbortController();
        const onClientGone = () => {
          if (!res.writableFinished) controller.abort();
        };
        res.on("close", onClientGone);
        const result = await service.execute(payload, model, dialect, auth, {
          stream: Boolean(chatBody.stream),
          signal: controller.signal,
        });
        res.off("close", onClientGone);
        if (controller.signal.aborted || (!result.ok && result.code === "client_disconnected")) {
          res.destroy();
          return;
        }
        if (!result.ok) return sendJson(res, result.status, failureBody(dialect, result));
        const wantsStream = Boolean(chatBody.stream);
        if (!wantsStream && path !== "/v1/completions") {
          sendJson(res, 200, dialect === "anthropic" ? result.anthropic : result.openaiCompletion);
          return;
        }
        if (!wantsStream && path === "/v1/completions") {
          const choice = result.openaiCompletion.choices?.[0] ?? {};
          sendJson(res, 200, {
            id: String(result.openaiCompletion.id || "").replace("chatcmpl-", "cmpl-"),
            object: "text_completion",
            created: result.openaiCompletion.created,
            model: result.openaiCompletion.model,
            choices: [{ index: 0, text: choice.message?.content || "", finish_reason: choice.finish_reason || "stop" }],
            usage: result.openaiCompletion.usage ?? {},
          });
          return;
        }
        res.writeHead(200, SSE_HEADERS);
        if (dialect === "anthropic") {
          res.end(anthropicSse(result.anthropic));
          return;
        }
        res.end(result.openaiSse);
        return;
      }
      sendJson(res, 404, { detail: "not found" });
    } catch (error) {
      log(`request failed on ${path}`);
      const dialect = path.startsWith("/v1/messages") ? "anthropic" : "openai";
      const message = error instanceof SyntaxError ? "request body must be JSON" : "internal error";
      if (path.startsWith("/v1/")) sendJson(res, 400, failureBody(dialect, { ok: false, status: 400, code: "invalid_request_error", message }));
      else sendJson(res, 500, { detail: message });
    }
  });
}

function anthropicSse(message: Record<string, any>): string {
  const events = [
    { type: "message_start", message: { ...message, content: [] } },
    ...((message.content ?? []) as Record<string, any>[]).flatMap((block, index) => {
      const start = { type: "content_block_start", index, content_block: block.type === "text" ? { type: "text", text: "" } : block };
      const delta =
        block.type === "text"
          ? { type: "content_block_delta", index, delta: { type: "text_delta", text: block.text ?? "" } }
          : null;
      const stop = { type: "content_block_stop", index };
      return delta ? [start, delta, stop] : [start, stop];
    }),
    {
      type: "message_delta",
      delta: { stop_reason: message.stop_reason ?? "end_turn", stop_sequence: null },
      usage: message.usage ?? { input_tokens: 0, output_tokens: 0 },
    },
    { type: "message_stop" },
  ];
  return events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
}

export function listen(app: GatewayApp) {
  const server = createGateway(app);
  return new Promise<ReturnType<typeof createGateway>>((resolve) => {
    server.listen(app.config.port, app.config.host, () => resolve(server));
  });
}

export { makeConfig, Account };
