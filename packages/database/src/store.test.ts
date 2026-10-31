import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { UsageStore } from "./store.ts";

test("usage summary counts successes and rejects unknown columns", () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "azc-db-")), "gateway.db");
  const store = new UsageStore(file);
  store.record({
    account_id: "usr-1",
    client_key: "local",
    dialect: "openai",
    model: "GLM-5.3-Flash",
    variant: "anthropic",
    stream: 0,
    status: 200,
    duration_ms: 12,
    prompt_tokens: 3,
    completion_tokens: 4,
    total_tokens: 7,
    error_code: null,
  });
  store.record({
    account_id: "usr-1",
    client_key: "local",
    dialect: "openai",
    model: "GLM-5.3",
    variant: "anthropic",
    stream: 1,
    status: 429,
    duration_ms: 8,
    prompt_tokens: 1,
    completion_tokens: 0,
    total_tokens: 1,
    error_code: "rate_limit_error",
  });
  const summary = store.summary();
  assert.equal(summary.requests, 2);
  assert.equal(summary.ok, 1);
  assert.equal(summary.rate_limited, 1);
  assert.equal(summary.total_tokens, 8);
  assert.throws(() => store.record({ nope: 1 }), /unknown usage column/);
  store.close();
  const reopened = new UsageStore(file);
  assert.equal(reopened.summary().requests, 2);
  reopened.close();
});
