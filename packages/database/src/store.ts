import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts REAL NOT NULL,
  account_id TEXT,
  client_key TEXT,
  dialect TEXT,
  model TEXT,
  variant TEXT,
  stream INTEGER,
  status INTEGER,
  duration_ms REAL,
  prompt_tokens INTEGER,
  completion_tokens INTEGER,
  total_tokens INTEGER,
  error_code TEXT
);
CREATE INDEX IF NOT EXISTS idx_usage_ts ON usage(ts);
CREATE INDEX IF NOT EXISTS idx_usage_account ON usage(account_id);
CREATE INDEX IF NOT EXISTS idx_usage_model ON usage(model);
`;

const COLUMNS = [
  "ts",
  "account_id",
  "client_key",
  "dialect",
  "model",
  "variant",
  "stream",
  "status",
  "duration_ms",
  "prompt_tokens",
  "completion_tokens",
  "total_tokens",
  "error_code",
] as const;

export type UsageRow = Partial<Record<(typeof COLUMNS)[number], string | number | null>>;

export class UsageStore {
  db: DatabaseSync;

  constructor(file: string) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec(SCHEMA);
  }

  close() {
    this.db.close();
  }

  record(row: UsageRow) {
    const unknown = Object.keys(row).filter((key) => !COLUMNS.includes(key as (typeof COLUMNS)[number]));
    if (unknown.length) throw new TypeError(`unknown usage column(s): ${unknown.sort().join(",")}`);
    const values = COLUMNS.map((column) => (column === "ts" ? (row.ts ?? Date.now() / 1000) : (row[column] ?? null)));
    this.db
      .prepare(`INSERT INTO usage (${COLUMNS.join(",")}) VALUES (${COLUMNS.map(() => "?").join(",")})`)
      .run(...values);
  }

  summary(sinceSeconds?: number | null) {
    const where = sinceSeconds ? "WHERE ts >= ?" : "";
    const params = sinceSeconds ? [Date.now() / 1000 - sinceSeconds] : [];
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS requests,
                COALESCE(SUM(total_tokens), 0) AS total_tokens,
                COALESCE(SUM(prompt_tokens), 0) AS prompt_tokens,
                COALESCE(SUM(completion_tokens), 0) AS completion_tokens,
                AVG(duration_ms) AS avg_duration_ms,
                COALESCE(SUM(CASE WHEN status = 200 THEN 1 ELSE 0 END), 0) AS ok,
                COALESCE(SUM(CASE WHEN status = 402 THEN 1 ELSE 0 END), 0) AS insufficient_credits,
                COALESCE(SUM(CASE WHEN status = 429 THEN 1 ELSE 0 END), 0) AS rate_limited
         FROM usage ${where}`,
      )
      .get(...params) as Record<string, number | null>;
    const byModel = this.db
      .prepare(
        `SELECT model AS model, COUNT(*) AS requests, COALESCE(SUM(total_tokens), 0) AS tokens
         FROM usage ${where} GROUP BY model ORDER BY COUNT(*) DESC`,
      )
      .all(...params) as Array<{ model: string; requests: number; tokens: number }>;
    return {
      requests: Number(row.requests ?? 0),
      total_tokens: Number(row.total_tokens ?? 0),
      prompt_tokens: Number(row.prompt_tokens ?? 0),
      completion_tokens: Number(row.completion_tokens ?? 0),
      avg_duration_ms: row.avg_duration_ms ? Math.round(Number(row.avg_duration_ms) * 10) / 10 : 0,
      ok: Number(row.ok ?? 0),
      insufficient_credits: Number(row.insufficient_credits ?? 0),
      rate_limited: Number(row.rate_limited ?? 0),
      by_model: byModel.map((item) => ({
        model: item.model,
        requests: Number(item.requests ?? 0),
        tokens: Number(item.tokens ?? 0),
      })),
    };
  }
}
