# Draft PR descriptions for Scient fork modernization

These descriptions are prepared for review. They must not be merged or
published without separate authorization. Both PRs are stacked:
PR 15 builds on PR 14, which builds on merged PR 13 (`origin/main`).

## PR 14: Server-owned fork boundary resolution

**Title:** `refactor(fork): move boundary authority to server-owned SQL resolver`

**Body:**

Move fork boundary resolution from client-shaped thread snapshots to a
Scient-owned server resolver that queries SQL-backed `projection_turns` joined
with `scient_thread_lineage` at resolution time. The public fork command now
carries only four fields: `originThreadId`, `newThreadId`,
`sourceAssistantMessageId`, and `workspaceMode`. The client no longer supplies
boundary arrays, turn counts, checkpoint relationships, or caller titles.

### What changed

- Introduced `ForkBoundaryReadModel`, a Scient-owned resolver that
  authoritatively verifies the assistant message, completion state, origin
  ownership, stale/reverted state, and checkpoint eligibility from SQL.
- The pure fork decider (`forkDecider.ts`) consumes resolved boundaries
  exclusively and no longer reads `origin.conversationForkBoundaries` from the
  read model.
- Removed complete boundary arrays from global shell snapshots and ordinary
  client thread detail. The client receives only a narrow lineage marker
  (`originThreadId` and `baselineAssistantMessageId`).
- Closed the snapshot watermark gap: `REQUIRED_SNAPSHOT_PROJECTORS` now
  includes `threadTurns` and `scientThreadLineage` so `snapshotSequence`
  cannot advance ahead of fork-boundary/checkpoint/latest-turn projectors.
- Ordered `scientThreadLineage` before `threadMessages` and `threadTurns`
  during bootstrap/restart replay so fork baselines survive revert replay.
- Fork titles are now server-owned and collision-safe, derived from resolved
  server boundaries and the narrow `forkLineage` marker.
- Added cross-area integration tests for exact boundary through
  projection/persistence (VAL-CROSS-005) and revert-then-fork (VAL-CROSS-010).

### What is preserved

- Exact-boundary fork behavior, origin immutability, fail-closed validation.
- Re-fork, attachment copying, checkpoint eligibility, non-Git local forks.
- Durable lineage, recovery, provider bootstrap, and restart safety.
- Old-client compatibility and existing persisted event readability.

### Verification

220 focused tests across 16 files pass, including boundary resolution,
decider, projection, snapshot, state, and cross-area integration suites.
Typecheck, lint, format, and `git diff --check` pass.

---

## PR 15: Normalized Scient persistence

**Title:** `refactor(fork): replace monolithic schema with versioned migration runner and normalize active lineage`

**Body:**

Replace the monolithic startup schema inspection with a Scient-owned versioned
migration runner built on the standard Effect SQL Migrator (`Migrator.make`)
and the separate `scient_schema_migrations` ledger. Normalize the active
lineage model so `transcript-bootstrap` is the only active provider bootstrap
mode, enforce terminal lifecycle guards in repository SQL predicates, and
remove active runtime dependence on prototype concepts.

### What changed

- Introduced `scientMigrator.ts`, a versioned migration runner delegating to
  the standard Effect SQL Migrator with three migrations:
  `durable-thread-forks` (1), `durable-provider-bootstrap` (2), and
  `normalize-active-lineage` (3). Each unapplied migration runs once,
  transactionally, in ascending ID order.
- Added a Scient-owned preflight: legacy `applied_at` ledgers are rebuilt
  into the canonical `created_at` shape in one transaction (all IDs, names,
  and timestamps preserved; `applied_at` kept as nullable residue), and the
  recorded ledger is strictly validated as a contiguous prefix of the
  manifest — gaps, renamed entries, and unknown future IDs fail closed.
- Migration 3 normalizes prototype mode values (`cold-start`, `chat-only`,
  `replay`) to `transcript-bootstrap`, adds lifecycle columns with safe
  defaults, quarantines malformed rows into
  `scient_thread_lineage_quarantine` (payload snapshot, reason, timestamp)
  instead of failing startup, and creates supporting indexes. Physical
  compatibility columns remain.
- Enforced terminal lifecycle guards in repository SQL predicates:
  `markForkFailed`, `markForkAbandoned`, `markForkReady`, and `claimFork`
  all prevent abandoned/ready regression. `markAccepted` requires
  `status = 'ready'` plus `provider_bootstrap_status = 'pending'`.
- `prepareTurn` no longer reads the `provider_mode` compatibility column;
  it checks only `status`, `provider_bootstrap_status`, and
  `fork_point_turn_count`. `markForkReady` no longer writes `fidelity_mode`.
- Added cross-area integration tests for fresh startup to ready fork
  (VAL-CROSS-001), prototype upgrade compatibility (VAL-CROSS-002), restart
  during pending fork (VAL-CROSS-003), interrupted provisioning retry
  (VAL-CROSS-004), re-fork after normalization (VAL-CROSS-006), T3/Scient
  ledger isolation (VAL-CROSS-008), and lifecycle semantics surviving
  migration (VAL-MIGRATE-13).

### What is preserved

- All PR 13 and PR 14 behavior: exact boundaries, origin immutability,
  re-forks, attachments, checkpoint eligibility, revert, and recovery.
- T3 migration ledger and numbering are never modified.
- Physical compatibility columns remain queryable with data.
- Pending, provisioning, failed, abandoned, and ready lifecycle semantics.
- Provider bootstrap normal path (single-injection) and crash recovery
  (at-least-once).
- Restart safety and durable recovery semantics.

### Out of scope

Startup turn reconciliation, generic T3 migration redesign, checkpoint-reactor
redesign, and unrelated provider runtime schema work. These belong to future
work.

### Verification

220 focused tests across 16 files pass, including migration runner (21 tests),
lifecycle (14 tests), provider bootstrap (18 tests), and cross-area integration
(15 tests). Typecheck, lint, format, and `git diff --check` pass. Disposable
loopback server health check on port 18923 returns HTTP 200.
