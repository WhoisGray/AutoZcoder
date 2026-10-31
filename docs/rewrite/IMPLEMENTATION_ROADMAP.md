# Implementation roadmap

The task board in `.agent/` is the schedule. This file is the map.

| Phase | Exit we are using | State after this session |
| --- | --- | --- |
| 0 Audit | Inventory and architecture docs | Written from the source read in this session |
| 1 Coordinator | Lease and recovery tests | `tools/coordinator`, tests green |
| 2 Foundation | Electron, Vue, and Node launch | Node packages and a Vue project exist. A packaged double-click app does not |
| 3 Gateway | Contract and streaming tests | Mock-upstream contracts pass, including park, rotate, no replay after content, and disconnect cancel. Live upstream was not called. The client still receives a buffered body |
| 4 Accounts | Pool and storage tests | Snapshots, strategies, and usage rows. No quota polling, no credential import |
| 5 Dashboard | Desktop journeys | Pages call the local API. Not exercised in a browser in this session |
| 6 Automation | Supported browser flows | Signup, CAPTCHA, and claims are refused. No replacement browser flow yet |
| 7 Migration | Import and rollback tests | Plan only |
| 8 Performance | Measured gates | Baseline pytest only |
| 9 Packaging | Clean install on each OS | Not built |
| 10 CI | Pipelines | Node job added to `.github/workflows/ci.yml`. Not run on GitHub from here |
| 11 Report | Final delivery | Not started. The product is not finished |

Run the rewrite tests with:

```text
npm test
```

Run the gateway without Electron:

```text
npm run start:gateway
```

The original app is unchanged on `master` and still runs with `.venv/bin/python -m zcode_gateway.main`.
