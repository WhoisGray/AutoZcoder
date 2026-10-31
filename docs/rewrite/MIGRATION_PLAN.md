# Migration plan

The new data directory defaults to `~/.autozcoder` (`AZC_DATA_DIR` overrides it). The Python app keeps writing beside its executable or the working tree. The rewrite must not modify those files in place.

## Planned steps

1. Ask for a folder, or detect `config.yaml` plus `accounts/` beside a known install.
2. Copy the folder to a backup before reading it. Never open the old SQLite database with a migrating writer. Use a read-only connection or a file copy.
3. Map `config.yaml` keys onto the Node config. Unknown keys are retained in an `extras` object.
4. Copy `accounts/*.txt` with the existing parser. Skip files that fail validation and list them in the result.
5. Copy `usage` rows into the new database inside a transaction.
6. Copy `relays.json` only as data. Do not deploy anything during import.
7. Leave `generator-data` proxies, inboxes, and claim results out of the import. Report them as skipped.
8. If a credential is `enc:v1` and the platform key does not match, keep the ciphertext and ask the user to sign in again.
9. On any failed step, delete the partial new directory and leave the source unchanged.

## Idempotency

A second import of the same snapshot id replaces the row only when `expires_at_ms` is newer. That matches `loadAccountsDir`.

## Not in this session

No migration command exists yet. Task `AZC-070`.
