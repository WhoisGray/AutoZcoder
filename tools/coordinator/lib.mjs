/**
 * Durable task board for the AutoZCoder rewrite.
 * SQLite (WAL, full sync) is authoritative. Markdown snapshots are derived.
 */
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export const TASK_STATUSES = [
  "BACKLOG",
  "READY",
  "DOING",
  "REVIEW",
  "BLOCKED",
  "DONE",
  "CANCELLED",
];

const SCHEMA = `
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  phase INTEGER NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  priority TEXT NOT NULL DEFAULT 'medium',
  status TEXT NOT NULL,
  owner TEXT,
  depends_on TEXT NOT NULL DEFAULT '[]',
  allowed_paths TEXT NOT NULL DEFAULT '[]',
  acceptance_criteria TEXT NOT NULL DEFAULT '[]',
  test_commands TEXT NOT NULL DEFAULT '[]',
  branch TEXT,
  worktree TEXT,
  last_commit TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  lease_expires_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  blocking_reason TEXT,
  objective TEXT,
  tests_passed INTEGER NOT NULL DEFAULT 0,
  test_summary TEXT
);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  task_id TEXT,
  kind TEXT NOT NULL,
  actor TEXT,
  detail TEXT
);
CREATE TABLE IF NOT EXISTS checkpoints (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  phase INTEGER,
  task_id TEXT,
  commit_sha TEXT,
  note TEXT NOT NULL,
  payload TEXT
);
CREATE TABLE IF NOT EXISTS heartbeats (
  owner TEXT PRIMARY KEY,
  ts INTEGER NOT NULL,
  task_id TEXT
);
`;

function now() {
  return Date.now();
}

function atomicWrite(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  const fd = fs.openSync(tmp, "w");
  try {
    fs.writeFileSync(fd, content);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
}

function parseJson(text, fallback) {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

function rowToTask(row) {
  if (!row) return null;
  return {
    id: row.id,
    title: row.title,
    phase: row.phase,
    description: row.description,
    priority: row.priority,
    status: row.status,
    owner: row.owner,
    depends_on: parseJson(row.depends_on, []),
    allowed_paths: parseJson(row.allowed_paths, []),
    acceptance_criteria: parseJson(row.acceptance_criteria, []),
    test_commands: parseJson(row.test_commands, []),
    branch: row.branch,
    worktree: row.worktree,
    last_commit: row.last_commit,
    attempts: row.attempts,
    lease_expires_at: row.lease_expires_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
    blocking_reason: row.blocking_reason,
    objective: row.objective,
    tests_passed: Boolean(row.tests_passed),
    test_summary: row.test_summary,
  };
}

export class Coordinator {
  constructor(rootDir) {
    this.root = path.resolve(rootDir);
    this.agentDir = path.join(this.root, ".agent");
    this.runtimeDir = path.join(this.agentDir, "runtime");
    fs.mkdirSync(this.runtimeDir, { recursive: true });
    fs.mkdirSync(path.join(this.agentDir, "checkpoints"), { recursive: true });
    fs.mkdirSync(path.join(this.agentDir, "reports"), { recursive: true });
    fs.mkdirSync(path.join(this.agentDir, "handoffs"), { recursive: true });
    this.db = new DatabaseSync(path.join(this.runtimeDir, "board.db"));
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA synchronous = FULL");
    this.db.exec(SCHEMA);
  }

  close() {
    this.db.close();
  }

  _event(kind, taskId, actor, detail) {
    this.db
      .prepare(
        "INSERT INTO events (ts, task_id, kind, actor, detail) VALUES (?, ?, ?, ?, ?)",
      )
      .run(now(), taskId ?? null, kind, actor ?? null, detail ?? null);
  }

  upsertTask(spec) {
    const existing = this.db.prepare("SELECT id FROM tasks WHERE id = ?").get(spec.id);
    const ts = now();
    if (existing) return this.get(spec.id);
    this.db
      .prepare(
        `INSERT INTO tasks (
          id, title, phase, description, priority, status, owner, depends_on,
          allowed_paths, acceptance_criteria, test_commands, branch, worktree,
          last_commit, attempts, lease_expires_at, created_at, updated_at,
          blocking_reason, objective
        ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, NULL, NULL, NULL, 0, NULL, ?, ?, NULL, NULL)`,
      )
      .run(
        spec.id,
        spec.title,
        spec.phase,
        spec.description ?? "",
        spec.priority ?? "medium",
        spec.status ?? "READY",
        JSON.stringify(spec.depends_on ?? []),
        JSON.stringify(spec.allowed_paths ?? []),
        JSON.stringify(spec.acceptance_criteria ?? []),
        JSON.stringify(spec.test_commands ?? []),
        ts,
        ts,
      );
    this._event("seed", spec.id, null, spec.status ?? "READY");
    return this.get(spec.id);
  }

  seed(tasks) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const task of tasks) this.upsertTask(task);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return this.list();
  }

  /**
   * Restore a committed snapshot into an empty database.
   * The runtime SQLite file is gitignored, so a fresh checkout must be able
   * to recover DONE/READY from `.agent/board.json` without reopening work.
   */
  restore(tasks) {
    if (this.list().length > 0) return this.list();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const spec of tasks) {
        const ts = spec.created_at ?? now();
        this.db
          .prepare(
            `INSERT INTO tasks (
              id, title, phase, description, priority, status, owner, depends_on,
              allowed_paths, acceptance_criteria, test_commands, branch, worktree,
              last_commit, attempts, lease_expires_at, created_at, updated_at,
              blocking_reason, objective, tests_passed, test_summary
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            spec.id,
            spec.title,
            spec.phase,
            spec.description ?? "",
            spec.priority ?? "medium",
            spec.status ?? "READY",
            spec.owner ?? null,
            JSON.stringify(spec.depends_on ?? []),
            JSON.stringify(spec.allowed_paths ?? []),
            JSON.stringify(spec.acceptance_criteria ?? []),
            JSON.stringify(spec.test_commands ?? []),
            spec.branch ?? null,
            spec.worktree ?? null,
            spec.last_commit ?? null,
            spec.attempts ?? 0,
            spec.lease_expires_at ?? null,
            ts,
            spec.updated_at ?? ts,
            spec.blocking_reason ?? null,
            spec.objective ?? null,
            spec.tests_passed ? 1 : 0,
            spec.test_summary ?? null,
          );
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    this._event("restore", null, null, `${tasks.length} tasks`);
    return this.list();
  }

  get(id) {
    return rowToTask(this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(id));
  }

  list() {
    return this.db
      .prepare("SELECT * FROM tasks ORDER BY phase, id")
      .all()
      .map(rowToTask);
  }

  _depsMet(task) {
    for (const dep of task.depends_on) {
      const other = this.get(dep);
      if (!other || other.status !== "DONE") return dep;
    }
    return null;
  }

  claim({ id, owner, ttlMs = 60 * 60 * 1000, branch = null, worktree = null, objective = null }) {
    if (!owner) throw new Error("claim requires an owner");
    const ts = now();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const task = this.get(id);
      if (!task) throw new Error(`unknown task ${id}`);
      if (task.status === "DONE" || task.status === "CANCELLED") {
        throw new Error(`task ${id} is ${task.status}`);
      }
      const unmet = this._depsMet(task);
      if (unmet) throw new Error(`dependency ${unmet} is not DONE`);
      const leaseLive =
        task.status === "DOING" &&
        task.lease_expires_at != null &&
        task.lease_expires_at > ts &&
        task.owner &&
        task.owner !== owner;
      if (leaseLive) {
        throw new Error(`task ${id} is leased by ${task.owner} until ${task.lease_expires_at}`);
      }
      const expires = ts + ttlMs;
      this.db
        .prepare(
          `UPDATE tasks SET status = 'DOING', owner = ?, lease_expires_at = ?,
           attempts = attempts + 1, branch = COALESCE(?, branch),
           worktree = COALESCE(?, worktree), objective = COALESCE(?, objective),
           blocking_reason = NULL, tests_passed = 0, updated_at = ? WHERE id = ?`,
        )
        .run(owner, expires, branch, worktree, objective, ts, id);
      this.db
        .prepare(
          "INSERT INTO heartbeats (owner, ts, task_id) VALUES (?, ?, ?) ON CONFLICT(owner) DO UPDATE SET ts = excluded.ts, task_id = excluded.task_id",
        )
        .run(owner, ts, id);
      this._event("claim", id, owner, objective);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return this.get(id);
  }

  heartbeat(owner) {
    const ts = now();
    const beat = this.db.prepare("SELECT task_id FROM heartbeats WHERE owner = ?").get(owner);
    if (!beat) throw new Error(`no heartbeat slot for ${owner}`);
    this.db.prepare("UPDATE heartbeats SET ts = ? WHERE owner = ?").run(ts, owner);
    const task = beat.task_id ? this.get(beat.task_id) : null;
    if (task && task.owner === owner && task.status === "DOING" && task.lease_expires_at) {
      const extension = Math.max(task.lease_expires_at, ts + 60 * 60 * 1000);
      this.db
        .prepare("UPDATE tasks SET lease_expires_at = ?, updated_at = ? WHERE id = ?")
        .run(extension, ts, task.id);
    }
    this._event("heartbeat", beat.task_id, owner, null);
    return { owner, ts, task_id: beat.task_id };
  }

  releaseExpired(at = now()) {
    const stale = this.db
      .prepare(
        "SELECT id, owner FROM tasks WHERE status = 'DOING' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?",
      )
      .all(at);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const row of stale) {
        this.db
          .prepare(
            `UPDATE tasks SET status = 'READY', owner = NULL, lease_expires_at = NULL,
             updated_at = ?, blocking_reason = NULL WHERE id = ? AND status = 'DOING'`,
          )
          .run(at, row.id);
        this._event("lease_expired", row.id, row.owner, "returned to READY");
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return stale.map((row) => row.id);
  }

  review(id, { testsPassed, summary, commit = null }) {
    const task = this.get(id);
    if (!task) throw new Error(`unknown task ${id}`);
    if (task.status !== "DOING" && task.status !== "REVIEW") {
      throw new Error(`task ${id} cannot enter REVIEW from ${task.status}`);
    }
    const ts = now();
    this.db
      .prepare(
        `UPDATE tasks SET status = 'REVIEW', tests_passed = ?, test_summary = ?,
         last_commit = COALESCE(?, last_commit), lease_expires_at = NULL, updated_at = ? WHERE id = ?`,
      )
      .run(testsPassed ? 1 : 0, summary ?? null, commit, ts, id);
    this._event("review", id, task.owner, summary ?? "");
    return this.get(id);
  }

  done(id) {
    const task = this.get(id);
    if (!task) throw new Error(`unknown task ${id}`);
    if (task.status !== "REVIEW") throw new Error(`task ${id} must be REVIEW before DONE`);
    if (!task.tests_passed) throw new Error(`task ${id} has no passing test record`);
    const ts = now();
    this.db
      .prepare(
        "UPDATE tasks SET status = 'DONE', owner = NULL, lease_expires_at = NULL, updated_at = ? WHERE id = ?",
      )
      .run(ts, id);
    this._event("done", id, null, task.test_summary);
    return this.get(id);
  }

  block(id, reason) {
    if (!reason) throw new Error("block requires a reason");
    const task = this.get(id);
    if (!task) throw new Error(`unknown task ${id}`);
    const ts = now();
    this.db
      .prepare(
        `UPDATE tasks SET status = 'BLOCKED', blocking_reason = ?, lease_expires_at = NULL, updated_at = ? WHERE id = ?`,
      )
      .run(reason, ts, id);
    this._event("blocked", id, task.owner, reason);
    return this.get(id);
  }

  ready(id) {
    const task = this.get(id);
    if (!task) throw new Error(`unknown task ${id}`);
    const ts = now();
    this.db
      .prepare(
        `UPDATE tasks SET status = 'READY', owner = NULL, lease_expires_at = NULL,
         blocking_reason = NULL, updated_at = ? WHERE id = ?`,
      )
      .run(ts, id);
    this._event("ready", id, null, null);
    return this.get(id);
  }

  checkpoint({ phase = null, taskId = null, commit = null, note, payload = null }) {
    const ts = now();
    this.db
      .prepare(
        "INSERT INTO checkpoints (ts, phase, task_id, commit_sha, note, payload) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(ts, phase, taskId, commit, note, payload ? JSON.stringify(payload) : null);
    const stamp = new Date(ts).toISOString().replace(/[:.]/g, "-");
    atomicWrite(
      path.join(this.agentDir, "checkpoints", `${stamp}.md`),
      `# Checkpoint ${new Date(ts).toISOString()}\n\n${note}\n\n- phase: ${phase ?? ""}\n- task: ${taskId ?? ""}\n- commit: ${commit ?? ""}\n`,
    );
    this._event("checkpoint", taskId, null, note);
  }

  highestEligible(at = now()) {
    this.releaseExpired(at);
    const tasks = this.list();
    const rank = { high: 0, medium: 1, low: 2 };
    const open = tasks
      .filter((task) => task.status === "READY" || task.status === "BLOCKED")
      .filter((task) => task.status !== "BLOCKED")
      .filter((task) => this._depsMet(task) == null)
      .sort((a, b) => a.phase - b.phase || (rank[a.priority] ?? 9) - (rank[b.priority] ?? 9) || a.id.localeCompare(b.id));
    return open[0] ?? null;
  }

  snapshot(git = {}) {
    const tasks = this.list();
    const counts = Object.fromEntries(TASK_STATUSES.map((status) => [status, 0]));
    for (const task of tasks) counts[task.status] = (counts[task.status] ?? 0) + 1;
    const doing = tasks.filter((task) => task.status === "DOING");
    const lastDone = [...tasks].reverse().find((task) => task.status === "DONE");
    const next = this.highestEligible();

    const board = [
      "# Task board",
      "",
      "Authoritative state is `.agent/runtime/board.db`. This file is a snapshot.",
      "",
      `| Status | Count |`,
      `| --- | ---: |`,
      ...TASK_STATUSES.map((status) => `| ${status} | ${counts[status] ?? 0} |`),
      "",
      "| ID | Phase | Priority | Status | Owner | Title |",
      "| --- | ---: | --- | --- | --- | --- |",
      ...tasks.map(
        (task) =>
          `| ${task.id} | ${task.phase} | ${task.priority} | ${task.status} | ${task.owner ?? ""} | ${task.title.replaceAll("|", "/")} |`,
      ),
      "",
    ].join("\n");

    const taskDump = tasks
      .map((task) => {
        const yaml = [
          "```yaml",
          `id: ${task.id}`,
          `title: ${JSON.stringify(task.title)}`,
          `phase: ${task.phase}`,
          `description: ${JSON.stringify(task.description)}`,
          `priority: ${task.priority}`,
          `status: ${task.status}`,
          `owner: ${task.owner ?? "null"}`,
          `depends_on: ${JSON.stringify(task.depends_on)}`,
          `allowed_paths: ${JSON.stringify(task.allowed_paths)}`,
          `acceptance_criteria: ${JSON.stringify(task.acceptance_criteria)}`,
          `test_commands: ${JSON.stringify(task.test_commands)}`,
          `branch: ${task.branch ?? "null"}`,
          `worktree: ${task.worktree ?? "null"}`,
          `last_commit: ${task.last_commit ?? "null"}`,
          `attempts: ${task.attempts}`,
          `lease_expires_at: ${task.lease_expires_at ?? "null"}`,
          `created_at: ${task.created_at}`,
          `updated_at: ${task.updated_at}`,
          `blocking_reason: ${task.blocking_reason ?? "null"}`,
          `tests_passed: ${task.tests_passed}`,
          "```",
          "",
        ];
        return yaml.join("\n");
      })
      .join("\n");

    const phase = doing[0]?.phase ?? next?.phase ?? lastDone?.phase ?? 0;
    const state = [
      "# State",
      "",
      `Updated: ${new Date().toISOString()}`,
      "",
      `- Current phase: ${phase}`,
      `- Tasks in DOING: ${doing.map((task) => task.id).join(", ") || "none"}`,
      `- Last completed: ${lastDone?.id ?? "none"}`,
      `- Next eligible: ${next?.id ?? "none"}`,
      `- Branch: ${git.branch ?? doing[0]?.branch ?? ""}`,
      `- Commit: ${git.commit ?? ""}`,
      "",
      "Counts:",
      "",
      ...TASK_STATUSES.map((status) => `- ${status}: ${counts[status] ?? 0}`),
      "",
    ].join("\n");

    const resume = [
      "Current phase:",
      String(phase),
      "Current task:",
      doing.map((task) => `${task.id} ${task.title} owner=${task.owner}`).join("; ") || "none",
      "Last completed task:",
      lastDone ? `${lastDone.id} ${lastDone.title}` : "none",
      "Current branch:",
      git.branch ?? doing[0]?.branch ?? "",
      "Active worktree:",
      git.worktree ?? doing[0]?.worktree ?? this.root,
      "Last successful commit:",
      git.commit ?? lastDone?.last_commit ?? "",
      "Last passing tests:",
      tasks
        .filter((task) => task.tests_passed && task.test_summary)
        .map((task) => `${task.id}: ${task.test_summary}`)
        .slice(-8)
        .join("\n") || "none recorded",
      "Known failures:",
      tasks
        .filter((task) => task.status === "BLOCKED")
        .map((task) => `${task.id}: ${task.blocking_reason}`)
        .join("\n") || "none",
      "Uncommitted changes:",
      git.dirty ?? "inspect git status",
      "Recovery instructions:",
      [
        "1. Read .agent/AGENTS.md, .agent/STATE.md and this file.",
        "2. Open .agent/runtime/board.db with tools/coordinator/board.mjs.",
        "3. Run `node tools/coordinator/board.mjs release-expired`.",
        "4. Run `node tools/coordinator/board.mjs recover`.",
        "5. Claim the highest READY task whose dependencies are DONE.",
        "6. Do not mark a task DONE without a recorded passing test.",
      ].join(" "),
      "Next executable action:",
      next ? `Claim ${next.id} — ${next.title}` : "No READY task. Inspect BLOCKERS.md.",
      "",
    ].join("\n");

    atomicWrite(path.join(this.agentDir, "BOARD.md"), board);
    atomicWrite(path.join(this.agentDir, "TASKS.md"), `# Tasks\n\n${taskDump}`);
    atomicWrite(path.join(this.agentDir, "STATE.md"), state);
    atomicWrite(path.join(this.agentDir, "RESUME.md"), resume);
    atomicWrite(path.join(this.agentDir, "board.json"), `${JSON.stringify(tasks, null, 2)}\n`);
    return { counts, doing: doing.map((task) => task.id), next: next?.id ?? null };
  }
}

export const SEED_TASKS = [
  {
    id: "AZC-001",
    phase: 0,
    priority: "high",
    title: "Repository discovery and feature inventory",
    description: "Inspect the Python gateway, generator, tests, and docs. Write FEATURE_INVENTORY.md from source, not from the README alone.",
    acceptance_criteria: ["FEATURE_INVENTORY.md lists each feature group with source files and a status"],
    test_commands: ["node tools/coordinator/board.mjs status"],
    allowed_paths: ["docs/rewrite/FEATURE_INVENTORY.md"],
  },
  {
    id: "AZC-002",
    phase: 0,
    priority: "high",
    title: "Record the original offline test baseline",
    description: "Run the existing pytest suite and record pass, fail, and skip counts without inventing results.",
    acceptance_criteria: ["PERFORMANCE_BASELINE.md or the audit records the actual pytest summary"],
    test_commands: [".venv/bin/python -m pytest tests -q --tb=no"],
    allowed_paths: ["docs/rewrite/"],
  },
  {
    id: "AZC-003",
    phase: 0,
    priority: "high",
    title: "Architecture, compatibility, security, and roadmap documents",
    description: "Write the Phase 0 audit set from inspected behavior.",
    depends_on: ["AZC-001"],
    acceptance_criteria: ["docs/rewrite contains the required audit files"],
    test_commands: ["test -f docs/rewrite/ARCHITECTURE_AUDIT.md"],
    allowed_paths: ["docs/rewrite/"],
  },
  {
    id: "AZC-010",
    phase: 1,
    priority: "high",
    title: "SQLite task coordinator with exclusive leases",
    description: "Authoritative board in .agent/runtime/board.db with transactional claim, heartbeat, and expiry.",
    acceptance_criteria: ["A second owner cannot claim a live lease", "Expired leases return to READY and are not marked DONE"],
    test_commands: ["node --experimental-strip-types --test tools/coordinator/board.test.mjs"],
    allowed_paths: ["tools/coordinator/", ".agent/", ".gitignore"],
  },
  {
    id: "AZC-011",
    phase: 1,
    priority: "high",
    title: "Crash-recovery protocol and markdown snapshots",
    description: "Snapshot BOARD, TASKS, STATE, and RESUME. Recover expired leases idempotently.",
    depends_on: ["AZC-010"],
    acceptance_criteria: ["RESUME.md contains the required fields", "release-expired does not mark tasks DONE"],
    test_commands: ["node --experimental-strip-types --test tools/coordinator/board.test.mjs"],
    allowed_paths: ["tools/coordinator/", ".agent/"],
  },
  {
    id: "AZC-020",
    phase: 2,
    priority: "high",
    title: "TypeScript workspace layout",
    description: "Monorepo for the Electron, Vue, and Node rewrite beside the untouched Python tree.",
    depends_on: ["AZC-010"],
    acceptance_criteria: ["packages and apps exist and the Python tree is still present"],
    test_commands: ["test -f package.json", "test -f zcode_gateway/app.py"],
    allowed_paths: ["package.json", "tsconfig.json", "apps/", "packages/"],
  },
  {
    id: "AZC-021",
    phase: 2,
    priority: "high",
    title: "Port protocol translation and upstream body builder",
    description: "TypeScript port of Anthropic/OpenAI translation, ZCode body construction, and error classification.",
    depends_on: ["AZC-020"],
    acceptance_criteria: ["Translation tests cover the legacy translate cases and body rules"],
    test_commands: ["node --experimental-strip-types --test packages/protocols/src/translate.test.ts"],
    allowed_paths: ["packages/protocols/"],
  },
  {
    id: "AZC-022",
    phase: 2,
    priority: "high",
    title: "Account pool, snapshot loader, and usage store",
    description: "Port selection strategies, accounts/*.txt loading, and the usage SQLite schema.",
    depends_on: ["AZC-020"],
    acceptance_criteria: ["Pool and store tests pass, including drain-first and malformed snapshots"],
    test_commands: ["node --experimental-strip-types --test packages/pool/src/pool.test.ts packages/database/src/store.test.ts"],
    allowed_paths: ["packages/pool/", "packages/database/"],
  },
  {
    id: "AZC-023",
    phase: 3,
    priority: "high",
    title: "Node gateway HTTP surface with mock upstream",
    description: "OpenAI and Anthropic routes, auth, health, streaming translation, overload retry before output, and explicit refusal of account-generation routes.",
    depends_on: ["AZC-021", "AZC-022"],
    acceptance_criteria: ["Contract tests pass against an in-process mock upstream", "Claim and generator routes return 410"],
    test_commands: ["node --experimental-strip-types --test apps/gateway/src/server.test.ts"],
    allowed_paths: ["apps/gateway/"],
  },
  {
    id: "AZC-024",
    phase: 5,
    priority: "high",
    title: "Electron shell and Vue dashboard",
    description: "Context-isolated Electron window, Vue pages for overview, accounts, models, usage, and settings, bound to the local gateway.",
    depends_on: ["AZC-023"],
    acceptance_criteria: ["Desktop project typechecks or builds", "Renderer has no Node integration"],
    test_commands: ["npm run build -w @azc/desktop"],
    allowed_paths: ["apps/desktop/", "DESIGN.md"],
  },
  {
    id: "AZC-030",
    phase: 3,
    priority: "medium",
    title: "Quota parking, rotation, and disconnect handling",
    description: "Match per-model park behavior for 405/3012, 402/11113, and 429, and stop retries after client-visible output.",
    depends_on: ["AZC-023"],
    acceptance_criteria: ["Gateway tests cover park, rotate, and no-retry-after-output"],
    test_commands: ["node --experimental-strip-types --test apps/gateway/src/server.test.ts"],
    allowed_paths: ["apps/gateway/", "packages/pool/"],
  },
  {
    id: "AZC-040",
    phase: 4,
    priority: "medium",
    title: "Import the user's own ZCode credential file",
    description: "Read ~/.zcode credentials, decrypt enc:v1 blobs only for the local user, and write account snapshots. Never log tokens.",
    depends_on: ["AZC-022"],
    acceptance_criteria: ["Round-trip test with a synthetic AES-GCM fixture", "Tokens absent from logs"],
    test_commands: ["node --experimental-strip-types --test packages/pool/src/credentials.test.ts"],
    allowed_paths: ["packages/pool/"],
  },
  {
    id: "AZC-041",
    phase: 4,
    priority: "medium",
    title: "User-present device login",
    description: "Official OAuth poll flow. The user approves in a browser. No automated signup.",
    depends_on: ["AZC-023"],
    acceptance_criteria: ["Login state machine tested with a mock OAuth server"],
    test_commands: ["node --experimental-strip-types --test apps/gateway/src/login.test.ts"],
    allowed_paths: ["apps/gateway/"],
  },
  {
    id: "AZC-050",
    phase: 5,
    priority: "medium",
    title: "Dashboard journeys on live gateway data",
    description: "Overview, accounts, models, usage, and settings read the running gateway. No permanent mock data.",
    depends_on: ["AZC-024", "AZC-023"],
    acceptance_criteria: ["UI builds", "Empty and error states render"],
    test_commands: ["npm run build -w @azc/desktop"],
    allowed_paths: ["apps/desktop/"],
  },
  {
    id: "AZC-060",
    phase: 6,
    priority: "high",
    title: "Record unsupported generator workflows",
    description: "Do not port CAPTCHA solving, bulk signup, or promotional credit claims. Document the compliant alternative: import or device-login of accounts the user owns.",
    depends_on: ["AZC-003"],
    acceptance_criteria: ["API_COMPATIBILITY.md and the gateway both say these routes are unsupported"],
    test_commands: ["node --experimental-strip-types --test apps/gateway/src/server.test.ts"],
    allowed_paths: ["docs/rewrite/", "apps/gateway/"],
  },
  {
    id: "AZC-070",
    phase: 7,
    priority: "medium",
    title: "Legacy data migration and backup restore",
    description: "Copy config, account snapshots, usage SQLite, and relay settings into the new data directory. Never mutate the source.",
    depends_on: ["AZC-022", "AZC-023"],
    acceptance_criteria: ["Migration tests use sanitized fixtures and roll back on failure"],
    test_commands: ["node --experimental-strip-types --test packages/database/src/migrate.test.ts"],
    allowed_paths: ["packages/database/", "apps/gateway/"],
  },
  {
    id: "AZC-080",
    phase: 8,
    priority: "medium",
    title: "Failure injection and measured performance",
    description: "Exercise upstream timeout, worker crash, and unclean SQLite shutdown. Record only measurements that were actually taken.",
    depends_on: ["AZC-023", "AZC-030"],
    acceptance_criteria: ["PERFORMANCE_RESULTS.md contains real numbers or an explicit not-measured marker"],
    test_commands: ["node --experimental-strip-types --test apps/gateway/src/failure.test.ts"],
    allowed_paths: ["apps/gateway/", "docs/rewrite/PERFORMANCE_RESULTS.md"],
  },
  {
    id: "AZC-090",
    phase: 9,
    priority: "medium",
    title: "Electron Builder packaging configuration",
    description: "Configure macOS, Windows, and Linux packages. Do not claim a platform was tested unless it was.",
    depends_on: ["AZC-024"],
    acceptance_criteria: ["electron-builder config exists", "Unverified targets are labeled unverified"],
    test_commands: ["test -f apps/desktop/electron-builder.yml"],
    allowed_paths: ["apps/desktop/"],
  },
  {
    id: "AZC-100",
    phase: 10,
    priority: "medium",
    title: "GitHub Actions for the rewrite",
    description: "CI runs the Node test suite on pull requests. Release workflow stays a draft until signing secrets exist.",
    depends_on: ["AZC-023", "AZC-010"],
    acceptance_criteria: ["ci.yml runs unit and gateway tests"],
    test_commands: ["test -f .github/workflows/ci.yml"],
    allowed_paths: [".github/workflows/"],
  },
  {
    id: "AZC-110",
    phase: 11,
    priority: "low",
    title: "Final parity audit and delivery report",
    description: "Write FINAL_DELIVERY_REPORT.md only after the supported feature set is verified. Do not invent artifact verification.",
    depends_on: ["AZC-023", "AZC-024", "AZC-060", "AZC-070", "AZC-090", "AZC-100"],
    acceptance_criteria: ["Report separates verified, unverified, and intentionally unsupported items"],
    test_commands: ["test -f docs/rewrite/FINAL_DELIVERY_REPORT.md"],
    allowed_paths: ["docs/rewrite/FINAL_DELIVERY_REPORT.md"],
  },
];
