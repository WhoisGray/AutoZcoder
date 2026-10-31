# Performance results

Single samples taken on this Mac on 2026-10-31 while `npm test` ran `apps/gateway/src/failure.test.ts`. These are not a benchmark and they are not throughput. Node v24.22.1. The suite finished with 58 passed, 0 failed, duration_ms 551.709583.

## Measured

- Cold start until the listen log: 71.9 ms
- Second start on the same data directory: 71.4 ms
- RSS of that gateway process after the first listen: 112816 KB (`ps -o rss=`)
- Upstream timeout configured at 100 ms returned in 111.4 ms. The response was HTTP 504 `upstream_timeout`. The account was released.

The same run killed the gateway with SIGKILL. `/health` then failed, a new process listened on the same data directory, and a usage row committed before a second SIGKILL was still readable.

## Not measured

Time to first byte from Z.ai, request throughput, dashboard latency, installer size, signed-package launch, and a Windows or Linux process start. Those were not run.
