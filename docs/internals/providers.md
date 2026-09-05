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

## Runtime context

Every adapter uses `apps/server/src/provider/RuntimeInstructions.ts` to identify T3 Code and
the harness, and describe Markdown image/video embeds. Codex includes it in developer
instructions; Claude appends it to its system preset; OpenCode sends it in each prompt's
`system` field. Cursor, Grok, and Antigravity append a separate text block to ACP prompts,
which have no system-message field. This does not change the stored user message.

Per-turn context includes the current model when known. Codex includes reasoning effort;
Grok includes it when explicitly selected for the turn. Claude's session-level context omits model and effort because they can
change during a session. OpenCode variants are not assumed to be reasoning-effort levels.

## Codex async questions

Codex 0.153 exposes `request_user_input_async` through `item/started` and `item/completed`
notifications. The item has `type: "agentMessage"`, `delivery: "async"`, and a `questions` array.
Each question has a `title` and an optional `options` array of strings. The tool returns `{"accepted":true}`
without waiting. This is separate from the `item/tool/requestUserInput` server request.
See the [Codex tool handler](https://github.com/openai/codex/blob/d979df154cf60e13eafb5453e75b6d84f21c67bf/codex-rs/core/src/tools/handlers/request_user_input_async.rs).

The Codex adapter maps completed question items to `user-input.requested` with
`responseMode: "message"` and stable request and event IDs. Questions use the existing web,
desktop, and mobile panels. They stay pending while the turn runs and after it finishes.

The engine reads the request's latest stored activity before deciding a reply. This works after
startup, when the command snapshot has no activities, and after a resolution leaves the recent
activity window. The query returns one activity, not the full thread history.

For these requests, the decider saves the resolution and a user message in one transaction.
The standard turn path delivers the message, including session resume and active-turn input.
It does not send a JSON-RPC response to Codex. Other providers and blocking Codex questions
keep their existing response paths.

## Registry and routing

Two registries separate configuration from live processes:

- [`ProviderInstanceRegistry`][instances] keys configured instances by `ProviderInstanceId`. Creating
  one looks up the driver by `driverKind`, decodes `entry.config` with that driver's schema, opens a
  child scope, and calls `driver.create`.
- [`ProviderAdapterRegistry`][registry] resolves an instance ID to its live adapter via
  `getByInstance`.

[`ProviderService`][service] sits on top. It combines the adapter registry with the provider session
directory to route session and turn operations for a thread, so callers name a thread, not an agent.

`ProviderService.sendTurn` expands [assistant citations](./assistant-citations.md) into quoted
reference data before dispatching to any adapter. Bound user comments remain distinct from the quoted
assistant text. Persisted messages keep their serialized links.

Adding a driver means writing the driver plus adapter and adding it to `BUILT_IN_DRIVERS`. No
orchestration, contract, or client change is required for the common case.

### Grok health check

`checkGrokProviderStatus` never opens an ACP session. It runs `grok --version`, then `grok models`
for login state and model slugs, then a single ACP `initialize` and reads models from
`_meta.modelState`. `authenticate` and `session/new` are skipped on purpose: `authenticate` can open
a browser login and `session/new` boots every configured MCP server, both of which made background
probes hang or surprise the user. A failed `initialize` degrades to `warning` with the CLI's model
list instead of persisting `error` over a working install. The built-in `grok-build` slug is the
CLI's product name, not an ACP model id. `applyGrokAcpModelSelection` treats it as "keep the
session's current model" and never sends it in `session/set_model`.

## Antigravity ownership and protocol

[`AntigravityDriver`][antigravity] uses Google's official ACP executable. The instance config
selects the ACP auth method: `oauth-personal` (default), `oauth-business`, `gemini-api-key`, or
`agent-platform`. The two OAuth methods share the loopback sign-in flow below. The API key
methods pass the configured key to the agent as `GEMINI_API_KEY` or `GOOGLE_API_KEY` and never
open a browser. A GCP project and location are written to the profile's `settings.json` on each
launch. The driver never reuses CLI credentials or ambient `GOOGLE_*` variables and never falls
back to another method. Antigravity is disabled by default and supports multiple provider
instances. The open driver and instance identifiers require no database migration.

### Runtime installation

[`AntigravityInstallation`][antigravity-installation] belongs to the environment, outside
WebSocket and provider-instance scopes. Instances share an explicit download operation and the
completed runtime. Client disconnects and instance rebuilds do not cancel installation.

The fixed [release table][antigravity-release] supplies the bundled floor. Scient's qualified
catalog may advance immutable release facts under the separate `antigravityAcp` key; the app
still owns the allowed targets, Google URL family, exact executable pair, and launch policy.
The catalog's semver is distinct from the agent's native build version. Downloads stream to disk.
Lazy `yauzl` entry streams extract only that pair, with member names, types, duplicates, and
sizes checked. Validation runs ACP `initialize` in a temporary profile without authentication
or a session. Progress updates are bounded, not sent for every network chunk.

Complete releases live in immutable version directories under the T3 home
`tools/antigravity-acp/<platform>-<arch>/versions`. An atomic `active.json` change selects the
release for new processes. Each process holds a version lease until it exits. Updates do not
replace running executables. Removal refuses active leases or explicit binary paths that still
reference the managed files. Failure or cancellation removes owned partial files, not the
previous release or account data.

Repair validates a complete replacement before swapping a damaged generation, refuses active
leases, and restores the previous directory if publication fails. A registry-only revision of
the same verified archive updates its receipt without replacing or downloading the binaries.

Resolution order is explicit `binaryPath`, active managed release, then the instance's `PATH`.
An invalid explicit path fails without fallback. Manual installations are never changed by the
installer. Every launch pins `ANTIGRAVITY_HARNESS_PATH` to the selected executable's sibling.

### Google profiles and sign-in

Each instance owns a stable profile at
`<stateDir>/providers/antigravity/<sha256(instanceId)>`.
[`antigravityAuthSupport.ts`][antigravity-auth-support] sets `GEMINI_HOME` to this directory and
`AGY_ACP_FORCE_FILE_STORAGE=1` after merging instance environment variables. File storage avoids
the official macOS keychain entry being shared across instances. Profile directories use mode
`0700` on POSIX. This is file storage, not an encrypted keychain. Windows uses the host profile's
filesystem permissions.

The launch environment removes API-key and cloud-billing variables, disables inherited
environment extension, sets `PYTHONUNBUFFERED=1`, and controls `BROWSER`. A tested Node or
Electron-as-Node helper prevents the official agent from opening a browser on the environment.
The same launch factory serves setup, health checks, chat, and text generation.

The official agent prints a non-JSON OAuth line on stderr in version 1.1.1. Earlier versions
print it on stdout. T3 accepts the exact native prefix on either stream and its browser-helper
marker on stderr. Fragmented lines are joined and bounded. Other malformed protocol output
remains fatal. Authorization URLs are validated before use. Other stderr is discarded because
it can contain OAuth data. Normal work rejects an interactive login request with a
sign-in-required error instead of waiting for consent. A rejected stderr callback fails pending
ACP requests and closes the owned process.

[`AntigravityAuth`][antigravity-auth] owns each sign-in process and deadline in the instance
scope. Only the initiating T3 auth session receives its URL and flow ID or can complete or
cancel it. Other clients receive busy state without those values. Subscriptions follow
controller replacement when settings rebuild an instance.

Scient's compact setup delegates to that same controller through `AntigravityLifecycleBridge`.
The bridge owns one private controller session for the shared lifecycle supervisor; existing
authorized lifecycle clients can complete or cancel its current operation. It is not a second
authentication engine. The direct upstream setup RPC keeps its initiating-client ownership.

For remote completion, the client sends the full return URL through the typed setup RPC.
The server validates the pending loopback origin, port, root path, and single matching state
before forwarding once to the owned listener. It does not probe the listener or follow
redirects. Google's process owns PKCE, token exchange, refresh, and storage. Callback HTTP
success is not authentication success. The controller waits for authenticated session setup
and catalog discovery. Cancellation closes the process instead of sending a synthetic denial.

Auth RPCs `provider.auth.start`, `complete`, `cancel`, `logout`, and `subscribe` require
`orchestration:operate`. Install `start`, `cancel`, and `remove` use that scope too.
`provider.install.subscribe` and public provider snapshots require `orchestration:read`.
[`providerSetup.ts`][provider-setup] defines the operation IDs, states, and safe errors.

Sign-out closes process admission for the instance, stops provider bindings through
[`ProviderAuthService`][provider-auth-service], then stops owned startup and helper processes.
A fresh official process calls `initialize` and native `logout` without authenticating.
Only then does the provider clear auth, models, commands, skills, and workspace metadata.
Thread history and native session files remain. Settings sign-out and a text-only `/logout`
use this same path. The command is handled before model prompting or title generation.
Disabling an instance closes its processes but keeps credentials. Account replacement is
explicit sign-out followed by sign-in.

### Sessions, models, and client capabilities

[`AntigravityAdapter`][antigravity-adapter] owns one ACP process per active thread. It uses
native `session/resume` without transcript replay and reapplies the persisted model and
permission mode after new or resumed setup. An unavailable explicit model fails instead of
accepting the native default. Steering cancels the previous prompt, waits for its result and
event drain, then sends the replacement. Native background commands use T3's existing
background-task state.

The permission mapping is `approval-required` and `auto` to `default`, `auto-accept-edits` to
`auto_edit`, and `full-access` to `yolo`. Native requests still need replies in `yolo`.
`interaction_` requests are user questions, not approvals. T3 keeps opaque option IDs in
`UserInputQuestion.options[].value` and sets `allowCustomAnswer=false`. Both clients preserve
these values. Ordinary approval replies use only offered option IDs, including `allow_always`
only when present. Existing providers keep their prior behavior when the optional fields are
absent.

`showInteractionModeToggle=false` keeps native `/plan` separate from T3 Plan mode.
`supportsConversationRollback=false` hides unsupported client actions and makes checkpoint
revert fail before filesystem changes. Checkpoint capture and diffs remain supported.

Automatic status refreshes, reconnects, and workspace checks do not open catalog sessions.
Health probes use `initialize` only. Disabled instances do not run background probes.
An explicit `serverRefreshProviders` request with `refreshModels: true` calls the driver's
optional `refreshModels` operation. Antigravity opens a short-lived catalog session under the
instance's process admission guard, uses saved credentials, publishes models and commands,
then closes the process. An interactive login request fails with sign-in required. Web's
**Refresh provider status** and mobile's **Refresh models** actions request this operation.
Account access starts unknown and becomes authenticated after successful session setup,
including an explicit model refresh.
The [provider snapshot][antigravity-provider] takes models and commands from setup and native
updates. It preserves returned Gemini model IDs, labels, order, and thinking-level choices.
Desktop/web and mobile derive a presentation-only grouping of recognized Gemini effort variants
through `packages/client-runtime/src/antigravityModelPresentation.ts`. A family occupies one
picker row; the existing reasoning control chooses another available native model ID.
The control descriptor is local UI data, never a provider option sent over ACP or stored on a
selection. The native ID remains authoritative for drafts, defaults, favorites, resume, and turns.
Favorites retain exact variant shortcuts; hidden rows are not restored by grouping. Custom
models, ambiguous names, and models already advertising native options are not rewritten.
The catalog, ACP adapter, legacy `agy` reasoning path, and managed lifecycle remain unchanged.

ACP `config_option_update` notifications and supplied `session/set_config_option`
inventories update the instance model catalog. An empty acknowledgment preserves
an inventory already published by a notification; otherwise it confirms only the
requested selection. Child session notifications do not change the root catalog.
The registry treats a successful empty catalog as authoritative and clears cached metadata
after sign-out. It must not retain a previous account's models. Cached models do not prove
current access. The auth response does not supply an email, plan tier, or reliable quota.

Some upstream failures arrive as assistant text followed by `end_turn`. Preserve that message
without treating model-written text as a structured error or successful task completion.

### Text generation

[`AntigravityTextGeneration`][antigravity-text] implements titles, branch names, commit text,
and PR text through the same instance and Google sign-in. Each helper uses a temporary empty
workspace, no injected MCP servers, native `default` mode, and explicit denial of tools and
questions. Output is bounded, parsed against the existing schemas, and sanitized. Cancellation,
timeout, and sign-out close the process. Cleanup removes only that helper's verified temporary
native session files.

The official agent has no verified hard no-tools setting. Global hooks and MCP configuration
can run before a prompt. Helpers check the profile's `config/hooks.json` and
`config/mcp_config.json` before launch and reject nonempty, malformed, or oversized
configuration. `supportsTextGeneration=false` keeps such an instance out of system-model
pickers. Empty managed profiles are supported. Do not describe prompt-time denial as a native
sandbox.

## OpenCode server ownership and catalog

Each OpenCode provider instance owns one lazy local server for catalog discovery and text-generation
helpers through [`OpenCodeServerOwner.ts`][opencode-server-owner]. Concurrent borrowers share one
startup. The helper closes 30 seconds after the last borrower releases it, or when the provider
instance closes, and a failed or exited process can start again on the next use. An explicitly
configured external server remains externally owned.

The local server and its SDK clients use one resolved password. An explicit provider password
overrides `OPENCODE_SERVER_PASSWORD` in the spawned environment. Without an explicit password, a
local client uses the password inherited by the process. External servers use only the explicit
provider password and never inherit the host's local password. Every connection must pass an
authenticated `/global/health` check and report OpenCode 1.14.19 or newer before inventory or
session work begins.

Chat adapters keep one server per thread because OpenCode stores MCP connections by directory and
each thread registers its own Scient MCP connection. Catalog discovery instead uses the provider
instance's shared helper. It runs when an enabled instance starts, when a client subscribes to server
configuration, and when provider status is refreshed. Successful snapshots are persisted through
the existing per-instance cache. Failed discovery keeps the last known models, slash commands, and
skills; a successful empty inventory is authoritative. Existing threads keep their explicit model
and options when catalog metadata is temporarily absent.

Native configuration files can remain cached while a local helper is alive. Refreshing after its
idle shutdown starts a new helper and rereads those files. Scient does not own an external OpenCode
process, so changes there may require that server's own reload or restart before refresh can see them.

Chat adapters send the runtime mode as a session ruleset, but upstream OpenCode evaluates
doom-loop and subagent asks against the agent ruleset only. In full access the adapter answers
those asks itself so the user never sees an approval they already granted. It replies `once`
rather than `always` because OpenCode stores `always` grants per directory, and on a shared
external server that would widen what a supervised thread in the same directory may do.

OpenCode loads its catalog through the HTTP API when an enabled provider instance starts. The
provider registry keeps the snapshot in memory and persists it in the existing per-instance cache.
Each `subscribeServerConfig` connection refreshes all providers, so a client reconnect reloads the
OpenCode catalog from the current helper. The `serverRefreshProviders` request also refreshes it.
Periodic OpenCode probes remain disabled. OpenCode reads credentials for each inventory request,
but its native configuration files can remain cached for the lifetime of the helper process. The
helper closes 30 seconds after its last inventory or text-generation borrower releases it. A
refresh after that idle period starts a new helper and reads file changes. Repeated refreshes and
active text-generation work can extend process reuse. Changes to the provider configuration or
environment replace the instance and start a new discovery. Changes to unrelated settings only
update snapshot enrichment. Other providers retain their existing refresh policy.

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

### Legacy Antigravity compatibility

The official ACP path above is the default on supported hosts. Scient's previous `agy`
stream-json transport remains only for version-2 continuation cursors, explicit legacy executable
paths (`agy`, `agy.exe`, or the old managed `antigravity` binary), and the unsupported-ACP Intel Mac
default. `AntigravityCompatibilityAdapter` creates the legacy adapter lazily for old conversations;
version-1 ACP cursors stay ACP. It never replays or converts one protocol's cursor into the other.

`LegacyAntigravityDriver` and [`AgySession.ts`][agy-session] preserve the existing subscription,
credential-store, attachment, and managed-runtime behavior for that path. The `antigravity` catalog
entry stays separate from `antigravityAcp`. Neither authentication nor installation migrates old
credentials. New ACP text and voice helpers share T3's structured-generation implementation.

The [provider lifecycle architecture](./provider-lifecycle.md) owns the shared management contract.

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

External runtime maintenance uses T3's ownership resolver in
`apps/server/src/provider/providerMaintenance.ts`. It proves the resolved binary's installer,
pins npm's owning prefix, and uses Homebrew's available version rather than npm's version for a
Homebrew install. Unproven ownership stays manual-only. Resolution is cached per instance and
revalidated immediately before mutation; the runner verifies the installed version afterward.
Scient-managed paths remain manual-only at this generic boundary: their separate runtime actions
own discovery, verification, activation, leases, and rollback. Never send a managed binary through
an inferred system-package update command.

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

## Attachment access

The server stores uploaded attachments outside the project workspace. Scient's composer accepts
images and generic files, while each provider decides whether to receive a native content block or
a safe path reference according to its real capabilities.

- Codex, Claude, Cursor, and Grok send images as native image inputs and skip generic files. For
  these providers, generic files reach the agent only as file paths in the turn text.
- OpenCode sends PNG/JPEG/GIF/WebP images, text files, and PDFs up to 20 MB as native file parts
  with their real mime type. Everything else (ZIP and other binaries, image formats model APIs
  reject, oversized files) falls back to the file path in the turn text, like the other providers.
- Antigravity sends BMP/JPEG/PNG/WebP images and common audio formats as native blocks, UTF-8 text
  as embedded resources, and PDFs as local resource links. Text is limited to 1 MiB per file,
  images to 10 MiB each, and all attachments to 50 MiB per turn. Unsupported or oversized inputs
  fail explicitly instead of being dropped. Its ACP file-service requests are confined to the
  workspace and attachments directory.

The server must never copy a file into the project or bypass a provider's approval rules merely to
make the shared UI uniform. A provider that cannot ingest a format natively receives a path only
when its adapter explicitly supports that fallback.

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
[antigravity]: ../../apps/server/src/provider/Drivers/AntigravityDriver.ts
[antigravity-adapter]: ../../apps/server/src/provider/Layers/AntigravityAdapter.ts
[antigravity-provider]: ../../apps/server/src/provider/Layers/AntigravityProvider.ts
[antigravity-installation]: ../../apps/server/src/provider/AntigravityInstallation.ts
[antigravity-release]: ../../apps/server/src/provider/antigravityRelease.ts
[antigravity-auth]: ../../apps/server/src/provider/AntigravityAuth.ts
[antigravity-auth-support]: ../../apps/server/src/provider/antigravityAuthSupport.ts
[antigravity-text]: ../../apps/server/src/textGeneration/AntigravityTextGeneration.ts
[provider-auth-service]: ../../apps/server/src/provider/Layers/ProviderAuthService.ts
[provider-setup]: ../../packages/contracts/src/providerSetup.ts
[opencode-server-owner]: ../../apps/server/src/provider/OpenCodeServerOwner.ts
[droid]: ../../apps/server/src/provider/Drivers/DroidDriver.ts
[agy-session]: ../../apps/server/src/provider/antigravity/AgySession.ts
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
