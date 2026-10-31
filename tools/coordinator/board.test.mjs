import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Coordinator } from "./lib.mjs";

function tempBoard() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "azc-board-"));
  const board = new Coordinator(root);
  board.seed([
    {
      id: "AZC-001",
      phase: 0,
      priority: "high",
      title: "First",
      description: "base",
      acceptance_criteria: ["exists"],
      test_commands: ["node --test"],
    },
    {
      id: "AZC-002",
      phase: 1,
      priority: "high",
      title: "Second",
      description: "depends",
      depends_on: ["AZC-001"],
      acceptance_criteria: ["after first"],
      test_commands: ["node --test"],
    },
  ]);
  return { root, board };
}

test("exclusive lease rejects a second owner", () => {
  const { board } = tempBoard();
  board.claim({ id: "AZC-001", owner: "alpha", ttlMs: 60_000 });
  assert.throws(
    () => board.claim({ id: "AZC-001", owner: "beta", ttlMs: 60_000 }),
    /leased by alpha/,
  );
  assert.equal(board.get("AZC-001").status, "DOING");
  board.close();
});

test("expired lease returns to READY and can be reclaimed, never DONE", () => {
  const { board } = tempBoard();
  board.claim({ id: "AZC-001", owner: "alpha", ttlMs: 1_000 });
  const released = board.releaseExpired(Date.now() + 5_000);
  assert.deepEqual(released, ["AZC-001"]);
  const task = board.get("AZC-001");
  assert.equal(task.status, "READY");
  assert.equal(task.owner, null);
  assert.notEqual(task.status, "DONE");
  const reclaimed = board.claim({ id: "AZC-001", owner: "beta", ttlMs: 60_000 });
  assert.equal(reclaimed.owner, "beta");
  assert.equal(reclaimed.status, "DOING");
  assert.throws(
    () => board.claim({ id: "AZC-002", owner: "beta", ttlMs: 1_000 }),
    /dependency AZC-001/,
  );
  board.close();
});

test("dependency blocks the downstream task until the upstream is DONE", () => {
  const { board } = tempBoard();
  assert.throws(
    () => board.claim({ id: "AZC-002", owner: "alpha" }),
    /dependency AZC-001/,
  );
  board.claim({ id: "AZC-001", owner: "alpha" });
  board.review("AZC-001", { testsPassed: true, summary: "1 passed" });
  board.done("AZC-001");
  const next = board.claim({ id: "AZC-002", owner: "beta" });
  assert.equal(next.status, "DOING");
  assert.equal(next.owner, "beta");
  board.close();
});

test("DONE requires REVIEW and a passing test record", () => {
  const { board } = tempBoard();
  board.claim({ id: "AZC-001", owner: "alpha" });
  assert.throws(() => board.done("AZC-001"), /REVIEW/);
  board.review("AZC-001", { testsPassed: false, summary: "failed" });
  assert.throws(() => board.done("AZC-001"), /passing test/);
  board.review("AZC-001", { testsPassed: true, summary: "ok" });
  assert.equal(board.done("AZC-001").status, "DONE");
  board.close();
});

test("snapshot writes the resume contract and recovery does not complete work", () => {
  const { root, board } = tempBoard();
  board.claim({ id: "AZC-001", owner: "alpha", ttlMs: 1_000, objective: "write audit" });
  board.snapshot({ branch: "rewrite/electron-vue-node", commit: "abc123", dirty: "2 paths" });
  const resume = fs.readFileSync(path.join(root, ".agent", "RESUME.md"), "utf8");
  for (const label of [
    "Current phase:",
    "Current task:",
    "Last completed task:",
    "Current branch:",
    "Active worktree:",
    "Last successful commit:",
    "Last passing tests:",
    "Known failures:",
    "Uncommitted changes:",
    "Recovery instructions:",
    "Next executable action:",
  ]) {
    assert.ok(resume.includes(label), label);
  }
  assert.match(resume, /AZC-001/);
  board.releaseExpired(Date.now() + 10_000);
  const recovered = fs.readFileSync(path.join(root, ".agent", "RESUME.md"), "utf8");
  board.snapshot({ branch: "rewrite/electron-vue-node", commit: "abc123", dirty: "clean" });
  const after = fs.readFileSync(path.join(root, ".agent", "RESUME.md"), "utf8");
  assert.equal(board.get("AZC-001").status, "READY");
  assert.doesNotMatch(after, /status: DONE/);
  assert.ok(recovered.length > 0);
  const wal = fs.readdirSync(path.join(root, ".agent", "runtime")).some((name) => name.includes("board.db"));
  assert.equal(wal, true);
  board.close();
});

test("same owner can refresh an unexpired lease", () => {
  const { board } = tempBoard();
  board.claim({ id: "AZC-001", owner: "alpha", ttlMs: 60_000 });
  const again = board.claim({ id: "AZC-001", owner: "alpha", ttlMs: 60_000 });
  assert.equal(again.attempts, 2);
  assert.equal(again.status, "DOING");
  board.close();
});
