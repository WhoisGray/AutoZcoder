import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { UsageStore } from "../../../packages/database/src/store.ts";
import { PoolManager } from "../../../packages/pool/src/router.ts";
import { Registry } from "../../../packages/protocols/src/registry.ts";
import { createGateway, makeConfig } from "../../gateway/src/server.ts";
import { ChatService } from "../../gateway/src/service.ts";

const pages = path.join(import.meta.dirname, "pages");

test("dashboard copy includes the empty and error states", () => {
  const overview = fs.readFileSync(path.join(pages, "OverviewPage.vue"), "utf8");
  const accounts = fs.readFileSync(path.join(pages, "AccountsPage.vue"), "utf8");
  const usage = fs.readFileSync(path.join(pages, "UsagePage.vue"), "utf8");
  const models = fs.readFileSync(path.join(pages, "ModelsPage.vue"), "utf8");
  const settings = fs.readFileSync(path.join(pages, "SettingsPage.vue"), "utf8");
  assert.match(overview, /Gateway unreachable/);
  assert.match(overview, /No usable account/);
  assert.match(overview, /Admin key required/);
  assert.match(accounts, /No accounts loaded/);
  assert.match(usage, /No usage yet/);
  assert.match(models, /gateway\.error/);
  assert.match(settings, /generator\.supported === false/);
  assert.match(settings, /Start device login/);
});

test("overview, accounts, models, usage, and settings read a live empty gateway", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "azc-dash-"));
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
    upstream: { async send() { throw new Error("unused"); } },
    config,
  });
  const server = createGateway({ config, service, logs: [] });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  const port = address && typeof address === "object" ? address.port : 0;
  const base = `http://127.0.0.1:${port}`;
  const admin = { authorization: "Bearer admin-test-key" };
  try {
    const health = await fetch(`${base}/health`);
    assert.equal((await health.json()).status, "ok");
    const ready = await fetch(`${base}/ready`);
    const readyBody = await ready.json();
    assert.equal(ready.status, 503);
    assert.equal(readyBody.accounts_ready, 0);
    const missingModels = await fetch(`${base}/v1/models`);
    assert.equal(missingModels.status, 401);
    const models = await fetch(`${base}/v1/models`, { headers: { authorization: "Bearer client-test-key" } });
    const listed = await models.json();
    assert.equal(models.status, 200);
    assert.ok(listed.data.some((item: { id: string }) => item.id === "GLM-5.3"));
    const accounts = await fetch(`${base}/admin/accounts`, { headers: admin });
    assert.deepEqual((await accounts.json()).accounts, []);
    const stats = await fetch(`${base}/admin/stats`, { headers: admin });
    assert.equal((await stats.json()).requests, 0);
    const settings = await fetch(`${base}/admin/dash/settings`, { headers: admin });
    const settingsBody = await settings.json();
    assert.equal(settingsBody.generator.supported, false);
    assert.match(settingsBody.generator.reason, /not part of this application/);
    const denied = await fetch(`${base}/admin/dash/settings`, { headers: { authorization: "Bearer client-test-key" } });
    assert.equal(denied.status, 403);
  } finally {
    store.close();
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
  await assert.rejects(fetch(`${base}/health`));
});
