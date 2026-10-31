# Security review

This is a local network service that holds third-party access tokens. The review covers what the rewrite does now.

## Preserved controls

- Default bind is `127.0.0.1`.
- Client and admin keys are compared by SHA-256 digest with `timingSafeEqual`, so a short key does not throw.
- OpenAI and Anthropic error bodies stay on their own routes.
- Account list and import responses expose `token_hint` (last four characters), not the token.
- Snapshot files are written with mode `0600`.
- The gateway test asserts the upstream request log stored by the test double does not get copied into the HTTP response, and the completion JSON does not contain the fixture token.
- Electron: `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`. Navigation off localhost or `file:` is cancelled. New windows are denied and http(s) links go to the system browser.
- Single-instance lock is requested.
- Unsupported signup and claim routes return 410 instead of executing the old tools.

## Gaps

- Admin and client keys generated in `index.ts` are printed only as a hint, but the full key still lives in the environment of the gateway process. There is no OS keychain yet.
- The Vue settings page can store keys in `localStorage`. That is acceptable only for a local app window. Do not load the renderer from a remote origin.
- Content-Security-Policy is on the desktop `index.html`. The Vite dev server is a separate origin and is for development.
- YAML config loading is not implemented, so a copied `config.yaml` is not what the Node process reads.
- Device-login and credential decryption are not implemented. Do not copy encrypted blobs across operating systems and expect them to open. `docs/PROTOCOL.md` says the key is derived from the platform, home directory, and username.
- Rate-limit `rpm` is parsed and not enforced.
- The gateway does not yet apply a connection limit or backpressure beyond the 20 MB body cap.
- Dependency audit of the Electron tree was not run in this session if `npm install` had not completed. See the delivery notes in `.agent/RESUME.md` after the next checkpoint.
- Automated CAPTCHA solving and bulk account creation were removed from the new process on purpose. Leaving the Python generator on `master` does not make those features part of the rewrite.

## Logging

Gateway request failures log the path, not the body. Import logs the account id. Tests use synthetic tokens and must stay that way.
