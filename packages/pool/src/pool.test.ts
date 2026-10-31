import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Account } from "./account.ts";
import { PoolManager } from "./router.ts";
import { loadAccountsDir, writeSnapshotAtomic } from "./snapshots.ts";

function account(id: string, token = "tok-secret-value", remaining?: number): Account {
  const item = new Account(id);
  item.accessToken = token;
  item.email = `${id}@example.test`;
  if (remaining != null) item.notes.quotas = { "GLM-5.3-Flash": { remaining } };
  return item;
}

test("drain-first uses the account nearest exhaustion and respects the in-flight cap", () => {
  const pool = new PoolManager([account("a", "t1", 50), account("b", "t2", 5), account("c", "t3", 5)], {
    strategy: "drain_first",
    maxInFlightPerAccount: 1,
  });
  const first = pool.router.acquire(pool.accounts, new Set(), "GLM-5.3-Flash");
  assert.equal(first?.id, "b");
  const second = pool.router.acquire(pool.accounts, new Set(), "GLM-5.3-Flash");
  assert.equal(second?.id, "c");
  const third = pool.router.acquire(pool.accounts, new Set(), "GLM-5.3-Flash");
  assert.equal(third?.id, "a");
  assert.equal(pool.router.acquire(pool.accounts, new Set(), "GLM-5.3-Flash"), null);
});

test("a model cap hides one model and leaves the other routable", () => {
  const item = account("a");
  const pool = new PoolManager([item], { strategy: "least_in_flight" });
  pool.capModel(item, "GLM-5.3", 600, { code: "3012" });
  assert.equal(pool.router.acquire(pool.accounts, new Set(), "GLM-5.3"), null);
  assert.equal(pool.router.acquire(pool.accounts, new Set(), "GLM-5.3-Flash")?.id, "a");
});

test("round robin advances and least-in-flight prefers the idle account", () => {
  const pool = new PoolManager([account("a"), account("b")], { strategy: "round_robin" });
  assert.equal(pool.router.acquire(pool.accounts, new Set())?.id, "a");
  assert.equal(pool.router.acquire(pool.accounts, new Set())?.id, "b");
  const least = new PoolManager([account("a"), account("b")], { strategy: "least_in_flight", maxInFlightPerAccount: 4 });
  least.accounts[0]!.inFlight = 2;
  assert.equal(least.router.acquire(least.accounts, new Set())?.id, "b");
});

test("snapshots skip a bad expiry, dedupe by id, and do not echo the token in the public view", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "azc-accounts-"));
  writeSnapshotAtomic(path.join(dir, "old.txt"), {
    account_id: "usr-1",
    email: "one@example.test",
    access_token: "secret-token-aaaa",
    expires_at_ms: "10",
  });
  writeSnapshotAtomic(path.join(dir, "new.txt"), {
    account_id: "usr-1",
    email: "one@example.test",
    access_token: "secret-token-bbbb",
    expires_at_ms: "20",
  });
  fs.writeFileSync(path.join(dir, "bad.txt"), "account_id: usr-2\naccess_token: secret-token-cccc\nexpires_at_ms: nope\n");
  fs.writeFileSync(path.join(dir, "empty.txt"), "email: nobody@example.test\n");
  const loaded = loadAccountsDir(dir);
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0]!.accessToken, "secret-token-bbbb");
  const pub = JSON.stringify(loaded[0]!.toPublic());
  assert.equal(pub.includes("secret-token-bbbb"), false);
  assert.match(pub, /bbbb/);
});
