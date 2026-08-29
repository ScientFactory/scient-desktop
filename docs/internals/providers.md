# Provider architecture

> For maintainers. Using Scient? See [provider guides](../user/providers.md).

A provider is the agent runtime that does the actual work. Scient supports several, and the
orchestration layer does not know which one is behind a thread.

## Built-in drivers

[`builtInDrivers.ts`][drivers] exports `BUILT_IN_DRIVERS` with seven entries:

| Driver kind   | Driver source                                 |
| ------------- | --------------------------------------------- |
| `codex`       | [`Drivers/CodexDriver.ts`][codex]             |
| `claudeAgent` | [`Drivers/ClaudeDriver.ts`][claude]           |
| `cursor`      | [`Drivers/CursorDriver.ts`][cursor]           |
| `grok`        | [`Drivers/GrokDriver.ts`][grok]               |
| `opencode`    | [`Drivers/OpenCodeDriver.ts`][opencode]       |
| `droid`       | [`Drivers/DroidDriver.ts`][droid]             |
| `antigravity` | [`Drivers/AntigravityDriver.ts`][antigravity] |

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

## Scient awareness

Interactive agents receive one compact, Scient-owned awareness contract from
[`ScientAwareness.ts`][awareness]. The always-on block identifies Scient as a project workspace,
states what the user can inspect, and names the rich Markdown representations the chat actually
renders. A separate browser block is composed only when the exact MCP credential for that session
grants `preview`; the same capability decision drives both authorization and awareness. Sources
mechanics remain in tool descriptions rather than consuming every turn's instruction context.

Each built-in driver has an explicit native delivery decision, guarded against `BUILT_IN_DRIVERS`:

- Codex uses developer instructions; Claude appends to its preset system prompt; OpenCode uses its
  per-prompt system field; Grok uses `--rules`; Droid uses `--append-system-prompt`.
- Cursor accepts a documented `--plugin-dir`, but live CLI and ACP verification found that
  session-local plugin rules were not applied. Antigravity likewise has no verified
  application-private system extension. Both integrations are therefore marked unsupported for
  Scient awareness instead of rewriting the user's first message, writing rules into the project,
  or modifying global configuration.

Adding a provider requires adding a tested delivery decision. System awareness never comes from
hidden user-message prefixes, project instruction files, credentials copied into a synthetic home,
or undocumented ACP metadata.

### Droid (Factory) driver

Droid runs the `@factory/cli` binary over ACP (`droid exec --output-format acp`), sharing the ACP
session runtime with Grok and Cursor. See [Droid in Scient](../user/providers-droid.md) for the
user-facing setup flow. Implementation notes that go beyond the shared runtime:

- `Drivers/DroidDriver.ts` composes the existing adapter with the optional Scient lifecycle seam.
  It preserves healthy custom and system binaries, otherwise resolves the reviewed app-private
  runtime and exposes only actions that match the current runtime and ACP capabilities.
- `Layers/DroidProvider.ts` probes version, opens one passive ACP connection, and initializes it to
  inspect account capabilities. It calls `session/new` without `authenticate` to classify account
  state and read the model inventory. Model-specific reasoning ladders are discovered best-effort
  and time-bounded; failure keeps the models with unknown ladders instead of publishing wrong ones.
- `acp/DroidAcpSupport.ts` owns auth-method selection, model and effort parsing, autonomy mapping,
  and the shared model/effort application used by interactive and headless paths.
- `Layers/DroidAdapter.ts` owns prompt preparation, steering, atomic turn settlement, interruption,
  ACP elicitation, and the Droid idle watchdog.
- `scient/providerLifecycle/DroidConnectionActions.ts` invokes device pairing only when the exact
  initialized peer advertises it. Droid owns its browser flow, and Sign out is exposed only when the
  peer advertises ACP logout.
- `scient/providerLifecycle/DroidManagedRuntimeActions.ts` delegates download, verification, staging,
  smoke testing, atomic activation, repair, and removal to the shared provider-runtime package.
  Scient disables Droid's in-place updater for managed processes.

Shared ACP compatibility edits required by Droid remain narrow and tested. `AcpSessionRuntime.ts`
folds configuration notifications into cached session state and handles Droid's model-option
notification behavior. `packages/effect-acp` decodes missing or null configuration inventories
tolerantly without weakening non-array validation or editing generated schemas.

### Antigravity driver

Antigravity is a native integration, not an ACP compatibility bridge. Its provider-specific runtime
is intentionally separate from the assisted lifecycle machinery:

- [`AgySession.ts`][agy-session] starts one official `agy` process per Scient thread using the
  documented `stream-json` transport. It keeps the process warm across turns, emits typed init,
  delta, tool, result, usage, and conversation-ID events, and resumes from the last completed
  conversation after interruption.
- [`AntigravityAdapter.ts`][antigravity-adapter] maps those events into the provider contract, owns
  process and session scopes, stages attachments privately, and rejects unsupported approvals,
  model switching, and rollback rather than presenting unavailable controls.
- [`AntigravityTextGeneration.ts`][antigravity-text] uses the native structured-output path with a
  JSON schema and validates `structured_output`; it does not scrape JSON from prose.

Antigravity's Google account flow, managed runtime, and capability-specific lifecycle behavior are
documented in [Provider lifecycle architecture](./provider-lifecycle.md).

## Scient-assisted provider lifecycle

Codex, Claude, Cursor, Antigravity, Grok, and Droid optionally expose assisted runtime and account
capabilities on their existing provider instances. OpenCode keeps its inherited multi-provider setup.
The lifecycle extension does not create another provider registry, session router, model catalog,
credential store, or updater.

The canonical architecture, action semantics, provider matrix, extension checklist, evidence levels,
and T3 maintenance boundary are documented in
[Provider lifecycle architecture](./provider-lifecycle.md). The
[capability audit](./provider-lifecycle-capability-audit.md) records provider-specific evidence and
open qualification questions.

At the integration boundary:

- [`ProviderDriver.ts`][driver] exposes optional connection and managed-runtime capabilities;
- [`ProviderRegistry`][provider-registry] overlays transient operations on canonical provider
  snapshots without persisting them as provider truth;
- [`ProviderConnectionManager`][connection-manager] supervises official provider account flows;
- [`ProviderRuntimeManager`][runtime-manager] supervises reviewed app-private runtime mutations; and
- [`packages/scient-provider-runtime`][runtime-package] owns the reviewed artifact and filesystem
  boundary.

The surrounding T3 provider host remains authoritative for provider instances, enablement, adapters,
sessions, models, external maintenance, and turn execution.

### Settings presentation seam

The provider editor's initial presentation is a small Scient-owned policy over that host state.
Shipped drivers open on **Models** when the tab exists; unknown/custom drivers stay on their only
**Configuration** tab. Provider-reported authenticated email is shown initially so multiple account
instances can be distinguished, while the same reusable sensitive-text component remains redacted
by default for other uses and lets the user hide or reveal the email. These defaults live in
`apps/web/src/components/settings/ProviderInstanceCard.tsx` and are guarded by
`ProviderInstanceCard.tabs.test.tsx` and `RedactedSensitiveText.test.tsx`.

## Model manifest

The model picker's legacy section is driven by `apps/server/src/provider/model-manifest.json`, which
lists the current (non-legacy) model slugs per driver kind. The `ModelManifest` service
(`apps/server/src/provider/ModelManifest.ts`) refreshes that policy from the same file on Scient's
`main` branch, so changing a model's classification is a reviewed Scient commit rather than an app
release. Preference order is remote fetch, then the on-disk copy of the last successful fetch in
the state directory, then the bundled copy.

Refreshes are TTL-gated, run concurrently with provider probes, respect the
`enableProviderUpdateChecks` setting, and never fail a provider check. Codex and Claude currently
apply the classification to every snapshot; driver kinds absent from the manifest have no legacy
classification. Keep the remote source Scient-owned: pointing it at upstream would let an unrelated
repository change Scient's model policy outside Scient's review and release boundary.

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
3. [`CheckpointReactor`][checkpoint] captures workspace checkpoints on turn start and completion,
   and performs reverts.

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
[droid]: ../../apps/server/src/provider/Drivers/DroidDriver.ts
[antigravity]: ../../apps/server/src/provider/Drivers/AntigravityDriver.ts
[agy-session]: ../../apps/server/src/provider/antigravity/AgySession.ts
[antigravity-adapter]: ../../apps/server/src/provider/Layers/AntigravityAdapter.ts
[antigravity-text]: ../../apps/server/src/textGeneration/AntigravityTextGeneration.ts
[adapter]: ../../apps/server/src/provider/Services/ProviderAdapter.ts
[awareness]: ../../apps/server/src/provider/ScientAwareness.ts
[instances]: ../../apps/server/src/provider/Services/ProviderInstanceRegistry.ts
[registry]: ../../apps/server/src/provider/Services/ProviderAdapterRegistry.ts
[service]: ../../apps/server/src/provider/Layers/ProviderService.ts
[driver]: ../../apps/server/src/provider/ProviderDriver.ts
[provider-registry]: ../../apps/server/src/provider/Layers/ProviderRegistry.ts
[connection-manager]: ../../apps/server/src/scient/providerLifecycle/ProviderConnectionManager.ts
[runtime-manager]: ../../apps/server/src/scient/providerLifecycle/ProviderRuntimeManager.ts
[runtime-package]: ../../packages/scient-provider-runtime/
[contracts]: ../../packages/contracts/src/orchestration.ts
[worker]: ../../packages/shared/src/DrainableWorker.ts
[ingest]: ../../apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts
[cmd]: ../../apps/server/src/orchestration/Layers/ProviderCommandReactor.ts
[checkpoint]: ../../apps/server/src/orchestration/Layers/CheckpointReactor.ts
