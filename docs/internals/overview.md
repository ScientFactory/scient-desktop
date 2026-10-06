# Architecture

> For maintainers. Using Scient? See [docs/user](../user/).

Scient uses a server runtime that owns agent sessions, workspaces, and version control, plus clients
(web, desktop, mobile) that talk to it over one authenticated Effect RPC WebSocket. The server is the
execution boundary: every provider process, terminal, git operation, and filesystem read happens
there, never in the client.

```text
Clients: web, Electron desktop, mobile
  shared connection/domain runtime: packages/client-runtime
             |
             | authenticated Effect RPC (/ws) + bounded HTTP reads
             v
Server: orchestration V2, provider instances and native adapters
  event log + projections + command receipts + effect outbox
  provider execution, checkpointing, VCS, terminals, filesystem
             |
             | provider-specific process, SDK or protocol transport
             v
Agent runtimes: Codex, Claude, Cursor, Grok, OpenCode, Droid,
                Antigravity, Pi, Oh My Pi, Scient Agent, ACP registry
```

## The RPC boundary

The client/server contract is an Effect RPC group, not a hand-rolled push protocol. [`rpc.ts`][rpc]
declares `WS_METHODS` and assembles `WsRpcGroup`; each member is either unary or a server stream
(`stream: true`). Streaming members such as `orchestration.subscribeShell`,
`orchestration.subscribeThread`, `subscribeServerConfig`, and `terminal.attach` replace what used to
be a broadcast push bus: a client subscribes to what it needs and the server pushes only on that
subscription.

### Pull request linking compatibility

Web, desktop, mobile, and environments upgrade independently. Negotiate linking through the
environment descriptor, never through a client version or an assumed coordinated release:

| Environment capability                | Client behavior                                                                                                   |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `threadPullRequests: true`            | Use persisted `pullRequests[]`, multi-link commands, stack UI, and reverse thread lookup.                         |
| Only `threadPullRequestLinking: true` | Use `linkedPullRequest` and the existing `thread.meta.update` single-link operation. Do not call multi-link RPCs. |
| Neither flag                          | Hide linking actions; existing branch-discovered PR display remains available.                                    |

V2 environments retain the linking capability and derived `linkedPullRequest` field, and use
native `thread.metadata.update` for single-link metadata. The old `thread.meta.update` command
belongs to older hosts; V2 rejects unsupported legacy-only commands with a client-update error.
The retained message-boundary fork wire command is an explicit exception routed to a V2 service. That hostless field includes only
links in the thread project's own repository; cross-host and cross-repository links require the
multi-link protocol. New clients accept snapshots that
omit `pullRequests`. Retain the legacy wire fields, projection column, and replay support; this feature
does not schedule their removal. Missing new capabilities must also override cached multi-link data
after an environment downgrade.

[`ws.ts`][ws] serves the group. `websocketRpcRouteLayer` mounts `GET /ws`, authenticates the upgrade
through `EnvironmentAuth.authenticateWebSocketUpgrade`, then hands the socket to
`RpcServer.toHttpEffectWebsocket`. Authorization is per method: `RPC_REQUIRED_SCOPE` maps each method
to a scope, and `authorizeEffect`/`authorizeStream` enforce it. Holding a valid socket is not
authorization to call everything on it. See [environment-auth.md](./environment-auth.md).

On the client, [`session.ts`][session] opens the socket and builds the typed client.
`RpcSessionFactory` is the service; a session exposes `client`, `initialConfig`, `ready`, `probe`,
and `closed`. It performs one attempt and does not retry. Retry, backoff, and offline policy belong
to the connection supervisor.

## Settings ownership

Client preferences stay in the current client; environment defaults and project overrides stay
on their owning server. The web and desktop settings target is URL state, resolved against current
connections and project membership. An unavailable target must not fall back to another environment.
**All environments** is an explicit bulk edit of connected, loaded servers, not a durable global
default or a promise to synchronize offline or future environments. Project-group targets similarly
select known environment-local checkouts; the group itself does not store inherited defaults.

## Durable intent and side effects

The event log is the source of truth for orchestration state. The
[v2 orchestrator](../../apps/server/src/orchestration-v2/Orchestrator.ts) serializes commands and
plans durable events and effects; provider execution belongs to the effect services.
[EventSink](../../apps/server/src/orchestration-v2/EventSink.ts) commits events, persisted projections,
the accepted command receipt, and outbox effects in one database transaction. Subscribers receive
events after that commit, in database sequence order. This keeps command retries idempotent and prevents a persisted projection
from getting ahead of the event log.

The sink serializes commit and publication across command, provider, and project writes, then wakes
outbox workers. Its transaction body can be interrupted and rolled back; once commit succeeds,
publication finishes before cancellation releases the writer. Publishing writes own their SQL
transaction. Import preparation and its final ledger write run inside that transaction, so a failed
import cannot publish events that rolled back. Callers must not nest a publishing write inside
another SQL transaction.

The [effect worker](../../apps/server/src/orchestration-v2/EffectWorker.ts) performs side effects
after intent has been recorded, then feeds results back into orchestration. A command acknowledgement
therefore means the intent committed, not that the provider, checkpoint, or other follow-up work
finished. Admission also validates attachment sources and reads their actual file sizes; Scient
boundary forks freeze a Git checkpoint before committing fork intent. Provider execution and durable
provisioning follow committed outbox intent. External process calls do not run inside the EventSink
SQL transaction. Effects tied to a lost provider process cannot simply replay; recovery retires them
before admitting new work.

## Shared client runtime

`packages/client-runtime` holds every non-visual client concern: connection lifecycle,
authentication, RPC, cached environment data, and domain state as Atom factories. Web and mobile
compose it the same way (`apps/web/src/connection/runtime.ts` and
`apps/mobile/src/connection/runtime.ts` mirror each other, differing only in platform-specific
background-activity layers) and differ beyond that only in the platform layer they supply and the
UI they build on top. React components never construct transports, retry loops,
or RPC clients. See [connection-runtime.md](./connection-runtime.md).

## Orchestration V2

Production composition lives in [`runtimeLayer.ts`][runtime]. The application graph separates
app threads and messages from runs, attempts, execution nodes, provider sessions, provider threads,
provider turns, turn items, runtime requests, checkpoints, and context transfers. App IDs are
primary; native provider IDs are attributed references, not interchangeable app identities.
[`orchestrationV2.ts`][contracts] defines the commands, events, and projections.

[`Orchestrator.ts`][orchestrator] plans commands against persisted state. `ThreadCommandExecutor`
serializes each thread independently; forks acquire source and destination locks in a stable order.
There is no global V1 command worker or authoritative in-memory V1 read model. Dispatch checks
`CommandReceiptStore`, validates the request through `CommandPolicy` and command invariants,
then commits through [`EventSink.ts`][sink]. The accepted receipt, events, materialized projection,
and requested effects share one SQL transaction. Publication and worker wakeups follow commit.
A retry returns the durable receipt; a command ID cannot be reused for another thread.

Clients send commands such as `message.dispatch`, `run.interrupt`, `runtime-request.respond`,
`queued-run.cancel`, and `checkpoint.rollback`. Provider adapters emit normalized V2 events;
[`ProviderEventIngestor.ts`][ingest] associates them with the recorded run/attempt/node and
persists them through the same sink. `ProjectionStore` builds persisted read models;
`WireProjection`, `ThreadStream`, and `ShellStream` provide bounded client views. Change domain
facts through commands/events, not by treating a UI snapshot as write authority.

Root provider completion and run finalization are separate. `RunExecutionService` records
provider outcomes; [`RunFinalizationService.ts`][finalization] captures the checkpoint and advances
finalization. Child/subagent completion does not complete the root run. Late checkpoint or diff
work does not extend provider duration or masquerade as an active provider turn.

Automatic settlement settings belong to each server. Clients synchronize shared keys only to
connected settings targets that advertise `threadAutoSettlement` and warn on drift; an unavailable
environment is not silently replaced by another target.
[`ThreadSettlementService.ts`][settlement] owns evaluation. Its server sweep
works without a connected client; settings and PR merge notifications trigger reevaluation.
The guarded `thread.auto-settle` command rejects newer activity, explicit overrides, and live or
blocked work. It records the activity timestamp and detaches idle provider sessions. Clients render
the persisted result rather than deriving settlement from their clocks or PR caches.

At provider termination and checkpoint finalization, the V2 execution/capture services refresh PR discovery for the thread's matching
non-default branch when no newer run is active. `VcsStatusBroadcaster` requires loaded remote
status and permission from background policy. `GitManager` retries only a successful "no PR"
cache entry, preserving known PRs and failure backoff without fetching remotes. Remote status
reads that write the broadcaster cache share a lock per cwd.

## Asynchronous effects and recovery

[`EffectOutbox.ts`][outbox] persists pending work with leases and terminal outcomes.
[`EffectWorker.ts`][worker] claims it and calls the owning execution service: provider turn start
and control, runtime-request response, checkpoint rollback/finalization, fork provisioning, title
generation, or resource cleanup. Tests drain the V2 worker or await a specific persisted event or
command receipt. A receipt of command acceptance is distinct from completion of its effects.
Do not substitute a fixed delay or a V1 reactor test for live V2 completion evidence.

`ProviderRuntimeRecoveryService` reconciles lost processes before the worker starts. Replay-safe
work can be requeued; process-bound starts, steering, interrupts, and callback replies cannot be
blindly replayed against a vanished runtime. Recovery persists outcomes before admitting new work.
Old database/queue readers hydrate saved facts into V2; they do not execute V1 commands.

Native queued runs are the sole live queue authority. Admission, order, holds, and advancement
belong to `Orchestrator`; `QueuedRunsControl` adapts them into the Scient `ThreadQueueStrip`.
See [the queue contract](./scient-thread-queue.md) and
[legacy import](./legacy-orchestration-migration.md).

## Provider drivers

[`builtInDrivers.ts`][drivers] registers eleven built-in drivers: ACP registry, Codex, Claude,
Cursor, Grok, OpenCode, Droid, Antigravity, Pi, Oh My Pi, and Scient Agent. Drivers own instance
configuration, discovery, lifecycle capabilities, and native adapter construction.
`ProviderInstanceRegistry` owns configured runtime instances. `ProviderAdapterRegistryV2` obtains
their `ProviderAdapterV2` by instance ID, and `ProviderSessionManagerV2` owns live session scopes,
MCP credentials, idle release, and teardown. Protocol differences stay in `Adapters/` and shared
provider runtime helpers. See [providers.md](./providers.md).

## Checkpointing

V2 `CheckpointService` defines checkpointable workspace scopes. `RunExecutionService` attempts a
baseline, `CheckpointCaptureService` records completed-run capture/diffs, and
`CheckpointRollbackService` restores the workspace and reconciles the provider conversation.
Capture availability is separate from answer success. `CheckpointStore` still stores hidden Git
refs through `VcsCheckpointOps`; `CheckpointDiffQuery` serves diff reads. These are not a
Git-independent file-history backend.

Capture admission retains its limits (512 MiB per changed file, 1 GiB in changed files, bounded
path enumeration and execution time). Symlink accounting does not follow targets; porcelain paths
resolve from the repository root within the staging pathspec. Declined capture has a typed
availability error. Capture stages in a temporary repository and publishes only after staging
succeeds, with cleanup on failure or interruption. Shared-workspace restore safety is enforced by
V2 rollback policy, separately from conversation-only rollback.

## Issue presentation

The shared client-runtime activity policy assigns known failures to their owning capability.
Background capture and diff failures stay in persisted diagnostics and do not become failed answers
in either web or mobile, including when replaying older events. Capture and diff have separate event
kinds: failure to compare files does not mean the captured checkpoint was lost. Ordinary chat does
not prompt users to install Git. Worktree setup failures belong to the existing setup card; legacy
script failures without a card remain inspectable. Composer validation, attachment readiness and
queue-edit failures continue to use the composer, because they block the action requested there.

Approval and question reply errors appear on the pending request with retry feedback; drafts remain
available. Transport failures use the same local controls. Restore errors stay in the requesting web
dialog with expandable details; file-history diagnostics can also be inspected there. Historical restore failures remain inspectable as neutral activity.
Genuine start, runtime, Stop and session-stop failures remain prominent, with concise summaries and
expandable technical details. Unknown activity kinds remain visible; a `.failed` suffix alone does
not imply a failed answer. Tool outcomes retain their existing tool-specific presentation.

## Startup

[`serverRuntimeStartup.ts`][startup] starts keybindings and settings, reconciles legacy thread
shells and admits old queued payloads as held V2 runs, reconciles lost provider runtimes, then starts
the V2 effect worker and awareness relay. Auto-bootstrap, heartbeat, and headless/browser presentation
follow recovery. Startup then waits for `markHttpListening` and auxiliary readiness, publishes
welcome, activates the server, logs `Accepting commands`, signals command readiness, and publishes
ready. The HTTP listener can exist while command readiness is still gated.

## Related

- [Workspace layout](../../AGENTS.md#where-code-lives), [Glossary](./glossary.md)
- [Remote environments](./remote.md), [Server updates](./server-updates.md)
- [Resource telemetry](./resource-telemetry.md)
- [Scient conversation-fork architecture and T3 divergence](./scient-fork-divergence.md)
- [Mobile navigation headers](./mobile-navigation.md)
- [Scient product analytics](./product-analytics.md)
- [Scripts](./scripts.md), [CI gates](./ci.md)
- [D4 bootstrap record](./scient-next-d4-bootstrap.md)

[rpc]: ../../packages/contracts/src/rpc.ts
[contracts]: ../../packages/contracts/src/orchestrationV2.ts
[ws]: ../../apps/server/src/ws.ts
[session]: ../../packages/client-runtime/src/rpc/session.ts
[startup]: ../../apps/server/src/serverRuntimeStartup.ts
[runtime]: ../../apps/server/src/orchestration-v2/runtimeLayer.ts
[orchestrator]: ../../apps/server/src/orchestration-v2/Orchestrator.ts
[sink]: ../../apps/server/src/orchestration-v2/EventSink.ts
[ingest]: ../../apps/server/src/orchestration-v2/ProviderEventIngestor.ts
[worker]: ../../apps/server/src/orchestration-v2/EffectWorker.ts
[outbox]: ../../apps/server/src/orchestration-v2/EffectOutbox.ts
[finalization]: ../../apps/server/src/orchestration-v2/RunFinalizationService.ts
[settlement]: ../../apps/server/src/orchestration-v2/ThreadSettlementService.ts
[drivers]: ../../apps/server/src/provider/builtInDrivers.ts

## Desktop startup and native isolation

The Electron shell acquires `DesktopPreReadyPlatform.layer` synchronously before asynchronous
services. On Linux this sets the desktop-entry identity and global-shortcut portal flags before
Chromium initializes its portal connection. Setting the identity later in `DesktopAppIdentity`
is too late: Chromium caches the first registration, including failures. The identity must match
the installed entry managed by `DesktopLinuxUrlHandler`. Pre-ready setup also refreshes that entry's
`Exec` path before portal registration: AppImage updates can remove the previous executable, which
makes the old entry invalid even though its filename is correct. The later URL handler avoids
rewriting an identical entry while the portal may be reading it. On Wayland, Electron's synchronous
shortcut-registration result only confirms submission; it does not confirm desktop consent or
an active binding.

Native modules never load in the Electron main process on the startup path, and the two the
snapshot feature keeps are isolated: `@crowecawcaw/xa11y` runs only in forked Node-mode children
(`SnapShotAccessibilityWorker`, `RegionSnapShotWorker`) and a worker thread, and `ffi-rs` loads
lazily inside `WindowsForeground.ts` for a handful of Win32 calls. macOS window lookup shells out
to `osascript` instead of a native addon. A crash or stall in any of these must not take the app
down, so new native capability goes in a child with a deadline, not an `import` in main.

See the [glossary](./glossary.md) for shared terms and the
[development runbook](../operations/development.md) for setup and checks.
