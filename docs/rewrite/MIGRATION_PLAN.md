# Migration plan

The new data directory defaults to `~/.autozcoder` (`AZC_DATA_DIR` overrides it). The Python app keeps writing beside its executable or the working tree. The rewrite must not modify those files in place.

## Steps

1. The caller passes a legacy folder or a `.zip` backup. There is no install-folder scan.
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

## What the rewrite does

`migrateLegacy` in `packages/database/src/migrate.ts` reads a legacy directory, or a `.zip` backup, and writes the new data directory. `POST /admin/migrate` is admin-only and reloads the imported accounts into the running pool. The response has key hints, not the admin key, client keys, or account tokens.

The source is byte-copied first. `gateway.db` is then opened read-only on that copy. A second import of the same account keeps the existing snapshot unless `expires_at_ms` is newer. Usage rows are inserted in a transaction and a repeated row is not copied twice. An `enc:v1` token that does not decrypt with the local key stays ciphertext.

`relays.json` and `model-caps.json` are copied as data. Nothing is deployed, and the caps are not applied to the pool. Generator proxies, inboxes, claim results, and the `generator` section of `config.yaml` are reported as skipped and are not written into the new directory. A zip entry whose name escapes the archive is rejected before any destination file is written.

If a write fails, a destination this call created is deleted. A destination that already existed gets back the files this call replaced. The source is not modified.

The YAML reader covers the shape of `config.example.yaml`. It is not a general YAML library. Unknown keys are kept in `config.json` under `extras`. The gateway process still starts from its environment variables. It does not yet apply `config.json` on the next launch. Imported account files in the data directory are loaded on the next launch because that is already where `index.ts` reads snapshots.

Creating a new backup zip is not implemented. Live Z.ai is not called.
