# Performance baseline

Measured on this Mac on 2026-10-31. No other numbers in this file are estimates.

## Original suite

Command:

```text
.venv/bin/python -m pytest tests -q --tb=no -p no:cacheprovider
```

- Python: 3.11.17 (`.venv`)
- Result: **368 passed, 0 failed, 0 skipped**, 1 deprecation warning, **29.58s**
- The README says "161 tests". The tree at `f06d5ff` collected 368. The README is stale.

## Not measured

Cold start, warm start, idle RSS, dashboard latency, request throughput, time to first byte, browser launch, installer size. Those stay unmeasured until `AZC-080`. Do not treat the test duration as a gateway benchmark.

## Rewrite suite

`npm test` on Node v24.22.1:

- **58 passed, 0 failed, 0 skipped**
- Test runner duration: **546.72 ms** (`duration_ms` 546.716583 from `npm test` on 2026-10-31, after the packaging config was added)

That duration is the unit-test process, not a throughput benchmark. The Vue production build (`npm run build -w @azc/desktop`) finished in **99 ms** (vite reported `built in 99ms` on 2026-10-31) and wrote `apps/desktop/dist`. Electron itself was not installed and the window was not opened. No browser click-through was run.
