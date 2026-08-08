# Scient conversation-fork — T3 divergence manifest

Tracks every **T3-owned** file the reliable-fork feature touches, so a full
upstream T3 merge stays cheap. All fork _logic_ lives in Scient-owned modules;
T3 files carry only tiny, additive registration seams, each wrapped in
`// SCIENT-FORK:START` / `// SCIENT-FORK:END` markers. Audit with:
`grep -rn "SCIENT-FORK" apps packages`.

**Feature framing.** Fork is generic conversation behavior, not scientific truth
— T3's own Codex protocol already models `forkedFromId`/`parentThreadId` and
ships a (previously unwired) `thread/fork` RPC. So this is built to be
**upstream-proposable**; the global **retirement condition** for every seam is:
_if T3 ships a native thread-fork, adopt it and delete these seams._

## New Scient-owned files (no T3 divergence)

- `orchestration/scient-fork/forkDecider.ts` (+`.test.ts`) — the fork decider: validation + server-side prefix re-emit into a new stream.
- `orchestration/scient-fork/lineageProjection.ts` (+`.test.ts`) — folds `thread.forked` / `thread.fork-completed` into `scient_thread_lineage`.
- `orchestration/Services/ScientForkReactor.ts` + `Layers/ScientForkReactor.ts` (+`.test.ts`) — reacts to `thread.forked`; provisions the code-state substrate (checkpoint baseline + worktree) and records fidelity.
- `persistence/Migrations/038_ScientThreadLineage.ts` — a **separate** Scient-owned table (no T3 table altered).

## T3-owned seams (all additive + marked)

**Spine (event-sourcing + fidelity)**
| File | Edit |
|---|---|
| `packages/contracts/src/orchestration.ts` | `thread.fork` command + internal `thread.fork.complete`; `thread.forked`/`thread.fork-completed` events + payloads; `OrchestrationForkWorkspaceMode` + `OrchestrationForkFidelityMode` literals; appended to command/event unions |
| `orchestration/decider.ts` | 1 import + `case "thread.fork"` (delegates to Scient module) + `case "thread.fork.complete"` |
| `orchestration/Layers/OrchestrationEngine.ts` | `case "thread.fork"` in `commandToAggregateRef` (routes to `newThreadId`) |
| `orchestration/Layers/ProjectionPipeline.ts` | register the Scient lineage projector (import + name + entry) |
| `persistence/Migrations.ts` | register migration `038` (no renumbering of `001–037`) |

**Checkpoint substrate (`forkBaseline` = copy fork-point commit → new turn-0 ref)**
| File | Edit |
|---|---|
| `vcs/VcsDriver.ts` | `VcsForkBaselineInput` + `forkBaseline` on `VcsCheckpointOps` |
| `vcs/GitVcsDriver.ts` | `forkBaseline` impl (resolve ref → `update-ref`) |
| `checkpointing/CheckpointStore.ts` | `forkBaseline` facade |

**Provider substrate (native Codex `thread/fork`)**
| File | Edit |
|---|---|
| `provider/Services/ProviderAdapter.ts` | `forkThread` on adapter interface |
| `provider/Services/ProviderService.ts` | `forkConversation` on service interface |
| `provider/Layers/ProviderService.ts` | `forkConversation` impl (routes to adapter) |
| `provider/Layers/CodexSessionRuntime.ts` | `forkThread` impl (`thread/fork` RPC; origin session untouched) |
| `provider/Layers/CodexAdapter.ts` | `forkThread` (native) |
| `provider/Layers/{Claude,Cursor,Grok,OpenCode}Adapter.ts` | `forkThread` → typed unsupported error (fail-closed) |

**Reactor wiring (code-state substrate)**
| File | Edit |
|---|---|
| `server.ts` | `Layer.provideMerge(ScientForkReactorLive)` in `ReactorLayerLive` |
| `orchestration/Layers/OrchestrationReactor.ts` | dep + `scientForkReactor.start()` in the boot fan-out |

**Web trigger**
| File | Edit |
|---|---|
| `web/components/chat/MessagesTimeline.tsx` | GitFork dropdown ("Fork · new worktree" / "Fork · here") + optional `onForkUserMessage` |
| `web/components/ChatView.tsx` | fork command hook + `onForkUserMessage` (resolve turn → `newThreadId` → dispatch → navigate) |
| `client-runtime/operations/commands.ts` | `ForkThreadInput` + `forkThread` dispatch |
| `client-runtime/state/threadCommands.ts` | `fork` env-command atom (serial per `originThreadId`) |

**Test-harness stubs** (no production behavior — only because extending shared
interfaces/reactor deps forces structural implementers; keeps typecheck at 0):
`checkpointing/CheckpointDiffQuery.test.ts` (forkBaseline stub ×5);
`provider/Layers/{CodexAdapter,ProviderService,ProviderAdapterRegistry,ProviderSessionReaper}.test.ts`;
`orchestration/Layers/{CheckpointReactor,ProviderCommandReactor,ProviderRuntimeIngestion,OrchestrationReactor}.test.ts`;
`integration/{TestProviderAdapter,OrchestrationEngineHarness}.integration.ts`.
(`checkpointing/CheckpointStore.test.ts` gains real `forkBaseline` tests.)

## Increment status (verified green on the worktree)

- **1 — event-sourced spine:** ✅ new thread from prefix, origin immutable, fail-closed validation, lineage projected.
- **1b — UI trigger:** ✅ fork menu + `ChatView` fork-and-navigate.
- **2 — provider capability:** ✅ native Codex `thread/fork` wired + tested (non-Codex fail-closed).
- **3 — checkpoint substrate:** ✅ `forkBaseline` (real-git test).
- **4 — reactor:** ✅ `ScientForkReactor` provisions checkpoint baseline + worktree per `workspaceMode`, records fidelity; idempotent + error-safe.
- Gate: focused typecheck (server/contracts/client-runtime/web) 0 errors; 83 fork tests green; lint/fmt/`git diff --check` clean.

## Follow-ups (not yet done)

- **Native conversational continuity** — call `forkConversation` from the reactor and bind the forked provider session as the new thread's resume cursor at first turn (+ transcript replay for non-Codex). Needs a live Codex dev-app smoke; must fork at the boundary `lastTurnId` (not the tip) for mid-history forks.
- **Attachment-blob GC safety** — verify fork attachment refs survive origin deletion (cross-thread ref-counted GC).
- **Provenance banner** (honest source-unavailable rules), **"Base (N)" title families**, **client pending-approval fork gating**, **startup-recovery reconciler** for a fork whose substrate didn't finish before a crash.
