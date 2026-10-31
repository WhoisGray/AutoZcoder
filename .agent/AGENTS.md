# Agents

A new session starts by reading this file, `.agent/STATE.md`, and `.agent/RESUME.md`, then opening `.agent/runtime/board.db` if it exists.

## Roles used

This repository session ran as one orchestrator. It did not spawn separate backend, frontend, or QA agents. Do not describe the work as multi-agent.

The coordinator still has exclusive leases so a later parallel agent cannot take a live task.

## Commands

```text
node tools/coordinator/board.mjs status
node tools/coordinator/board.mjs recover
node tools/coordinator/board.mjs claim AZC-030 --owner <name> --objective "<what>"
node tools/coordinator/board.mjs review AZC-030 --pass --summary "<exact test output>"
node tools/coordinator/board.mjs done AZC-030
```

`done` fails unless the task is `REVIEW` and `--pass` was recorded.

## Rules

- Stay on `rewrite/electron-vue-node` unless the user asks to touch `master`.
- Do not commit `accounts/`, `config.yaml`, `gateway.db`, `.agent/runtime/`, or `node_modules/`.
- Do not port CAPTCHA solving, bulk signup, or promotional credit claims.
- Do not mark a platform tested unless that platform ran the binary.
- The Python tree remains the supported original app until the delivery report says otherwise.
