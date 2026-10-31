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
- Credential import decrypts `enc:v1` with AES-256-GCM. The key is SHA-256 of `ZCODE_CREDENTIAL_SECRET`, or of `zcode-credential-fallback:<platform>:<home>:<username>`. A blob sealed on another machine stays sealed. The admin import response and the account list contain a token hint, not the token.
- Device login posts to the official `/oauth/cli/init` endpoint and polls until the user approves in a browser. The approval URL has to be `https` on `chat.z.ai` or `zcode.z.ai`. Login status does not include the token. The flow was tested with a mock broker, not a live call.
- Rate-limit `rpm` is parsed and not enforced.
- The gateway does not yet apply a connection limit or backpressure beyond the 20 MB body cap.
- Dependency audit of the Electron tree was not run in this session if `npm install` had not completed. See the delivery notes in `.agent/RESUME.md` after the next checkpoint.
- Automated CAPTCHA solving and bulk account creation were removed from the new process on purpose. Leaving the Python generator on `master` does not make those features part of the rewrite.

## Logging

Gateway request failures log the path, not the body. Import logs the account id. Tests use synthetic tokens and must stay that way.
