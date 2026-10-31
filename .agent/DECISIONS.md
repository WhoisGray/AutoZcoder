# Decisions

## D1 — Branch

Rewrite work is committed on `rewrite/electron-vue-node`. `master` stays at the original Python application.

## D2 — Unsupported generator

Automated signup, CAPTCHA solving, proxy harvesting for signup, and promotional credit claims are not part of the Node application. Old routes return HTTP 410 with `feature_not_supported`. Users add accounts they already own.

## D3 — Runtime

Gateway code uses Node's built-in SQLite, HTTP, and TypeScript stripper so the test suite does not need a package install. The desktop UI uses Vite, Vue 3, Pinia, Vue Router, and Tailwind. Electron supervises the gateway as a child process.

## D4 — Upstream reads

The first gateway buffers the upstream body before writing to the client. Pre-output failures keep a real HTTP status. Incremental streaming is unfinished.

## D5 — Coordinator

`.agent/runtime/board.db` is authoritative. Markdown under `.agent/` is a snapshot. A task cannot become `DONE` without a recorded passing test.
