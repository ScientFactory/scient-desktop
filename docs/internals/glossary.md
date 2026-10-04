# Glossary

> For maintainers. Using Scient? See [docs/user](../user/).

This is a living glossary for Scient. It explains what common terms mean in this codebase.

## Table of contents

- [Project and workspace](#project-and-workspace)
- [Thread timeline](#thread-timeline)
- [Orchestration](#orchestration)
- [Provider runtime](#provider-runtime)
- [Checkpointing](#checkpointing)
- [Appearance](#appearance)
- [Pull requests](#pull-requests)
- [Composer context](#composer-context)

## Concepts

### Project and workspace

#### Project

The top-level host workspace record in the app. In [the orchestration contracts][1], a project has a `workspaceRoot` and a title. Projects are held by `ProjectStore`; V2 app threads reference their project by ID, and a project can have zero threads. This host record is environment-specific; it is not the portable Scient project identity. See [workspace-layout.md][2] and [Scient workspace binding][28].

#### Workspace root

The root filesystem path for a project. In [the orchestration model][1], it is the base directory for branches and optional worktrees. See [workspace-layout.md][2].

#### Worktree

A Git worktree used as an isolated workspace for a thread. If a thread has a `worktreePath` in [the contracts][1], it runs there instead of in the main working tree. Git operations live behind the VCS driver contract in `apps/server/src/vcs/VcsDriver.ts`, implemented by [GitVcsDriverCore.ts][3].

#### Scient project identity

The portable UUID stored in `.scient/project.json`. Scient-owned project
records may use it to describe logical lineage, but copying the UUID does not
grant access to a physical root or its live execution state. See [Scient
workspace binding][28].

#### Workspace binding

An app-private server record for one exact workspace root in one environment.
It combines the host project, canonical root, optional Scient project identity,
optional host filesystem identity, repository/worktree evidence, trust state,
and an authority generation. It is the current candidate key for
workspace-specific Scient authority. See [Scient workspace binding][28].

#### Authority generation

A monotonically increasing binding generation retained by protected operations.
Before committing an effect, the server re-resolves the active thread and
requires the same current generation; a stale receipt cannot authorize the
write. See [Scient workspace binding][28].

### Thread timeline

#### Thread

The durable app conversation/workspace identity (`AppThread`), independent of any provider
process. Its projection includes messages, runs, attempts, nodes, provider threads/turns,
runtime requests, checkpoints and context transfers. See [V2 contracts][1] and [ProjectionStore][4].

#### Run, attempt, and provider turn

A run is app-owned work admitted from user input or a continuation. Each attempt records its
execution identity; a provider turn is the native cycle associated with an execution node and
attempt. Root completion is separate from child/subagent completion. `RunExecutionService`
records provider outcomes and [RunFinalizationService][6] settles checkpoint follow-up; late
finalization does not extend provider duration. A live session becoming idle is not itself proof
of successful run completion.

#### Activity and turn item

A V2 turn item is an attributed timeline fact: text, reasoning, tool/command work, approval,
question, plan, checkpoint or failure. Client activity rows are presentation over those durable
facts, including imported inert history. [ProviderEventIngestor][5] normalizes native output;
[ProjectionStore][4] and wire projections supply the timeline.

### Orchestration

The live server engine is [OrchestratorV2][7], composed in `orchestration-v2/runtimeLayer.ts`.
It plans commands under per-thread serialization; [EventSink][11] persists facts and requested
side effects transactionally. The V1 engine/decider/projector/reactor execution path is superseded.

#### Aggregate

The app identity a command/event belongs to, usually a project or thread. Thread commands use
`ThreadCommandExecutor`; multi-thread fork work takes ordered source/destination locks.

#### Command

A typed request to change domain state. [CommandPolicy][9] and command invariants enforce
preconditions. Examples are `message.dispatch`, `run.interrupt`, `queued-run.cancel`, and
`checkpoint.rollback`. A committed acknowledgement proves admission, not external completion.

#### Domain event

A persisted fact, such as `thread.created`, `message.updated`, or `run.updated`. The event log is
the orchestration source of truth; [ProjectionStore][4] derives read models.

#### Decision and projection

V2 command planning lives in [Orchestrator][7] and domain services. [EventSink][11] appends events,
updates persisted projections, records the command receipt and enqueues effects in one transaction.
There is no V1 global in-memory read model to mutate. Projection rows and client snapshots are
read views, not independent execution authority.

#### Effect outbox and worker

`EffectOutbox` stores executable follow-up intent, leases, retries and outcomes. [EffectWorker][12]
claims it and calls V2 provider, checkpoint, fork or cleanup services. Other domains may still use
reactors, but V1 provider-command and checkpoint reactors do not own live conversation work.

#### Receipt

A durable command receipt makes retries idempotent and records acceptance or rejection.
It does not prove provider completion. Tests may also wait for specific persisted events or drain
[EffectWorker][12]; test-only runtime milestone signals never own production state.

#### Quiesced

All relevant asynchronous follow-up has settled. Await the specific V2 state/event or worker
completion needed by the test; a fixed sleep or V1 checkpoint receipt cannot establish it.

### Provider runtime

The external agent process/client and normalized native event stream. The contract is
[ProviderAdapterV2][15], with live handles owned by [ProviderSessionManagerV2][14].

#### Driver and instance

A driver identifies the implementation; an instance identifies one configured runtime/account.
Eleven built-in drivers are registered: ACP registry, Codex, Claude, Cursor, Grok, OpenCode,
Droid, Antigravity, Pi, Oh My Pi, and Scient Agent. [Providers][16] describes routing by instance ID
and [CodexAdapterV2][17] is a representative native adapter.

#### Provider lifecycle

Independent runtime, account, entitlement, readiness, maintenance, and transient-operation facts
used for assisted installation and connection. See [provider-lifecycle.md][25]. These managers
coordinate with the same V2 instances/session owner rather than a parallel conversation router.

#### Session and provider thread

A session is durable metadata plus a separately scoped live runtime handle. A provider thread is
native conversation identity and continuity attached to an app thread or node. Losing the process
does not erase app history; V2 recovery reconciles pending execution before recreating runtime.

#### Runtime and interaction modes

Runtime modes are `approval-required`, `auto-accept-edits`, `auto`, and `full-access`.
Interaction modes are `default` and `plan`. Adapter capabilities and runtime policy determine
which selections can be enforced; see [permission modes][18].

#### Assistant delivery

`responseStreamingMode` selects turn-level or paragraph-level delivery. `RunExecutionService`
uses `assistantStreaming.ts` to retain unfinished Markdown and throttle stable paragraph updates;
completed assistant/reasoning items flush in either mode. The V1 24,000-character spill rule is
superseded.

#### Snapshot

A bounded view of current state, such as a V2 shell/thread projection or provider discovery
snapshot. A checkpoint snapshot is a different workspace artifact. See [ProjectionStore][4].

#### Usage limits

The rolling subscription quota windows a provider reports for its signed-in account, such as Claude's five-hour and weekly windows or Codex's primary and secondary allowances. Each driver decides in its own `checkProvider` whether it has any and returns them on the snapshot as `usageLimits`; drivers with no notion of subscription usage leave the field absent. Adapters that receive rate-limit telemetry during a turn normalise it into a `ProviderUsageLimitsUpdate` at the boundary, and `ProviderUsageLimitsIngestion` folds it onto the owning instance's snapshot through `ServerProviderShape.applyUsageLimits`, so no central service needs to know a driver kind. See [providerUsageLimits.ts](../../packages/contracts/src/providerUsageLimits.ts) and [makeManagedServerProvider.ts](../../apps/server/src/provider/makeManagedServerProvider.ts).

#### Usage limit source

A read-only quota feed outside this environment's provider CLIs, configured under `settings.usageLimitSources`. The only kind today is a CLIProxyAPI hub, whose `quota-scheduler/status` reports the windows of every pooled account. `UsageLimitSources` polls each source on the provider health interval and publishes `UsageLimitSourceSnapshot`s over the config stream as `usageLimitSourcesUpdated`, gated by a client capability flag the way environment themes are. The management key round-trips through the secret store with a redaction marker on disk. See [UsageLimitSources.ts](../../apps/server/src/usage/UsageLimitSources.ts).

#### Model manifest

Scient-owned catalog and per-model visibility policy. Explicit `legacy` entries feed the model picker's Legacy section; unknown discovered models remain visible by default, with provider-native legacy flags preserved. Bundled at `apps/server/src/provider/model-manifest.json` and refreshed at runtime from the same file on `main`, so classification updates ship as commits instead of releases. See the [provider architecture][16] model manifest section.

### Checkpointing

V2 checkpoint scopes associate filesystem history with runs/nodes. [CheckpointService][19]
and `RunExecutionService` attempt baselines; `CheckpointCaptureService` and
[RunFinalizationService][6] settle completed-run capture/diff work. Capture availability is
independent of answer success.

#### Checkpoint and baseline

A checkpoint records workspace files and metadata in a V2 scope; a baseline is its starting
snapshot. `CheckpointStore` still uses hidden Git refs through `VcsCheckpointOps`. The retained
reference utilities are in [Utils.ts][22]. Fork baselines and inherited history are frozen
separately from later execution.

#### Checkpoint diff and rollback

[CheckpointDiffQuery][20] computes file differences with [Diffs.ts][23]. V2
`CheckpointRollbackService` enforces workspace safety, restores files when requested, and reconciles
the provider conversation. Rollback cannot erase a fork's frozen inherited prefix.

### Appearance

#### Environment theme

A theme published by the environment's machine, one file per theme under `themes/` in that
environment's state directory. [environmentTheme.ts][26] watches the directory and streams the set
through `subscribeServerConfig`; clients render each valid file as a theme card. See
[environment-theme.md][27].

#### Default theme

The environment-selected theme recorded in `settings.json` as `defaultTheme`, with
`defaultThemeSetAt` identifying the set generation. Web and desktop apply each generation once;
mobile retains its own appearance setting. A later manual choice remains until the environment sets
a theme again.

## Practical Shortcuts

- If you see `requested`, think "intent recorded".
- If you see `completed`, think "result applied".
- If you see `command receipt`, think "durable admission/rejection and retry identity".
- If you see `checkpoint`, think "workspace snapshot for diff/restore".
- If you see `quiesced`, think "all relevant follow-up work has gone idle".

## Pull requests

| Term                 | Meaning                                                                                                                                                                                  |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pull request link    | A persisted thread association identified by host, repository, and number. Links can cross projects within an environment and carry a server-maintained snapshot.                        |
| Pull request sync    | The reactor that refreshes each distinct linked review once per cadence and discovers native stack layers. Explicit refreshes and failed stack reads trigger another read.               |
| Current pull request | The link used by single-review controls and older clients. Open work takes precedence; a completed single chain points at its top layer. Unrelated terminal links use the latest update. |

## Composer context

| Term                 | Meaning                                                                                                                             |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Context record       | The typed payload behind a composer chip, keyed by `contextId` in `message.context.records`. It never holds bytes.                  |
| Context reference    | One occurrence of a record in message text: `[label](t3-context://v1/<kind>/<contextId>)`. Several references can share one record. |
| Attachment binding   | The link from an image or file record to its server-owned attachment. Its attachment ID can change without changing `contextId`.    |
| Attachment inventory | The ordered image records shown as thumbnails above the prose, including images with no inline references.                          |

See [composer context references](./composer-context-references.md) for the contract and lifecycle.

## Related Docs

- [Architecture overview][24]
- [Provider architecture][16]
- [Provider lifecycle architecture][25]
- [Permission modes][18]
- [Workspace layout][2]

[1]: ../../packages/contracts/src/orchestrationV2.ts
[2]: ../../AGENTS.md#where-code-lives
[3]: ../../apps/server/src/vcs/GitVcsDriverCore.ts
[4]: ../../apps/server/src/orchestration-v2/ProjectionStore.ts
[5]: ../../apps/server/src/orchestration-v2/ProviderEventIngestor.ts
[6]: ../../apps/server/src/orchestration-v2/RunFinalizationService.ts
[7]: ../../apps/server/src/orchestration-v2/Orchestrator.ts
[9]: ../../apps/server/src/orchestration-v2/CommandPolicy.ts
[11]: ../../apps/server/src/orchestration-v2/EventSink.ts
[12]: ../../apps/server/src/orchestration-v2/EffectWorker.ts
[14]: ../../apps/server/src/orchestration-v2/ProviderSessionManager.ts
[15]: ../../apps/server/src/orchestration-v2/ProviderAdapter.ts
[16]: ./providers.md
[17]: ../../apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts
[18]: ../user/permission-modes.md
[19]: ../../apps/server/src/orchestration-v2/CheckpointService.ts
[20]: ../../apps/server/src/checkpointing/CheckpointDiffQuery.ts
[22]: ../../apps/server/src/checkpointing/Utils.ts
[23]: ../../apps/server/src/checkpointing/Diffs.ts
[24]: ./overview.md
[25]: ./provider-lifecycle.md
[26]: ../../apps/server/src/environmentTheme.ts
[27]: ../user/environment-theme.md
[28]: ./scient-workspace-binding.md
