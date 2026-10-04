# Orchestration V2 migration verification — 2026-10-03

## Status: preservation verified; final cutover qualification pending

Worktree: `/Users/yaacov/REPOs/ScientFactory-worktrees/scient-t3-sync-ca7df394ed-20261003`.
Branch: `codex/t3-sync-ca7df394ed-20261003`.

The original preservation fixes, 69-test/nine-file report and zero-native-run JSON result below describe the migration verifier's historical snapshot in the integration worktree. They are retained as historical evidence, not a declaration that the complete V2 cutover is ready. Native V2 held-run admission and production startup qualification have since been added by the integration owner, with the later checkpoints below. The literal upstream merge is complete at `b8fbae4ffa84414b02461cf42a0afa4b10a03fcc`, retaining `ca7df394ed8151fa77f856beefa90bc60a785d60` as its upstream parent. The separate owned-main catchup to `33ab8e307afbabda3e155c439d89bc788148d379` is committed at `794ff29ed2120ac2d2ee13f30488e68b17402cb7`. Final immutable review identity and manual gates are tracked in the alignment receipt.

At the original verifier snapshot's commit check, `MERGE_HEAD` was `ca7df394ed8151fa77f856beefa90bc60a785d60`. An actual `git commit --only --dry-run -- apps/server/src/orchestration-v2/legacy/LegacyV1ThreadImporter.ts` returned:

```text
fatal: cannot do a partial commit during a merge.
```

No migration-only commit was made by the verifier. No unrelated files were staged, unstaged, reverted, or committed by that slice. The integration owner has read this handoff, reviewed the implementation and added native held-run admission. The completed upstream checkpoint already records its literal ancestry; the committed owned-main catchup and final review candidate are separate from that historical merge. The verifier's partial-commit refusal does not require a separate migration commit or an alternate ancestry construction.

## Changes owned by this slice

- `apps/server/src/orchestration-v2/legacy/LegacyScientHistory.ts`: Scient-owned historical-item import. Deterministic event identities, chronological positions shared with the message transcript, bounded event batches, and repair of positions from older message-only imports.
- `apps/server/src/orchestration-v2/legacy/LegacyV1ThreadImporter.ts`: reserve historical positions when creating shells; hydrate history before confirming transcript completion; upgrade already-completed message-only imports when opened. Compile structured-context decoding once and decode each message's context once.
- `apps/server/src/orchestration-v2/legacy/LegacyScientHistory.test.ts`: payload preservation, inert approvals, V2-edit preservation, projection rebuild, retry after a committed batch and a failed subsequent batch, malformed history refusal, and local fork ancestry/cycle refusal.
- `apps/server/src/scient/threadQueue/migration.ts` and `migration.test.ts`: retain queued payloads but revoke stale send/steer/edit authority and require explicit send/resume for imported JSON entries. Verify order, selected skills, structured context, composer snapshot, model, permission/interaction modes, source retention, and repeat-run behavior.
- `apps/server/src/persistence/initializeV2Database.test.ts`: concurrent publication and independent V1/V2 backup/restore, without overwriting post-backup work in the live V2 database.
- `apps/server/src/persistence/Migrations.compatibility.test.ts`: preserve recorded ledgers/session data, repeat-run ledger stability, and reject conflicting migration identity before later steps. Remove incidental assertions that copied the manifest and physical column lists.
- `apps/server/src/orchestration-v2/legacy/LegacyV1Cutover.integration.test.ts`: align the existing end-to-end fixture with the integration owner's strict immutable-ledger policy. Seed a supported Scient V1 database through migration 52 rather than a foreign build's conflicting migration 41. Remove obsolete warning-text and skipped-column assertions; ledger collision refusal is exercised separately. The shell, lazy transcript, metadata, long-context continuation, and restart scenarios remain.
- `docs/user/thread-migration.md`: describe the actual retained history, authority boundary, queue limitation, and complete-profile recovery procedure.
- `docs/internals/t3-upstream-sync-20261003-ca7df394ed.md`: add the independent migration checkpoint and link this handoff without closing the integration owner's broader gates.

The import adds no provider sessions, runtime approval requests, native-fork authority, or live execution nodes. Pending historical approvals are interrupted timeline facts. Proposed plan text is a historical turn item, not a live plan execution. Original V1 tables remain the recovery source.

## Exercised verification

All work used synthetic databases/profile files. No live user profile was opened or copied. Checks ran serially, with one Vitest worker.

### Before/after failures

1. The new history regression failed before the fix: only the user and assistant messages were present; system history, activity, approvals, and proposed plan history were missing.
2. The queue regression failed before the safety fix: imported legacy entries had no explicit waiting-for-resume state. Stale `sendRequested` was retained by the old importer.
3. The existing cutover fixture failed against the current ledger validator because it recorded a different build's name under migration 41. The fixture now covers a supported legacy ledger; a separate behavioral test verifies refusal of a conflicting ledger without rewriting it.

### Final regression run

```sh
pnpm exec vp test run \
  apps/server/src/orchestration-v2/legacy/LegacyScientHistory.test.ts \
  apps/server/src/orchestration-v2/legacy/LegacyV1ThreadImporter.test.ts \
  apps/server/src/orchestration-v2/legacy/LegacyV1Cutover.integration.test.ts \
  apps/server/src/persistence/initializeV2Database.test.ts \
  apps/server/src/persistence/Migrations.compatibility.test.ts \
  apps/server/src/scient/threadQueue/migration.test.ts \
  apps/server/src/scient/threadQueue/Store.test.ts \
  apps/server/src/scient/threadQueue/Ledger.test.ts \
  apps/server/src/scient/threadQueue/Worker.test.ts \
  --maxWorkers=1
```

Result: **9 files, 69 tests passed**. The continuation test uses the existing replay adapter, not a live provider account.

### Standalone file-backed smoke

A disposable Node program, outside Vitest, used the real SQLite migrators, snapshot initializer, importer, event sink, projection store, maintenance/rebuild, and queue document importer. It:

- seeded a Scient V1 database through migration 58 and the independent Scient ledger;
- copied to V2, applied migrations 59/60, and hydrated messages, activity, approval evidence, and plan text;
- verified the original V1 database bytes and queue JSON stayed unchanged;
- preserved structured message context, pin metadata, and interrupted streaming status;
- restarted the services and compared the full projection, event identities, and durable queue document;
- rebuilt projections and compared the complete timeline;
- backed up both databases with SQLite's backup API and copied queue JSON/attachment files;
- wrote additional work to the live V2 database, restored into a separate synthetic profile, and verified the restored snapshot without overwriting the live profile;
- verified restored V1 integrity, migration ceiling, legacy text, and unresolved approval evidence;
- verified stale queue authority was cleared and the payload order, skills, context, composer snapshots, and execution options survived restore.

Observed result:

```json
{
  "syntheticProfileOnly": true,
  "threads": 1,
  "messages": 2,
  "historicalItems": 3,
  "idempotentAfterRestart": true,
  "projectionRebuild": true,
  "v1SourceUnchanged": true,
  "backupRestore": "both databases, queue JSON, attachment bytes",
  "staleQueueAuthorityRevoked": true,
  "queueSourceItemsPreserved": ["qitem_recovery-1", "qitem_recovery-2"],
  "v2QueuedRuns": 0,
  "unresolvedGate": "Legacy queue payloads remain in Scient's SQL queue; V2 held-run promotion is not implemented in this worktree."
}
```

The disposable script, compiler configuration, and synthetic profiles are not deliverables and are removed after verification. SQLite backup files are logically equivalent snapshots; their physical header counters need not match the original bytes. The unchanged-source assertion is on the original V1 database, not on a newly generated SQLite backup file.

### Scoped static checks

- Lint of the eight changed TypeScript modules: passed with no output.
- Effect diagnostics of those eight modules: **0 errors, 0 warnings, 0 messages**.
- Native TypeScript compilation of those eight entrypoints and their imports: **0 diagnostics in the eight changed files**, but the latest compiler run still exited 1 with **40 diagnostics in imported dependencies**. The preceding run reported 39; the shared integration remains in flight. This is not a whole-server green typecheck.

No full application/browser migration rehearsal or live provider resumption was claimed.

## Historical integration prerequisites

The list below records the verifier's original handoff. It is superseded by the later integration checkpoints: native held-run admission, shared compilation and the literal merge are implemented, and file-backed recovery/native FIFO have been exercised. Final whole-candidate gates and repaired-app acceptance remain open in the alignment receipt.

1. **Native queue cutover qualification:** server-only held admission now preserves SQL/JSON payloads, native ordering and receipts. The compatibility HTTP service now calls V2 commands. Qualify final production startup and delivery after the remaining integration changes; focused admission checks alone do not close this gate. Ordinary `message.dispatch` is not used as an import shortcut.
2. **Shared compiler gate:** resolve the current imported-dependency diagnostics as part of the integration owner's work; the scoped checks above do not waive them.
3. **Merge/commit ownership:** finish and qualify the complete alignment without dropping this slice, then create the intended merge commit with the real upstream parent. Preserve unrelated work and do not use a commit-tree workaround.
4. After native admission is available, exercise recovered queued entries through the real V2 queue lifecycle and explicit resume. Only then can migration preservation and alignment be marked complete.

## Integration owner's review checkpoint

The importer and queue cutover were reviewed as owned implementation. The original report's
branch and merge-parent identity do not identify its uncommitted working diff, and its removed
standalone smoke program is not independently reproducible from this record. Final acceptance
must therefore record the final candidate identity and reproducible checks; the historical
69-test result remains scoped evidence for the verifier's snapshot.

The new `LegacyQueueAdmission.test.ts` exercises actual SQLite and the production orchestrator:
held admission without provider execution, retry after interrupted source retirement, preservation
of later native edits, copied SQL/JSON ordering, original image bytes, unavailable instances,
compatibility enqueue, single-head Send, busy-thread refusal, and versioned extraction replay.
The queue selection run passed 17 tests across five files, with 46 unrelated cases unselected.
Provider delivery in these tests uses replay infrastructure; live accounts were not exercised.

## Integration recovery checkpoint — 2026-10-04

The integration owner requalified all nine migration files listed above together with
`AttachmentPersistence.test.ts`, `EffectOutbox.completions.test.ts`, and
`MessageAdmissionReceipt.test.ts`: **74 tests passed across 12 files**, with one worker
(`queue-migration-final-round11.txt` in the umbrella alignment review directory).

Additional queue probes reproduced failures before correction: interrupted source retirement
retried attachment claims after native acceptance, expired pending uploads blocked reconciliation,
a deleted destination stopped admission of unrelated queues, and a pending identity overwrote
portable historical content. Recovery now reads the exact accepted admission receipt before any
attachment work, validates its thread and command type, and retires only the old source entry.
Unaccepted entries cannot reuse message identities already held by conversation history. Typed
per-thread failures retain pending work and allow other threads to cut over; defects and
interruption still propagate.

`LegacyQueueAdmission.test.ts` and `LegacyQueueCompatibility.clone.test.ts` passed **19 tests**
(`queue-cutover-final-round14.txt`). The new cases inspect actual SQLite projections and file
bytes: changed or removed pending-upload sources do not rewrite accepted attachments, produce
extra copies, or prevent retirement; historical identity collisions preserve both conversations;
corrupt, deleted-destination and invalid-attachment queues remain recoverable while a valid queue
is admitted once. Retained transport delivery now uses the same native management service and
clone guard as ordinary delivery. Admission during an active clone remains held; Resume, Send
and Steer cannot start work until the clone finishes.

The actual HTTP/WS server suite separately passed **233 tests** in
`queue-server-final-round12.txt`; the same combined run's new foreign-owner fixture failed for
a missing SQL dependency and was corrected before the 19-test rerun above. The startup/CLI/runtime
batch passed **97 tests**. These are synthetic-state local proofs, not a live-profile cutover or
hosted-provider acceptance. Final candidate identity and owned-main catch-up qualification still
belong to the complete alignment receipt.

## Receipt-safe claim and recovery visibility checkpoint — 2026-10-04

Further source review found two remaining defects: a failed or interrupted admission left
randomly claimed attachment copies behind, and the compatibility list could report an empty
native queue while retained SQL or unreadable JSON work still required recovery.

Claim acquisition and cleanup registration now share an interruption mask. After dispatch
settles, cleanup reads the exact command receipt. Proven nonacceptance releases only this
attempt's copies; accepted admission retains the files named by its original committed message
event and releases only unused raced-replay copies. Later V2 edits do not determine original
file ownership. Unreadable, mismatched, or missing accepted-event evidence retains copies and
the source for recovery. Pending upload originals are never removed by this cleanup.

Compatibility list now returns a typed, visible recovery error when retained staging or an
unreadable/unimported JSON queue remains. It instructs users to keep their backup, restart
Scient to retry admission, and seek recovery support if the condition persists before
resending messages. Listing does not admit work, grant execution, or replace existing native
pending runs. A completed SQL import receipt prevents intentionally retained JSON originals
from being reported as new pending work.

The final scoped checkpoint passed **54 distinct tests across seven complete files** with
one worker. `queue-claim-recovery-round3.txt` records 28 passing queue/importer tests;
`queue-claim-recovery-round2.txt` also qualifies the unchanged three clone-gate and ten
attachment-claim tests; `queue-claim-recovery-dependencies-round1.txt` records 13 history,
file-backed cutover and legacy JSON source tests. Seven new queue cases use actual SQLite
and disposable files, with controlled dispatch boundaries: SQL commit failure and retry,
interruption before and after acceptance, ambiguous receipt-read failure, concurrent replay,
an accepted V2 edit clearing references before cleanup, and corrupt-source list visibility
without altering native pending work. The two new importer metadata cases independently
qualify missing versus explicit-null auto-settle choices and projection rebuild preservation;
they use isolated databases to preserve the existing shared-fixture count assertions.

Reproduction from the alignment checkout:

```sh
./node_modules/.bin/vp test run apps/server/src/orchestration-v2/LegacyQueueAdmission.test.ts apps/server/src/orchestration-v2/legacy/LegacyV1ThreadImporter.test.ts apps/server/src/orchestration-v2/legacy/LegacyQueueCompatibility.clone.test.ts apps/server/src/orchestration-v2/AttachmentClaims.test.ts apps/server/src/orchestration-v2/legacy/LegacyScientHistory.test.ts apps/server/src/orchestration-v2/legacy/LegacyV1Cutover.integration.test.ts apps/server/src/scient/threadQueue/Store.test.ts --maxWorkers 1
cd apps/server
../../node_modules/.bin/tsc --noEmit
```

Canonical server compilation exited **0**, with no hard errors or Effect warnings
(`queue-claim-recovery-server-compiler-round2.txt`); existing suggestions remain. Scoped
format, lint and diff checks are recorded with the same checkpoint. This qualifies the
current working-source slice. Final immutable candidate identity, complete alignment gates,
and manual/live-profile acceptance remain pending in the integration owner's receipt.
