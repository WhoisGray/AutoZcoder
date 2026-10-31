# Dependency audit

## Python runtime, still required for the original app

From `requirements.txt`: FastAPI, Uvicorn, httpx, Pydantic, PyYAML, requests, truststore, certifi, cryptography (non-Windows), pywebview, and platform WebView bindings.

Dev: pytest, pytest-asyncio (`requirements-dev.txt`).

Generator extras are separate (`generator/requirements.txt`) and include Playwright. Those are not a dependency of the rewrite.

The installed baseline environment is `.venv` with Python 3.11.17. System `python3` is 3.9.6 and is too old for this codebase. Homebrew also has 3.14 and 3.15; they were not used for the baseline.

## Node rewrite

Runtime for the gateway tests is Node.js itself. This machine has Node v24.22.1. The gateway, pool, protocol, and coordinator code use:

- `node:http`, `node:sqlite`, `node:crypto`, `node:test`
- No Python
- No Playwright download

The desktop package adds Vue 3, Vue Router, Pinia, Vite, Tailwind CSS, and Electron. Those install from npm when the UI is built. They are build tools. A packaged Electron app must ship its own runtime so the end user does not install Node. That package has not been produced.

`node:sqlite` avoids a native `better-sqlite3` build for the usage ledger and the task board.

## Supply chain notes

- The original CI installs Python dependencies on each run and compiles the generator entry points, including `captcha_solver.py`. That job is unchanged so `master` behavior stays covered.
- The new `rewrite` job runs `npm test`, which does not install packages. Gateway tests have no third-party imports.
- No SBOM has been generated.
- Signing certificates are not present. Installers are not signed.
