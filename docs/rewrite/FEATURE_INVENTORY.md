# Feature inventory

Source of truth: the Python tree on `master` at `f06d5ff`, inspected in this working copy. Status values: `DISCOVERED`, `PLANNED`, `IN_PROGRESS`, `IMPLEMENTED`, `TESTED`, `VERIFIED`.

`VERIFIED` means exercised against a live upstream or a packaged install. Nothing in the rewrite is `VERIFIED` yet. The Node tests use a mock upstream.

## Gateway

| Feature | Sources | Behavior | Tests | Config / storage | Rewrite | Status |
| --- | --- | --- | --- | --- | --- | --- |
| OpenAI chat completions | `api_openai.py`, `service.py`, `zcode_protocol.py` | Builds an Anthropic body, reads the upstream SSE stream, returns a chat completion or OpenAI SSE | `tests/test_zcode_core.py`; rewrite `server.test.ts` | `config.yaml` upstream and models | `apps/gateway`, `packages/protocols` | TESTED against a mock |
| Legacy completions | `api_openai.py` | Prompt becomes one user message; non-stream response is `text_completion` | rewrite gateway test | same | same | TESTED against a mock |
| Model list | `registry.py`, `api_openai.py` | `GLM-5.3` and `GLM-5.3-Flash`, plus aliases | rewrite gateway test | `models.aliases` | `packages/protocols/src/registry.ts` | TESTED |
| Anthropic messages | `api_anthropic.py`, `translate_anthropic.py` | Native body is preserved, bootstrap system blocks are added, non-stream returns a message | `tests/test_translate_anthropic.py`; rewrite tests | same | protocol + gateway | TESTED against a mock |
| Token count | `api_anthropic.py` | Local estimate, about 4 characters per token. Upstream has no counter | rewrite gateway test | none | gateway | TESTED |
| Streaming frames | `service.py`, `aggregate.py` | Anthropic events become OpenAI chunks. `[DONE]` closes the OpenAI stream. A cut after content is not replayed; a cut before content is retried | `tests/test_stream_retry.py`; rewrite stream tests | none | gateway | TESTED for the buffered path |
| Overload retry | `model_retry.py`, `service.py` | HTTP 529 / code 1305 retries before output, capped delay. A client disconnect during the wait stops the next attempt | `tests/test_model_retry.py`; rewrite test | `upstream.overload_*` | `packages/protocols/src/retry.ts` | TESTED |
| Unusual activity park | `pool.py`, `service.py`, `docs/UNUSUAL-ACTIVITY.md` | 405 / code 3012 parks that model on that account only and the request rotates | `tests/test_model_caps_persist.py`; rewrite test | `pool.blocked_model_cooldown_seconds`, `model-caps.json` | in-memory park. Disk persistence is not ported | TESTED in memory |
| Quota park and rotation | `service.py`, `pool.py` | 402 / 11113 / 1005 parks that model until its reset, for 600s when the ledger still shows balance, or exhausts the account after three empty-ledger strikes. The same request uses the next account | `tests/test_zcode_core.py`, `tests/test_hardening_round.py`; rewrite gateway tests | in-memory caps | gateway `quotaPark` | TESTED against a mock |
| Auth | `deps.py` | Client key or admin key. Missing key is 401 in the caller's dialect. No CORS middleware | `tests/test_auth_and_complete.py`; rewrite test | `server.client_keys`, `server.admin_key` | gateway | TESTED |
| Health, ready, metrics | `api_health.py` | `/ready` is 503 when no account is usable | rewrite test | `gateway.db` | gateway + `UsageStore` | TESTED |
| Usage ledger | `store.py` | SQLite `usage` table and summary | rewrite `store.test.ts` | `store.sqlite_path` | `packages/database` | TESTED |
| Account pool strategies | `pool.py` | drain-first, least-in-flight, round-robin, LRU, quota-aware | `tests/test_acquire_wait.py`; rewrite pool tests | `pool.strategy` | `packages/pool` | TESTED for drain-first, round-robin, least-in-flight, cap |
| Snapshot accounts | `accounts_dir.py` | `accounts/*.txt` key-value files. Bad expiry is skipped. Duplicate ids keep the newer token | `tests/test_accounts_dir.py`; rewrite test | `accounts.dir` | `packages/pool/src/snapshots.ts` | TESTED |
| Providers JSON and pool.json loaders | `pool.py` | Other account sources | Python tests | `accounts.source` | not ported | PLANNED |
| Quota and balance polling | `tokens.py`, `quota.py` | Background balance and plan checks | Python tests | `pool.balance_poll_seconds` | not ported | PLANNED |
| Device login | `device_auth.py`, `api_dash.py` | User approves in a browser; gateway polls the official OAuth endpoints. The approval URL must be https on chat.z.ai or zcode.z.ai | `tests/test_zcode_core.py`; `apps/gateway/src/login.test.ts` | none | `POST /admin/accounts/login` | TESTED against a mock broker. No live Z.ai call |
| Import installed ZCode credentials | `credential_cipher.py`, `zcode_accounts.py` | AES-GCM `enc:v1` blobs from the local client. API keys and OAuth access tokens are not copied. Admin JSON shows a token hint | Python tests; `packages/pool/src/credentials.test.ts`; gateway import test | `~/.zcode/v2/credentials.json`, `ZCODE_CREDENTIAL_SECRET` | `POST /admin/accounts/import` | TESTED with a fixture key. A blob sealed on another machine stays sealed |
| Relays | `relay_manager.py`, `relay_deploy.py` | Saved relay list, health checks, deploy helpers for the user's own Cloudflare, Vercel, Deno, or Netlify target | `tests/test_relays.py` | `generator-data/relays.json` | not ported | PLANNED |
| Backup zip | `backup.py` | Export and restore local data | Python tests | runtime files | not ported | PLANNED |
| Update check | `updater.py` | GitHub release badge | `tests/test_updater.py` | `update.repo` | not ported | PLANNED |
| Kilo config sync | `client_sync.py` | Optional local client config edits | Python tests | user config path | not ported | DISCOVERED |
| Edge-block breaker | `breaker.py`, `service.py` | Pauses the pool when the CDN returns an HTML 403 | Python tests | none | classification exists; breaker loop is not ported | PLANNED |
| Request capture | `store.py` JsonlCapture | Off by default | Python tests | `logging.capture` | not ported | PLANNED |
| Desktop shell | `gui.py`, pywebview | Windows/macOS window around the dashboard | none automated found | none | Electron shell in `apps/desktop` | IN_PROGRESS |
| Web dashboard | `dashboard/index.html`, `api_dash.py` | Monolithic page for every admin surface | Python dashboard tests | admin key | Vue pages for overview, accounts, models, usage, settings | IN_PROGRESS |

## Explicitly unsupported

These exist in the Python tree. They are not being reimplemented. The Node gateway answers the old routes with HTTP 410 and `feature_not_supported`. That response is covered by `apps/gateway/src/server.test.ts`.

| Feature | Sources | Why it is not ported |
| --- | --- | --- |
| Automated signup | `generator/main.py`, `zcode_gateway/generator.py` | Creates accounts in bulk through the provider's signup flow |
| CAPTCHA solving | `generator/captcha_solver.py`, `tools/captcha-mint/` | Circumvents a provider challenge. Manual solving is also not wired up |
| Referral and giveaway claims | `generator/claim100.py`, `claim500.py`, `claim_start.py`, `invite_claim.py`, admin claim routes | Promotional credit claims after automated signup |
| Proxy scraping for signup | `generator/proxy_pool.py` and the dashboard proxy tools | Exists to obtain exit addresses for the signup pipeline |
| One-click worker deploy that installs Node | dashboard generator mail routes | The rewrite must not download a toolchain onto the end user's machine |

The compliant path is: import a snapshot of an account the user already owns, or the planned device-login flow where the user approves the official client in a browser.

The existing `mail-worker/` template stays in the repository for people who already operate it. The new app does not deploy it.

## Acceptance for the ported gateway slice

- OpenAI and Anthropic clients can call the local port with the client key.
- A mock upstream Anthropic stream becomes an OpenAI completion and an Anthropic message.
- A 529 before output is retried. A disconnect during that wait does not send another request.
- A 405/3012 parks only the requested model.
- A 402/11113 parks only the requested model and the same call rotates to the next account.
- A stream that already contained content is not replayed. A stream that died on `message_start` is retried.
- Admin account JSON does not contain the full access token.
- Claim and generator routes return 410.
