# MASTER ENGINEERING PROMPT
## AutoZCoder — Complete Cross-Platform Rewrite, Multi-Agent Development and Crash-Resumable Delivery

### 1. Your Role and Mission

You are a senior software architect, principal full-stack engineer, desktop application engineer, DevOps engineer, security engineer, QA engineer, and autonomous multi-agent development coordinator.

Your mission is to completely rewrite and modernize the following existing project:

**Repository:** https://github.com/WhoisGray/AutoZcoder

The new application must use:

- Node.js for the backend and application services.
- Electron for the cross-platform desktop application.
- Vue 3 for the frontend.
- TypeScript for application code.
- Tailwind CSS for styling.
- Apple Human Interface Guidelines and Material Design 3 as design references.
- Playwright for browser automation and automated testing.
- SQLite for local persistent data.
- GitHub Actions for CI/CD.
- Electron Builder or an appropriately justified alternative for packaging.

The application must run on Windows, macOS, and Linux.

This is a full production-grade rewrite, not a simple frontend redesign, wrapper, prototype, or partial migration.

The original project must remain available and functional throughout development.

You are responsible for planning, implementation, testing, integration, packaging, documentation, and release preparation.

**Critical requirement:** This is a long-running engineering project. All progress must be persisted, all tasks must be tracked, and the project must recover from agent termination, process crashes, computer restarts, context loss, or network interruptions.

Do not stop after producing a plan. Execute the plan incrementally until the project is complete or a genuine external blocker is encountered.

---

### 2. Non-Negotiable Engineering Rules

1. Inspect the actual repository before making architectural decisions.
2. Do not assume the README describes every feature.
3. Preserve the current application on its original branch.
4. Create a dedicated rewrite branch, preferably `rewrite/electron-vue-node`.
5. Never overwrite the original implementation.
6. Keep the rewritten application independently buildable.
7. Preserve existing supported functionality unless a removal is explicitly justified and recorded.
8. Never silently remove functionality.
9. Do not introduce Python as a runtime requirement in the final application.
10. Do not require users to install Node.js, Python, npm, pip, Playwright, Chromium, or other development dependencies.
11. Bundle all redistributable runtime dependencies required by supported features.
12. Implement durable project state and crash recovery before substantial coding.
13. Maintain an explicit, persistent task board.
14. Support multiple collaborating development agents with conflict prevention.
15. Implement and run real tests rather than merely claiming the code works.
16. Commit completed work in small, understandable increments.
17. Do not claim a platform or feature has been tested unless it actually has.
18. Never fabricate benchmark numbers, test outcomes, or release artifacts.
19. Do not publish an unverified production release.
20. Respect provider terms, account controls, authentication, rate limits, CAPTCHA requirements, and applicable laws.

When a requirement is technically infeasible, document the precise limitation and deliver the closest secure, working alternative without silently abandoning the feature.

---

### 3. Phase 0 — Repository Discovery and Baseline Audit

Before writing the new application, perform a detailed inspection of the current repository.

Inspect at least:

- `README.md`
- `SETUP.md`
- `config.example.yaml`
- `gui_main.py`
- `build.py`
- `build-exe.ps1`
- `zcode_gateway/`
- `zcode_gateway/dashboard/`
- `generator/`
- `mail-worker/`
- `tests/`
- `docs/`
- `tools/`
- `.github/workflows/`

Do not limit inspection to this list.

Analyze the actual imports, runtime dependencies, business logic, configuration formats, storage formats, API handlers, worker lifecycle, and build pipeline.

Pay special attention to the following existing modules:

- `zcode_gateway/app.py`
- `zcode_gateway/api_openai.py`
- `zcode_gateway/api_anthropic.py`
- `zcode_gateway/api_admin.py`
- `zcode_gateway/api_dash.py`
- `zcode_gateway/service.py`
- `zcode_gateway/pool.py`
- `zcode_gateway/store.py`
- `zcode_gateway/tokens.py`
- `zcode_gateway/relay_manager.py`
- `zcode_gateway/relay_deploy.py`
- `generator/main.py`
- `generator/proxy_pool.py`

Discover additional modules and dependencies through actual source inspection.

#### Required audit deliverables

Create:

```text
docs/rewrite/
  ARCHITECTURE_AUDIT.md
  FEATURE_INVENTORY.md
  API_COMPATIBILITY.md
  DATA_COMPATIBILITY.md
  DEPENDENCY_AUDIT.md
  SECURITY_REVIEW.md
  MIGRATION_PLAN.md
  PERFORMANCE_BASELINE.md
  IMPLEMENTATION_ROADMAP.md
  RISK_REGISTER.md
```

The feature inventory must document:

- Existing feature name and purpose.
- Source files implementing it.
- Current behavior.
- Existing tests, if available.
- Configuration and persistence dependencies.
- Planned replacement implementation.
- Migration considerations.
- Acceptance criteria.
- Implementation status.

Mark each feature as:

`DISCOVERED`, `PLANNED`, `IN_PROGRESS`, `IMPLEMENTED`, `TESTED`, or `VERIFIED`.

Record unavailable or unsupported features explicitly.

#### Establish the baseline

Run the existing offline test suite wherever the development environment permits.

Record the actual number of passing, failing, and skipped tests.

Capture existing API response fixtures and streaming examples using mocks or authorized test environments.

Preserve this baseline for later compatibility testing.

Do not delete the old Python implementation until migration and verification are complete.

---

### 4. Persistent Development Board and Task Tracking

This requirement must be implemented immediately after the audit infrastructure.

Create a durable task management system for the development process.

Use a local SQLite coordination database as the authoritative state store, with transactional writes and durable checkpoints.

Also generate human-readable, version-controlled snapshots of the board.

Required files:

```text
.agent/
  BOARD.md
  TASKS.md
  STATE.md
  RESUME.md
  DECISIONS.md
  BLOCKERS.md
  CHANGELOG.md
  AGENTS.md
  PHASES.md
  checkpoints/
  reports/
  handoffs/
```

Runtime coordinator data may live in an ignored `.agent/runtime/` directory. Never commit secrets or private credential data.

Use explicit task lifecycle states:

- BACKLOG
- READY
- DOING
- REVIEW
- BLOCKED
- DONE
- CANCELLED

Every task must contain:

```yaml
id: AZC-001
title: "Example task"
phase: 1
description: "Concrete engineering work"
priority: high
status: READY
owner: null
depends_on: []
allowed_paths: []
acceptance_criteria: []
test_commands: []
branch: null
worktree: null
last_commit: null
attempts: 0
lease_expires_at: null
created_at: null
updated_at: null
blocking_reason: null
```

Additional metadata may be added.

#### Task transition rules

Before an agent starts coding:

1. Verify dependencies.
2. Acquire an exclusive task lease.
3. Assign an owner.
4. Change the task status to `DOING`.
5. Record the branch, worktree and implementation objective.
6. Persist the transition before editing files.

After implementation:

1. Run the required tests.
2. Record the results.
3. Set status to `REVIEW`.
4. Assign an independent review agent when available.
5. Approve and mark `DONE` only after acceptance criteria pass.
6. Otherwise return to `READY`, or mark `BLOCKED` with an actionable reason.

Never mark an incomplete task as done.

The human-readable board must be kept synchronized with authoritative state.

Prevent multiple agents from claiming the same task simultaneously.

Optional GitHub Issues or GitHub Projects integration is welcome, but a network-dependent service must never be the sole source of task state.

---

### 5. Crash Recovery, Interrupted Sessions and Autonomous Resumption

The project must be recoverable after any unexpected interruption, including:

- Agent process termination.
- Coding session context exhaustion.
- Computer restart.
- Operating system crash.
- Internet disconnection.
- API outage.
- Power loss.
- Development tool crash.
- Interrupted tests or builds.
- Partially completed Git operations.

Implement a robust checkpoint and recovery protocol.

#### Persistent coordinator

Maintain:

- Task ownership and status.
- Task dependency graph.
- Active work orders.
- Worktree and branch references.
- Agent heartbeats.
- Lease expiration timestamps.
- Attempt history.
- Test history.
- Recent failure signatures.
- Last successful Git commit.
- Known uncommitted changes.
- Current development phase.
- Pending integration decisions.

Use SQLite transactions, WAL mode where appropriate, atomic file replacement, and filesystem synchronization for critical records.

#### Checkpoint frequency

Create checkpoints:

- Before beginning each task.
- After significant implementation milestones.
- After each successful test stage.
- After each completed task.
- Before handing work to another agent.
- Before a risky migration or large refactor.
- Before a planned shutdown.

Avoid committing temporary credentials, logs containing secrets, or generated binaries.

#### Automatic recovery procedure

On every new agent session:

1. Read `AGENTS.md`.
2. Read `.agent/STATE.md`.
3. Read `.agent/RESUME.md`.
4. Read the authoritative task database.
5. Inspect Git status, current branch, and available worktrees.
6. Reconcile the last known commits with persisted task state.
7. Identify expired or stale leases.
8. Inspect unfinished work before changing ownership.
9. Verify partially completed changes.
10. Resume the highest-priority eligible unfinished task.

Do not recreate completed features or repeat the entire planning process.

An interrupted task must resume from its last validated checkpoint whenever safe.

If an interrupted operation cannot safely resume, roll back that operation and retry idempotently.

Never blindly retry actions with external side effects.

#### Required resume document

`.agent/RESUME.md` must always contain:

```text
Current phase:
Current task:
Last completed task:
Current branch:
Active worktree:
Last successful commit:
Last passing tests:
Known failures:
Uncommitted changes:
Recovery instructions:
Next executable action:
```

A fresh agent with no previous conversational context must be able to continue from these files.

#### Recovery testing

Simulate intentional termination during development workflow execution.

Verify that state persists, expired leases are reclaimed safely, and tasks are not incorrectly marked complete.

Also test recovery from an interrupted migration and a partially completed build.

---

### 6. Multi-Agent Development Architecture

Support multi-agent development wherever the coding environment permits it.

Recommended agent roles:

**Orchestrator Agent**
- Owns the roadmap.
- Schedules tasks.
- Manages dependencies.
- Assigns ownership and resources.
- Coordinates integration.
- Maintains project state.

**Architecture Agent**
- Designs application boundaries.
- Defines shared interfaces and contracts.
- Reviews architectural decisions.

**Backend Agent**
- Implements Node.js services.
- Rewrites gateway routing.
- Handles persistence, HTTP, streaming and lifecycle management.

**Frontend Agent**
- Builds Vue components.
- Implements navigation, responsive layouts, state management and visual design.

**Automation Agent**
- Implements Playwright integration.
- Handles authorized browser workflows and browser lifecycle management.

**Migration Agent**
- Builds import, export, backup, migration and compatibility tools.

**QA Agent**
- Creates automated tests.
- Verifies compatibility.
- Performs regression and reliability testing.

**DevOps Agent**
- Implements installers, signing, CI/CD and release automation.

**Security Review Agent**
- Evaluates permissions, secrets, trust boundaries, injection risks and unsafe dependencies.

#### Parallelism and conflict prevention

Use Git worktrees for independent tasks.

Each agent must receive a clearly defined task contract containing:

- Task ID.
- Scope.
- Allowed files.
- Dependencies.
- Expected output.
- Acceptance criteria.
- Required tests.
- Branch name.

Never permit multiple agents to modify the same shared files concurrently without explicit coordination.

Use exclusive leases and dependency-aware scheduling.

Run parallel agents only on independent work.

Use bounded concurrency based on available resources.

The orchestrator must integrate changes only after tests and review pass.

If actual parallel agent execution is not supported by the available tools, run these roles sequentially while preserving exactly the same task contracts, handoffs, and recovery behavior.

Do not claim multi-agent execution occurred when only a single agent was used.

---

### 7. Target Application Architecture

Use a maintainable, modular architecture.

Suggested structure:

```text
apps/
  desktop/
    src/
      main/
      preload/
      renderer/
      windows/
      ipc/
  gateway/
    src/
      server/
      routes/
      services/
      providers/
      streaming/
      pool/
      quotas/
      security/
  automation/
    src/
      browser/
      workflows/
      jobs/
      workers/
  ui/
    src/
      components/
      layouts/
      pages/
      stores/
      composables/
      styles/

packages/
  shared/
  config/
  database/
  migrations/
  protocols/
  logging/
  testing/
  utilities/

resources/
  browsers/
  workers/
  templates/
  icons/

tests/
  unit/
  integration/
  contract/
  e2e/
  migration/
  performance/
  packaging/

scripts/
docs/
.agent/
.github/workflows/
```

This is a suggested starting structure, not a substitute for architectural analysis.

Use a workspace-based monorepo with a single pinned package manager and reproducible lockfile.

#### Electron responsibilities

The Electron main process should handle:

- Application startup.
- Window management.
- Single-instance enforcement.
- Secure IPC.
- Native menus and dialogs.
- OS integration.
- Tray behavior where supported.
- Application shutdown.
- Update notifications.
- Background process supervision.

Do not execute heavy gateway or browser automation work directly on the Electron main thread.

Run the gateway and automation engine in isolated Node.js utility or child processes with explicit supervision and IPC.

#### Backend responsibilities

The Node.js backend must independently implement the legacy gateway behavior.

Do not replace the Python backend with a packaged Python executable or silently depend on Python subprocesses.

Use stable modules for routing, upstream transport, account management, quotas, persistence, configuration and administrative operations.

#### Frontend responsibilities

Use Vue 3, TypeScript, the Composition API, Pinia where appropriate, Vue Router, and Tailwind CSS.

Separate visual components from business logic.

Use typed IPC and API contracts.

Avoid giant single-file components and unstructured global state.

---

### 8. Complete Existing Feature Compatibility

Preserve the current features identified in the repository audit.

At minimum, account for the following feature groups.

#### A. API Gateway

Preserve:

- OpenAI-compatible chat completions.
- Legacy completions where supported.
- Model listing.
- Anthropic-compatible Messages API.
- Streaming and non-streaming responses.
- SSE event formats.
- Request and response translation.
- Tool calls and structured content blocks.
- System instructions and metadata.
- Reasoning configuration.
- Token accounting.
- Proper error propagation.
- Client disconnection handling.
- Authentication and access control.
- Existing API paths, unless a documented compatibility alias is provided.

Do not assume basic JSON response matching is sufficient.

Streaming frames, ordering, content types, status codes, and disconnect behavior are part of the compatibility contract.

#### B. Account Management

Preserve supported account operations:

- Manual account import.
- Existing account snapshot import.
- Supported credential import from installed clients.
- Account listing and removal.
- Token validation and refresh where supported.
- Account state reporting.
- Quota and reset-time visibility.
- Plan and model availability.
- Existing pool-selection strategies.
- Per-account concurrency limits.
- Usage records and statistics.

Any account or quota management must respect the provider's applicable rules and restrictions.

#### C. Gateway Reliability

Preserve and improve:

- Health and readiness endpoints.
- Request timeout handling.
- Load distribution.
- Retry and backoff policies.
- Per-model availability decisions.
- Model overload handling.
- Failure classification.
- Graceful shutdown.
- Cancellation propagation.
- Structured logging.

Avoid unsafe retries after output streaming begins or after non-idempotent upstream actions may have occurred.

#### D. Dashboard

Migrate the existing dashboard features into Vue.

Retain functional coverage for:

- Overview and health.
- Accounts and account details.
- Models and quotas.
- Gateway settings.
- Client keys.
- Usage analytics.
- Request logs.
- Generator controls where permitted.
- Proxy management.
- Relay management.
- Notifications.
- Update information.

The final UI must not be a copy of the existing monolithic HTML dashboard.

#### E. Browser Automation

Rewrite applicable, authorized Playwright workflows using Node.js and Playwright.

Preserve the user-facing workflow management experience:

- Browser lifecycle management.
- Visible and headless browser modes where appropriate.
- Job progress and logs.
- Start, stop and cancellation controls.
- Worker status reporting.
- Failed-job diagnostics.
- Configurable concurrency.
- Persistent results.
- Manual user participation where required.

Do not implement automated CAPTCHA circumvention, unauthorized account creation, or bypasses of provider security and abuse controls.

Where a legacy workflow depends on those mechanisms, document the limitation and implement a compliant manual or official-API alternative.

#### F. Proxy and Relay Administration

Preserve lawful proxy configuration, verification and administration features.

Account for supported proxy formats, health monitoring, failure reporting, persistent configurations, and authorized connection routing.

Preserve supported relay integrations identified in the repository, including Cloudflare, Vercel, Deno and Netlify where applicable.

Use official supported deployment APIs or bundled deployment resources.

Do not silently download a complete development toolchain on the end user's machine.

Cloud service deployment may still require internet access, authentication, and external configuration.

---

### 9. Modern UI/UX — Apple-Inspired Desktop Experience

Design the application to feel like a high-quality native desktop product.

Use:

- Apple Human Interface Guidelines as a major design reference.
- Material Design 3 principles where appropriate.
- Clean, restrained typography.
- Consistent spacing and alignment.
- Native-feeling window controls.
- Platform-specific keyboard shortcuts.
- Clear information hierarchy.
- Accessible components.
- Light and dark modes.
- Smooth, subtle transitions.

Create `DESIGN.md` containing:

- Design principles.
- Color tokens.
- Typography system.
- Spacing scale.
- Component specifications.
- Layout rules.
- Navigation behavior.
- Accessibility standards.
- Platform-specific adaptations.

Build reusable components including:

- Sidebar navigation.
- Top toolbar.
- Dashboard cards.
- Data tables.
- Search and filter controls.
- Status indicators.
- Dialogs and sheets.
- Progress indicators.
- Charts.
- Log viewers.
- Settings controls.
- Empty and error states.

Important requirements:

- Tables must align correctly.
- Large tables must remain responsive.
- Logs must not freeze the interface.
- Use virtual scrolling where warranted.
- Support useful sorting and filtering.
- Maintain readable layouts on smaller windows.
- Support clear connection and error states.

Use real application data rather than permanent mock data.

Do not sacrifice performance for decorative animations.

---

### 10. Legacy Data Migration and Restore Compatibility

This requirement is mandatory.

Existing users must be able to restore their old application data into the new application.

Inspect and support relevant legacy data, including:

```text
config.yaml
gateway.db
accounts/
pool.json
generator-data/
logs/
model-caps.json
relays.json
```

Also discover any other storage formats used by the original application.

#### Migration requirements

Implement a versioned migration system with:

- Legacy installation discovery.
- Manual folder selection.
- Backup before migration.
- Schema validation.
- Config mapping.
- Account snapshot migration.
- Database migration.
- Proxy configuration migration.
- Relay configuration migration.
- Supported historical runtime state migration.
- Safe handling of encrypted credentials.
- Detailed migration results.
- Rollback or recovery on failure.

Preserve existing account identifiers and relevant statistics where possible.

Never assume platform-specific encrypted credentials can be decrypted on another operating system.

Document and implement the appropriate native reauthorization flow when necessary.

#### Migration safety

- Never overwrite the original source data.
- Never mutate an old database in place.
- Never write plaintext credentials to logs.
- Validate imported paths.
- Reject malformed or unsafe input.
- Preserve unknown supported fields when safe.
- Use transactional migration steps.
- Ensure repeated imports are idempotent where appropriate.
- Report any unsupported or skipped records.

#### Import/export compatibility

Implement a user-facing backup and restore feature.

Prefer a versioned export format, with an explicitly documented schema and integrity checks.

A backup from the legacy application must be importable through a compatibility path.

A new-format backup must be restorable after an application reinstall.

Provide migration tests with sanitized fixtures and edge cases.

No migration task is complete until the restored application behaves correctly using the imported data.

---

### 11. Fully Self-Contained Application Packaging

A user must be able to download the appropriate release package and launch the application without installing a programming runtime or development toolchain.

Package:

- Electron runtime.
- Node.js runtime provided by Electron.
- Compiled Vue frontend.
- Backend services.
- Required runtime libraries.
- Required native modules.
- Playwright browser binaries for supported features.
- Browser automation assets.
- Required templates.
- Application resources.
- Configuration defaults.

Do not rely on:

```text
npm install
npm run build
pip install
python
playwright install
npx playwright install
system-wide Node.js installation
system-wide Chrome installation
```

on the end user's machine.

Browser binaries must be packaged for the target operating system and architecture, and verified to launch from the installed application.

Use supported Playwright executable resolution and unpack resources that cannot run directly from ASAR.

Do not assume Electron's embedded Chromium automatically replaces every Playwright browser binary.

#### Windows

Provide suitable deliverables such as:

- A self-contained installer.
- A portable application package.

Target supported x64 and ARM64 architectures as feasible.

Test execution without Python or Node.js installed.

Use code signing when signing credentials are available.

#### macOS

Provide suitable deliverables such as:

- DMG.
- A correctly packaged `.app`, distributed in a suitable archive where appropriate.

Target Apple Silicon and Intel Macs through validated architecture-specific or universal builds.

Support hardened runtime, code signing, and notarization when the required Apple credentials are available.

Handle browser subprocesses, bundled executable permissions, and signing correctly.

#### Linux

Provide suitable deliverables such as:

- AppImage.
- DEB.
- RPM where supported.

Test on declared supported distributions.

Do not claim that bundling application dependencies eliminates all operating-system-level dependencies.

Identify and document the minimum supported system libraries and environments.

#### Runtime storage

Use a safe cross-platform data directory by default.

Support a deliberate portable mode where practical.

Do not assume application installation directories are writable.

Ensure signed macOS application bundles are not modified at runtime.

---

### 12. Performance Optimization

Performance is a major project objective.

Measure the original application where practical and use comparable workloads to benchmark the rewrite.

Track:

- Cold startup duration.
- Warm startup duration.
- Idle memory consumption.
- Active memory consumption.
- Dashboard interaction latency.
- API request throughput.
- Gateway overhead.
- Streaming time to first byte.
- Browser initialization time.
- Automation worker overhead.
- Database query performance.
- Installer and package sizes.

Do not invent performance improvements without evidence.

#### Optimization requirements

Consider:

- Lazy-loaded frontend routes.
- Code splitting.
- Tree shaking.
- Reusable HTTP connections.
- Connection pooling.
- Appropriate caching.
- Efficient async I/O.
- Worker process isolation.
- Database indexing.
- Batched persistence.
- Virtualized tables and logs.
- Bounded queues.
- Configurable concurrency.
- Avoiding unnecessary polling.
- Preventing renderer/main-thread blocking.
- Reducing memory leaks and orphan processes.

Use profiling to identify actual bottlenecks before complex optimization.

Record before-and-after measurements in:

`docs/rewrite/PERFORMANCE_RESULTS.md`

Prioritize correctness, stability, and compatibility over speculative micro-optimizations.

---

### 13. Security and Application Reliability

Treat this application as security-sensitive because it handles local network services, credentials, account data and external API traffic.

#### Required security measures

- Enable Electron context isolation.
- Disable unsafe renderer Node.js access.
- Use a minimal, strongly typed preload API.
- Validate IPC arguments.
- Restrict navigation and window creation.
- Use a strict Content Security Policy.
- Do not expose privileged filesystem APIs to arbitrary web content.
- Protect sensitive local endpoints against unauthorized browser origins.
- Preserve authenticated administrative operations.
- Avoid wildcard CORS policies on sensitive local services.
- Store credentials using appropriate native keychain or encrypted storage mechanisms.
- Redact secrets from logs and diagnostics.
- Never publish real credentials in test fixtures.
- Validate file imports and external URLs.
- Prevent arbitrary command injection.
- Apply dependency and package integrity checks.
- Prevent insecure TLS fallback.
- Avoid including runtime secrets in release packages.

#### Reliability requirements

- Single-instance enforcement.
- Graceful app shutdown.
- Browser worker cleanup.
- Child process supervision.
- Health checks.
- Controlled restart of crashed local services.
- Bounded retries.
- Backpressure management.
- Cancellation propagation.
- Clear user-visible errors.
- Persistent logs.
- Database integrity checks.
- Recovery after an unclean shutdown.

The gateway should not silently terminate because the UI renderer crashes.

Support a documented option for keeping the local gateway running independently of the visible window if the architecture supports it safely.

---

### 14. Testing Strategy and Quality Gates

Use a comprehensive test system.

Recommended tooling includes:

- Vitest for unit tests.
- Playwright for end-to-end tests.
- Electron-specific Playwright tests.
- HTTP integration and contract tests.
- Static TypeScript checks.
- ESLint.
- Security and dependency scanning.
- Deterministic mock upstream services.

#### Required test categories

**Unit tests**
- Protocol transformations.
- Configuration logic.
- Pool algorithms.
- Database helpers.
- Error classification.
- Migration logic.

**Integration tests**
- API routing.
- Authentication.
- Account persistence.
- Streaming behavior.
- Retry handling.
- Process supervision.
- Browser lifecycle.

**Compatibility tests**
- Legacy API fixtures.
- Response schemas.
- SSE event sequences.
- Error formats.
- Legacy configuration mappings.
- Database and backup restoration.

**Desktop E2E tests**
- First launch.
- Dashboard navigation.
- Settings persistence.
- Account import.
- Backup and restore.
- Local gateway startup.
- Application restart.
- Browser launch.
- User-visible error handling.

**Failure-injection tests**
- Network disconnection.
- Upstream timeouts.
- Invalid credentials.
- Gateway worker crash.
- Browser worker crash.
- Application restart.
- SQLite interruption.
- Migration failure.
- Interrupted development task execution.

**Performance tests**
- Concurrent API requests.
- Long-running streams.
- Multiple-account workloads.
- Large usage databases.
- High-volume logs.
- Repeated browser creation and cleanup.

#### Definition of Done for every task

A task is complete only when:

1. The implementation exists.
2. Required acceptance criteria are met.
3. Relevant tests pass.
4. Existing validated functionality has not regressed.
5. Security constraints remain satisfied.
6. Documentation is updated.
7. The task is reviewed.
8. Changes are committed.
9. The task board is updated.
10. Recovery state is checkpointed.

---

### 15. CI/CD and Release Engineering

Implement GitHub Actions workflows for:

```text
.github/workflows/
  ci.yml
  security.yml
  build.yml
  release.yml
```

Adjust filenames if necessary, but preserve equivalent responsibilities.

#### Continuous Integration

For every relevant pull request and branch push:

- Install pinned build dependencies.
- Validate formatting.
- Run linting.
- Run TypeScript type checks.
- Run unit tests.
- Run integration tests.
- Run applicable desktop E2E tests.
- Run migration tests.
- Run dependency security checks.
- Build the application.

Use Windows, macOS and Linux runners where appropriate.

#### Continuous Delivery

Build on native operating-system runners.

Produce independently usable packages for declared supported architectures.

Validate:

- Package contents.
- Native module compatibility.
- Bundled browser paths.
- Executable permissions.
- First-launch behavior.
- Runtime dependency completeness.
- Version metadata.
- Artifact integrity.

Test installed or extracted release candidates, not only source builds.

#### GitHub Releases

Use semantic version tags such as `v1.0.0`.

When a release is triggered:

1. Validate the version.
2. Run required quality gates.
3. Build all supported targets.
4. Perform packaging validation.
5. Generate SHA-256 checksums.
6. Generate release notes.
7. Attach installation artifacts.
8. Attach checksums and relevant metadata.
9. Publish only after the required gates pass.

Support release drafts and prereleases.

Never expose signing keys or secrets.

If signing or notarization credentials are unavailable, record the limitation and produce clearly identified test or unsigned artifacts where allowed.

Do not report unsigned artifacts as fully verified production releases.

#### Supply chain

Use lockfiles, least-privilege workflow permissions, controlled release triggers, dependency provenance or SBOM generation where feasible, and reproducible build practices.

---

### 16. Mandatory Implementation Phases

Organize all work into the following phases.

Each phase must be represented on the task board with dependencies, smaller tasks, acceptance criteria and test commands.

| Phase | Description | Required exit condition |
|---|---|---|
| 0 | Repository audit and baseline | Feature inventory and architecture audit complete |
| 1 | Task coordinator and crash recovery | Recovery and task lifecycle tests pass |
| 2 | Monorepo and desktop foundation | Electron, Vue and Node application launches |
| 3 | Core gateway rewrite | API contract and streaming tests pass |
| 4 | Account, quota and persistence migration | Pool and storage tests pass |
| 5 | Modern desktop dashboard | Key user journeys pass desktop E2E tests |
| 6 | Playwright and supported integrations | Bundled browser and integration tests pass |
| 7 | Legacy data and restore compatibility | Migration and rollback tests pass |
| 8 | Performance, reliability and security | Benchmarks and failure-injection gates pass |
| 9 | Cross-platform packaging | Clean-install checks pass on target platforms |
| 10 | CI/CD and release validation | Multi-platform release pipelines pass |
| 11 | Final parity audit and documentation | All required features verified or explicitly blocked |

Do not begin large dependent phases before their foundational requirements are ready.

Independent tasks may be implemented concurrently when they do not create conflicting modifications.

Use vertical slices to deliver working functionality throughout development.

---

### 17. Progress Reporting and Agent Handoffs

After every task, update the task board and state files.

At the end of each meaningful implementation checkpoint, report:

```text
PROJECT: AutoZCoder Rewrite

Current phase:
Current task:
Task status:
Completed tasks:
Active agents:
Files changed:
Tests executed:
Passing tests:
Failing tests:
Latest commit:
Known blockers:
Next task:
```

If development is interrupted, leave an accurate handoff.

Do not produce a handoff that merely says "continue implementation."

State the exact task, files, test results, branch and next executable action.

Every agent must be able to resume from the persisted repository state without relying on earlier chat history.

---

### 18. Final Delivery Requirements

The project is not finished until it includes:

- A complete Node.js implementation of the supported gateway functionality.
- An Electron desktop application.
- A modular Vue 3 and Tailwind frontend.
- Cross-platform native integration.
- Supported Playwright browser workflows.
- Bundled browser executables.
- No Python runtime dependency.
- No separate Node.js installation requirement.
- Compatible API endpoints.
- Legacy data import and restore support.
- Reliable local persistence.
- Proper handling of credentials.
- Health monitoring and structured logs.
- Automated unit and integration tests.
- Desktop end-to-end tests.
- Cross-platform build configuration.
- Automated CI/CD.
- Release-ready packages.
- Accurate installation documentation.
- Developer documentation.
- Architecture documentation.
- Migration documentation.
- Performance results.
- Complete task board history.
- Recovery and handoff documentation.

Create a final file:

`docs/rewrite/FINAL_DELIVERY_REPORT.md`

This report must contain:

1. Implemented feature inventory.
2. Known differences from the original project.
3. API compatibility results.
4. Migration compatibility results.
5. Test results.
6. Performance comparisons.
7. Security review summary.
8. Supported platforms.
9. Produced release artifacts.
10. Actual verification status of each artifact.
11. Known limitations.
12. Outstanding blockers, if any.
13. Final Git commit and branch information.

No fabricated claims.

If certain OS-specific checks cannot be executed in the current environment, mark them as unverified and provide executable CI or manual verification steps.

---

### 19. Autonomous Execution Instructions

You are expected to perform engineering work, not merely describe it.

Follow this loop:

```text
START
  |
  v
Read persistent project state
  |
  v
Inspect repository and Git state
  |
  v
Recover interrupted work
  |
  v
Find highest-priority eligible task
  |
  v
Acquire task lease
  |
  v
Mark task DOING
  |
  v
Implement scoped changes
  |
  v
Run tests
  |
  v
Review results
  |
  +-- Failed --> Repair or record blocker
  |                  |
  |                  v
  |                Retry within limits
  |
  +-- Passed --> Commit changes
                    |
                    v
                Mark task DONE
                    |
                    v
                Save checkpoint
                    |
                    v
                Select next task
```

Continue until there are no remaining executable tasks or an external blocker prevents further progress.

Use bounded retries and explicit blocking states rather than infinite loops.

If a network outage blocks downloading build dependencies, continue with available offline work. Do not corrupt dependency files or silently substitute incompatible packages.

If context is running low, prioritize committing valid progress and producing an accurate recovery checkpoint.

If a new session begins, resume rather than restart.

Do not wait for a human to manually reassign ordinary tasks.

Ask for user involvement only when genuinely necessary, such as external account authorization, signing credentials, unavailable protected secrets, or irreversible actions requiring approval.

Never pretend those dependencies are satisfied.

---

### 20. Your First Actions — Start Now

Perform the following immediately:

**Step 1:** Inspect repository contents, current branch and Git status.

**Step 2:** Create or select the dedicated rewrite branch without modifying the original branch.

**Step 3:** Create the persistent `.agent/` infrastructure, including the task board and recovery protocol.

**Step 4:** Inventory the original functionality and identify its actual implementation files.

**Step 5:** Run and record the available baseline tests.

**Step 6:** Create the architecture, compatibility, migration and phase documents.

**Step 7:** Break the roadmap into small, independently verifiable tasks with stable IDs and dependencies.

**Step 8:** Assign ownership, mark the first executable task as `DOING`, and begin implementation.

**Step 9:** Run tests, commit valid progress, update the board and save a checkpoint.

**Step 10:** Continue autonomously through the remaining phases, respecting dependencies and integration gates.

**Final instruction:** Deliver working, maintainable, tested software. Do not stop at planning, scaffolding, UI mockups, unverified code, or claims of completion. Preserve verified progress continuously so another agent or future session can resume exactly where work stopped.