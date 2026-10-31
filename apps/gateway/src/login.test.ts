import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Account } from "../../../packages/pool/src/account.ts";
import { PoolManager } from "../../../packages/pool/src/router.ts";
import { UsageStore } from "../../../packages/database/src/store.ts";
import { Registry } from "../../../packages/protocols/src/registry.ts";
import { createGateway, makeConfig } from "./server.ts";
import { ChatService } from "./service.ts";
import { DeviceLogin, type LoginClient } from "./login.ts";

function scripted(steps: Array<(input: { method: string; url: string; headers: Record<string, string>; body?: unknown }) => { status: number; json: any }>): { client: LoginClient; calls: Array<{ method: string; url: string; headers: Record<string, string>; body?: unknown }> } {
  const calls: Array<{ method: string; url: string; headers: Record<string, string>; body?: unknown }> = [];
  const client: LoginClient = {
    async request(input) {
      calls.push(input);
      const next = steps.shift();
      if (!next) throw new Error("no scripted login response left");
      return next(input);
    },
  };
  return { client, calls };
}

function initOk(extra: Record<string, unknown> = {}) {
  return {
    status: 200,
    json: {
      code: 0,
      data: {
        flow_id: "flow",
        authorize_url: "https://chat.z.ai/api/oauth/authorize?state=test",
        expires_at: Date.now() / 1000 + 30,
        poll_interval_sec: 1,
        ...extra,
      },
    },
  };
}

test("device login asks the official broker, then stores the approved account", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "azc-login-"));
  const { client, calls } = scripted([
    (input) => {
      assert.equal(input.method, "POST");
      assert.equal(input.url.endsWith("/oauth/cli/init"), true);
      assert.deepEqual(input.body, { provider: "zai" });
      const token = input.headers.authorization.replace(/^Bearer /, "");
      assert.equal(token.length, 64);
      assert.equal(/^[0-9a-f]+$/.test(token), true);
      assert.equal(input.headers["x-api-key"], undefined);
      return initOk({ poll_token: "server-substituted-token" });
    },
    (input) => {
      assert.equal(input.method, "GET");
      assert.equal(input.url.endsWith("/oauth/cli/poll/flow"), true);
      assert.equal(input.headers.authorization, calls[0]!.headers.authorization);
      assert.equal(Object.hasOwn(input.headers, "x-device-mid"), true);
      return { status: 200, json: { code: 0, data: { status: "ready", token: "header.payload.fake-jwt", user: { user_id: "one", email: "owner@example.test", name: "Owner" } } } };
    },
  ]);
  const added: Account[] = [];
  const login = new DeviceLogin({ accountsDir: dir, client, onAccount: (account) => added.push(account), sleep: async () => undefined });
  await login.run();
  assert.equal(login.state, "done");
  assert.equal(added[0]!.id, "one");
  assert.equal(added[0]!.expiresAt, 0);
  assert.equal(login.snapshotPath && fs.existsSync(login.snapshotPath), true);
  assert.equal(fs.readFileSync(login.snapshotPath!, "utf8").includes("fake-jwt"), true);
  assert.equal(JSON.stringify(login.status()).includes("fake-jwt"), false);
  assert.equal(JSON.stringify(login.status()).includes("server-substituted-token"), false);
});

test("a login URL on another host is refused before any poll", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "azc-login-"));
  const { client, calls } = scripted([
    () => ({ status: 200, json: { code: 0, data: { flow_id: "flow", authorize_url: "https://evil.example/approve", expires_at: Date.now() / 1000 + 30 } } }),
    () => ({ status: 200, json: { code: 0, data: { status: "ready", token: "should-not" } } }),
  ]);
  const login = new DeviceLogin({ accountsDir: dir, client, sleep: async () => undefined });
  await login.run();
  assert.equal(login.state, "error");
  assert.match(login.error ?? "", /unexpected login URL/);
  assert.equal(calls.length, 1);
  assert.equal(fs.readdirSync(dir).length, 0);
});

test("pending approval is polled again and a denial does not write a snapshot", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "azc-login-"));
  let sleeps = 0;
  const { client, calls } = scripted([
    () => initOk(),
    () => ({ status: 200, json: { code: 0, data: { status: "pending" } } }),
    () => ({ status: 200, json: { code: 0, data: { status: "denied" } } }),
  ]);
  const login = new DeviceLogin({
    accountsDir: dir,
    client,
    sleep: async () => {
      sleeps += 1;
    },
  });
  await login.run();
  assert.equal(login.state, "error");
  assert.equal(login.error, "Login was not approved");
  assert.equal(calls.length, 3);
  assert.equal(sleeps, 1);
  assert.equal(fs.readdirSync(dir).length, 0);
  assert.equal(JSON.stringify(login.status()).includes("Bearer"), false);
});

test("cancel during approval stops the poll", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "azc-login-"));
  const { client, calls } = scripted([
    () => initOk(),
    (input) => {
      assert.equal(input.url.includes("/poll/"), true);
      return { status: 200, json: { code: 0, data: { status: "pending" } } };
    },
  ]);
  const login = new DeviceLogin({
    accountsDir: dir,
    client,
    sleep: async () => {
      login.cancel();
    },
  });
  await login.run();
  assert.equal(login.state, "cancelled");
  assert.equal(calls.length, 2);
});

test("the admin login route returns the approval URL and hides the token", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "azc-login-gw-"));
  const { client } = scripted([
    () => initOk(),
    () => ({ status: 200, json: { code: 0, data: { status: "ready", token: "header.payload.hidden-token", user: { user_id: "one", email: "owner@example.test" } } } }),
  ]);
  const config = makeConfig({
    accountsDir: dir,
    adminKey: "admin-test-key",
    clientKeys: [{ key: "client-test-key", name: "local", rpm: 0 }],
  });
  const store = new UsageStore(path.join(dir, "gateway.db"));
  const service = new ChatService({
    pool: new PoolManager([], config.pool),
    registry: new Registry(),
    store,
    upstream: { async send() { throw new Error("chat upstream is not used"); } },
    config,
    sleep: async () => undefined,
  });
  const server = createGateway({ config, service, logs: [], loginClient: client });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  const port = address && typeof address === "object" ? address.port : 0;
  const base = `http://127.0.0.1:${port}`;
  try {
    const denied = await fetch(`${base}/admin/accounts/login`, { method: "POST", headers: { authorization: "Bearer client-test-key" } });
    assert.equal(denied.status, 403);
    const started = await fetch(`${base}/admin/accounts/login`, { method: "POST", headers: { authorization: "Bearer admin-test-key" } });
    const body = await started.json();
    assert.equal(started.status, 200);
    assert.equal(body.verification_url, "https://chat.z.ai/api/oauth/authorize?state=test");
    const deadline = Date.now() + 1000;
    let status = body;
    while (status.state !== "done" && Date.now() < deadline) {
      const polled = await fetch(`${base}/admin/accounts/login`, { headers: { authorization: "Bearer admin-test-key" } });
      status = await polled.json();
    }
    assert.equal(status.state, "done");
    assert.equal(status.email, "owner@example.test");
    assert.equal(JSON.stringify(status).includes("hidden-token"), false);
    const listed = await fetch(`${base}/admin/accounts`, { headers: { authorization: "Bearer admin-test-key" } });
    const accounts = await listed.json();
    assert.equal(JSON.stringify(accounts).includes("hidden-token"), false);
    assert.equal(accounts.accounts.some((account: { id: string; token_hint: string }) => account.id === "one" && account.token_hint.endsWith("oken")), true);
  } finally {
    store.close();
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});
