#!/usr/bin/env node
/**
 * Task board CLI.
 * Usage: node tools/coordinator/board.mjs <command> [args]
 */
import { execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Coordinator, SEED_TASKS } from "./lib.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function gitInfo() {
  const run = (cmd) => {
    try {
      return execSync(cmd, { cwd: root, encoding: "utf8" }).trim();
    } catch {
      return "";
    }
  };
  const dirty = run("git status --porcelain");
  return {
    branch: run("git rev-parse --abbrev-ref HEAD"),
    commit: run("git rev-parse --short HEAD"),
    worktree: run("git rev-parse --show-toplevel"),
    dirty: dirty ? `${dirty.split("\n").length} path(s) dirty` : "clean",
  };
}

function arg(name, fallback = null) {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  return process.argv[index + 1] ?? fallback;
}

function has(flag) {
  return process.argv.includes(flag);
}

const [command, positional] = process.argv.slice(2);
const board = new Coordinator(root);

try {
  switch (command) {
    case "init":
    case "seed": {
      board.seed(SEED_TASKS);
      const snap = board.snapshot(gitInfo());
      console.log(`seeded ${board.list().length} tasks; next=${snap.next ?? "none"}`);
      break;
    }
    case "status": {
      const tasks = board.list();
      if (tasks.length === 0) {
        console.log("board is empty — run: node tools/coordinator/board.mjs seed");
        break;
      }
      for (const task of tasks) {
        console.log(
          `${task.status.padEnd(9)} ${task.id} p${task.phase} ${task.owner ?? "-"} ${task.title}`,
        );
      }
      break;
    }
    case "claim": {
      const task = board.claim({
        id: positional,
        owner: arg("--owner"),
        ttlMs: Number(arg("--ttl-ms", String(2 * 60 * 60 * 1000))),
        branch: arg("--branch", gitInfo().branch),
        worktree: arg("--worktree", root),
        objective: arg("--objective"),
      });
      board.snapshot(gitInfo());
      console.log(`DOING ${task.id} owner=${task.owner} attempt=${task.attempts}`);
      break;
    }
    case "heartbeat": {
      const beat = board.heartbeat(arg("--owner"));
      console.log(`heartbeat ${beat.owner} task=${beat.task_id}`);
      break;
    }
    case "review": {
      const task = board.review(positional, {
        testsPassed: has("--pass"),
        summary: arg("--summary", ""),
        commit: arg("--commit", gitInfo().commit),
      });
      board.snapshot(gitInfo());
      console.log(`REVIEW ${task.id} tests_passed=${task.tests_passed}`);
      break;
    }
    case "done": {
      const task = board.done(positional);
      board.snapshot(gitInfo());
      console.log(`DONE ${task.id}`);
      break;
    }
    case "block": {
      const task = board.block(positional, arg("--reason"));
      board.snapshot(gitInfo());
      console.log(`BLOCKED ${task.id}: ${task.blocking_reason}`);
      break;
    }
    case "ready": {
      const task = board.ready(positional);
      board.snapshot(gitInfo());
      console.log(`READY ${task.id}`);
      break;
    }
    case "release-expired": {
      const ids = board.releaseExpired();
      board.snapshot(gitInfo());
      console.log(ids.length ? `released ${ids.join(", ")}` : "no expired leases");
      break;
    }
    case "snapshot": {
      const snap = board.snapshot(gitInfo());
      console.log(`snapshot next=${snap.next ?? "none"} doing=${snap.doing.join(",") || "none"}`);
      break;
    }
    case "recover": {
      const released = board.releaseExpired();
      const snap = board.snapshot(gitInfo());
      console.log(
        `recovered expired=${released.join(",") || "none"} next=${snap.next ?? "none"}`,
      );
      break;
    }
    case "checkpoint": {
      board.checkpoint({
        phase: arg("--phase") ? Number(arg("--phase")) : null,
        taskId: arg("--task"),
        commit: gitInfo().commit,
        note: arg("--note", "checkpoint"),
      });
      board.snapshot(gitInfo());
      console.log("checkpoint saved");
      break;
    }
    default:
      console.error(
        "commands: init|seed, status, claim, heartbeat, review, done, block, ready, release-expired, snapshot, recover, checkpoint",
      );
      process.exitCode = 2;
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  board.close();
}
