# Architecture audit

Inspected `f06d5ff` on 2026-10-31. The Python application is still the default on `master`. The rewrite lives on `rewrite/electron-vue-node` and does not replace those files.

## What the current process does

`zcode_gateway/app.py` builds one FastAPI process:

- OpenAI routes, Anthropic routes, admin routes, dashboard routes, and health routes share one `AppState`.
- `ChatService` selects an account, builds an Anthropic request in `zcode_protocol.build_body`, and posts it to `upstream.base_url + chat_path` (default `https://zcode.z.ai/api/v1/zcode-plan/anthropic/v1/messages`).
- The upstream speaks Anthropic SSE. OpenAI clients are adapted at the edge.
- `PoolManager` keeps account state in memory. Per-model parks are also written to `model-caps.json`.
- `Store` appends a usage row to SQLite. Bodies are captured to JSONL only when `logging.capture` is on.
- `gui.py` is a pywebview shell. The packaged build is PyInstaller (`build.py`, `ZcodeGateway-macos.spec`).
- `generator/` is a separate Playwright pipeline started as a subprocess by `zcode_gateway/generator.py`. It is optional in config (`generator.enabled` defaults false in code, and the example file shows a referral code).

The dashboard is one HTML file served at `/dash`. Admin calls use the admin key. There is intentionally no CORS middleware (`app.py`).

## Boundaries to keep

| Boundary | Decision |
| --- | --- |
| Electron main | Window, single instance, navigation lock, child-process supervision. No request proxying on the UI thread |
| Gateway process | Node `http` server. Can run without Electron via `npm run start:gateway` |
| Protocol package | Pure functions: body builder, translators, error classes, retry math |
| Pool package | Account records, strategies, snapshot files |
| Database package | Usage SQLite through `node:sqlite` |
| Renderer | Vue 3, no Node integration, context isolation on |

Python stays in the tree until the rewrite covers the supported features and the old tests still pass. This session's pytest run is recorded in `PERFORMANCE_BASELINE.md`.

## Request path in the rewrite

1. The client sends `/v1/chat/completions` or `/v1/messages` with a bearer key.
2. The gateway checks the key with a SHA-256 compare.
3. `buildBody` produces the Anthropic payload, including the captured bootstrap system blocks, and forces `stream: true`.
4. The pool acquires an account. Headers carry the account token as `authorization` and `x-api-key`, plus the captured ZCode client headers.
5. The upstream response is parsed as SSE. Failures before a successful message can rotate or retry. A 529 uses the capped backoff.
6. OpenAI clients receive translated chunks, or one aggregated completion. Anthropic clients receive the accumulated message.
7. A usage row is written. Public account views keep only a token hint.

The current gateway reads the upstream body to completion before it writes the client response. That preserves status codes for pre-output failures. Chunk-by-chunk client streaming and disconnect cancellation are still open under task `AZC-030`.

## Not adopted

- Packaging the Python interpreter or calling `python` for generator jobs.
- Automated CAPTCHA solving, bulk signup, and promotional claims. See `FEATURE_INVENTORY.md`.
- Wildcard CORS.
- Renderer access to the filesystem or to `child_process`.
