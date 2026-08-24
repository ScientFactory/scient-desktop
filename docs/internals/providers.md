# Provider architecture

> For maintainers. Using T3 Code? See [docs/user](../user/).

A provider is the agent runtime that does the actual work. T3 Code supports several, and the
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
- Cursor 2026.08.11 accepts a documented `--plugin-dir`, but live CLI and ACP verification found
  that session-local plugin rules were not applied. Antigravity 1.1.19 likewise has no verified
  application-private system extension. Both integrations are therefore marked unsupported for
  Scient awareness instead of rewriting the user's first message, writing rules into the project,
  or modifying global configuration.

Adding a provider requires adding a tested delivery decision. System awareness never comes from
hidden user-message prefixes, project instruction files, credentials copied into a synthetic home,
or undocumented ACP metadata.

### Droid (Factory) driver

Droid runs the `@factory/cli` binary over ACP (`droid exec --output-format acp`), sharing the ACP
session runtime with Grok and Cursor. See [providers-droid.md](../user/providers-droid.md) for the
user-facing setup flow. Implementation notes that go beyond the shared runtime:

- `Drivers/DroidDriver.ts` composes the existing adapter with the optional Scient lifecycle seam.
  It preserves healthy custom and system binaries, otherwise resolves the reviewed app-private
  runtime and exposes only the actions that match the current runtime and ACP capabilities.
- `Layers/DroidProvider.ts` probes status as version check → one passive ACP connection. That
  connection initializes once to read account capabilities, then calls `session/new` without
  `authenticate` to classify account state and read the model inventory from
  `sessionSetupResult.configOptions`. It then walks
  every catalog entry to observe its own reasoning-effort ladder (best-effort and time-bounded; on
  failure the snapshot inventory stands with unknown per-model ladders rather than wrong ones). Only an
  "Authentication required" failure maps to an unauthenticated snapshot; any other startup or spawn
  failure is a generic probe error. Factory custom (`custom:`) models remain marked custom for
  ownership and presentation, while their reasoning-effort capabilities come from the same
  selected-model ACP snapshot as Factory-managed models.
- `acp/DroidAcpSupport.ts` owns Droid-specific vocabulary: auth-method selection
  (`FACTORY_API_KEY` env vs device pairing), model/effort config-option parsing (including the
  per-model factory-token cost label parsed from each option description), autonomy-mode
  mapping, and the shared `applyDroidModelAndEffort` used by both the interactive adapter and
  headless text generation.
- `Layers/DroidAdapter.ts` follows the Grok adapter chassis (thread-locked prompt preparation,
  steering by prompt counting, atomic turn settlement under `Effect.ensuring`, two-phase interrupt)
  and advertises standard ACP form elicitation so structured Droid questions use Scient's existing
  user-input request/response lifecycle. It also adds a Droid idle watchdog: a silent child turn is cancelled after
  `SCIENT_DROID_TURN_IDLE_TIMEOUT_MS` (default 600s; capped at 3600s while nested Tasks run).
- `scient/providerLifecycle/DroidConnectionActions.ts` invokes only the standard ACP
  `device-pairing` method advertised by the exact initialized peer. Droid owns its dynamic browser
  flow; because ACP exposes no URL to Scient, the generic connection attempt represents that
  provider-opened-browser state explicitly and publishes no invented fallback URL or code. Sign out
  is exposed only when the passive probe advertises ACP logout and is rechecked against the exact
  connection used for logout; there is no terminal-output fallback.
- `scient/providerLifecycle/DroidManagedRuntimeActions.ts` delegates immutable download,
  verification, staging, smoke testing, atomic activation, repair, and removal to the shared
  provider-runtime package. Scient disables Droid's in-place updater for managed processes.

Shared-runtime edits this driver required (reconcile on upstream refreshes):

- `AcpSessionRuntime.ts`: pass-through of authenticate metadata, folding of
  `config_option_update` notifications into cached config state, and resolution of mode-selector
  ids by category when `session/set_mode` names a value rather than an option id. Factory CLI 0.200.0
  applies model writes and publishes their updates but never completes those JSON-RPC requests, so
  Droid selects notification transport only for the `model` option and waits for the matching
  authoritative update. Reasoning and autonomy keep normal request transport; a successful empty
  acknowledgment updates the cached value only when no concurrent notification replaced the snapshot.
- `packages/effect-acp`: `SetSessionConfigOptionResponse` decoding is made tolerant in
  `rpc.ts` via a hand-written lenient wire codec (`LenientSetSessionConfigOptionResponse`), not by
  editing the generated `schema.gen.ts`: a missing or `null` `configOptions` field normalizes to an
  empty array while non-array payloads are still rejected. Keeping this out of generated code means
  regeneration from the pinned schema assets cannot silently drop it; `rpc.test.ts` guards both
  behaviors. Missing or null inventories remain absent rather than being normalized to an
  authoritative empty list.

## Scient-assisted provider lifecycle

Scient adds an optional lifecycle seam to the existing T3 provider instance. It does not add a
second provider registry, model catalog, session router, or credential store. A driver without the
optional seam keeps its inherited setup and provider behavior.

The current vertical implementations are Codex, Claude, Cursor, Antigravity, Grok, and Droid:

- [`ProviderDriver.ts`][driver] exposes optional provider-owned connection and managed-runtime
  actions on a materialized provider instance;
- [`ProviderRegistry`][provider-registry] applies transient operation summaries to the canonical
  provider snapshot without persisting them as provider truth;
- [`ProviderConnectionManager`][connection-manager] supervises official browser, device-code, and
  Claude account sign-in, cancellation, verification, and logout;
- [`ProviderRuntimeManager`][runtime-manager] plans, starts, cancels, and reconciles an app-private
  runtime action; and
- [`packages/scient-provider-runtime`][runtime-package] owns the reviewed artifact catalog and the
  small filesystem/download boundary.

Grok uses the same lifecycle seam without adding a credential store. Its reviewed raw executable is
installed atomically into Scient's private runtime directory. Account sign-in, device-code sign-in,
authorization-code submission, cancellation, account inspection, and logout use Grok Build's
official ACP auth extensions. Readiness probes initialize ACP only: they never call authenticate,
create a session, or request token-bearing extension data. A configured `XAI_API_KEY` remains a
distinct ready state and is not presented as a connected Grok subscription.

The contracts are additive. `ServerProvider.auth.required` distinguishes a provider that needs no
account from one whose account state is not yet known. The optional `connection` summary adds only
supported actions, transient progress, and runtime ownership. Existing `installed`, `auth`,
`models`, version, update, instance, and driver facts remain canonical.

### Operation ownership and concurrency

The connection and runtime managers are constructed once per server process and shared by every
WebSocket client. Closing a dialog or disconnecting one client therefore does not create a second
operation or make an in-flight provider flow disappear.

Their construction effects are owned by the server layer scope. Every active operation is removed
from its manager atomically and then passes through the same resource cleanup path used by explicit
cancellation. Server teardown drains all remaining operations, gives active connection attempts a
bounded best-effort window to stop, interrupts their supervisors, closes connection-owned scopes,
and releases lifecycle reservations. Teardown does not publish a synthetic cancelled or failed
result: the process is going away, and the next server derives provider truth again from the provider
and managed-runtime state. Repeated cleanup is harmless because only the first atomic claim receives
the active operation.

Reservation acquisition through detached-supervisor handoff is also one cleanup boundary. If the
initiating request is interrupted before handoff, Scient releases the reservation and owned resources;
an operation that was already published becomes `cancelled`, while an interruption before publication
leaves no synthetic operation behind.

Explicit connection cancellation uses that same cleanup path. An unresponsive provider can delay it
for up to the configured provider-cancel bound (currently five seconds) before Scient interrupts its
supervisor and continues resource cleanup. After owned resources stop, Scient publishes the terminal
state while the lifecycle reservation is still held, then releases that reservation in an `ensuring`
finalizer. Failed connection startup, explicit cancellation, and post-disconnect refresh all follow
that ordering, so an older terminal write cannot overwrite a newer operation. Final account
verification is different: it decides whether the connection actually succeeded, so it keeps the
transition claim through the probe and terminal publication. A cancel requested after provider
completion waits for that decision and cannot replace truthful `connected` or `failed` state. Runtime
reload remains cancellable until terminal publication because it reconciles an already-finished
runtime mutation instead of deciding its result.

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
transient. After restart, the runtime service safely reconciles atomic state and derives truth
again from the filesystem and provider probe instead of restoring a stale wizard page. Abandoned
staging is removed only when the next serialized runtime mutation begins, so a concurrent status
refresh cannot delete an active installation.

Registry characterization tests protect that boundary: transient connection and runtime summaries
publish immediately, are reapplied after an authoritative provider refresh, are excluded from the
persistent status cache, and are pruned when an instance disappears. Terminal operation state also
cannot be overwritten by an older cache write that finishes later.

### Connection adapter primitives

`ProviderConnectionActions.ts` owns only mechanics that are identical across provider adapters. Its
terminal scanner preserves OSC 8 link targets, removes terminal presentation controls, bounds and
parses HTTPS candidates, and then delegates the final URL decision to a provider-owned predicate.
Its environment picker copies values from a provider's complete explicit allowlist without defining
shared keys or forced values. Its disconnect wrapper sequences session shutdown before
provider-owned credential revocation and delegates shutdown-error wording to the provider.

The policies remain local: Claude, Cursor, and Antigravity declare their own accepted authorization
hosts and paths and their own process-environment allowlists; provider-specific updater controls are
added only after filtering. Structured Codex, Grok, and Droid authentication does not pass through
the terminal scanner. A provider opts into session shutdown explicitly rather than inheriting it from
the shared helper.

### Codex authentication

[`CodexConnectionActions`][codex-connection] uses the structured Codex app-server account API. It
does not parse terminal text. The browser or device-code URL and short-lived user code may cross
the RPC boundary; passwords, access tokens, refresh tokens, credential files, and unredacted
provider output may not. Browser login uses Codex's official local success page rather than its
hosted Codex-app handoff, so a successful Scient login ends with a closeable browser page. Codex
owns credential persistence, refresh, expiry, and revocation.

The server does not report connection success from a button click. It waits for Codex completion,
refreshes the provider instance, and derives the next UI state from the resulting runtime, account,
and model snapshot. Logout uses the provider operation and then refreshes the same canonical
snapshot.

### Claude authentication

[`ClaudeConnectionActions`][claude-connection] supervises Claude Code's official `auth login`
process. It does not replace T3's Claude Agent SDK adapter, session transport, permissions, or model
execution. Claude.ai subscription authentication is the default assisted method, with Anthropic
Console authentication available as an alternative. Both account methods are executed by Claude
Code itself; Scient never receives the provider password or becomes the credential owner. Configured
API keys, custom endpoints, and Bedrock, Vertex, or Foundry backends keep their existing
provider-specific setup and do not receive an irrelevant interactive account flow.

Claude normally completes its local browser callback automatically. When Claude's browser page
instead displays a one-time code, the UI may send that transient value to the stdin of the matching
live Claude process. The operation identity is checked first, the value is bounded and rejected if
it contains control characters, and it is never added to the provider snapshot, URL, logs, settings,
or persistent storage. Claude owns the resulting credentials and Scient verifies success through
`claude auth status --json` before refreshing the canonical models.

Claude Code also owns the initial browser launch. Scient captures and validates the printed HTTPS
authorization URL only to provide a **Reopen browser** recovery action; it does not open the same
page a second time and create duplicate tabs.

### Antigravity architecture and authentication

Antigravity is a native integration, not an ACP compatibility bridge:

- **Session transport (`AgySession.ts`)**: Starts one official `agy` process per Scient thread with
  documented `stream-json` input and output. The process stays warm for multiple turns and emits
  typed init, delta, tool, result, usage, and conversation-ID data. Cancellation terminates the
  process; the next turn starts a fresh process with the last completed conversation ID.
- **Adapter (`AntigravityAdapter.ts`)**: Maps native events into canonical provider events, owns
  process/session scopes, stages attachments in a private directory, and rejects unsupported
  interactive approvals, model switching, and rollback honestly.
- **Authentication (`AntigravityConnectionActions.ts`)**: Launches the official interactive client
  in a PTY, lets Antigravity open Google sign-in, and verifies completion with `agy models`.
  Disconnect sends `/logout`. If the CLI blocks that command behind first-run screens, Scient
  removes only Antigravity's provider-owned local consumer credential entries and then verifies that
  `agy models` is unauthenticated. Scient never reads or copies token contents. The process
  environment is allowlisted, disables Antigravity's in-place updater, and omits API-key and
  custom-endpoint variables, preserving the Google-account subscription boundary.
- **Structured text generation (`AntigravityTextGeneration.ts`)**: Uses the same native transport
  with `--json-schema` and validates `structured_output`; it does not scrape JSON from prose.
- **Assisted onboarding (`AntigravityInlineSetup.tsx`)**: Surfaces reviewed managed install,
  cancellation/recovery, Google sign-in, model readiness, updates, and sign-out in the
  composer and Settings surfaces.

### Managed runtime trust boundary

The reviewed runtime catalogs currently include OpenAI Codex `0.149.1`, release tag
`rust-v0.149.1`; Anthropic Claude Code `2.1.170`, paired with the Claude Agent SDK version already
used by T3; Cursor Agent `2026.08.11-e8db854`; Google Antigravity CLI `1.1.19`; xAI Grok `1.0.5`;
and Factory Droid `0.202.0`. Each known artifact has an exact HTTPS URL, allowlisted redirect hosts,
byte size, SHA-256 or SHA-512 digest, archive shape, executable path, and smoke command compiled
into the signed application source.

That paired Claude runtime satisfies the current Fable 5 capability threshold, but it does not
claim Opus 5 support: Opus 5 remains hidden until a healthy Claude Code `2.1.219` or newer is
actually detected. A managed upgrade must review the Claude Agent SDK and executable together, or
prove that the existing SDK is compatible with the newer executable; the executable must not be
advanced alone merely to expose a model label.

An install, update, or repair:

1. opens a unique private staging directory;
2. downloads with size, overall-time, idle-time, redirect-host, and cancellation bounds;
3. verifies the exact digest;
4. extracts in-process while rejecting traversal, links, duplicates, excessive files, and excessive
   expanded data (or stages the reviewed raw Windows executable shape);
5. runs a bounded `--version` smoke test with an explicit environment allowlist;
6. activates the verified directory atomically; and
7. removes staging data on success, failure, or cancellation.

Verification ownership is deliberately layered:

- the shared managed-runtime contract suite owns provider-independent install, update, repair,
  failure, cancellation, rollback, reconciliation, and removal invariants;
- `runtimeFiles.test.ts` owns archive-format handling and extraction security; and
- thin manifest and runtime-wrapper tests own provider-specific target support, private roots,
  smoke policy, and complete package metadata, including required companion executables.

A successful smoke command does not prove that a provider package is complete. Providers whose
official package needs companion executables must list them in reviewed artifact metadata so the
shared materializer can reject an incomplete extraction before activation.

Routine status reconciliation never deletes staging because another serialized install may still
own it. Abandoned staging is removed only after the installation reservation has been acquired and
a new install, update, or repair begins.

A newly reviewed artifact does not make an older healthy managed copy disappear. Status and launch
resolution continue to use the atomically activated executable recorded in the private runtime
state. An update stages and verifies the reviewed replacement, then switches that state only after
activation. A failed replacement leaves the previous working managed runtime in place. `Remove`
deletes only the selected Scient-private provider runtime root. It never changes a custom path,
system package, provider credential home, or provider-owned account data. A user-visible manual
rollback action is not exposed until two distinct managed releases have each passed the required
release proof.
Settings exposes repair and removal for a managed copy. When the canonical provider probe reports
that an existing managed executable cannot run, the assisted dialog routes directly to runtime
recovery rather than presenting authentication as the next step.

Managed runtime state schema v2 records explicit user selection beside the activated version in the
same atomic file. The generic source order is: explicit custom path; explicitly selected managed
runtime; healthy system runtime; legacy managed runtime when no healthy system runtime exists; then
missing. Schema-v1 state records activation but no selection, so upgrades preserve the existing
system-first behavior instead of silently taking over a working installation. The next successful
install, update, or repair writes v2 only after download, verification, smoke testing, and activation
have succeeded. Failure or cancellation therefore leaves the active source unchanged.

System-to-managed handoff is an explicit provider capability, not an artifact inference. Codex keeps
its bespoke capability-health and fallback policy. Claude, Antigravity, Grok, Droid, and Cursor opt
into the shared policy at their server wrappers after provider-specific account, update, package,
removal, and platform review. The capability is advertised only for a healthy default system source
on a writable local desktop target with a fully assisted artifact. Custom paths always remain
authoritative. Successful activation reloads every instance of that provider; default-runtime
instances use the selected private copy, while explicit custom-path instances remain unchanged.
Removal deletes only Scient's private root and re-probes the system runtime. Provider credentials are
never copied or migrated: both sources continue to use each provider's established account/home
environment and provider-owned authentication rules.

The app-private store has one owning Scient server process per data directory. The desktop
single-instance and server lifecycle enforce that deployment invariant; independent server
processes must not be configured to mutate the same application data directory.

### Codex platform capability matrix

Support is selected by host mode, operating system, architecture, and, for Linux diagnostics,
runtime libc. The shared UI consumes the resulting support tier; it contains no operating-system
installation branches.

| Host target                                 | Tier in this implementation  | Managed action                                                 |
| ------------------------------------------- | ---------------------------- | -------------------------------------------------------------- |
| Local desktop, macOS Apple silicon          | `fully_assisted`             | Install, repair, and remove the reviewed private artifact      |
| Local desktop, macOS Intel                  | `fully_assisted`             | Install, repair, and remove the reviewed private artifact      |
| Local desktop, Windows ARM64 or x64         | `fully_assisted`             | Install, repair, and remove the reviewed private executable    |
| Local desktop, Linux ARM64 or x64           | `fully_assisted`             | Install, repair, and remove the reviewed private static binary |
| Remote or web/server mode on a known target | `external_runtime_supported` | Use the runtime administered on that host; no managed mutation |
| Unknown operating system or architecture    | `unsupported`                | No invented fallback action                                    |

Official Intel-macOS, Windows, and Linux artifact metadata is represented and contract-tested, and
the local desktop offers the same verified managed lifecycle on each reviewed row. Platform release
validation remains a separate acceptance responsibility: a failure on one row must not be treated
as evidence that another row is healthy or unhealthy.

### Claude platform capability matrix

Claude's official native catalog covers Apple-silicon and Intel macOS, Windows ARM64 and x64, and
Linux ARM64 and x64 with glibc or musl. Those targets share the same fail-closed download, digest,
smoke-test, atomic-activation, and recovery pipeline. Managed mutation remains local-desktop-only;
remote and web hosts use an externally administered runtime.

Catalog coverage is implementation evidence, not a public release-proof claim. Before a packaged
build enables or advertises a target, that exact operating-system and architecture row must pass
clean-machine installation, cancellation, authentication, update, interruption, and recovery
qualification. Passing those checks on one target does not certify another.

### Antigravity platform capability matrix

The reviewed Antigravity `1.1.19` catalog covers Apple-silicon and Intel macOS, Windows ARM64 and
x64, and glibc Linux ARM64 and x64. Google's macOS and Linux archives contain one native
`antigravity` executable; the Windows release is a reviewed raw `agy.exe`. Musl Linux is not
advertised because Google does not publish a matching artifact in this release.

Known local-desktop targets receive managed install, repair, update, and removal. Remote/server
hosts may use an externally administered runtime but cannot mutate it through Scient. As with the
other provider catalogs, each operating-system and architecture row still requires packaged-app
qualification before release; catalog metadata and unit tests alone are not cross-platform proof.

### Droid platform capability matrix

The reviewed Droid `0.202.0` catalog covers Apple-silicon and Intel macOS, ARM64 and x64 Windows,
and ARM64 and x64 glibc Linux. X64 targets use Factory's official baseline binaries so managed
installation does not require a separate CPU-detection subsystem. Musl Linux is not advertised
because Factory does not publish a distinct reviewed artifact for it.

Known local-desktop targets receive managed install, repair, and removal. Remote/server hosts may
use an externally administered runtime but cannot mutate it through Scient. Catalog metadata and
unit tests do not replace packaged-app qualification of every operating-system and architecture
row.

### Upstream-maintenance boundary

Most lifecycle behavior is under `apps/server/src/scient`, `apps/web/src/scient`, and
`packages/scient-provider-runtime`. The intentional inherited seams are narrow: optional driver
actions, additive contracts/RPCs, registry overlays, one shared reservation around T3's existing
maintenance runner, server composition, and small composer and Settings entry points. Upstream T3
remains authoritative for provider instances, adapters, sessions, model discovery, process
ownership, update commands, provider enablement, and the surrounding UI. Future T3 refreshes should
preserve those seams and reconcile only the bounded inherited edits rather than porting the
lifecycle into a parallel host architecture.

The composer keeps T3's model picker and model-selection logic. Two optional presentation callbacks
allow an enabled provider that is not ready to remain selectable in the picker rail and render its
Scient-owned setup surface in place of the model list. Once the canonical provider snapshot becomes
ready, the callback stops applying and the same selected rail item returns to T3's model list. This
keeps other providers reachable after the first connection without creating a second model picker.
When setup began in the first-provider onboarding picker, readiness hands the provider's declared
default model to that same T3 selection path and closes onboarding; it does not create a separate
Scient model-selection state.

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
[droid]: ../../apps/server/src/provider/Drivers/DroidDriver.ts
[antigravity]: ../../apps/server/src/provider/Drivers/AntigravityDriver.ts
[adapter]: ../../apps/server/src/provider/Services/ProviderAdapter.ts
[awareness]: ../../apps/server/src/provider/ScientAwareness.ts
[instances]: ../../apps/server/src/provider/Services/ProviderInstanceRegistry.ts
[registry]: ../../apps/server/src/provider/Services/ProviderAdapterRegistry.ts
[service]: ../../apps/server/src/provider/Layers/ProviderService.ts
[driver]: ../../apps/server/src/provider/ProviderDriver.ts
[provider-registry]: ../../apps/server/src/provider/Layers/ProviderRegistry.ts
[connection-manager]: ../../apps/server/src/scient/providerLifecycle/ProviderConnectionManager.ts
[runtime-manager]: ../../apps/server/src/scient/providerLifecycle/ProviderRuntimeManager.ts
[codex-connection]: ../../apps/server/src/scient/providerLifecycle/CodexConnectionActions.ts
[claude-connection]: ../../apps/server/src/scient/providerLifecycle/ClaudeConnectionActions.ts
[antigravity-connection]: ../../apps/server/src/scient/providerLifecycle/AntigravityConnectionActions.ts
[runtime-package]: ../../packages/scient-provider-runtime/
[contracts]: ../../packages/contracts/src/orchestration.ts
[worker]: ../../packages/shared/src/DrainableWorker.ts
[ingest]: ../../apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts
[cmd]: ../../apps/server/src/orchestration/Layers/ProviderCommandReactor.ts
[checkpoint]: ../../apps/server/src/orchestration/Layers/CheckpointReactor.ts
