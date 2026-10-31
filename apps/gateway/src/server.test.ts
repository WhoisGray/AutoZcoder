import assert from "node:assert/strict";
import { createCipheriv, createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { UsageStore } from "../../../packages/database/src/store.ts";
import { Account } from "../../../packages/pool/src/account.ts";
import { PoolManager } from "../../../packages/pool/src/router.ts";
import { Registry } from "../../../packages/protocols/src/registry.ts";
import { createGateway, makeConfig } from "./server.ts";
import { ChatService, quotaPark, type UpstreamClient, type UpstreamRequest, type UpstreamResponse } from "./service.ts";

function sse(events: Record<string, unknown>[]): string {
  return events.map((event) => `event: ${(event as { type?: string }).type ?? "message"}\ndata: ${JSON.stringify(event)}\n\n`).join("");
}

function reply(text: string, tokens = 4): UpstreamResponse {
  return {
    status: 200,
    headers: {},
    text: sse([
      { type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", model: "GLM-5.3-Flash", content: [], stop_reason: null, usage: { input_tokens: 2, output_tokens: 0 } } },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: tokens } },
      { type: "message_stop" },
    ]),
  };
}

function httpError(status: number, code: string, message: string): UpstreamResponse {
  return { status, headers: {}, text: JSON.stringify({ error: { code, message } }) };
}

async function start(
  scripts: Array<(req: UpstreamRequest) => UpstreamResponse | Promise<UpstreamResponse>>,
  options: { accounts?: Account[]; sleep?: () => Promise<void> } = {},
) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "azc-gw-"));
  const account = new Account("usr-1");
  account.email = "one@example.test";
  account.accessToken = "secret-token-zzzz";
  const calls: unknown[] = [];
  let sleeps = 0;
  const upstream: UpstreamClient = {
    async send(request) {
      calls.push(request.body);
      const next = scripts.shift();
      if (!next) throw new Error("no scripted upstream response left");
      return await next(request);
    },
  };
  const config = makeConfig({
    accountsDir: dir,
    adminKey: "admin-test-key",
    clientKeys: [{ key: "client-test-key", name: "local", rpm: 0 }],
    maxAttempts: 3,
    overloadMaxAttempts: 3,
    pool: { strategy: "drain_first", maxInFlightPerAccount: 4, cooldownSeconds: 30, blockedModelCooldownSeconds: 900, acquireWaitSeconds: 0 },
  });
  const store = new UsageStore(path.join(dir, "gateway.db"));
  const service = new ChatService({
    pool: new PoolManager(options.accounts ?? [account], config.pool),
    registry: new Registry({ aliases: { "glm-5.3-flash": "GLM-5.3-Flash" } }),
    store,
    upstream,
    config,
    sleep: options.sleep ?? (async () => {
      sleeps += 1;
    }),
  });
  const server = createGateway({ config, service, logs: [] });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  const port = address && typeof address === "object" ? address.port : 0;
  return {
    base: `http://127.0.0.1:${port}`,
    calls,
    get sleeps() {
      return sleeps;
    },
    store,
    service,
    close: () =>
      new Promise<void>((resolve, reject) => {
        store.close();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

async function post(base: string, pathname: string, body: unknown, key?: string) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (key) headers.authorization = `Bearer ${key}`;
  const response = await fetch(`${base}${pathname}`, { method: "POST", headers, body: JSON.stringify(body) });
  const text = await response.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: response.status, json, text, headers: response.headers };
}

test("auth errors use the client dialect and models require a key", async () => {
  const gw = await start([() => reply("hi")]);
  const missing = await post(gw.base, "/v1/chat/completions", { model: "GLM-5.3-Flash", messages: [{ role: "user", content: "hi" }] });
  assert.equal(missing.status, 401);
  assert.equal(missing.json.error.type, "authentication_error");
  const anthropic = await post(gw.base, "/v1/messages", { model: "GLM-5.3", max_tokens: 16, messages: [{ role: "user", content: "hi" }] });
  assert.equal(anthropic.status, 401);
  assert.equal(anthropic.json.type, "error");
  assert.equal(anthropic.json.error.type, "authentication_error");
  const models = await fetch(`${gw.base}/v1/models`, { headers: { authorization: "Bearer client-test-key" } });
  const listed = await models.json();
  assert.equal(models.status, 200);
  assert.ok(listed.data.some((item: { id: string }) => item.id === "GLM-5.3-Flash"));
  await gw.close();
});

test("chat completions translate an Anthropic upstream stream into an OpenAI completion", async () => {
  const gw = await start([() => reply("Hello")]);
  const response = await post(
    gw.base,
    "/v1/chat/completions",
    { model: "glm-5.3-flash", messages: [{ role: "user", content: "hi" }] },
    "client-test-key",
  );
  assert.equal(response.status, 200);
  assert.equal(response.json.choices[0].message.content, "Hello");
  assert.equal(response.json.model, "GLM-5.3-Flash");
  const sent = gw.calls[0] as { model: string; stream: boolean; system: { text: string }[] };
  assert.equal(sent.model, "GLM-5.3-Flash");
  assert.equal(sent.stream, true);
  assert.equal(sent.system[0].text.includes("ZCode"), true);
  assert.equal(JSON.stringify(gw.calls).includes("secret-token-zzzz"), false);
  assert.equal(gw.store.summary().ok, 1);
  await gw.close();
});

test("streaming keeps event frames and legacy completions return text", async () => {
  const gw = await start([() => reply("Hel"), () => reply("there")]);
  const streamed = await post(
    gw.base,
    "/v1/chat/completions",
    { model: "GLM-5.3-Flash", stream: true, messages: [{ role: "user", content: "hi" }] },
    "client-test-key",
  );
  assert.equal(streamed.headers.get("content-type")?.includes("text/event-stream"), true);
  assert.match(streamed.text, /"content":"Hel"/);
  assert.match(streamed.text, /\[DONE\]/);
  const legacy = await post(gw.base, "/v1/completions", { model: "GLM-5.3-Flash", prompt: "hi" }, "client-test-key");
  assert.equal(legacy.json.object, "text_completion");
  assert.equal(legacy.json.choices[0].text, "there");
  await gw.close();
});

test("overload before output is retried and unusual activity parks only that model", async () => {
  const gw = await start([
    () => httpError(529, "1305", "overloaded"),
    () => reply("after-retry"),
    () => httpError(405, "3012", "unusual activity"),
    () => reply("flash-ok"),
  ]);
  const retried = await post(
    gw.base,
    "/v1/chat/completions",
    { model: "GLM-5.3-Flash", messages: [{ role: "user", content: "hi" }] },
    "client-test-key",
  );
  assert.equal(retried.json.choices[0].message.content, "after-retry");
  assert.equal(gw.sleeps, 1);
  assert.equal(gw.calls.length, 2);
  const blocked = await post(
    gw.base,
    "/v1/chat/completions",
    { model: "GLM-5.3", messages: [{ role: "user", content: "hi" }] },
    "client-test-key",
  );
  assert.equal(blocked.status, 405);
  const other = await post(
    gw.base,
    "/v1/chat/completions",
    { model: "GLM-5.3-Flash", messages: [{ role: "user", content: "hi" }] },
    "client-test-key",
  );
  assert.equal(other.status, 200);
  assert.equal(other.json.choices[0].message.content, "flash-ok");
  const parked = await post(
    gw.base,
    "/v1/chat/completions",
    { model: "GLM-5.3", messages: [{ role: "user", content: "hi" }] },
    "client-test-key",
  );
  assert.equal(parked.status, 503);
  await gw.close();
});

test("loopback dashboard origins can read health and foreign origins cannot", async () => {
  const gw = await start([]);
  try {
    const local = await fetch(`${gw.base}/health`, { headers: { origin: "http://localhost:5173" } });
    assert.equal(local.status, 200);
    assert.equal(local.headers.get("access-control-allow-origin"), "http://localhost:5173");
    assert.equal((await local.json()).status, "ok");
    const ipv4 = await fetch(`${gw.base}/ready`, { headers: { origin: "http://127.0.0.1:5173" } });
    assert.equal(ipv4.headers.get("access-control-allow-origin"), "http://127.0.0.1:5173");
    const ipv6 = await fetch(`${gw.base}/health`, { headers: { origin: "http://[::1]:5173" } });
    assert.equal(ipv6.headers.get("access-control-allow-origin"), "http://[::1]:5173");
    const preflight = await fetch(`${gw.base}/admin/accounts`, {
      method: "OPTIONS",
      headers: {
        origin: "http://127.0.0.1:5173",
        "access-control-request-method": "GET",
        "access-control-request-headers": "authorization,content-type",
      },
    });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get("access-control-allow-origin"), "http://127.0.0.1:5173");
    assert.match(preflight.headers.get("access-control-allow-headers") ?? "", /authorization/);
    const foreign = await fetch(`${gw.base}/health`, { headers: { origin: "https://evil.example" } });
    assert.equal(foreign.status, 200);
    assert.equal(foreign.headers.get("access-control-allow-origin"), null);
    const foreignPreflight = await fetch(`${gw.base}/health`, {
      method: "OPTIONS",
      headers: { origin: "https://evil.example", "access-control-request-method": "POST" },
    });
    assert.equal(foreignPreflight.status, 403);
    assert.equal(foreignPreflight.headers.get("access-control-allow-origin"), null);
    const dotted = await fetch(`${gw.base}/health`, { headers: { origin: "http://evil.localhost:5173" } });
    assert.equal(dotted.headers.get("access-control-allow-origin"), null);
  } finally {
    await gw.close();
  }
});

test("empty pool is not ready, claim routes are gone, and admin views hide tokens", async () => {
  const gw = await start([], { accounts: [] });
  const ready = await fetch(`${gw.base}/ready`);
  assert.equal(ready.status, 503);
  const missing = await post(
    gw.base,
    "/v1/chat/completions",
    { model: "GLM-5.3-Flash", messages: [{ role: "user", content: "hi" }] },
    "client-test-key",
  );
  assert.equal(missing.status, 503);
  assert.equal(missing.json.error.code, "no_accounts_available");
  const claim = await post(gw.base, "/admin/accounts/usr-1/claim500m", {}, "admin-test-key");
  assert.equal(claim.status, 410);
  assert.equal(claim.json.error.code, "feature_not_supported");
  const generator = await fetch(`${gw.base}/admin/dash/generator/start`, { method: "POST", headers: { authorization: "Bearer admin-test-key" } });
  assert.equal(generator.status, 410);
  const imported = await post(
    gw.base,
    "/admin/accounts",
    { account_id: "usr-9", email: "nine@example.test", access_token: "secret-token-9999" },
    "admin-test-key",
  );
  assert.equal(imported.status, 200);
  assert.equal(JSON.stringify(imported.json).includes("secret-token-9999"), false);
  assert.match(imported.json.account.token_hint, /9999/);
  const listed = await fetch(`${gw.base}/admin/accounts`, { headers: { authorization: "Bearer admin-test-key" } });
  const body = await listed.json();
  assert.equal(JSON.stringify(body).includes("secret-token-9999"), false);
  const settings = await fetch(`${gw.base}/admin/dash/settings`, { headers: { authorization: "Bearer client-test-key" } });
  assert.equal(settings.status, 403);
  await gw.close();
});

test("anthropic messages return a message object and health stays up with an empty pool", async () => {
  const gw = await start([() => reply("native")]);
  const health = await fetch(`${gw.base}/health`);
  assert.equal((await health.json()).status, "ok");
  const response = await post(
    gw.base,
    "/v1/messages",
    { model: "GLM-5.3", max_tokens: 32, messages: [{ role: "user", content: "hi" }] },
    "client-test-key",
  );
  assert.equal(response.status, 200);
  assert.equal(response.json.type, "message");
  assert.equal(response.json.content[0].text, "native");
  assert.equal(response.json.role, "assistant");
  await gw.close();
});

test("count_tokens is a local estimate and malformed messages are 400", async () => {
  const gw = await start([]);
  const bad = await post(gw.base, "/v1/chat/completions", { model: "GLM-5.3-Flash", messages: "hi" }, "client-test-key");
  assert.equal(bad.status, 400);
  const counted = await post(
    gw.base,
    "/v1/messages/count_tokens",
    { model: "GLM-5.3", messages: [{ role: "user", content: "hello!!!!" }] },
    "client-test-key",
  );
  assert.equal(counted.status, 200);
  assert.equal(counted.json.input_tokens >= 1, true);
  await gw.close();
});

function makeAccount(id: string, token: string, notes: Record<string, unknown> = {}) {
  const account = new Account(id);
  account.email = `${id}@example.test`;
  account.accessToken = token;
  account.notes = notes;
  return account;
}

function messageStart() {
  return { type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", model: "GLM-5.3", content: [], stop_reason: null, usage: { input_tokens: 2, output_tokens: 0 } } };
}

test("quota rejection parks that model and the same request rotates", async () => {
  const first = makeAccount("usr-1", "secret-token-zzzz", { quotas: { "GLM-5.3": { remaining: 50, resets_at: 10_000_000 } } });
  const second = makeAccount("usr-2", "secret-token-9999");
  const gw = await start([() => httpError(402, "11113", "exceed quota limit"), () => reply("from-two")], { accounts: [first, second] });
  const response = await post(gw.base, "/v1/chat/completions", { model: "GLM-5.3", messages: [{ role: "user", content: "hi" }] }, "client-test-key");
  assert.equal(response.status, 200);
  assert.equal(response.json.choices[0].message.content, "from-two");
  assert.equal(gw.calls.length, 2);
  assert.equal(first.state, "ready");
  assert.equal(first.isModelCapped("GLM-5.3"), true);
  assert.equal(first.isModelCapped("GLM-5.3-Flash"), false);
  const parkedFor = (first.modelCaps["GLM-5.3"] ?? 0) - Date.now() / 1000;
  assert.ok(parkedFor > 500 && parkedFor < 700);
  assert.equal(JSON.stringify(response.json).includes("secret-token"), false);
  await gw.close();
});

test("quota park duration follows the bucket reset or exhausts an empty ledger", () => {
  const spent = new Account("spent");
  spent.notes = { quotas: { "GLM-5.3": { remaining: 0, resets_at: 1_000_000 } } };
  const untilReset = quotaPark(spent, "GLM-5.3", 1_000_000 - 7200);
  assert.equal(untilReset.action, "park");
  if (untilReset.action === "park") assert.ok(Math.abs(untilReset.seconds - 7200) < 1);
  const empty = new Account("empty");
  empty.notes = { quotas: {} };
  assert.deepEqual(quotaPark(empty, "GLM-5.3"), { action: "park", seconds: 900 });
  assert.deepEqual(quotaPark(empty, "GLM-5.3-Flash"), { action: "park", seconds: 900 });
  assert.deepEqual(quotaPark(empty, "GLM-5.3"), { action: "exhaust" });
  assert.equal(empty.quotaStrikes, 3);
});

test("a streaming failure after output is not replayed", async () => {
  const partial: UpstreamResponse = {
    status: 200,
    headers: { "content-type": "text/event-stream" },
    text: sse([
      messageStart(),
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello" } },
    ]),
  };
  const gw = await start([() => partial, () => reply("should-not-run")]);
  const response = await post(
    gw.base,
    "/v1/chat/completions",
    { model: "GLM-5.3-Flash", stream: true, messages: [{ role: "user", content: "hi" }] },
    "client-test-key",
  );
  assert.equal(gw.calls.length, 1);
  assert.equal(response.status, 502);
  assert.equal(response.json.error.code, "truncated_stream");
  await gw.close();
});

test("truncation before content is retried and an error after message_start is not", async () => {
  const prelude: UpstreamResponse = {
    status: 200,
    headers: { "content-type": "text/event-stream" },
    text: sse([messageStart()]),
  };
  const recovered = await start([() => prelude, () => reply("recovered")]);
  const ok = await post(
    recovered.base,
    "/v1/chat/completions",
    { model: "GLM-5.3-Flash", stream: true, messages: [{ role: "user", content: "hi" }] },
    "client-test-key",
  );
  assert.equal(recovered.calls.length, 2);
  assert.match(ok.text, /recovered/);
  await recovered.close();

  const errored: UpstreamResponse = {
    status: 200,
    headers: { "content-type": "text/event-stream" },
    text: sse([messageStart(), { type: "error", error: { type: "api_error", message: "oops" } }]),
  };
  const failed = await start([() => errored, () => reply("should-not-run")]);
  const response = await post(
    failed.base,
    "/v1/chat/completions",
    { model: "GLM-5.3-Flash", stream: true, messages: [{ role: "user", content: "hi" }] },
    "client-test-key",
  );
  assert.equal(failed.calls.length, 1);
  assert.equal(response.status, 502);
  assert.match(response.json.error.message, /oops/);
  await failed.close();
});

test("non-streaming truncation after content is retried because the client saw nothing", async () => {
  const partial: UpstreamResponse = {
    status: 200,
    headers: { "content-type": "text/event-stream" },
    text: sse([
      messageStart(),
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello" } },
    ]),
  };
  const gw = await start([() => partial, () => reply("full")]);
  try {
    const response = await post(gw.base, "/v1/chat/completions", { model: "GLM-5.3-Flash", messages: [{ role: "user", content: "hi" }] }, "client-test-key");
    assert.equal(gw.calls.length, 2);
    assert.equal(response.status, 200);
    assert.equal(response.json.choices[0].message.content, "full");
  } finally {
    await gw.close();
  }
});

test("an initial quota event rotates and a JSON business error does too", async () => {
  const first = makeAccount("usr-1", "secret-token-zzzz");
  const second = makeAccount("usr-2", "secret-token-9999");
  const gw = await start(
    [
      () => ({
        status: 200,
        headers: { "content-type": "text/event-stream" },
        text: sse([{ type: "error", error: { code: "11113", message: "Insufficient balance" } }]),
      }),
      () => reply("rotated"),
    ],
    { accounts: [first, second] },
  );
  const streamed = await post(gw.base, "/v1/chat/completions", { model: "GLM-5.3", messages: [{ role: "user", content: "hi" }] }, "client-test-key");
  assert.equal(streamed.json.choices[0].message.content, "rotated");
  assert.equal(first.isModelCapped("GLM-5.3"), true);
  assert.equal(gw.calls.length, 2);
  await gw.close();

  const again = await start(
    [
      () => ({ status: 200, headers: { "content-type": "application/json" }, text: JSON.stringify({ code: 11113, msg: "Insufficient balance" }) }),
      () => reply("from-json"),
    ],
    { accounts: [makeAccount("usr-1", "secret-token-zzzz"), makeAccount("usr-2", "secret-token-9999")] },
  );
  const json = await post(again.base, "/v1/chat/completions", { model: "GLM-5.3", messages: [{ role: "user", content: "hi" }] }, "client-test-key");
  assert.equal(json.json.choices[0].message.content, "from-json");
  assert.equal(again.calls.length, 2);
  await again.close();
});

test("disconnect during overload backoff sends no further request", async () => {
  const controller = new AbortController();
  const gw = await start([() => httpError(529, "1305", "overloaded"), () => reply("should-not")], {
    sleep: async () => {
      controller.abort();
    },
  });
  const result = await gw.service.execute(
    { model: "GLM-5.3-Flash", messages: [{ role: "user", content: "hi" }] },
    "GLM-5.3-Flash",
    "openai",
    "local",
    { signal: controller.signal },
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "client_disconnected");
  assert.equal(gw.calls.length, 1);
  assert.equal(gw.service.pool.accounts[0]!.inFlight, 0);
  assert.equal(gw.service.pool.accounts[0]!.state, "ready");
  await gw.close();
});

test("a disconnected client cancels the upstream attempt and releases the account", async () => {
  const gw = await start([
    (request) =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(() => resolve(reply("late")), 5000);
        const abort = () => {
          clearTimeout(timer);
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        };
        if (request.signal?.aborted) abort();
        else request.signal?.addEventListener("abort", abort, { once: true });
      }),
  ]);
  const controller = new AbortController();
  const pending = fetch(`${gw.base}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer client-test-key" },
    body: JSON.stringify({ model: "GLM-5.3-Flash", messages: [{ role: "user", content: "hi" }] }),
    signal: controller.signal,
  });
  const started = Date.now();
  while (gw.calls.length < 1 && Date.now() - started < 2000) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(gw.calls.length, 1);
  controller.abort();
  await pending.catch(() => undefined);
  const released = Date.now();
  while (gw.service.pool.accounts[0]!.inFlight !== 0 && Date.now() - released < 1000) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(gw.service.pool.accounts[0]!.inFlight, 0);
  assert.equal(gw.service.pool.accounts[0]!.state, "ready");
  await gw.close();
});

test("admin import opens an enc:v1 credential file and does not return the token", async () => {
  const previous = process.env.ZCODE_CREDENTIAL_SECRET;
  process.env.ZCODE_CREDENTIAL_SECRET = "test-secret";
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "azc-import-"));
  const payload = Buffer.from(JSON.stringify({ user_id: "owner-1", sub: "owner-1", iat: 4, exp: 4_000_000_000 })).toString("base64url");
  const token = `eyJhbGciOiJIUzI1NiJ9.${payload}.not-a-real-signature-zzzz`;
  const key = createHash("sha256").update("test-secret", "utf8").digest();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
  const sealed = `enc:v1:${iv.toString("base64url")}.${cipher.getAuthTag().toString("base64url")}.${ciphertext.toString("base64url")}`;
  fs.writeFileSync(
    path.join(dir, "credentials.json"),
    JSON.stringify({ zcodejwttoken: sealed, "oauth:zai:user_info": { email: "owner@example.test", name: "Owner" } }),
  );
  const gw = await start([]);
  try {
    const denied = await post(gw.base, "/admin/accounts/import", { path: path.join(dir, "credentials.json") }, "client-test-key");
    assert.equal(denied.status, 403);
    const imported = await post(gw.base, "/admin/accounts/import", { path: path.join(dir, "credentials.json") }, "admin-test-key");
    assert.equal(imported.status, 200);
    assert.equal(imported.json.written, 1);
    assert.deepEqual(imported.json.emails, ["owner@example.test"]);
    assert.equal(JSON.stringify(imported.json).includes("eyJhbGciOiJIUzI1NiJ9"), false);
    assert.equal(JSON.stringify(imported.json).includes("not-a-real-signature-zzzz"), false);
    const listed = await fetch(`${gw.base}/admin/accounts`, { headers: { authorization: "Bearer admin-test-key" } });
    const body = await listed.json();
    assert.equal(JSON.stringify(body).includes("not-a-real-signature-zzzz"), false);
    assert.equal(
      body.accounts.some((account: { id: string; token_hint: string }) => account.id === "owner-1" && account.token_hint.endsWith("zzzz")),
      true,
    );
    const missing = await post(gw.base, "/admin/accounts/import", { path: path.join(dir, "missing.json") }, "admin-test-key");
    assert.equal(missing.status, 404);
  } finally {
    if (previous == null) delete process.env.ZCODE_CREDENTIAL_SECRET;
    else process.env.ZCODE_CREDENTIAL_SECRET = previous;
    await gw.close();
  }
});
