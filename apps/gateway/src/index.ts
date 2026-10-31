import fs from "node:fs";
import path from "node:path";
import { UsageStore } from "../../../packages/database/src/store.ts";
import { loadAccountsDir } from "../../../packages/pool/src/snapshots.ts";
import { PoolManager } from "../../../packages/pool/src/router.ts";
import { Registry } from "../../../packages/protocols/src/registry.ts";
import { listen, makeConfig } from "./server.ts";
import { ChatService, type GatewayConfig, type UpstreamClient } from "./service.ts";

function dataDir(): string {
  const fromEnv = process.env.AZC_DATA_DIR;
  if (fromEnv) return fromEnv;
  const home = process.env.HOME || process.env.USERPROFILE || ".";
  return path.join(home, ".autozcoder");
}

export function buildApp(config: GatewayConfig, upstream: UpstreamClient) {
  fs.mkdirSync(config.accountsDir || dataDir(), { recursive: true });
  const accounts = config.accountsDir ? loadAccountsDir(config.accountsDir) : [];
  const store = new UsageStore(path.join(dataDir(), "gateway.db"));
  const service = new ChatService({
    pool: new PoolManager(accounts, config.pool),
    registry: new Registry(),
    store,
    upstream,
    config,
  });
  return { config, service, logs: [] as string[], store };
}

async function main() {
  const dir = dataDir();
  fs.mkdirSync(dir, { recursive: true });
  const config = makeConfig({
    accountsDir: path.join(dir, "accounts"),
    port: Number(process.env.AZC_PORT || 8788),
    host: process.env.AZC_HOST || "127.0.0.1",
    adminKey: process.env.AZC_ADMIN_KEY || `gw-${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`,
    clientKeys: [{ key: process.env.AZC_CLIENT_KEY || `ck-${Math.random().toString(36).slice(2)}`, name: "local", rpm: 0 }],
  });
  const upstream: UpstreamClient = {
    async send(request) {
      const response = await fetch(request.url, {
        method: "POST",
        headers: request.headers,
        body: JSON.stringify(request.body),
        signal: request.signal,
      });
      return {
        status: response.status,
        headers: Object.fromEntries(response.headers.entries()),
        text: await response.text(),
      };
    },
  };
  const app = buildApp(config, upstream);
  const server = await listen(app);
  const address = server.address();
  const port = address && typeof address === "object" ? address.port : config.port;
  console.log(`AutoZCoder gateway listening on http://${config.host}:${port}`);
  console.log(`admin key hint …${config.adminKey.slice(-4)} (set AZC_ADMIN_KEY to choose one)`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
