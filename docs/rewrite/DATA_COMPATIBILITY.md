# Data compatibility

Legacy files found in this working copy and in the source:

| Path | Role | Rewrite |
| --- | --- | --- |
| `config.yaml` | Server, upstream, pool, accounts, models, logging, generator | Not loaded yet. The Node process uses environment defaults (`AZC_PORT`, `AZC_HOST`, `AZC_ADMIN_KEY`, `AZC_CLIENT_KEY`, `AZC_DATA_DIR`). YAML import is task `AZC-070` |
| `config.example.yaml` | Documented defaults. Port 8788, bind `127.0.0.1`, strategy `drain_first` | Defaults copied into `makeConfig` |
| `accounts/*.txt` | `account_id`, `email`, `access_token`, `refresh_token`, `expires_at_ms`, and extra keys | Reader matches the line format, skips a non-numeric expiry, dedupes by id. Tested with synthetic files. The real `accounts/` directory in this checkout is gitignored and was not copied |
| `gateway.db` | `usage` table | New database uses the same columns. The old file is not opened or migrated yet |
| `model-caps.json` | Persisted per-model parks | Not read yet. Parks live in memory for the process |
| `pool.json` | Alternate account source | Not read yet |
| `generator-data/` | Proxies, mail config, relays, generator results | Left untouched. Signup data is not imported |
| `logs/` | Text and optional JSONL capture | Not imported |
| `~/.zcode/v2/credentials.json` | Installed client credentials, sometimes `enc:v1` AES-GCM | `POST /admin/accounts/import` decrypts with `ZCODE_CREDENTIAL_SECRET` or the platform fallback key and writes `accounts/*.txt`. A key from another machine does not open the blob |

Rules already followed:

- Snapshot writes use a temp file and `rename`.
- Account HTTP responses do not include `access_token`.
- Tests use fake tokens such as `secret-token-zzzz`.
- The original `accounts/`, `config.yaml`, and `gateway.db` stay gitignored.

Migration is not done. A user cannot yet point the new app at an old folder and continue. That is `AZC-070`.
