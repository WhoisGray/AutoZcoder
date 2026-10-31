# API compatibility

Paths below are what `create_app` mounts today. The rewrite column is the Node server in `apps/gateway`.

| Method and path | Python behavior | Rewrite |
| --- | --- | --- |
| `GET /` | Name, version, dialect list | Same shape, plus an `unsupported` list. Version is `2.0.0-rewrite.0` |
| `GET /health` | `{status}` plus optional edge-block | `{status:"ok"}`. Edge-block field not yet returned |
| `GET /ready` | 200 or 503 | Matched, with a test |
| `GET /metrics` | Pool snapshot and usage window | Matched |
| `GET /v1/models`, `GET /models` | Registry catalogue | Captured models and aliases. No live catalog refresh |
| `POST /v1/chat/completions` | Stream or aggregated completion | Mock-tested. Live ZCode not called |
| `POST /v1/completions` | Legacy text shim | Non-stream tested. Legacy streaming reshape is not ported |
| `POST /v1/messages` | Native Anthropic | Non-stream tested |
| `POST /v1/messages/count_tokens` | Local estimate | Matched |
| `GET /admin/accounts` | Full admin view | Public view. Token is a hint |
| `POST /admin/accounts` | Add account | Snapshot fields, file mode 0600 when a directory is set |
| `DELETE /admin/accounts/{id}` | Remove | Implemented |
| `POST /admin/accounts/{id}/enable` | Enable | Implemented |
| `GET /admin/pool/state` | Snapshot | Implemented, tokens omitted |
| `GET /admin/stats` | Usage summary | Implemented |
| `GET /admin/dash/settings` | Raw settings | Host, strategy, key hints. Full keys are not returned |
| `GET /admin/dash/logs` | Ring buffer | Process log lines only |
| Claim, generator, proxy-tool, and setup routes | Drive signup and claims | **410** `feature_not_supported` |
| `POST /admin/accounts/login`, `GET` the same path, `POST /admin/accounts/login/cancel` | User approves in a browser | Implemented against a mock broker. No live Z.ai call |
| `POST /admin/accounts/import` | Read the local ZCode credential file | Implemented. The token is not in the JSON response |
| `POST /admin/migrate` | Backup restore in the Python app is a zip replace | Imports a directory or zip into the new data directory. Does not write a new zip |
| Dashboard HTML `GET /dash` | Inline SPA | Replaced by the Vue app. This path is 404 on the Node server |
| Relay deploy, update check | Present in `api_dash.py` | Not implemented. Those paths are 404. `relays.json` can be copied as data and is not used |

Error bodies:

- OpenAI routes use `{error:{message,type,param,code}}`.
- Anthropic routes use `{type:"error",error:{type,message,code}}`.
- Admin routes use `{detail}` for auth failures, matching the dashboard's reader.

Streaming compatibility is partial. OpenAI `data:` frames are produced from a fully buffered upstream read. A client disconnect aborts that read and releases the account, and a stream that already contained content is not replayed. Anthropic SSE on the wire for `stream:true` is rebuilt from the accumulator, so thinking signatures and extra event types can be dropped. Bytes are not forwarded as they arrive.
