import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { UsageStore } from "../../../packages/database/src/store.ts";
import { Account } from "../../../packages/pool/src/account.ts";
import { PoolManager } from "../../../packages/pool/src/router.ts";
import { Registry } from "../../../packages/protocols/src/registry.ts";
import { createGateway, makeConfig } from "./server.ts";
import { ChatService, type UpstreamClient, type UpstreamResponse } from "./service.ts";

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

async function start(scripts: Array<(req: { body: any }) => UpstreamResponse>, options: { accounts?: Account[]; sleep?: () => Promise<void> } = {}) {
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
      return next(request);
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
