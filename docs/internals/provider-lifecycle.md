# Provider lifecycle architecture

> Canonical maintainer reference for Scient-assisted provider installation and account connection.
> For user-facing behavior, see [Providers in Scient](../user/providers.md). For provider session and
> turn architecture, see [Provider architecture](./providers.md).

Scient extends the existing T3 provider system with optional assisted installation, maintenance, and
account connection. The extension is capability-driven: providers advertise only the operations they
can perform safely on the current server, runtime source, account configuration, and platform.

This document describes the current architecture. The
[capability audit](./provider-lifecycle-capability-audit.md) records evidence, provider differences,
and unresolved questions. The
[unification proposal](./provider-lifecycle-unification-proposal.md) is the implementation plan that
led here; it is not a second source of current behavior.

## First principles

1. **Share mechanics, not provider policy.** Download, verification, operation ownership, and shared
   presentation structure belong in common infrastructure. Authentication protocols, environment
   policy, package contents, and capability decisions remain provider-owned.
2. **The server and provider are authoritative.** The renderer never invents runtime actions, login
   methods, code fields, browser ownership, logout, account metadata, or platform support.
3. **Lifecycle facts are independent.** Enablement, runtime source, authentication, entitlement,
   readiness, update state, and transient operations must not collapse into one `connected` flag.
4. **Assistance must remove work.** Use the fastest safe path. Add a confirmation only for a real
   choice or a runtime mutation the user should understand.
5. **Managed operations are recoverable.** Failed or cancelled replacement work keeps the previous
   usable runtime and never mutates a custom or system installation.
6. **Remote clients describe the server.** Runtime paths, platform support, credentials, and managed
   storage belong to the machine running the Scient server, not necessarily the device displaying the
   UI.

## Ownership boundaries

| Owner                                     | Responsibilities                                                                                                                                                                                                                                                       |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Existing T3 provider host                 | Provider instances, enablement settings, adapters, sessions, model discovery, turn routing, external update discovery and commands, and the canonical `ServerProvider` snapshot.                                                                                       |
| Shared Scient lifecycle                   | Operation supervision, cancellation and teardown, same-provider coordination, reviewed runtime planning, download and filesystem safety, atomic activation, transient snapshot overlays, shared Settings/composer routing, and generic capability presentation.        |
| Provider lifecycle adapter                | Available login methods, browser ownership, URL validation, code behavior, login environment, credential verification, logout support, package-completeness policy, managed-runtime eligibility, system-to-managed qualification, and provider-specific error wording. |
| Official provider tool or account service | Passwords, tokens, credential persistence, refresh, expiry, revocation, account creation, subscriptions, billing, hosted authorization pages, and provider service availability.                                                                                       |

Scient does not add a second provider registry, model catalog, session router, credential store, or
account system. A driver that omits the optional lifecycle capabilities keeps the inherited T3 setup
and maintenance behavior.

## Independent lifecycle state

The UI derives a provider's next action from several independent facts:

| Dimension       | Examples                                                                      | Authority                                                                                  |
| --------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Enablement      | enabled, disabled                                                             | Provider settings and the canonical provider instance.                                     |
| Runtime source  | custom, system, Scient-managed, missing, unknown                              | Provider runtime resolution on the server.                                                 |
| Runtime support | fully assisted, external runtime supported, manual/advanced only, unsupported | Reviewed artifact availability, host mode, target, and provider policy.                    |
| Authentication  | not required, unauthenticated, authenticated, unknown                         | Provider-specific passive probe.                                                           |
| Entitlement     | subscription or billing mode, usable models, no eligible models               | Provider-reported account and model state.                                                 |
| Readiness       | ready, attention, unavailable, probing                                        | Canonical provider snapshot after runtime, account, and model reconciliation.              |
| Maintenance     | external update advisory, managed install/update/repair/remove                | Existing T3 updater for external sources; reviewed lifecycle actions for a managed source. |
| Operation       | starting, waiting, verifying, downloading, testing, activating, terminal      | Process-scoped connection or runtime manager.                                              |

Consequences:

- disabling a provider does not uninstall it or sign it out;
- installing a runtime does not authenticate an account;
- authentication does not prove a paid subscription or usable model;
- removing Scient's managed runtime does not sign out the provider;
- signing out does not remove any runtime; and
- a broken managed runtime is a repair state, not a sign-in state.

An enabled provider begins with a process-local `probePending` placeholder. Until the first probe
publishes authoritative facts, lifecycle surfaces show a passive loading state instead of guessing
whether to offer Install, Sign in, or Manage.

## Capability contract

The additive lifecycle contract is defined in
[`providerLifecycle.ts`](../../packages/contracts/src/providerLifecycle.ts). A materialized provider
instance may expose two optional seams through
[`ProviderDriver.ts`](../../apps/server/src/provider/ProviderDriver.ts):

- `connectionActions` starts and cancels official provider account flows and disconnects when the
  provider can truthfully do so;
- `managedRuntimeActions` reports runtime source and support, plans reviewed mutations, and executes
  advertised install, update, repair, or remove actions.

The canonical provider snapshot carries the resulting capabilities:

- `connection.methods` is the complete list of login methods available for that instance;
- `connection.canDisconnect` controls whether Sign out is visible;
- `connection.operation` describes only the current or most recent transient connection operation;
- `connection.runtime.source` and `supportTier` describe the active runtime and support boundary;
- `connection.runtime.actions` is the complete list of permitted managed actions;
- `connection.runtime.operation` describes transient runtime work; and
- optional diagnostics provide display-only recovery coordinates and never contain credentials.

Fields are additive for rolling client/server compatibility. The renderer may hide an unknown
capability, but must not reconstruct it from a provider name or from unrelated state.

Shared process helpers may provide bounded terminal capture, ANSI and OSC 8 sanitization, URL
extraction, and mechanical environment filtering. The provider adapter still owns the complete
environment allowlist, accepted URL hosts and paths, browser-opening behavior, and code protocol.
Those values are security and compatibility policy, so they are never widened through a shared
default set.

## User action semantics

| Action             | Exact meaning                                                                                                                                                                    |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Enable             | Changes only the provider's enabled setting. It does not install, sign in, or open a browser.                                                                                    |
| Install            | Adds and selects a reviewed app-private runtime after confirmation, verification, smoke testing, and atomic activation.                                                          |
| Use Scient-managed | Runs the same reviewed install path while a healthy default system runtime remains active. The system installation is not removed or modified.                                   |
| Update             | Replaces an active Scient-managed runtime with a newer reviewed artifact through the safe replacement path.                                                                      |
| Repair             | Downloads a fresh copy of the reviewed artifact, verifies and smoke-tests it, then replaces the managed copy. The previous usable copy remains active until activation succeeds. |
| Remove             | Deletes only Scient's app-private runtime. It preserves provider credentials, custom paths, and system installations, then re-probes the provider.                               |
| Sign in            | Starts one official provider-owned account flow and verifies the resulting provider state before reporting success.                                                              |
| Submit code        | Sends a bounded transient code only to the matching live provider operation when that operation explicitly advertises support. It is not persisted.                              |
| Cancel             | Cancels the exact live operation. It does not reverse an operation that already completed and verified successfully.                                                             |
| Sign out           | Delegates credential revocation to the provider and verifies the resulting state. It preserves every runtime.                                                                    |

Account creation and subscription purchase remain on the provider's official page. Scient can explain
that eligible access is missing, but it does not create a parallel signup or billing flow.

## Managed runtime selection and safety

### Source selection

The generic source order is:

1. an explicit custom binary path;
2. an explicitly selected Scient-managed runtime;
3. a healthy default system runtime;
4. a legacy managed runtime when no healthy system runtime exists; then
5. missing or unknown.

Codex keeps a bespoke capability-health resolver because its complete package and app-server
companion requirements differ from a simple version probe. Claude, Antigravity, Grok, Droid, and
Cursor use the shared resolver while retaining provider-specific package and environment policy.

Managed state schema v2 writes the selected managed version and explicit selection in one atomic
state update. Legacy state did not record selection, so an upgrade never silently takes over a
healthy system runtime. A failed or cancelled install cannot write the managed selection.

### System-to-managed handoff

The presence of a reviewed artifact does not automatically permit **Use Scient-managed**. A provider
must explicitly qualify and advertise that transition. The action is available only for a healthy
default system source, a writable local desktop host, and a fully assisted reviewed target. Custom
paths always remain authoritative.

During the handoff, the system runtime remains active until the private copy has downloaded, passed
verification and package-completeness checks, passed its smoke test, and activated. Success reloads
every default-runtime instance of that provider; explicit custom-path instances stay unchanged.
Removing the managed copy re-probes and returns to the healthy system source. Credentials are neither
copied nor migrated because both sources use the provider's established account environment.

The [capability audit](./provider-lifecycle-capability-audit.md#phase-4b-runtime-source-qualification)
records each provider's qualification and evidence level. These rows remain code-confirmed until the
corresponding real-app and platform scenarios are recorded.

### Download and activation boundary

[`packages/scient-provider-runtime`](../../packages/scient-provider-runtime/) owns the shared runtime
engine and provider manifests. The manifests—not prose documentation—are authoritative for current
versions, URLs, checksums, sizes, archive shapes, executable paths, and supported targets.

An install, update, or repair:

1. creates a unique private staging directory;
2. downloads with size, total-time, idle-time, redirect-host, and cancellation bounds;
3. verifies the exact reviewed digest;
4. extracts in process while rejecting traversal, links, duplicates, excessive files, and excessive
   expanded data, or stages the reviewed raw executable;
5. validates provider-specific required package contents;
6. runs the provider's bounded smoke test with an explicit environment; and
7. activates the verified directory atomically and cleans staging.

Routine status refresh never deletes staging because a serialized mutation may still own it.
Abandoned staging is reconciled when the next mutation acquires ownership. A newly reviewed artifact
does not invalidate the currently activated healthy copy; replacement happens only after successful
activation.

Managed runtime mutation is local-desktop-only. Remote and read-only clients may inspect truthful
server state but cannot mutate the host runtime. Unsupported targets fail closed without a guessed
binary or command.

### Reviewed target coverage

The following table is **code-confirmed catalog coverage**, not packaged-app qualification. Current
versions and artifact coordinates remain authoritative only in the provider manifests.

| Provider    | macOS                   | Windows            | Linux                          | Known exclusion                             |
| ----------- | ----------------------- | ------------------ | ------------------------------ | ------------------------------------------- |
| Codex       | Apple silicon and Intel | ARM64 and x64      | ARM64 and x64 static artifacts | Other operating systems and architectures.  |
| Claude      | Apple silicon and Intel | ARM64 and x64      | ARM64 and x64, glibc and musl  | Other operating systems and architectures.  |
| Antigravity | Apple silicon and Intel | ARM64 and x64      | ARM64 and x64, glibc           | Musl Linux.                                 |
| Grok        | Apple silicon and Intel | ARM64 and x64      | ARM64 and x64, glibc           | Musl Linux.                                 |
| Droid       | Apple silicon and Intel | ARM64 and x64      | ARM64 and x64, glibc           | Musl Linux.                                 |
| Cursor      | Apple silicon and Intel | ARM64 and x64      | ARM64 and x64, glibc           | Musl Linux.                                 |
| OpenCode    | No managed catalog      | No managed catalog | No managed catalog             | Scient-managed lifecycle is not advertised. |

A release may advertise a row as platform-qualified only after its exact packaged install,
cancellation, smoke test, authentication, repair, update, interruption, removal, and recovery paths
have passed on that target. Passing on one row does not qualify another.

## Operation ownership, concurrency, and recovery

[`ProviderConnectionManager`](../../apps/server/src/scient/providerLifecycle/ProviderConnectionManager.ts)
and
[`ProviderRuntimeManager`](../../apps/server/src/scient/providerLifecycle/ProviderRuntimeManager.ts)
are process-scoped services shared by every WebSocket client. Closing a dialog or disconnecting one
client therefore does not duplicate or orphan an operation.

One lifecycle coordinator serializes connection, managed runtime mutation, and inherited provider
maintenance for the same instance. Shared runtime mutation also takes a driver-wide reservation
because several provider instances may use one executable. Different providers can proceed
independently. Independent account sign-ins may overlap only where they do not conflict with runtime
mutation.

Every operation has an identity and cleanup owner. Duplicate starts and stale reviewed plans are
rejected. Explicit cancellation, request interruption during startup, normal completion, and server
teardown converge on the same idempotent cleanup path. The server releases reservations and owned
scopes even when a provider ignores cancellation.

Connection completion keeps its transition claim through the bounded final account probe because
that probe decides whether the operation really connected. A cancel arriving during that verification
waits and cannot overwrite a truthful connected or failed result. Runtime reload remains cancellable
until terminal publication because reload reconciles a mutation whose filesystem result is already
known.

Operation summaries are transient overlays on the canonical provider snapshot. They publish
immediately, survive an overlapping authoritative refresh, are excluded from the persistent provider
status cache, and are pruned when the instance disappears. A terminal operation result cannot be
overwritten by an older cache write that finishes later. After a process restart, Scient derives truth
from the provider and managed filesystem rather than restoring a stale wizard or operation.

Progress is semantic and coalesced. The client does not receive raw provider output or every download
chunk, and it shows a percentage only when the server supplies meaningful byte totals.

## Settings and composer

Settings and the composer use one explicit
[`AssistedProviderSetupHost`](../../apps/web/src/scient/providerConnection/AssistedProviderSetupHost.tsx)
for Codex, Claude, Antigravity, Grok, Droid, and Cursor. The host owns only shared routing and
presentation rules; provider views retain their real authentication and recovery flows.

- **Settings** is the complete management surface. It can show runtime source, diagnostics, managed
  maintenance, system-to-managed handoff, account actions, and recovery.
- **Composer** is the fastest safe setup path. An unavailable selected provider can show Enable,
  Install, or Sign in in place of its model list. Full maintenance remains in Manage.
- A disabled provider opens one shared disabled state. A permitted Enable action keeps the surface
  open and waits for the refreshed snapshot, but never auto-installs or starts authentication.
- Managed repair and removal remain reachable while a provider is disabled when advertised.
- When setup finishes, the composer returns to T3's existing model list and selection state. Scient
  does not maintain a second picker or model selection.
- Diagnostics and raw server paths stay behind a low-prominence disclosure and out of the fast
  composer path.

Provider dispatch is intentionally explicit and exhaustive. With seven built-in providers, one
switch is easier to audit than a dynamic registry and prevents a new provider from silently
inheriting unsupported lifecycle behavior.

## Provider-specific capabilities

Managed availability is conditional on host mode, target, and reviewed manifest. The table documents
policy and protocol differences, not universal platform qualification.

| Provider    | Assisted account flow and verification                                                                                                                                                                                                                           | Sign out                                                                                                                                     | Runtime and update policy                                                                                                                                                                                     |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Codex       | Structured app-server browser or device-code login. The device code is copied from Scient to the provider page, never pasted back into Scient. Account state is verified through Codex's account API and a fresh process.                                        | Available only for Codex-owned interactive authentication. Hidden for API-key or workload-controlled configurations.                         | Custom, system, and Scient-managed sources. Bespoke package-health selection. External sources retain T3's package-aware updater; managed sources use reviewed actions.                                       |
| Claude      | Claude subscription or Anthropic Console through `claude auth login`. Claude normally opens the browser; a validated fallback URL can reopen it. A returned code is accepted only while the live process supports it. Verification uses Claude's account status. | Available for Claude-owned credentials and hidden for API-key, Bedrock, Vertex, Foundry, or custom-endpoint ownership.                       | Custom, system, and Scient-managed sources. External sources retain package-aware and qualified native update behavior; managed sources use reviewed actions.                                                 |
| Antigravity | Google subscription flow through the official interactive client. Browser completion or a returned code may be supported by the live operation. Verification requires a successful account-owned model inventory.                                                | Uses provider logout and verification, with a bounded provider-owned local credential cleanup fallback when the official command is blocked. | Custom, system, and Scient-managed sources. Ambient API-key/custom-endpoint variables are excluded from this subscription integration. External updates are manual; managed updates use the reviewed catalog. |
| Grok        | ACP browser login or explicit device code. A pasted code appears only when the exact live ACP operation advertises it. Passive probes never start authentication.                                                                                                | Available for Grok-owned account credentials; it never claims to remove an environment-provided API key.                                     | Custom, system, and Scient-managed sources. External updates remain manual pending installation-source qualification.                                                                                         |
| Droid       | ACP device pairing only when the initialized peer advertises it and an external Factory API key is not controlling authentication. Droid may open a browser without giving Scient a URL.                                                                         | Visible only when the exact ACP peer advertises logout; there is no terminal-automation fallback.                                            | Custom, system, and Scient-managed sources. External updates remain manual pending installation-source qualification.                                                                                         |
| Cursor      | Browser login. Scient runs Cursor in no-open-browser mode, validates the captured official URL, and opens it once. There is no pasted-code flow. Verification uses a fresh account probe.                                                                        | Available for Cursor-owned credentials and hidden when API endpoint, key, or token configuration owns authentication.                        | Custom, system, and Scient-managed sources. External sources retain Cursor's native update path; managed sources use reviewed actions and disable in-place self-update.                                       |
| OpenCode    | No single assisted account flow. OpenCode manages credentials for multiple unrelated upstream providers.                                                                                                                                                         | No universal sign-out is advertised.                                                                                                         | System, custom, or remote runtime use. No Scient-managed lifecycle or system-to-managed handoff is currently advertised; inherited updater behavior remains authoritative.                                    |

The detailed evidence and unresolved questions for these rows live in the
[capability audit](./provider-lifecycle-capability-audit.md), not in provider-name branches in shared
code.

## Evidence and qualification

Use precise evidence labels:

- **Code-confirmed:** implemented in the inspected contract, server, provider adapter, renderer, and
  focused tests.
- **Provider-documented:** described by current official provider documentation, without proving
  Scient integration.
- **Live-qualified:** exercised in a named isolated or packaged Scient app with runtime source,
  account state, platform, and scenario recorded.
- **Platform-qualified:** the complete packaged lifecycle passed on the exact operating-system and
  architecture row being advertised.
- **Open:** requires more evidence before it becomes supported behavior or planned work.

Source inspection and unit tests can establish structure, declared capability, rollback invariants,
and fail-closed behavior. They do not prove a hosted login page, credential propagation,
subscription entitlement, provider service availability, native package execution, or another
platform. Never promote code-confirmed system-to-managed rows or manifest target coverage to live or
platform qualification without recording the matching scenario.

The [capability audit](./provider-lifecycle-capability-audit.md) is the evidence ledger. It should
record only scenarios actually exercised and must leave untested providers, states, and platforms
explicitly unqualified. Actionable gaps belong in the owning issue or project, not as permanent
promises in canonical architecture prose.

## Adding or changing lifecycle support

1. Confirm the provider's current official protocol, CLI behavior, package shape, and account model.
2. Decide independently whether it needs connection actions, managed runtime actions, both, or
   neither. Do not pursue button-for-button parity.
3. Keep complete environment allowlists, URL policy, browser ownership, code semantics, verification,
   logout, and package-completeness rules in the provider adapter.
4. Reuse the existing managers, coordinator, runtime engine, snapshot overlay, and setup host. Do not
   create another registry, wizard state machine, updater, or credential store.
5. Advertise only capabilities proved for the exact instance, source, host mode, and target. Unknown
   or rolling-version capabilities fail closed.
6. Add provider-specific tests plus shared contract coverage where the invariant is genuinely common.
7. Exercise Settings and composer, disabled and enabled states, system/custom/managed sources,
   cancellation, restart recovery, sign-in/out, and remote/read-only behavior where applicable.
8. Record evidence and the concrete reason for every intentional difference in the capability audit.
9. Update this canonical document when ownership or semantics change; update provider user docs when
   a user-visible path changes.

## T3 upstream boundary

Most lifecycle implementation lives under `apps/server/src/scient`, `apps/web/src/scient`, and
`packages/scient-provider-runtime`. The intentional inherited seams are narrow: optional driver
actions, additive contracts and RPCs, transient registry overlays, one reservation around T3's
maintenance runner, server composition, and small Settings/composer entry points.

T3 remains authoritative for provider instances, adapters, sessions, model discovery, process
ownership, provider enablement, external update commands, and surrounding UI. Upstream refreshes
should preserve the narrow Scient seams and reconcile their surrounding context instead of moving
the lifecycle into a parallel host architecture.
