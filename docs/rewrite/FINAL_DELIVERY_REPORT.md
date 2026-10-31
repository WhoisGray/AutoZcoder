# Final delivery report

The rewrite is not a finished product. The supported gateway behavior is implemented on `rewrite/electron-vue-node` and tested against mocks. There is no installer, the Electron window was not opened, GitHub Actions was not run for this branch, and live Z.ai was not called.

Before this report, HEAD was `3a8b7fd`. `master` is still `f06d5ff` and was not modified. Nothing was pushed.

## 1. Implemented feature inventory

Tested on this Mac with Node v24.22.1 and npm 11.19.1, against a mock upstream or a local empty gateway:

- OpenAI chat completions, legacy non-stream completions, and Anthropic messages, including local `count_tokens`.
- Model list for `GLM-5.3` and `GLM-5.3-Flash`, plus aliases.
- Quota parking, same-request rotation, overload retry, and cancellation when the client disconnects.
- Account snapshots, pool strategies, and the SQLite usage ledger.
- Import of the user's own `enc:v1` credential file. A blob sealed on another machine stays sealed. Responses show a token hint.
- User-present device login against a mock OAuth broker. Approval URLs must be `https` on `chat.z.ai` or `zcode.z.ai`.
- Legacy directory and zip import into a new data directory, with rollback. Generator proxies, inboxes, and claim results are skipped.
- Vue pages for overview, accounts, models, usage, and settings. Empty and error copy is in the templates. A journey test called a live empty gateway. The pages were not painted in a browser.
- An upstream hang of 100 ms returns HTTP 504 and releases the account.
- A SIGKILL leaves a committed usage row readable, and a new process can listen on the same data directory.

The original Python suite was run once on this machine: 368 passed, 0 failed, 0 skipped, 29.58s, Python 3.11.17. That tree was not modified by the rewrite commits.

## 2. Known differences from the original project

- Signup, CAPTCHA solving, promotional credit claims, and proxy scraping are not ported. Those routes return HTTP 410.
- `GET /dash` is 404. The Vue app is a separate desktop shell.
- Streaming is buffered. The client does not see frames as they arrive. A stream that already contained content is not replayed.
- Relay files can be copied. Health checks and deploy are not ported, and the gateway does not route through them.
- `config.json` written by migration is not applied on the next launch. The process still starts from environment variables. Account files in the data directory are loaded.
- Model caps are not persisted. A copied `model-caps.json` is data only.
- Quota and balance polling, the edge-block breaker loop, update checks, and request capture are not ported.
- The rewrite branch still contains the Python tree so the original app remains in the repository. The Node process does not start Python.

## 3. API compatibility results

`docs/rewrite/API_COMPATIBILITY.md` is the route table. Chat, models, health, ready, metrics, admin account management, credential import, device login, and legacy migrate were exercised with mocks or local fixtures. Claim and generator routes were exercised as HTTP 410. Relay deploy and the update check were not implemented. No request was sent to `zcode.z.ai`.

## 4. Migration compatibility results

`packages/database/src/migrate.test.ts` passed inside the 58-test run. A sanitized directory and a zip were imported. The source bytes did not change. A bad usage database deletes a new destination. An existing destination keeps files the failed call did not own. A newer `expires_at_ms` replaces an account. An older one does not. An `enc:v1` token stays ciphertext when the key does not match. The admin route does not return the token or the full keys.

The importer does not write a new backup zip. It does not scan the disk for an install folder. The caller passes the source.

## 5. Test results

Latest rewrite command:

```text
npm test
```

- 58 passed, 0 failed, 0 skipped
- `duration_ms` 546.716583
- Node v24.22.1, npm 11.19.1
- Date: 2026-10-31
- This duration is the test process, not a gateway benchmark

`test -f apps/desktop/electron-builder.yml` passed. `npm run build -w @azc/desktop` succeeded earlier the same day in 99 ms, as recorded in `PERFORMANCE_BASELINE.md`. That build was not repeated for this report.

## 6. Performance comparisons

There is no comparison against the Python gateway's request latency. The numbers that were actually taken are in `docs/rewrite/PERFORMANCE_RESULTS.md`:

- Cold start until the listen log: 71.9 ms
- Second start on the same data directory: 71.4 ms
- RSS after the first listen: 112816 KB
- A 100 ms upstream timeout returned in 111.4 ms

Time to first byte from Z.ai, throughput, dashboard latency, and installer size were not measured.

## 7. Security review summary

`docs/rewrite/SECURITY_REVIEW.md` is the longer note. In short: the default bind is loopback, keys are compared by SHA-256, snapshots are mode `0600`, import and migrate responses omit tokens, device-login URLs are host-checked, and the source database is opened read-only on a byte copy. Signup and claim routes return 410. There is no OS keychain. The Vue settings page can store keys in `localStorage`.

## 8. Supported platforms

The rewrite was executed on this Mac. Windows and Linux were not run. `apps/desktop/electron-builder.yml` lists macOS, Windows, and Linux targets and marks each one unverified.

## 9. Produced release artifacts

None. No dmg, zip, nsis installer, AppImage, or deb was produced for the rewrite. Electron and electron-builder are not installed here.

## 10. Actual verification status of each artifact

| Item | Status |
| --- | --- |
| `npm test` (58 tests) | Ran on this Mac. 58 passed, 0 failed |
| Original pytest | Ran earlier on this Mac. 368 passed, 0 failed |
| Vue production build | Ran earlier on this Mac. Vite reported 99 ms. Window not opened |
| Dashboard journey | Gateway HTTP and template copy only. No browser click-through |
| `electron-builder.yml` | File exists. Builder was not run |
| Electron window | Not opened |
| GitHub Actions `rewrite` job | Present in `.github/workflows/ci.yml`. Not executed. The workflow triggers on `main` and `master` only, and this branch was not pushed |
| Live Z.ai | Not called |
| Installers | Not produced |

## 11. Known limitations

- An end user still needs Node to run the rewrite. The prompt's packaged, no-Node app does not exist yet.
- Playwright is not a dependency. No browser is bundled. The refused generator flows were not replaced with a browser automation flow.
- The desktop main process starts the gateway with a repository-relative path. That will not match a packaged `asar` layout, and that layout was not tried.
- CI on GitHub was not observed.
- Streaming remains buffered.

## 12. Outstanding blockers

- Packaging and signing are unverified, so there is no release artifact to install on macOS, Windows, or Linux.
- This branch is not on a remote, and the GitHub Actions job has not run.
- `config.json` from a legacy import is not loaded on startup.
- Relays are data, not a route.
- The Electron window and a real browser pass of the Vue pages are still open.
- Live upstream behavior is unproven.

Generator omission is intentional, not a blocker to fix by reimplementing signup or CAPTCHA.

## 13. Git commit and branch

- Branch: `rewrite/electron-vue-node`
- `master`: `f06d5ff` (`release: upload macOS .app zip as sole mac artifact`). That commit belongs to the Python app. It is not a rewrite artifact.
- Parent of this report: `3a8b7fd`
- The report commit is the next commit on this branch. It was not pushed.

Manual checks that were not run here:

```text
npm test
npm run build -w @azc/desktop
npm run start:gateway
```

The GitHub `rewrite` job runs `npm test` on `ubuntu-latest` with Node 24 when this branch is pushed or the workflow is given a trigger for it. That job has not been observed.
