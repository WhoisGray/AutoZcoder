Current phase:
3
Current task:
none
Last completed task:
AZC-100 GitHub Actions for the rewrite
Current branch:
rewrite/electron-vue-node
Active worktree:
/Users/paliz/Downloads/هحسثززز/zcode
Last successful commit:
4170159
Last passing tests:
AZC-011: RESUME.md contract covered by coordinator tests
AZC-020: workspaces apps/* and packages/*; Python tree still present
AZC-021: packages/protocols tests passed inside npm test
AZC-022: pool and usage store tests passed inside npm test
AZC-023: gateway server.test.ts passed; npm test 29 passed, 0 failed
AZC-024: vite build -w @azc/desktop succeeded in 618ms; Electron binary not launched
AZC-060: claim and generator routes return 410; documented in API_COMPATIBILITY.md
AZC-100: rewrite job added to .github/workflows/ci.yml; GitHub has not run it
Known failures:
none
Uncommitted changes:
3 path(s) dirty
Recovery instructions:
1. Read .agent/AGENTS.md, .agent/STATE.md and this file. 2. Open .agent/runtime/board.db with tools/coordinator/board.mjs. 3. Run `node tools/coordinator/board.mjs release-expired`. 4. Run `node tools/coordinator/board.mjs recover`. 5. Claim the highest READY task whose dependencies are DONE. 6. Do not mark a task DONE without a recorded passing test.
Next executable action:
Claim AZC-030 — Quota parking, rotation, and disconnect handling
