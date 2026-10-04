# T3 upstream sync through ca7df394ed

> Maintainer receipt. Product workflows live in [docs/user](../user/).

**Status: integration qualification in progress.** The literal upstream merge is
committed locally. The separate owned-main catch-up, final gates, artifact review,
technical review and isolated-app review remain open. Scoped results below are
checkpoints; they do not declare the current working diff ready to ship.

## Candidate and ancestry

| Boundary                    | Identity                                                             |
| --------------------------- | -------------------------------------------------------------------- |
| Owned starting base         | `ad215fd9157e86252a2ee1187e746b65c8b003be`                           |
| Previous qualified upstream | `54084ae1e6c32809db040e4fa571c80fdf2d8ae4`                           |
| Adopted upstream            | `ca7df394ed8151fa77f856beefa90bc60a785d60` — 15 commits              |
| Literal upstream merge      | `b8fbae4ffa84414b02461cf42a0afa4b10a03fcc`                           |
| Frozen owned-main catch-up  | `33ab8e307afbabda3e155c439d89bc788148d379` — 70 commits              |
| Branch / upstream push      | `codex/t3-sync-ca7df394ed-20261003` / `DISABLED`                     |
| Target tag relationship     | No exact local tag; nearest ancestor `v0.0.45-nightly.20260930.2493` |
| Integration worktree        | `ScientFactory-worktrees/scient-t3-sync-ca7df394ed-20261003`         |

The upstream merge has exact parents `ad215fd9157e86252a2ee1187e746b65c8b003be`
and `ca7df394ed8151fa77f856beefa90bc60a785d60`. The catch-up is a separate merge
in progress, with the frozen owned-main commit as its second parent. Neither
history is squash-replayed. `upstream-state.json` retains the previous qualified
cursor until final acceptance. No push, PR, release or manual acceptance is claimed.

## Architecture and protected decisions

Production execution uses native V2 admission, deciders, durable events, projections,
workers and recovery. Retained section and clicked-message fork payloads call V2
services. V1 libraries are retained only where historical import or compatibility
tests consume them. Dead V1 production layers and unused parallel readers were
removed after checking their callers; preservation means preserving behavior.

- **MCP authority:** credentials bind exactly the issuer's requested capabilities.
  Native session creation requests Scient document, compute, Sources and history
  capabilities explicitly, alongside orchestration/worktree/PR capabilities. Browser
  and device access remain conditional. Skill delivery requires the configured
  adapter's actual host-injection channel and exact `skills:read` scope. Native tool
  support alone does not prove that channel exists. Credential reuse compares the
  whole grant; exact live and pending owners control reclamation.
- **History versus inspection:** `scient_thread_read` is read-only, paginated and
  same-project under `threads:read`. `scient_thread_inspect` uses `orchestration`,
  accepts user-attached context and acknowledges a direct child's complete terminal
  result. Both read native projections. Attached-thread guidance names inspection.
  Canonical tools use `scient_`; historical aliases and private MCP/profile/package
  identities remain compatible.
- **RPC compatibility:** one `orchestration.dispatchCommand` registration accepts
  both payload families and preserves `forkDisposition`. Fields distinguish the two
  fork shapes. No retained command is routed into a V1 execution engine.
- **ACP configuration:** missing or null inventory remains distinct from an explicit
  empty array in both wire generations. The production compatibility codec is
  lenient. Transport termination composes prompt cleanup and caller notification.
  Generated ACP schema files were not regenerated from mutable remote inputs.
- **Selection authority:** selected skills are durable message data, not inferred
  from prompt text. Queued edits replace them atomically; `[]` clears selection.
  Context omission retains the old value; explicit null clears both the message
  and its queued turn item. Removed queue edits recover into ordinary drafts.
- **Migration ledger:** released Scient migration identities remain immutable.
  `059_OrchestrationV2.ts` is byte-identical to upstream `055_OrchestrationV2.ts`;
  upstream's next migration is composed at 060. Structured slot-collision refusal
  runs before the opaque migrator error. Foreign ledgers are not rewritten.
- **Data and execution:** historical activity, tools, plans, system messages and
  approvals survive import. Approvals remain inert; history grants no provider-native
  continuation, approval or fork authority. Native held admission follows durable
  receipts, then retires only the accepted legacy queue source. Original V1 data
  remains recoverable. [Migration evidence](../operations/orchestration-v2-migration-verification.md)
  describes both databases, queue files and attachment recovery.
- **Projects and workspaces:** V2 requires project identity. Scratch/internal projects
  remain explicit identities. Workspace transition planning reads SQL ProjectStore,
  detaches the exact old binding before delivery and preserves portable history and
  held order. A process is shared across workspaces only when both per-thread cwd
  and multiple-thread capabilities explicitly allow it; instance identity always
  remains a guard.
- **Providers:** adapters own native differences. OMP, Droid, Pi and legacy
  Antigravity use native V2 transports. Scient Agent is an independent product,
  backed by its target-aware RPC adapter, managed executable and instance-owned
  state root. Product version is distinct from OMP runtime version. Sign-out and
  managed-runtime changes tear down the exact configured instance, preserving peers.
- **Released compatibility:** OpenCode 1 remains valid below Scient 0.6.18; OpenCode 2
  starts there. Pi retains Scient's shipped 0.0.42 minimum and 0.84.4 supported
  version. Unstamped development-build opt-in remains a separate policy.
- **Transport:** opt-in `item-refs-v1` HTTP snapshots reference only byte-equivalent
  canonical items. Unmarked responses keep the old shape; the shared decoder
  restores visibility, provenance and history before ingestion. Invalid references
  fail. Transfer ceilings and fixture entropy were not weakened.
- **Product boundaries:** cloud, telemetry, updater, signing and mobile publication
  controls are preserved. Public language is Scient. Compatibility-sensitive paths,
  environment variables, package names and license notices are retained. SSH adopts
  upstream's archive runner while retaining Scient's pinned-package default.
- **Mobile native concurrency:** the installed Expo 58 permissions registry keeps
  Scient's synchronized registration/read boundary. Notification replay removes
  only its delivered snapshot, and registration during delivery sees the pending
  response before callbacks run. Version-pinned package patches preserve these
  guarantees without rolling back SDK 58 or activating mobile distribution.

## Preservation acceptance map

These rows identify implementation and reproducible proof owners. Full-candidate
requalification is still required; live providers and other operating systems are
separate acceptance boundaries.

| Criterion                                           | Named proof / owner                                                                                                                                                                   |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B1–B2: lineage and complete inert historical import | `LegacyScientHistory.test.ts`, `LegacyV1ThreadImporter.test.ts`, `LegacyV1Cutover.integration.test.ts`; [migration handoff](../operations/orchestration-v2-migration-verification.md) |
| B3: native OMP and instance routing                 | `OmpAdapterV2.test.ts`, `OmpProviderHandoff.integration.test.ts`: confirmed model, invalid resume refusal, portable handoff and held order                                            |
| B4: Droid ACP supervision                           | `DroidAdapterV2.test.ts`, `AcpAdapterV2.test.ts`: confirmed autonomy, explicit specification approval, refusal before delivery                                                        |
| B5 + E8: Pi native selection and Scient delivery    | `PiAdapterV2.test.ts`, `PiCustomModels.test.ts`, Pi orchestrator replays: canonical model/effort, instance authority and native skill commands                                        |
| B6 + B11: tool inventory, ownership and dispatch    | Native adapter owner tests, actual MCP catalog/dispatch tests, manager-issued capability/skill tests; actual producer-to-SQL workflow lifetime regressions                            |
| B7: workspace transitions                           | `WorkspaceRelocation.integration.test.ts`, native manager lifetime tests and `OmpProviderHandoff.integration.test.ts`: immediate/held, live/dead old binding, exact MCP ownership     |
| B8: continuation identity                           | `ProviderContinuationIdentity.integration.test.ts`, `ProviderSwitchService.test.ts`, OMP cursor cases: instance/account/home/target boundaries                                        |
| B9: delegation and thread creation                  | `DelegatedCompletionDelivery.test.ts`, native subagent tests, MCP orchestration integration; [Agents receipt](../operations/orchestration-v2-agents-parity.md)                        |
| B12: Scient Agent                                   | `ScientAgentDriver.test.ts`, exact-account lifecycle tests, both targets in `OmpProviderHandoff.integration.test.ts`                                                                  |
| B13: provenance and removal                         | Registry native lifetime tests, manager lifetime integration, connection/runtime coordinator tests: exact-instance close, failed/in-flight opens and last credential holder           |
| Legacy queue cutover and recovery                   | `LegacyQueueAdmission.test.ts`, `LegacyQueueCompatibility.clone.test.ts`: held-only admission, accepted receipt replay, attachment bytes, explicit release and clone guard            |
| Stream, replay and transfer invariants              | Actual `server.test.ts` HTTP/WS cases: held ACK, coalescing, interleaving, high-water replay, fairness, retry, deletion, capture race and bounded transfer                            |

The original handoff does not define B10 in the durable source record. Queue
cutover is tracked explicitly above rather than assigning an invented identifier.

Native workflow presentation preserves observed role, phases, usage and member
slots without granting child-thread or continuation authority. Historical rows
remain display-only. The follow-up closes late producer progress, runless workflow routing, lifetime
cleanup/transfer and historical live-count gaps. Actual producer-to-SQL and exact
subscriber-release regressions pass; earlier SQL-to-wire tests alone did not
qualify these paths.

## Reviewer findings

All eleven supplied findings have implementation and scoped evidence. A further
packaging review found missing Linux Cursor helpers in the Windows WSL fallback
tree and incomplete target validation; both corrections pass their scoped suite.
Final gates must cover the combined candidate, including the owned-main catch-up.

| Finding                           | Corrected source paths                                                                                                                                                                                                        | Named behavioral proof                                                                                                                                                                                                                                                                    | Scoped evidence log                                                                                                                                                                                                                                                                                                              |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| V1/V2 dispatch collision          | `packages/contracts/src/rpc.ts`: one combined wire registration                                                                                                                                                               | `packages/contracts/src/rpc.test.ts`: “accepts retained section commands through the shared dispatch registration”; actual retained fork and V2 creation use that registration in `apps/server/src/server.test.ts`                                                                        | `rpc-acp-regressions.txt`: 42 tests / three files; actual WS acceptance below                                                                                                                                                                                                                                                    |
| Lost fork disposition             | `packages/contracts/src/orchestrationDispatch.ts`, `packages/contracts/src/rpc.ts`: richer shared error transport                                                                                                             | `packages/contracts/src/rpc.test.ts`: “preserves every fork disposition through the registered error codec”; `apps/server/src/server.test.ts`: “rejects exact-boundary fork reuse of a deleted identity and preserves its history” asserts transported `rejected`                         | `rpc-acp-regressions.txt`; `fork-identities-round2.txt`: eight selected cases / two files                                                                                                                                                                                                                                        |
| Retained commands on V2 threads   | `apps/server/src/ws.ts`, `apps/server/src/orchestration-v2/ThreadManagementService.ts`, `apps/server/src/orchestration-v2/scient-fork/ConversationForkService.ts`: native section and exact-boundary services                 | `apps/server/src/server.test.ts`: “dispatches V2 creation, section assignment and exact-boundary forks through the real shared websocket RPC”                                                                                                                                             | `server-v2-streams-round4.txt`: 20 acceptance cases; same actual WS case requalified in `fork-identities-round2.txt`                                                                                                                                                                                                             |
| Missing production Cursor helpers | `scripts/build-desktop-artifact.ts`: production staging and `stageAndPackWindowsServerAsar`; exact target and WSL fallback resources                                                                                          | `scripts/build-desktop-artifact.test.ts`: “stages Cursor helpers and extracts the actual Windows archive for WSL fallback”, plus target-validation cases; `scripts/cursor-wsl-packaging.integration.test.mjs` exercises the packaged fallback                                             | `provider-cursor-packaging-tests-final.txt`: 99 tests / three files. Controlled Windows ASAR extraction is covered; the complete production macOS ARM64 ZIP also passes SDK/helper inspection (`final-desktop-artifact-inspection.json`, `final-desktop-asar-inspection.json`). Full Windows Electron startup remains unverified |
| Strict ACP compatibility response | `packages/effect-acp/src/rpc.ts`: lenient `CompatSetSessionConfigOptionResponse` used by production registration                                                                                                              | `packages/effect-acp/src/rpc.test.ts`: “uses the lenient codec in the production compatibility registration” covers missing, null, empty, both wire generations and malformed inventories                                                                                                 | `rpc-acp-regressions.txt`; later complete ACP suite                                                                                                                                                                                                                                                                              |
| ACP termination callback override | `packages/effect-acp/src/client.ts`: prompt cleanup precedes caller notification without overriding it                                                                                                                        | `packages/effect-acp/src/client.test.ts`: “settles an acknowledged V2 prompt when transport closes with a termination observer” and “cleans pending prompts before a blocked/defect/throw termination observer”                                                                           | `rpc-acp-regressions.txt`; later complete ACP suite                                                                                                                                                                                                                                                                              |
| Missing completed-answer metadata | `apps/server/src/orchestration-v2/ProjectionStore.ts`, `packages/shared/src/orchestrationV2ThreadShell.ts`, `packages/client-runtime/src/state/models.ts`: native answer producer and preserved absence/null distinction      | `apps/server/src/orchestration-v2/ProjectionStore.test.ts`: “SQL shell preserves the completed answer until it is rolled back” and matching memory case; `apps/web/src/scient/answerAttention/completion.test.ts`: “falls back only for old servers and only for successful answers”      | `discovery-answer-projection-round1.txt`: 34 tests / two files; complete web suite                                                                                                                                                                                                                                               |
| Mobile dispatch mode lost         | `apps/mobile/src/state/thread-outbox-start-turn.ts`, `apps/mobile/src/state/use-thread-outbox-drain.ts`: captured mode forwarded; missing legacy mode queues                                                                  | `apps/mobile/src/state/thread-outbox-start-turn.test.ts`: “replays captured %s after storage round-trip” and “keeps always-queue behavior for old rows without a dispatch choice”                                                                                                         | `mobile-outbox-regressions.txt`: 33 tests / two files; complete mobile suite                                                                                                                                                                                                                                                     |
| Mobile initial title seed lost    | `apps/mobile/src/state/thread-outbox-start-turn.ts`, `apps/mobile/src/state/use-thread-outbox-drain.ts`: citation-aware first-message title seed                                                                              | `apps/mobile/src/state/thread-outbox-start-turn.test.ts`: “seeds the first message from readable citation text” and “seeds attachment-only first messages from prepared attachment names”                                                                                                 | `mobile-outbox-regressions.txt`; complete mobile suite. Native device interaction remains separate                                                                                                                                                                                                                               |
| Obsolete queued skill selections  | `packages/client-runtime/src/operations/commands.ts`, `apps/web/src/components/ChatView.tsx`, `apps/server/src/orchestration-v2/Orchestrator.ts`: atomic replacement; omitted retains and `[]` clears                         | `packages/client-runtime/src/operations/commands.test.ts`: “dispatches V2-native relationship and queue commands without compatibility shaping”; `apps/server/src/orchestration-v2/runtimeLayer.test.ts`: “edits and removes queued runs” asserts replacement and explicit empty clearing | `queue-answer-regressions.txt`: 110 tests / four files; complete server qualification                                                                                                                                                                                                                                            |
| Removed queued context retained   | `packages/client-runtime/src/operations/commands.ts`, `apps/web/src/components/ChatView.tsx`, `apps/server/src/orchestration-v2/Orchestrator.ts`: omitted retains; explicit null clears both existing durable representations | `apps/server/src/orchestration-v2/runtimeLayer.test.ts`: “retains omitted queued context and clears both historical message and user item” uses actual EventSink state; “edits and removes queued runs” preserves native queue admission without a timeline item                          | `queue-answer-regressions.txt`; `final-auth-and-queue-round1.txt`: 60 tests / two complete files, including the historical-item regression                                                                                                                                                                                       |

## Evidence and remaining gates

Logs are retained outside source at
`ScientFactory/reviews/orchestration-v2-alignment-20261003/`.
All databases, transports and attachments used for local qualification are
synthetic/disposable. No live profile or provider credentials were copied.

Relevant checkpoints, each superseded when its path changes:

- The complete uncached static gate passes all 32 package TypeScript/Effect
  checks (`final-typecheck-round2.txt`), with no hard errors or Effect warnings.
  The final browser-fixture changes also pass the web compiler
  (`layout-fixture-typecheck-round2.txt`). Whole-tree formatting, Knip, branding
  and all five protected-seam checks pass (`final-format-round4.txt`,
  `final-knip-round3.txt`, `final-brand-round3.txt`, `final-seams-round3.txt`).
  Whole-tree lint passes with zero errors and 1,066 warnings
  (`final-lint-round3.txt`); this is not a warning-free claim. No assertion or lint
  exception was widened during this final qualification pass. Later browser
  fixtures pass scoped format and lint checks.
- Complete desktop tests pass 1,588 cases across 130 files, with 43 cases in four
  files intentionally skipped (`final-desktop-tests-round4.txt`). Mobile passes
  1,886 cases across 213 files, and the remaining recursive package lanes pass
  (`final-tests-round3.txt`). Scripts pass 577 cases across 44 files, with one
  intentionally skipped case/file (`final-scripts-tests-round4.txt`), including
  the actual transfer-report producer/consumer contract.
- Complete web unit qualification: 10,227 tests across 862 files pass in
  `final-web-tests-round8.txt`. The later optional-runtime hook-order correction
  passes 90 cases across the complete runtime-control unit and real React browser
  files (`final-runtime-optional-summary-round4.txt`). Server and web typechecks
  pass uncached after that correction (`final-affected-typecheck-round6.txt`).
  Runs clear inherited app URL and state selectors and use one worker. Browser
  layout, integrated desktop interaction and the owner's visual acceptance remain
  separate gates.
- Complete server qualification reached 11,650 passing cases, 152 intentional skips,
  and one Cursor maintenance failure across 860 files (`final-server-tests-round6.txt`).
  All 88 earlier failures are cleared. The remaining failure exposed an implicit CLI
  update target on SDK-default instances. Maintenance now uses the original configured
  path: SDK defaults are manual-only; explicit external CLI targets retain native update,
  and private copies retain managed replacement. The affected Cursor, registry,
  maintenance and full-transfer matrix passes 317 cases across 24 complete files
  (`final-cursor-and-transfer-round4.txt`). This is composed qualification after the
  narrow correction, not a claim that the earlier full command exited successfully.
- The server repair checkpoint passes 69 cases across six complete queue,
  migration, boundary and transfer files (`server-owned-final-round14.txt`).
  Native V2 imports the pure queue admission module rather than the retained
  V1 control module. The source boundary scanner distinguishes comments,
  type-only imports and executable dynamic imports; its complete scan passes
  without increasing the Node heap. Project and relay regressions pass, and
  the actual clone/favicon case executes separately. Full server requalification
  is covered by the later complete server run and affected-path matrix.
- The dedicated full-snapshot transfer fixture now measures the compact codec
  requested by the shared client on the same full HTTP endpoint. It retains
  20 messages and 80 timeline items, including 50 commands and ten MCP results,
  and compares the entire decoded projection and cursor with the legacy response.
  HTTP wire bytes are 4,365/4,374 for Codex/Claude; total traffic is 5,707/5,726
  (`final-full-transfer-report.md`, `final-full-transfer-report.json`). The 5,000/7,000-byte limits are unchanged.
  The legacy default remains compatible but exceeds the modern snapshot ceiling
  at 5,839/5,850 bytes; that separate measurement is disclosed. The bounded
  startup scenario remains a separate proof rather than replacing this fixture.
- Transfer reporting now emits schema version 2 with a closed startup-transport
  enum. The trusted publisher accepts historical version 1 artifacts and refuses
  misleading comparisons across full, bounded or unspecified startup transports.
  Its dependency-free Node suite passes nine cases (`transfer-report-parser-round1.txt`).
  The actual producer/consumer probe belongs to the repository scripts suite;
  the write-capable publisher still checks out and executes only trusted scripts.
  The actual producer probe passes (`transfer-report-contract-round1.txt`);
  the final full-fixture result is separately retained and passes the trusted schema validator.
  The complete server run also produces a separately identified bounded-startup result
  (`final-transfer-report.json`), so its last report cannot be mistaken for full-history proof.
- Source review found identity reuse in both exact-boundary and native run forks:
  shell reads hid tombstones, and the native planner omitted destination admission.
  Both producers now check the durable destination under their existing command
  lock, accepting absence only through the typed not-found error. Accepted receipt
  retries remain unchanged. Actual SQLite live/deleted/self and WS history-preservation
  regressions pass eight cases across two files (`fork-identities-round2.txt`).
  Their first run exposed
  fixture errors: a stale worker hint and the legitimate outgoing fork relation
  omitted from success expectations. The revised fixtures use durable creation
  receipts and preserve exact historical state. The scoped review with blob
  identities is `nonprovider-integration-source-review-round16.md`.
- Provider repair qualification passes 407 cases across 21 complete files:
  82 ACP cases and 325 native cases across 14 files. This covers native config
  generations, model/effort confirmation, caller/runtime lifetime separation,
  safe process-exit classification, containment and workspace replacement.
  The OpenCode replay harness broadcasts one native event feed to independent
  subscribers; it no longer makes simultaneous subscriptions steal events.
  Full server and final compiler qualification remain separate gates.
- Independent migration review and recovery follow-up: 54 distinct tests across
  seven complete files, covering missing-versus-explicit-null metadata repair,
  pre/post-commit interruption, ambiguous receipts, raced attachment copies,
  immutable accepted attachment ownership after queued edits, and visible recovery
  refusal. Exact logs and commands are in the migration handoff. Server compiler,
  scoped lint and formatting pass.
- Mobile native recovery: 15 tests across four files in
  `mobile-native-recovery-round2.txt`. The actual installed Objective-C permissions
  registry and Swift notification manager/Mutex run under ThreadSanitizer; the
  dependency ceiling remains unchanged. The outbox command builder now lives with
  its state owner. Frozen lockfile installation passes. Native simulator/device
  interaction and mobile distribution remain separate boundaries.
- Migration/recovery: 74 tests across 12 files in `queue-migration-final-round11.txt`.
  Native queue/clone: 19 in `queue-cutover-final-round14.txt`; startup/CLI/runtime:
  97 in `startup-bin-runtime-round2.txt`.
- Actual server HTTP/WS: 232 in `server-full-round4.txt`; later queue case separately
  qualified. Codex/Claude cold snapshots were 4,463/4,473 wire bytes against 5,000,
  total thread traffic 5,805/5,794 against 7,000 (`server-transfer-final-round2.json`).
- Provider protocols/lifetime: 430 distinct tests across ten files in provider
  rounds 27–31; owned-main provider integration: 94 / four files, with the affected
  OMP file's 18 cases repeated after fixture correction.
- Native MCP channel/credential policy: 659 distinct cases qualified across 15
  files by `provider-mcp-lifetime-tests-round1.txt` plus affected ACP/Cursor/OpenCode
  reruns in rounds 2–3. The first run had one stale product-copy assertion; all
  169 affected cases pass after correction. Totals are not added across reruns.
  Production-issued token/catalog/history/skill delivery, exact grant rotation,
  live/pending peer retention, final owner cleanup and disabled native Codex
  injection are exercised. Scoped lint round3 has zero warnings/errors; compiler
  round2 passes with suggestions only. Concurrent Claude workflow changes still
  require final dependency requalification.
- Actual native OMP/Scient Agent service handoff: six cases in
  `omp-fullservice-tests-round4.txt`; target warning regression in
  `provider-final-target-warning-round2.txt`.
- Native history reader: six real SQLite cases in `native-thread-reader-tests-round1.txt`.
  Canonical attached-thread guidance: `composer-thread-inspection-tests-round1.txt`.
- Native skill-use labels: 108 cases across complete timeline and shared tool-name
  suites in `native-skill-label-tests-round1.txt`. Native input/status preserves
  concise load/use/failure labels across provider prefixes and immutable release
  names; foreign tool identities remain generic. Scoped formatter and lint pass.
- Agents producer, presentation, history and transport checkpoints are recorded in
  [their receipt](../operations/orchestration-v2-agents-parity.md). The 14 production
  workflow lifetime cases pass in `workflow-runtime-tests-round6.txt`. The later
  count/reopen/routing selection passes 26 cases across six files; complete small
  consumer and actual SDK-to-SQLite suites pass 62 across six files. Server and web
  compiler checkpoints pass. Complete Claude and run-execution suites remain part
  of the final gate.
- Complete Chromium layout passes 219 cases across 25 files
  (`final-web-layout-round5.txt`). The simultaneous late-growth assertion originally
  mixed a rendered viewport at 2,175 px with the virtualizer's stale requested scroll
  at 2,287 px. Both measurements now use rendered geometry, with the same 2 px
  tolerance and required reading-end marker. Diagnostic traces show actual end drift
  of 0.265625 px; all temporary instrumentation was removed. Native subagent fixtures,
  sidebar capability mocking and a cross-origin Mermaid probe replace stale assumptions.
- Cursor's runtime controls and user/lifecycle guidance identify separate CLI management.
  Missing, system, custom and private CLI labels no longer describe the bundled SDK's
  execution prerequisites; CLI actions remain available. The default SDK needs no CLI
  install or update target.
- Optional runtime summaries no longer change React's hook order. A real mounted
  component is rerendered without, with, and without metadata for Cursor and Droid;
  controls recover without launching an operation. Explicit initial actions wait for
  metadata, and unavailable summaries cannot admit a runtime operation. Independent
  read-only review found no remaining defect in the correction. The complete Chromium
  layout suite passes 221 cases across 25 files (`final-web-layout-round6.txt`); the
  subsequent callback-dependency cleanup passes the 90-case affected matrix above.
- The uncached whole-workspace build passes (`final-build-round1.txt`). The repository's
  Electron smoke gate passes with a fresh synthetic profile, all eleven provider
  instances disabled, usage sources empty, and the safety envelope enabled
  (`final-desktop-smoke-round1.txt`, `final-desktop-smoke-profile.json`). This eight-second
  fatal-load check is distinct from persistent candidate readiness and UI acceptance.

- Production unsigned macOS ARM64 packaging passes (`final-desktop-artifact-round1.txt`).
  The resulting `Scient-0.0.45-arm64.zip` contains SDK 1.0.31 JavaScript in `app.asar`
  and the matching sandbox, ripgrep and parser native helpers in the external resources
  tree. All inspected native files are ARM64 Mach-O binaries with executable permissions;
  packaged ripgrep starts successfully. Artifact SHA-256 is
  `a8c2be0665077b8ec302700747582a773694379d7cadbd5e8b74c67b5661dd35`
  (`final-desktop-artifact-inspection.json`, `final-desktop-asar-inspection.json`).
  No signing or publication was performed; complete Windows Electron packaging/startup
  remains distinct from controlled Windows/WSL archive extraction tests.

- Final formatting passes all 7,300 candidate files (`final-format-round6.txt`),
  excluding only the unrelated untracked `apps/server/tsconfig.agentfixcheck.json`,
  which is preserved and excluded from the commit. Lint passes with zero errors and
  1,056 warnings (`final-lint-round4.txt`). Knip, branding, all five configured seam
  entry points and diff whitespace checks pass (`final-knip-round4.txt`,
  `final-brand-round4.txt`, `final-*-seams-round4.txt`, `final-diff-check-round4.txt`).
  The final complete Cursor driver rerun also passes (`final-cursor-driver-round5.txt`).

Still required before presenting the candidate as ready for manual review:

1. Finish the separate owned-main merge with its literal parent; record final
   candidate identity and advance the integration cursor only with final evidence.
2. Run read-only Codex Sol 6.1 review on the complete immutable diff, address all
   findings and requalify affected paths.
3. Launch a fresh isolated development candidate, exercise changed surfaces, capture
   screenshots and perform visual review. Preserve it for the owner's manual review.

The built-in Browser panel reports unavailable, so the required `test-t3-app` skill
blocks integrated browser interaction and screenshot review. Automated Chromium
component/layout cases remain separate evidence; they do not close that gate.

Local scripted/native replay acceptance does not establish hosted provider sessions,
Windows/Linux process behavior, signing, remote SSH or native mobile interaction.
The owner's manual acceptance and hosted CI are distinct from local qualification.
No publication is authorized by this receipt.

See [upstream-alignment-protocol.md](./upstream-alignment-protocol.md) and
[scient-fork-divergence.md](./scient-fork-divergence.md) for the preserved contract.
