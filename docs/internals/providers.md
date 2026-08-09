# Provider architecture

> For maintainers. Using T3 Code? See [docs/user](../user/).

A provider is the agent runtime that does the actual work. T3 Code supports several, and the
orchestration layer does not know which one is behind a thread.

## Built-in drivers

[`builtInDrivers.ts`][drivers] exports `BUILT_IN_DRIVERS` with five entries:

| Driver kind   | Driver source                           |
| ------------- | --------------------------------------- |
| `codex`       | [`Drivers/CodexDriver.ts`][codex]       |
| `claudeAgent` | [`Drivers/ClaudeDriver.ts`][claude]     |
| `cursor`      | [`Drivers/CursorDriver.ts`][cursor]     |
| `grok`        | [`Drivers/GrokDriver.ts`][grok]         |
| `opencode`    | [`Drivers/OpenCodeDriver.ts`][opencode] |

Each driver declares its `driverKind`, a `configSchema`, and a `create` function that builds an
adapter in a child scope. Adapter implementations live beside them in
`apps/server/src/provider/Layers/` (`CodexAdapter.ts`, `ClaudeAdapter.ts`, and so on) and conform to
[`ProviderAdapter.ts`][adapter]. Read the driver plus its adapter to see how a specific agent's
transport, config, and event shapes are mapped.

## Registry and routing

Two registries separate configuration from live processes:

- [`ProviderInstanceRegistry`][instances] keys configured instances by `ProviderInstanceId`. Creating
  one looks up the driver by `driverKind`, decodes `entry.config` with that driver's schema, opens a
  child scope, and calls `driver.create`.
- [`ProviderAdapterRegistry`][registry] resolves an instance ID to its live adapter via
  `getByInstance`.

[`ProviderService`][service] sits on top. It combines the adapter registry with the provider session
directory to route session and turn operations for a thread, so callers name a thread, not an agent.

Adding a driver means writing the driver plus adapter and adding it to `BUILT_IN_DRIVERS`. No
orchestration, contract, or client change is required for the common case.

## Scient-assisted provider lifecycle

Scient adds an optional lifecycle seam to the existing T3 provider instance. It does not add a
second provider registry, model catalog, session router, or credential store. A driver without the
optional seam keeps its inherited setup and provider behavior.

The first vertical implementation is Codex:

- [`ProviderDriver.ts`][driver] exposes optional provider-owned connection and managed-runtime
  actions on a materialized provider instance;
- [`ProviderRegistry`][provider-registry] applies transient operation summaries to the canonical
  provider snapshot without persisting them as provider truth;
- [`ProviderConnectionManager`][connection-manager] supervises official browser and device-code
  sign-in, cancellation, verification, and logout;
- [`ProviderRuntimeManager`][runtime-manager] plans, starts, cancels, and reconciles an app-private
  runtime action; and
- [`packages/scient-provider-runtime`][runtime-package] owns the reviewed artifact catalog and the
  small filesystem/download boundary.

The contracts are additive. `ServerProvider.auth.required` distinguishes a provider that needs no
account from one whose account state is not yet known. The optional `connection` summary adds only
supported actions, transient progress, and runtime ownership. Existing `installed`, `auth`,
`models`, version, update, instance, and driver facts remain canonical.

### Operation ownership and concurrency

The connection and runtime managers are constructed once per server process and shared by every
WebSocket client. Closing a dialog or disconnecting one client therefore does not create a second
operation or make an in-flight provider flow disappear.

One lifecycle coordinator serializes connection, managed-runtime mutation, and inherited T3
provider maintenance for the same provider instance. Managed runtime mutation and provider-tool
updates also have a driver-wide reservation because every Codex account in one environment may
resolve to the same executable. Independent account sign-ins may proceed together, but no sign-in
can overlap an install, repair, removal, or update of that provider's shared runtime. Separate
providers can proceed independently; T3's existing update-command lock still serializes package
manager commands that share an external lock such as `npm-global`.

Operation identities and reviewed-plan revisions reject duplicate starts and stale consent.
Progress is semantic and coalesced by stage or meaningful download advance; renderer clients do
not receive raw process output or every network chunk. Current operations are intentionally
transient. After restart, the runtime service removes interrupted staging work and derives truth
again from the filesystem and provider probe instead of restoring a stale wizard page.

### Codex authentication

[`CodexConnectionActions`][codex-connection] uses the structured Codex app-server account API. It
does not parse terminal text. The browser or device-code URL and short-lived user code may cross
the RPC boundary; passwords, access tokens, refresh tokens, credential files, and unredacted
provider output may not. Codex owns credential persistence, refresh, expiry, and revocation.

The server does not report connection success from a button click. It waits for Codex completion,
refreshes the provider instance, and derives the next UI state from the resulting runtime, account,
and model snapshot. Logout uses the provider operation and then refreshes the same canonical
snapshot.

### Managed runtime trust boundary

The initial managed runtime is OpenAI Codex `0.147.0`, release tag `rust-v0.147.0`. Each known
artifact has an exact HTTPS URL, allowlisted redirect hosts, byte size, SHA-256 digest, archive
shape, executable path, and smoke command compiled into the signed application source.

An install, update, or repair:

1. opens a unique private staging directory;
2. downloads with size, overall-time, idle-time, redirect-host, and cancellation bounds;
3. verifies the exact digest;
4. extracts in-process while rejecting traversal, links, duplicates, excessive files, and excessive
   expanded data (or stages the reviewed raw Windows executable shape);
5. runs a bounded `--version` smoke test with an explicit environment allowlist;
6. activates the verified directory atomically; and
7. removes staging data on success, failure, or cancellation.

A newly reviewed artifact does not make an older healthy managed copy disappear. Status and launch
resolution continue to use the atomically activated executable recorded in the private runtime
state. An update stages and verifies the reviewed replacement, then switches that state only after
activation. A failed replacement leaves the previous working managed runtime in place. `Remove`
deletes only Scient's private Codex runtime root. It never changes a custom path, system package,
provider credential home, or provider-owned account data. A user-visible manual rollback action is
not exposed until two distinct managed releases have each passed the required release proof.

The app-private store has one owning Scient server process per data directory. The desktop
single-instance and server lifecycle enforce that deployment invariant; independent server
processes must not be configured to mutate the same application data directory.

### Platform capability matrix

Support is selected by host mode, operating system, architecture, and, for Linux diagnostics,
runtime libc. The shared UI consumes the resulting support tier; it contains no operating-system
installation branches.

| Host target                                 | Tier in this implementation  | Managed action                                                 |
| ------------------------------------------- | ---------------------------- | -------------------------------------------------------------- |
| Local desktop, macOS Apple silicon          | `fully_assisted`             | Install, repair, and remove the reviewed private artifact      |
| Local desktop, macOS Intel                  | `external_runtime_supported` | Preserve and use a healthy custom or system runtime            |
| Local desktop, Windows ARM64 or x64         | `external_runtime_supported` | Preserve and use a healthy custom or system runtime            |
| Local desktop, Linux ARM64 or x64           | `external_runtime_supported` | Preserve and use a healthy custom or system runtime            |
| Remote or web/server mode on a known target | `external_runtime_supported` | Use the runtime administered on that host; no managed mutation |
| Unknown operating system or architecture    | `unsupported`                | No invented fallback action                                    |

Official Intel-macOS, Windows, and Linux artifact metadata is represented and contract-tested, but
those rows remain external-runtime-only until their packaged clean-machine, cancellation,
permission, low-disk, interruption, authentication, and recovery evidence exists. A successful
Apple-silicon run is not evidence for another row.

### Upstream-maintenance boundary

Most lifecycle behavior is under `apps/server/src/scient`, `apps/web/src/scient`, and
`packages/scient-provider-runtime`. The intentional inherited seams are narrow: optional driver
actions, additive contracts/RPCs, registry overlays, one shared reservation around T3's existing
maintenance runner, server composition, and small composer and Settings entry points. Upstream T3
remains authoritative for provider instances, adapters, sessions, model discovery, process
ownership, update commands, provider enablement, and the surrounding UI. Future T3 refreshes should
preserve those seams and reconcile only the bounded inherited edits rather than porting the
lifecycle into a parallel host architecture.

## How provider work is requested

Clients never call a provider directly. They dispatch orchestration commands over the RPC method
`orchestration.dispatchCommand`, defined with the rest of the orchestration surface in
[`orchestration.ts`][contracts]. The client-dispatchable provider-facing commands are
`thread.turn.start`, `thread.turn.interrupt`, `thread.approval.respond`,
`thread.user-input.respond`, `thread.checkpoint.revert`, and `thread.session.stop`, plus the mode
setters `thread.runtime-mode.set` and `thread.interaction-mode.set`.

The engine persists an event for the command, and a server-side reactor performs the provider call.
Provider output comes back as internal commands such as `thread.message.assistant.delta` and
`thread.session.set`, which clients observe through `orchestration.subscribeThread`. See
[overview.md](./overview.md) for the command/event loop.

## Server-side workers

Provider work flows through three queue-backed workers. All three are built with
`makeDrainableWorker` from [`DrainableWorker.ts`][worker] and expose `drain` for deterministic test
synchronization.

1. [`ProviderRuntimeIngestion`][ingest] consumes provider runtime streams and emits orchestration
   commands.
2. [`ProviderCommandReactor`][cmd] reacts to orchestration intent events and dispatches provider
   calls.
3. [`CheckpointReactor`][checkpoint] captures workspace checkpoints on turn start and completion, and
   performs reverts.

### Buffered assistant delivery

A thread in `buffered` assistant delivery mode accumulates assistant text instead of streaming each
delta. The buffer is not held until turn completion. In [`ProviderRuntimeIngestion`][ingest],
`MAX_BUFFERED_ASSISTANT_CHARS` is 24,000: the append that would exceed it invalidates the buffer and
spills the whole accumulated text as one delta. The buffer also flushes at interaction boundaries,
when a request opens (approval) or user input is requested, via
`flushBufferedAssistantMessagesForTurn`.

[drivers]: ../../apps/server/src/provider/builtInDrivers.ts
[codex]: ../../apps/server/src/provider/Drivers/CodexDriver.ts
[claude]: ../../apps/server/src/provider/Drivers/ClaudeDriver.ts
[cursor]: ../../apps/server/src/provider/Drivers/CursorDriver.ts
[grok]: ../../apps/server/src/provider/Drivers/GrokDriver.ts
[opencode]: ../../apps/server/src/provider/Drivers/OpenCodeDriver.ts
[adapter]: ../../apps/server/src/provider/Services/ProviderAdapter.ts
[instances]: ../../apps/server/src/provider/Services/ProviderInstanceRegistry.ts
[registry]: ../../apps/server/src/provider/Services/ProviderAdapterRegistry.ts
[service]: ../../apps/server/src/provider/Layers/ProviderService.ts
[driver]: ../../apps/server/src/provider/ProviderDriver.ts
[provider-registry]: ../../apps/server/src/provider/Layers/ProviderRegistry.ts
[connection-manager]: ../../apps/server/src/scient/providerLifecycle/ProviderConnectionManager.ts
[runtime-manager]: ../../apps/server/src/scient/providerLifecycle/ProviderRuntimeManager.ts
[codex-connection]: ../../apps/server/src/scient/providerLifecycle/CodexConnectionActions.ts
[runtime-package]: ../../packages/scient-provider-runtime/
[contracts]: ../../packages/contracts/src/orchestration.ts
[worker]: ../../packages/shared/src/DrainableWorker.ts
[ingest]: ../../apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts
[cmd]: ../../apps/server/src/orchestration/Layers/ProviderCommandReactor.ts
[checkpoint]: ../../apps/server/src/orchestration/Layers/CheckpointReactor.ts
