# T3 upstream sync through ca7df394ed

> For maintainers. Using Scient? See [docs/user](../user/).

Status: **in progress.** This receipt is written while the merge is still being qualified. Sections
below record decisions that are settled; the Verification section states exactly how far
qualification has got and what is deliberately not yet claimed.

## Exact boundaries

- Original planning base: `origin/main` = `bf3439c243`; the composed merge was restarted on
  owned base `ad215fd9157e86252a2ee1187e746b65c8b003be` before qualification.
- Adopted: `MERGE_HEAD` = `ca7df394ed` (upstream PR #2829), 15 commits on `main`
- Merge base: `54084ae1e`
- Conflict resolution: **358 of 358 resolved**, zero conflict markers, zero staged files carrying
  markers, `MERGE_HEAD` ancestry intact.

Nothing is squash-replayed, patch-transplanted or reimplemented. The merge is composed in place so
its second-parent ancestry is real.

### Local ancestry checkpoint — 2026-10-04

The upstream merge is being committed as a local checkpoint before the separate owned-main
catch-up. This is not final approval. The integration cursor remains at the previously qualified
upstream boundary until the composed candidate completes qualification.

- Native queue cutover and clone-gated delivery: **19 tests passed**, plus the actual HTTP
  admission → clone rejection → WebSocket clone completion → delivery regression. Accepted receipts
  retire their source without reclaiming attachments; rejected imports retain pending work. Message
  ownership is rechecked in the admission transaction, preventing a cross-thread overwrite.
- Codex context delivery: **66 tests passed**. Two semantic orchestration entries respect the
  unchanged 4,000-byte per-entry bound; concatenation preserves the complete instruction text.
- Whole-candidate formatting passed across 7,240 files, excluding an unrelated untracked scratch
  `apps/server/tsconfig.agentfixcheck.json`. Lint exited successfully with no errors and 1,137
  warnings; warning cleanup and regression review remain part of final qualification.
- The canonical server compiler (`tsc --noEmit -p apps/server/tsconfig.json`, round39)
  exited successfully with no hard TypeScript or Effect diagnostics.
- The earlier complete server suite passed **233 tests**; the new HTTP case passed separately.
  Migration/recovery passed **74 tests**. These results qualify synthetic fixtures, not live
  provider accounts or user data.

Remaining work includes the owned-main Scient Agent integration, native Agents/workflow
presentation and producer parity, the actual OMP turn-service handoff proof, final full gates and
artifact inspection, and independent technical/visual review. No publication or manual acceptance
is claimed by this checkpoint.

## Adopted behavior

Upstream's mechanics were adopted wholesale in these areas, with Scient behaviour re-applied on
top rather than preserved by forking the component:

- **V2 orchestration runtime.** V2 owns production command admission, execution, projection,
  recovery and outbox delivery. Retained section and message-boundary fork payloads are translated
  into native V2 service calls; V1 remains a historical import/test library.
- **ACP wire generation.** `effect-acp` moves to a two-file generated schema split (v2 in
  `schema.gen.ts`, v1 in `schema-v1.gen.ts`). Regeneration was deliberately NOT performed: the
  generator downloads its ACP inputs at run time, and the existing output is byte-identical to
  upstream's.
- **SSH transport.** Upstream replaced the node-script runner with an archive runner. Adopted,
  with the fork's pinned-package default retained where it conflicts with upstream's
  "refuse to build a runner" assertion.
- **Provider lifecycle.** The Pi driver cluster was taken from upstream wholesale, because merged
  `ProviderInstance` requires `orchestrationAdapter` (`ProviderAdapterV2Shape`) which the fork's
  V1 driver never returned.

## Protected-boundary resolutions

**MCP ambient authority — upstream behavior deliberately changed.** Upstream's `McpSessionRegistry`
granted `orchestration`, `worktree` and `pull-requests` to _every_ minted MCP token. That widens a
credential beyond what its issuer requested. The registry now binds exactly the requested set,
and `apps/server/src/auth/RpcAuthorization.ts` carries a comment explaining why the ambient grant
was removed. **Consequence: any toolkit that relied on the ambient grant must now request its
capability explicitly.** This is the one place where this merge does not simply adopt upstream.

**`orchestration.dispatchCommand` — one combined wire registration.** The shared method accepts
both compatible payload shapes through one schema and preserves `forkDisposition` in its error
contract. Native V2 commands go to the orchestrator. Retained section and clicked-message fork
commands call V2 services; overlapping `thread.fork` shapes are distinguished by their fields.
No production command routes to a V1 execution engine. Actual WebSocket acceptance exercises
V2 creation, section assignment, assistant/user boundaries, refusal, and fork readiness.

**Config-option absence.** Upstream normalizes a missing inventory to `[]`. The fork's declared
contract preserves absence, because absence means "the agent will publish the refresh
asynchronously" and `[]` means "no options exist". Fork semantics kept, applied to both protocol
generations.

**Skill selection restored to the V2 wire.** `selectedScientSkillNames` existed only on the V1
`message.dispatch`; V2 dropped it, so a turn dispatched through V2 silently ran without the
user's skills — no type error, no warning. Restored across contracts, the V2 decider,
`ProviderTurnStartService` and `ThreadLaunchService`, proven by
`apps/server/src/orchestration-v2/SelectedScientSkillNames.test.ts`, which drives the real decider,
event store and projection read rather than asserting a type.

**A pre-existing skill-delivery bug, found while fixing the above.** `SCIENT_SKILL_DELIVERY` had
no `acpRegistry` entry. Upstream's new `AcpRegistryDriver` therefore fell through to
`unsupported`, and every V2 turn on that provider had its skills withheld with only a log line.
`src/scient/skills/ScientSkillSession.test.ts` was already failing on this before the merge; it is
green now.

**Migration ledger — fork ids retained.** Upstream renumbered its tail; the fork inserted
`041_ProjectlessThreads` and `043_RetireProjectlessThreads`, so the offset drifts (+1/+2/+3) along
the tail. The fork's ledger is authoritative and is pinned in
`apps/server/src/persistence/Migrations.compatibility.test.ts`. `059_OrchestrationV2.ts` is
byte-identical to upstream's `055_OrchestrationV2.ts`; the apparent "missing" V2 migrations are
composed inside it.

**Slot-collision detection.** Upstream's migrator now detects a ledger collision first and throws an
opaque `MigrationError` message, which suppressed the fork's structured
`MigrateDevDbSlotCollisionError { slot, codeName, appliedName }`. A pre-migration verification on
the snapshot now runs first so the structured error survives. Message-matching was deliberately
rejected as fragile.

**Scient services deleted upstream, retained at their actual consumers.**
`ThreadBackgroundLiveness`, `ActivityPayloadProjection`, `ThreadPlanProgress`,
`ProviderSessionDirectory` (at its original path — its callers are mostly outside
`orchestration`), the `StorageCleanup` service and `layer`, `discardCloneForDeletedProject`,
`revokeAllActiveMcpCredentials`, and the fork's `subagentRuntime` agent-panel subsystem were all
initially recovered from the frozen owned base. Production readers and cleanup now consume native
V2 projections; historical V1 libraries remain for import and compatibility tests. Preservation of
the behavior, rather than the earlier byte-for-byte recovery, is the acceptance condition.

**Two obsolete V1 components were deliberately left deleted.** The v1 `ProviderAdapterRegistry` was deleted
(zero importers; `orchestration-v2/runtimeLayer.ts` wires the V2 registry at three points and it has
its own test). The `threads-pagination` suite was deleted rather than restored: its behaviour was
superseded by V2's history-merge model, so restoring 664 lines would have tested a subsystem that no
longer exists.

## Follow-up corrections

The remaining parity questions below require implementation and behavioral evidence. Required fork
behavior must be preserved or migrated; only a deliberate product narrowing requires explicit approval.

1. **Pi managed-runtime actions** — desktop-managed Pi install, the Pi custom-models client, and
   `snapshotForCwd`, lost with the upstream Pi cluster.
2. **`serverRuntimeStartup`** — the provider-session continuation block
   (`withRunningThreadContinuation`) and the `launchAnalyticsEventObservers` call site need a
   continuation/observer parity audit. Deletion of an old dependency alone does not prove that its
   user-visible behavior is obsolete.
3. **`AgentSessionImporter.test.ts`** — the fork's V1 suite (~8 unit plus 5 integration tests).
   `ProviderSessionDirectory` retains its own 12-test suite.

**Server-layer correction.** The earlier draft incorrectly listed four missing server layers.
`ProviderInstallationRefreshLive`, `ReplayMarkers.layer` and `GitHubCli.layer` are present in
`server.ts`; checkpoint services are composed through `CheckpointStoreLayerLive` and
`CheckpointDiffQuery.layer`.

**Production V1 execution retired.** The temporary V1 runtime restoration exposed the retained
command seams but could not operate on V2-created threads. It has been replaced by native V2
section/fork services, held-queue admission, import/export, MCP reads and cleanup. Historical V1
fixtures still test journal and compatibility behavior; they do not qualify production execution.
The production skill catalog/policy service is mounted independently and captured by the V2
start and steering services.

### Data-model boundary

V2 requires a project identity. Migration and internal/scratch handling are qualified in the
[independent migration handoff](../operations/orchestration-v2-migration-verification.md).
A native consumer fixture must use the real V2 shape. Historical V1 shapes belong at the import
boundary; casts and fabricated nullable native project IDs are not compatibility evidence.

## Verification

Qualified so far, with the syntax gate confirmed open before each reading:

| Tree                      | Hard TypeScript errors | Tests     |
| ------------------------- | ---------------------- | --------- |
| `packages/contracts`      | 0                      | 727/727   |
| `packages/shared`         | 0                      | 1156/1156 |
| `packages/client-runtime` | 0                      | 2136/2136 |
| `packages/effect-acp`     | 0                      | 76/76     |
| `packages/ssh`            | 0                      | 53/53     |
| `apps/mobile`             | 0                      | 1473/1473 |
| `apps/desktop`            | 0                      | 1589/1589 |

`apps/web` and `apps/server` were **not** zero and are not claimed as such. `apps/server` reached
0 `Cannot find module` (from 145); `apps/web` is down to a single file.

### Post-agent qualification checkpoint

- Server typecheck after runtime restoration: **1,124 diagnostics**, comprising **519 hard
  TypeScript diagnostics** and **605 Effect-plugin diagnostics**. Zero syntax-class errors and zero
  missing modules. The complete typecheck still fails; plugin diagnostics are not waived.
- Web agent handoff: **18 remaining diagnostics**, down from its starting 57. This is not a complete
  measure of the remaining work: the unresolved shell/thread helper leaves dependent values untyped.
  Archived-thread rendering, imported-conversation metadata, fork/checkpoint reads, queue-edit
  recovery and the missing agent-spawn row remain unqualified.
- Executed `vp test run src/orchestration/Layers/ProjectionPipeline.test.ts
src/orchestration/Layers/OrchestrationEngine.test.ts`: **73 passed**, two files.
- Executed `vp test run src/components/ChatView.logic.test.ts src/session-logic.test.ts` in
  `apps/web`: **237 passed**, two files. These logic suites do not prove the actual ChatView surface.
- The temporary restored-runtime SQLite smoke passed and was removed after execution.

Two bugs in this merge were invisible to the compiler and were found by reading for what no longer
exists rather than by diagnostics:

- `revokeAllActiveMcpCredentials` became module-private upstream when its only consumer was deleted,
  while `provider/Layers/ProviderService.ts` still calls it from `runStopAll`. "Stop all" would
  have silently failed to revoke MCP credentials.
- `ProviderAdapterError` / `ProviderAdapterValidationError` / `ProviderUnsupportedError` were dropped
  from `provider/Errors.ts`. The referencing code compiled — as a value with no type — and crashed at
  runtime.

### Independent migration verification — 2026-10-03

The shared-worktree migration slice now retains system history, activities/tool results,
historical approvals, and proposed plan text through the Scient-owned legacy history importer.
It repairs message-only imports on first access, preserves V2 edits, retries after partial
batch commits, and leaves live provider/approval/fork authority uncreated. JSON queue imports
retain payloads and clear stale send/steer/edit authority, waiting for explicit send/resume.

- Migration, cutover, compatibility, snapshot and queue regression run: **69 tests passed in
  nine files**, one worker.
- Standalone synthetic file-backed smoke: original V1 database and queue JSON unchanged;
  restart and projection rebuild stable; both database snapshots, queue payloads and attachment
  bytes recoverable in a separate restored profile.
- Eight migration-owned TypeScript modules: lint passed and Effect diagnostics reported
  **0 errors, 0 warnings, 0 messages**. The focused compiler still failed with **40 diagnostics
  in imported dependencies**, none in the eight selected modules.
- **At the migration verifier's snapshot**, queue payloads remained in Scient's SQL queue.
  The subsequent integration checkpoint below adds native admission; startup and final-candidate
  qualification remain open.
- **Commit blocked:** the upstream merge remains pending; an actual path-only dry run returned
  `fatal: cannot do a partial commit during a merge.` No migration commit or unrelated staging
  was performed.

Exact ownership, commands, preservation boundaries, and integration prerequisites are recorded
in [the migration verification handoff](../operations/orchestration-v2-migration-verification.md).
These scoped results do not close the full application, compiler, visual, packaging or merge gates.

### Native queue integration checkpoint

Legacy SQL and JSON payloads now enter native V2 held runs through a server-only admission
command. Acceptance records the payload and receipt without opening a provider session or
creating a live approval. Source retirement follows acceptance, so interrupted retirement
replays the receipt and preserves later V2 edits. Inline attachments use exclusive publication
and conflicting retries cannot overwrite accepted bytes.

The compatibility HTTP service reads V2 projections and translates delivery, cancellation,
steering and extraction into V2 commands. Its SQL document is staging only; the V1 worker is
not mounted. Stale edit reservations require recovery into ordinary drafts. Modern clients use
their native queue controls after the compatibility response identifies native ownership.
Explicit Send releases only the idle head; Resume releases the queue. Versioned extraction
rejects a changed payload while holding the same thread command lock as native edits.

Serial qualification: **17 tests passed, 46 intentionally unselected**, across five files:
`LegacyQueueAdmission.test.ts`, `RunCompletionReads.test.ts`,
`Orchestrator.control-reads.test.ts`, `QueuedRunOrder.test.ts`, and selected queue cases in
`runtimeLayer.test.ts`. This proves actual SQLite receipt/projection behavior and replay-provider
queue behavior; it does not establish live-provider delivery or full production startup.
The current full-server compiler still fails; no overall compiler approval is claimed.

### Provider compatibility preservation checkpoint

The frozen Scient base shipped OpenCode 1 through Scient 0.6.17 and Pi from 0.0.42.
The upstream manifest's OpenCode 2 boundary at 0.0.46 would reinterpret already-released
Scient 0.6.x clients as supporting the new driver. The composed manifest therefore starts
OpenCode 2 at Scient 0.6.18 and keeps OpenCode 1 below that boundary. It restores Pi's
Scient build minimum of 0.0.42 and its established supported upstream version of 0.84.4;
the upstream Pi minimum of 1.0.0 does not describe the provider shipped by this frozen base.
`compatibilityBuildVersion` remains unchanged: unstamped 0.0.x development builds continue
to opt into development drivers, independently of these released-build compatibility ranges.
The historical-release and prerelease tests retain those distinct policies.

After the native lifecycle corrections, the serialized provider batch ran **237 tests**
across 13 files: 233 passed initially; four obsolete fixture assertions failed and then passed
in the bounded two-file rerun (10 tests). The final native adapter rerun passed **19 tests**
across Droid, OMP and the shared native-session adapter. Droid uses a real spawned ACP mock
to prove confirmed autonomy transitions, rejection before delivery when the native setting
does not apply, explicit specification approval even in full access, and successful token-limit
truncation with a persisted notice. OMP uses the actual adapter and session runtime with a typed
scripted RPC process to prove confirmed model selection and refusal of unsupported supervision.
Native tests also prove instance ownership, stale steering rejection, and that a local startup
identity does not grant native resume authority. The full ACP suite passed after the policy and
truncation changes. Scoped lint across 16 files reported **0 errors and 0 warnings**; formatting
and scoped whitespace checks passed. Evidence is in
`reviews/orchestration-v2-alignment-20261003/provider-parity-test-round9.txt`,
`provider-parity-retry-round10.txt`, `provider-parity-test-round11.txt`, and
`provider-parity-lint-round11.txt` in the umbrella workspace. The full compiler remains a separate
gate. A later five-file batch passed **28 tests**, including a dedicated real spawned
Antigravity mock proving strong identity only after a receipt, retained resume effort, and
replacement-process failure notification. Scoped formatting/lint passed; evidence is in
`provider-parity-{fmt,lint,test}-round12.txt`. No real account, hosted provider, or cross-platform
startup is claimed. Pi canonical selection/effort confirmation is being repaired separately and
is not qualified by this checkpoint.

### Provider acceptance map — 2026-10-04

This reconstructs the provider-owned acceptance rows from the handoff and current source. A
separate durable B1–B13 ledger could not be located. The test names below identify actual
invariants; they do not imply a full candidate or live-provider pass. Earlier scoped execution
receipts are recorded above and in the Pi checkpoint below.

| Criterion                                                | Implementation and named proof                                                                                                                                                                                                                                                                                                                                                                                                                   | Acceptance boundary                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B3: OMP native V2 and instance routing                   | `OmpDriver` constructs `makeOmpAdapterV2` using resolved launch settings and the instance's native custom-model process factory. `OmpAdapterV2.test.ts`: “projects the confirmed native model before delivering a prompt”, “refuses an acknowledged model write that did not change native state”, “rejects unsupported supervision on an already opened full-access session”.                                                                   | Actual adapter with scripted native RPC; live OMP/account and complete driver-registry dispatch proof are separate. No V1 execution bridge.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| B4: Droid ACP flavor and supervision                     | `DroidAdapterV2` supplies confirmed autonomy/model policy and explicit specification approval to `AcpAdapterV2`. `DroidAdapterV2.test.ts`: “requires explicit specification approval in full access”, “confirms native autonomy on consecutive mode changes and plan entry”, “refuses delivery when Droid acknowledges an autonomy write without applying it”. ACP tests retain dialog cancellation, process-loss and terminal-receipt coverage. | Spawned ACP mock and scoped full ACP suite passed; Windows/Linux process-tree behavior and real Factory session remain unverified here.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| B5 + E8: adopted Pi adapter with Scient delivery         | `PiAdapterV2` retains one native event consumer and confirmed canonical model/effort selection. `PiCustomModelsConnection` decorates that same connection with instance authority. `PiAdapterV2.test.ts`: “expands every selected $ skill through Pi native skill commands”, “injects the T3 MCP extension and bearer when a session exists”, custom-model revocation/default-model cases.                                                       | 87 direct tests passed. Eight Pi replay scenarios qualified through unchanged seven passes plus corrected steering rerun. Supplemental selection frames are explicitly synthetic; no hosted endpoint acceptance claimed.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| B6 + B11: tool inventory, owner, projection and dispatch | Native adapter ownership guards, MCP instance guard in OMP, Pi/ACP tool and subagent projection. `NativeSessionAdapterV2.test.ts`: “rejects a provider thread owned by another instance before resume”, “rejects stale steering before the native transport receives it”, “publishes readable child results for native subagents”.                                                                                                               | Adapter portions qualified. Server MCP inventory/dispatch authority is integration-owned and must be qualified on the final candidate.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| B7: workspace-change transition criteria                 | All four native driver factories pass the effective workspace to native launch. `ProviderSessionManagerV2` validates directory existence before opening/reusing. Existing named manager tests reject missing/file/deleted workspaces. ACP and native selection transitions restart when required.                                                                                                                                                | Workspace existence is distinct from workspace relocation/handoff. A final end-to-end relocation, resume identity, MCP ownership and queue-order scenario is still required; no blanket row closure from adapter tests.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| B8: continuation identity per driver                     | Pi, OMP, Droid and legacy Antigravity call `defaultProviderContinuationIdentity`, yielding `driver:instance:instanceId`; stronger provider-specific account identity remains in its owning driver. Native resume guards require instance/driver/app-thread ownership. `ProviderSwitchService.test.ts`: “distinguishes compatible and incompatible instances of the same driver”.                                                                 | Source traced and adapter foreign-owner tests passed. Final integration must run the switch suite and verify all configured-driver identity cases, including native default versus custom account/profile state.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| B9: delegation and thread creation                       | Shared native adapter preserves spawning-run ownership and publishes readable child results. `NativeSessionAdapterV2.test.ts`: “retains background task identity and spawning-run ownership across a wake turn”, “publishes readable child results for native subagents”. Pi: “observes official subagent results without inventing child threads”.                                                                                              | Native adapter behavior qualified; server-authorized delegated creation and final tool dispatch are separate acceptance paths.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| B12: Scient Agent V2                                     | Frozen alignment HEAD predates the owned-main Scient Agent stack.                                                                                                                                                                                                                                                                                                                                                                                | Open: parent must merge the current owned-main stack after the literal upstream merge and qualify its actual independent driver. No substitute product driver is invented in this slice.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| B13: provenance and lifecycle/remove                     | Existing ACP registry mutation uses V2 instance shutdown; generic sign-out and managed-runtime activation were found to use retained shutdown paths. The transferred connection/runtime coordinator corrections now call authoritative `ProviderSessionManagerV2.closeInstance` before credential/runtime mutation; custom executable accounts are excluded from shared default-runtime replacement.                                             | 58 coordinator tests passed with scoped fmt/lint. The registry now attaches native session scopes to both the configured instance and session caller; 15 registry tests (six dedicated native lifetime cases) passed, covering unchanged settings, exact removal/rebuild, caller closure, failed/in-flight opens and stale references. Native methods reject retired session scopes. Seven integration tests passed through the actual manager, SQLite/EventSink and MCP registry: removal persists a stopped session and revokes only its credential; interrupted opening/caller cancellation revoke the fresh credential; reused tokens survive while exact live or pending holders still own them; the last failed pending holder reclaims the token. Same-driver peer session/credential remain live. The existing 40 manager regressions and six registry lifetime tests also passed. Provenance and final-candidate integration remain owned by the integration review. |
| Managed binary creation and text generation              | Pi, OMP, Droid and Antigravity pass their resolved effective configuration to V2 launch and text generation. Pi's typed custom-model authority also wraps native one-shot text generation. `DroidDriver.test.ts`: agent environment/no custom-model key spawn cases. `OmpDriver.test.ts`: managed actions and extension crash-cleanup cases.                                                                                                     | Source wiring reviewed; current named tests prove narrower seams, not every driver/instance's resolved managed executable. Final driver-routing/managed-path acceptance and parent-owned text-generation suite must run.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Recovery, requests and terminal settlement               | `NativeSessionAdapterV2.test.ts`: “settles a failed send and rejects reuse of the broken session”, “cancels unanswered dialogs and open nodes before the terminal receipt”, “records process failure while idle instead of scheduling a synthetic continuation”. Antigravity spawned mock proves replacement-process failure and resume effort. Pi tests cover lifecycle timeout retirement, compaction/Stop and stale late prompt rejection.    | Scoped local tests qualified; process-loss recovery across final server persistence and held queues is integration-owned.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |

The follow-up lifecycle qualification passed **58 tests across two files** in
`provider-lifecycle-test-round17.txt`; the corresponding fmt/lint receipts both exited zero with
no lint diagnostics. Connection tests prove close of the exact V2 instance before logout and
refresh, preservation of another account, and refusal to change credentials after shutdown
failure. Runtime tests cover install/update/repair/remove, close-before-activation and
close-before-reload, exclusion of healthy/unavailable custom paths and unrelated drivers,
existing idle confirmation, cancellation and failure contracts. Default instances share the
driver's managed selection; configured custom paths do not. The new manager dependency is
required, and production root composition/compiler acceptance remains the parent-owned gate.

The native registry/manager lifetime qualification uses controlled transports with actual registry,
manager, SQLite/EventSink and MCP credential code. `provider-manager-test-round23.txt` passed
40 existing manager regressions and six registry lifetime tests; its two failing new test assertions
incorrectly treated Effect 4 `Fiber.interrupt` as returning an exit. Those assertions now await
`Fiber.await`; `provider-manager-test-round24.txt` passed all seven integration cases. No production
change occurred between those runs. Scoped fmt/lint receipts exited zero. The manager now finalizes
failed/interrupted opens once, preserves the original failure, and uses its existing reservation
ledger plus exact live credential records to defer reclamation until the last holder leaves.
Successful admission transfers credential ownership to the live entry; release and attach cleanup
use the same serialized reclamation boundary. This qualifies credential/lifetime logic, not live
provider-account or platform process acceptance.

The three provider websocket route regressions passed in `provider-ws-test-round21.txt`: private
sign-in routes the authenticated websocket owner into the actual V2 auth controller; read-only
configuration snapshots and provider-status updates redact authorization material while operators
retain it; feedback resolves the persisted native provider thread and actual V2 session manager.
These tests use a controlled native feedback endpoint and do not claim hosted feedback delivery.

### Integration checkpoint — 2026-10-04

Checks ran serially with one test worker. These are scoped checkpoints, not final-candidate approval:

- **75 tests passed across four files** in `native-integration-round3.txt`: actual V2 conversation
  export and SCIC export fixtures, native steering with explicit skill selection/replacement, and
  import journal/recovery regressions. The separate native import commit suite passed in round 2.
  Export fixtures now create real V2 events, messages, runs and turn items in SQLite. They mount no
  legacy execution engine. The journal-only compatibility fixture retains a test-owned V1 consumer.
- **20 native HTTP/WS acceptance tests passed** in `server-v2-streams-round4.txt`, including
  exact-boundary fork dispatch, held-ACK detachment/recovery, live tool coalescing/interleaving,
  high-water replay, unrelated-thread fairness, transient snapshot retry, capture races and deletion.
  Deleted snapshots now retire the client cache and converge to deleted state after synchronization.
- **71 settlement/cleanup tests passed across three files** in `server-cleanup-round2.txt`.
  Cleanup reads actual native active/archive projections and durable outbox state; completion
  broadcasts are post-commit hints and SQL remains authoritative. Archived shared-worktree owners
  are retained. Successful/cancelled cleanup and refusal for unsafe ownership states are exercised.
- **28 provider tests passed across five files** in `provider-parity-test-round12.txt`; scoped
  formatting/lint passed. The dedicated Antigravity native test spawns an isolated mock process,
  resumes with retained effort and observes replacement-process termination. Live accounts and
  cross-platform application startup remain unqualified.
- The last full server compiler snapshot, `server-typecheck-round22.txt`, had **38 hard TypeScript
  errors**, down from 120 in round 21. It predates the latest corrections; Effect diagnostics remain
  an independent required gate. No zero-error result is claimed yet.

Reviewer corrections have implementation and scoped evidence as follows:

| Finding                            | Corrected seam                                               | Evidence checkpoint                                                                       |
| ---------------------------------- | ------------------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| Combined dispatch registration     | One combined payload registration                            | `rpc-acp-regressions.txt`, 42 tests across three files                                    |
| Fork disposition transport         | Shared richer dispatch error schema                          | Same contract run; actual refusal in native WS acceptance                                 |
| V2 section and exact-boundary fork | Native services and durable provisioning                     | `server-v2-streams-round4.txt`                                                            |
| Production Cursor resource staging | Staging called from production packaging                     | `desktop-packaging-regressions.txt`, 82 tests; complete candidate artifact still required |
| Lenient ACP compatibility response | Compatibility registry uses lenient codec                    | `rpc-acp-regressions.txt`                                                                 |
| ACP termination cleanup/callback   | Cleanup and callback composed                                | Same run; full ACP suite in provider round 9                                              |
| Completed-answer attention         | Native shell producer; absence remains distinct from null    | `discovery-answer-projection-round1.txt`, 34 tests across two files                       |
| Mobile captured dispatch mode      | Persisted mode forwarded; legacy rows remain queued          | `mobile-outbox-regressions.txt`, 33 tests across two files                                |
| Mobile first-message title seed    | Citation-aware seed forwarded for existing empty threads     | Same mobile run                                                                           |
| Queued skill replacement           | Explicit selection replaces atomically; empty clears         | `queue-answer-regressions.txt`, 110 tests across four files                               |
| Queued context clearing            | Omission retains; explicit null clears message and turn item | Same queue run                                                                            |

These checkpoints will be requalified where final integration or owned-main catch-up changes their
paths. Pi's later qualification is recorded below. Queue recovery round 8 passed **13 tests across
two files**: attachment interruption before atomic publication, equal/concurrent retries, corrupt
queue isolation without source loss, rejection after deletion, unavailable-provider Resume and
restoration, deferred title/plan consumption, and shared automatic-completion ordering. The tests
inspect actual durable native state with the provider worker paused; they do not prove a hosted
provider session. Compatibility reordering now validates and commits the complete owned order under
one thread lock. The additional unchanged-order regression remains pending.

### Pi native selection and custom-model authority checkpoint

The V2 Pi adapter now uses Scient's canonical percent-encoded model codec and the same
`applyPiModelSelection` policy as native discovery/background generation. It honors the shipped
`thinkingLevel` option, retains the older `thinking` alias, confirms supported/effective model
and effort before delivery, and preserves an untouched native default. Instance ownership is
checked before binding/resume/start/steer; an explicit native fork can bind its authoritative target.
Context-window keys use the same canonical codec. Pi's resolved managed binary now reaches V2.

`PiCustomModelsConnection` reuses the existing instance-scoped custom-model factory on the raw
V2 connection, with one V2 event consumer. Its bootstrap server and authority watcher live in the
provider-session scope. Construction returns the raw connection before extension discovery can
block so the V2 event pump can answer dialogs; normal commands await completed integration
initialization. Selection/discovery reuse the existing metadata and authority checks. Prompt/steer
checks authority without waiting on a prompt acknowledgment; short settlement probes retain their
timeout and lifecycle failures retain the native timeout identity. Native fork companion processes
use the same factory. The typed factory is also wired into Pi background generation.

The serialized Pi adapter/custom-model/model-selection batch passed **87 tests** (round15).
The eight Pi orchestrator replay scenarios are qualified: seven passed in the initial round15
run, and message steering passed in the one-case round16 rerun after removing synthetic model
selection frames incorrectly placed before an in-place steer. Their recorded native events remain;
new selection-confirmation frames are explicitly marked synthetic in transcript metadata and are
not newly recorded hosted-provider evidence. The direct custom-model test uses a disposable,
private loopback bootstrap and proves the selected instance, annotated explicit default `off`, and
refusal to deliver a later prompt after revocation. No live account or provider credential was used.

Evidence: `provider-parity-test-round15.txt`, `provider-parity-replay-round15.txt`,
`provider-parity-replay-round16.txt`, `provider-parity-fmt-round15.txt`, and
`provider-parity-compiler-round16.txt` in the umbrella review directory. The last compiler run
reported **zero hard TypeScript errors** and one unrelated fatal Effect diagnostic in
`server.test.ts` (`globalConsoleInEffect`). Scoped lint reported one unused private Pi constant
left after removing the unused private layer; the constant/import were then removed and require
final global lint confirmation. Hosted-provider sessions, cross-platform process ownership and
manual integration acceptance remain separate gates. Scient Agent arrives through the owned-main
catch-up; this checkpoint does not invent or qualify a duplicate driver.

## Not yet claimed

The full gate (`fmt`, `lint`, `typecheck`, `knip`, brand check, seam checks, provenance), the full
suite and build, parity-ledger row proofs, the stress tests, the Codex round-two review, the dev-app
visual review, and the B1–B13 blockers are **not done**. This merge is not shippable.

## Publication boundary

No release, publication, cloud, mobile activation or product-policy change is authorized by this
receipt. Mobile publication remains held.

## Related

See [upstream-alignment-protocol.md](./upstream-alignment-protocol.md) §5 for the validation
procedure this sync followed, including the two measurement traps that shaped it: read an error
count only when the syntax gate is open, and zero conflict markers is not resolution.

### Provider continuation and workspace checkpoint — 2026-10-04

`provider-parity-test-round25.txt` passed 55 cases: the existing 40 manager regressions,
10 actual registry/manager lifetime tests, and five OMP V2 tests. The manager now rejects
reuse of a live session ID under a different configured instance or explicit normalized
workspace, before attaching or touching the session. Both rejected paths preserve the old
runtime, native resource and MCP credential. An equivalent `/.` path retains its owner.
An omitted cwd retains the native default established when opening; the manager does not
perform relocation, choose a portable handoff, or allocate a replacement lifetime.

`ProviderContinuationIdentity.integration.test.ts` constructs the actual disabled driver
factories, with process/SDK/HTTP seams that fail if invoked. Seven cases passed in
`provider-parity-test-round26.txt`: Pi, OMP, Droid, legacy Antigravity and Cursor preserve
an instance's continuation key across recreation and isolate another instance; Codex shares
native-history identity across private auth overlays while isolating a different shared home;
Claude uses inherited `CLAUDE_CONFIG_DIR` and honors an explicit home override. Adapter
instance identity and snapshot continuation keys are asserted against the factory result.
The first matrix run lacked the secret-store layer's Crypto dependency; that fixture was
corrected before its successful rerun. Scoped fmt/lint receipts exited zero with no final lint
diagnostics. These are local configured-factory proofs, not hosted account acceptance.

The two added OMP adapter cases feed actual native RPC tool/subagent frames through
`OmpSessionRuntime` and `NativeSessionAdapterV2`. They assert retained tool input/output,
run/provider-thread ownership, observed child lineage/instance, and readable child result.
Server-authorized delegation, MCP dispatch and cross-thread persistence remain integration
acceptance paths. Project-root relocation planning and queue ordering are parent-owned;
the defensive manager guard alone does not close B7.

B12 catch-up source identity: owned `origin/main` at
`33ab8e307afbabda3e155c439d89bc788148d379` contains the independent Scient Agent product
stack (`ScientAgentDriver`, `ScientAgentTarget`, managed runtime, account/root isolation and
target-aware OMP helpers), absent from alignment HEAD
`ad215fd9157e86252a2ee1187e746b65c8b003be` during this review. Owned main does not provide
a V2 adapter. Catch-up must precede native V2 target wiring: `ScientAgentSettings` contracts,
`ScientAgentTarget`, generalized custom-model/bootstrap/status/text-generation/runtime APIs,
and isolated process state are dependencies. No duplicate product driver or V1 execution
bridge was introduced here.

### Native transport and workspace qualification — 2026-10-04

The shared HTTP snapshot contract now negotiates `item-refs-v1` through
`x-scient-thread-snapshot-format`. Unmarked responses retain the full legacy
shape. Marked responses replace only byte-equivalent visible-item payloads with
references into the same snapshot's canonical items; the shared client decoder
restores every array, visibility/provenance record and history cursor before
state ingestion. Noncanonical and divergent records remain inline, and invalid
indices fail decoding. CORS permits both this header and the existing
orchestration protocol header.

`server-full-round4.txt` passed all 232 actual server HTTP/WS tests, without
skips. The unchanged transfer ceilings pass with the compact shared-client
transport (`server-transfer-final-round2.json`): cold HTTP snapshots measured
4,463/4,473 wire bytes for Codex/Claude against 5,000; total measured thread
traffic was 5,805/5,794 against 7,000. Fixture entropy, history counts and
decoded projection arrays were retained. This is synthetic native transport
qualification, not a live provider or packaged-desktop acceptance result.

That full run includes public UUID reuse refusal. An accepted command receipt
remains idempotent; a different `thread.create` command cannot overwrite an
active or deleted conversation identity. A replacement receives a new ID.
The controlled deletion/setup race proves that completion of the old setup
cannot mutate either the replacement or the original tombstone.

`startup-bin-runtime-round2.txt` passed 97 startup, CLI and runtime cases.
Production composition now provides the scanner's ProjectStore dependency
explicitly. `contracts-compiler-final-round2.txt`,
`client-runtime-compiler-final-round1.txt`, and
`web-compiler-final-round1.txt` exited zero. These results qualify their current
working-tree checkpoint; they do not waive final qualification after owned-main
catch-up or subsequent shared changes.

Workspace transitions now resolve the current project root through RuntimePolicy,
select the active native root's exact session rather than a newer sibling, and
commit detachment before turn-start delivery. Immediate and held delivery retain
compatible native history and allocate a fresh replacement lifetime; an already
detached binding cannot reuse a sibling's pooled lifetime. Repairable missing
accounts remain held. Queue mode and skill snapshots retain their authority.
The dedicated SQL ProjectStore/Orchestrator/outbox regressions are recorded in
`WorkspaceRelocation.integration.test.ts`; final expanded qualification remains
in progress. OMP cursor compatibility and Scient Agent native V2 wiring still
need their separate provider acceptance paths.

### Provider workspace pooling and OMP continuation qualification — 2026-10-04

This checkpoint qualifies the working candidate above HEAD
`ad215fd9157e86252a2ee1187e746b65c8b003be`; it is not a commit, packaged artifact,
live-provider session, or whole-alignment approval.

The preceding defensive cwd guard is refined at the adapter boundary. The
optional session capability `supportsPerThreadWorkspace` is absent/false unless
a native adapter explicitly grants it. A manager may reuse a process across
project directories only when both this capability and
`supportsMultipleProviderThreadsPerSession` are true. Instance identity remains
an unconditional guard. Codex and OpenCode2 grant the capability: controlled
native protocol replays prove distinct `thread/start.cwd` values and native
session `location.directory` values inside one process. OpenCode's second
thread also receives its own MCP namespace grant. Manager integration proves
true/false/absent capability behavior, independent per-thread resume cwd,
unchanged process identity and first-thread authority, and admission of a
second MCP attachment only when allowed. Workspace relocation for an existing
conversation still belongs to the parent's transition planner and handoff
integration; this capability does not grant shared history or cross-instance
reuse.

OMP opening now establishes a fresh transcript and defers historical resume
to `resumeThread`. The persisted provider-thread `nativeMetadata.resumeCursor`
is checked against the existing instance, canonical workspace, home/profile,
owned session directory, RPC protocol and compatible OMP major. A native id
alone cannot authorize resume. The native switch must confirm both the exact
file and recorded session identity. A rejected or misreported switch can
rebind the same provider-row identity to fresh native state before portable
history is sent. Buffered session-info frames re-read native state before
updating durable cursor authority. The shared NativeSession adapter preserves
cursor updates and replaces a known null native reference when fresh state
has actually been established.

Scoped qualification, serialized with one worker:

| Evidence                                                             | Current final result                                                                                               |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `provider-parity-test-round27.txt`                                   | 113 PASS: OMP 16, NativeSession 28, manager 43, actual registry/manager lifetime 10, contracts 16                  |
| `provider-parity-test-round29.txt`                                   | Pi and lifecycle tests: 113 PASS; two Codex/OpenCode fixture failures were then corrected                          |
| `provider-parity-test-round30.txt`                                   | Final Codex 123 + OpenCode2 81: 204 PASS                                                                           |
| `provider-parity-test-round31.txt`                                   | Final affected OMP 16 + Codex 123: 139 PASS after test narrowing and removal of unused private Codex layer helpers |
| `provider-parity-fmt-round28.txt`, `provider-parity-fmt-round29.txt` | Formatting exit 0                                                                                                  |
| `provider-parity-lint-round28.txt`                                   | Fourteen owned paths, exit 0, no diagnostics                                                                       |

These logs establish **430 distinct passing tests across ten files**, with
139 affected cases repeated after the final cleanup. The abandoned round28
batch used stale synthetic Codex initialize expectations and was stopped by
exact process identity to avoid timeout cascades. Its failure is retained as
evidence. Synthetic expectations now use the shared Scient Desktop client
identity; recorded native response/event shapes were preserved. The existing
Codex preview assertion follows the actual `scient_awareness` additional-context
key rather than the obsolete `t3_code_tools` key.

`provider-parity-compiler-round17.txt` had three test-only nullable native-id
errors, subsequently narrowed and exercised in round31, and two server-owned
fatal JSON diagnostics. No warning-level Effect diagnostics remained, including
the three previously identified `multipleEffectProvide` warnings. Parent's
next canonical compiler must include these final source changes before a
current compiler-clean claim.

Proof limits remain explicit: the OMP cursor/fresh tests exercise the actual
OMP transport adapter, shared NativeSession adapter and the same native call
sequence used by `ProviderTurnStartService`'s portable fallback. They do not
prove the full service's persisted portable-handoff composition or a live OMP
process. That composition and the target-aware first-party Scient Agent
adapter remain acceptance work after the owned-main catch-up. OMP currently
uses native runtime `client.version`; catch-up must preserve the owned-main
separation between Scient Agent product version and OMP runtime version.
