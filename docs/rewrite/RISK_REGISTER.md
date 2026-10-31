# Risk register

| ID | Risk | Status | Mitigation |
| --- | --- | --- | --- |
| R1 | Rewriting signup, CAPTCHA solving, or credit claims would automate provider-control bypass | Open, accepted | Those routes return 410. The Python generator is not called by the new app |
| R2 | Streaming compatibility drifts from the Python SSE translator | Open | Port the captured event mapping and add fixture tests before calling the rewrite compatible |
| R3 | `model-caps.json` and `gateway.db` are not migrated, so a restart forgets parks and history | Open | `AZC-070` and cap persistence |
| R4 | Tokens in `localStorage` or logs | Partial | HTTP responses use hints. Settings page still stores keys locally. Do not log bodies |
| R5 | Electron packaging without a bundled browser, and Playwright features that no longer exist | Open | Do not claim a browser is bundled. There is no Playwright runtime in the rewrite yet |
| R6 | CI on GitHub has not executed the new job | Open | Workflow is in `ci.yml`. Run it on a push before trusting the badge |
| R7 | Original README under-counts tests and describes generator setup that the rewrite will not offer | Open | Baseline recorded 368 passes. User docs for the rewrite must not copy `SETUP.md` |
| R8 | Real account files exist in this working tree and must not be committed | Watching | `.gitignore` already ignores `accounts/`, `config.yaml`, `gateway.db`. Review `git status` before every commit |
| R9 | `node:sqlite` API differences across Node versions | Open | Engines field says `>=22.18`. CI pins Node 24 |
| R10 | Signing and notarization secrets are absent | Accepted | No release is published. Unsigned builds, when they exist, must be labeled unsigned |
