import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { UsageStore } from "../../../packages/database/src/store.ts";
import { Account } from "../../../packages/pool/src/account.ts";
import { PoolManager } from "../../../packages/pool/src/router.ts";
import { Registry } from "../../../packages/protocols/src/registry.ts";
import { createGateway, makeConfig } from "./server.ts";
import { ChatService } from "./service.ts";

const root = path.resolve(import.meta.dirname, "../../..");
const results = path.join(root, "docs/rewrite/PERFORMANCE_RESULTS.md");

function childEnv(extra: Record<string, string> = {}) {
  return {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "",
    TMPDIR: process.env.TMPDIR ?? "/tmp",
    LANG: process.env.LANG ?? "C",
    ...extra,
  };
}

function rssKb(pid: number): number {
  const text = execFileSync("ps", ["-o", "rss=", "-p", String(pid)], { encoding: "utf8" }).trim();
  const value = Number(text.split(/\s+/)[0]);
  if (!Number.isFinite(value) || value <= 0) throw new Error("rss was not readable");
  return value;
}

function stop(child: ChildProcess, signal: NodeJS.Signals = "SIGKILL") {
  return new Promise<void>((resolve) => {
    if (child.exitCode != null || child.signalCode != null) {
      resolve();
      return;
    }
    child.once("exit", () => resolve());
    child.kill(signal);
  });
}

async function bootGateway(dir: string) {
  const started = performance.now();
  const child = spawn(process.execPath, ["--experimental-strip-types", path.join(root, "apps/gateway/src/index.ts")], {
    cwd: root,
    env: childEnv({
      AZC_DATA_DIR: dir,
      AZC_PORT: "0",
      AZC_HOST: "127.0.0.1",
      AZC_ADMIN_KEY: "admin-test-key",
      AZC_CLIENT_KEY: "client-test-key",
    }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  const url = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`gateway did not listen\n${output}`)), 8000);
    const take = (chunk: Buffer) => {
      output += chunk.toString("utf8");
      const match = output.match(/listening on (http:\/\/127\.0\.0\.1:\d+)/);
      if (!match?.[1]) return;
      clearTimeout(timer);
      resolve(match[1]);
    };
    child.stdout?.on("data", take);
    child.stderr?.on("data", take);
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      reject(new Error(`gateway exited ${code ?? signal} before listen\n${output}`));
    });
  });
  return { child, url, elapsedMs: performance.now() - started, output };
}

test("an upstream hang stops at the timeout and the next health check still works", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "azc-fail-"));
  const account = new Account("usr-1");
  account.email = "one@example.test";
  account.accessToken = "secret-token-zzzz";
  const config = makeConfig({
    accountsDir: dir,
    adminKey: "admin-test-key",
    clientKeys: [{ key: "client-test-key", name: "local", rpm: 0 }],
    maxAttempts: 1,
    upstreamTimeoutMs: 100,
  });
  const store = new UsageStore(path.join(dir, "gateway.db"));
  const service = new ChatService({
    pool: new PoolManager([account], config.pool),
    registry: new Registry(),
    store,
    upstream: {
      send(request) {
        return new Promise((_, reject) => {
          const abort = () => {
            const error = new Error("aborted");
            error.name = "AbortError";
            reject(error);
          };
          if (request.signal?.aborted) abort();
          else request.signal?.addEventListener("abort", abort, { once: true });
        });
      },
    },
    config,
  });
  const logs: string[] = [];
  const server = createGateway({ config, service, logs });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  const port = address && typeof address === "object" ? address.port : 0;
  const base = `http://127.0.0.1:${port}`;
  const started = performance.now();
  try {
    const response = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { authorization: "Bearer client-test-key", "content-type": "application/json" },
      body: JSON.stringify({ model: "GLM-5.3", messages: [{ role: "user", content: "hi" }] }),
    });
    const elapsedMs = performance.now() - started;
    const body = await response.json();
    assert.equal(response.status, 504);
    assert.equal(body.error.code, "upstream_timeout");
    assert.equal(JSON.stringify(body).includes("secret-token-zzzz"), false);
    assert.equal(account.inFlight, 0);
    assert.equal(elapsedMs >= 90 && elapsedMs < 2000, true);
    const health = await fetch(`${base}/health`);
    assert.equal((await health.json()).status, "ok");
    console.log(`MEASURE upstream_timeout_ms=${elapsedMs.toFixed(1)}`);
  } finally {
    store.close();
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});

test("killing the gateway leaves SQLite readable and a new process can listen", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "azc-crash-"));
  const db = path.join(dir, "crash.db");
  const storeUrl = pathToFileURL(path.join(root, "packages/database/src/store.ts")).href;
  const writer = spawn(
    process.execPath,
    [
      "--experimental-strip-types",
      "--input-type=module",
      "-e",
      `import { UsageStore } from ${JSON.stringify(storeUrl)};
       const store = new UsageStore(process.argv[1]);
       store.record({ account_id: "usr-crash", client_key: "client-test-key", dialect: "openai", model: "GLM-5.3", variant: "anthropic", stream: 0, status: 200, duration_ms: 5, prompt_tokens: 2, completion_tokens: 3, total_tokens: 5, error_code: null });
       console.log("committed");
       setInterval(() => {}, 1000);`,
      db,
    ],
    { cwd: root, env: childEnv(), stdio: ["ignore", "pipe", "pipe"] },
  );
  let writerOut = "";
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`writer did not commit\n${writerOut}`)), 8000);
      const take = (chunk: Buffer) => {
        writerOut += chunk.toString("utf8");
        if (!writerOut.includes("committed")) return;
        clearTimeout(timer);
        resolve();
      };
      writer.stdout?.on("data", take);
      writer.stderr?.on("data", take);
    });
    const killed = new Promise<NodeJS.Signals | null>((resolve) => writer.once("exit", (_code, signal) => resolve(signal)));
    writer.kill("SIGKILL");
    assert.equal(await killed, "SIGKILL");
  } finally {
    await stop(writer);
  }
  const store = new UsageStore(db);
  try {
    assert.equal(store.summary().requests, 1);
    assert.equal(store.summary().total_tokens, 5);
  } finally {
    store.close();
  }

  const first = await bootGateway(dir);
  let second: Awaited<ReturnType<typeof bootGateway>> | null = null;
  try {
    assert.equal(first.output.includes("admin-test-key"), false);
    const health = await fetch(`${first.url}/health`);
    assert.equal((await health.json()).status, "ok");
    const memory = rssKb(first.child.pid!);
    const gone = new Promise<NodeJS.Signals | null>((resolve) => first.child.once("exit", (_code, signal) => resolve(signal)));
    first.child.kill("SIGKILL");
    assert.equal(await gone, "SIGKILL");
    await assert.rejects(fetch(`${first.url}/health`));
    second = await bootGateway(dir);
    const again = await fetch(`${second.url}/health`);
    assert.equal((await again.json()).status, "ok");
    console.log(`MEASURE cold_start_ms=${first.elapsedMs.toFixed(1)} rss_kb=${memory} warm_start_ms=${second.elapsedMs.toFixed(1)}`);
    const report = fs.readFileSync(results, "utf8");
    assert.match(report, /Not measured/);
    assert.match(report, /Time to first byte from Z\.ai/);
    assert.match(report, /Cold start until the listen log: \d+(?:\.\d+)? ms/);
  } finally {
    await stop(first.child);
    if (second) await stop(second.child);
  }
});
