# Provider Lifecycle Capability Audit

> Status: implementation evidence ledger, last refreshed 2026-08-24.
>
> This document is evidence for the
> [provider lifecycle unification proposal](./provider-lifecycle-unification-proposal.md), not an
> implementation contract and not proof that every listed path has passed packaged-app qualification.
> It records what the current code and provider documentation appear to support, why some differences
> should remain, and which gaps need more investigation. Revalidate the affected rows against the
> current checkout, upstream T3, the provider CLI or protocol, focused tests, and real-app behavior
> before changing a provider.

## Role of this document

This audit exists to keep two different questions separate:

1. **What does each provider actually support, and why does it differ?** This document owns that
   evidence, classification, and uncertainty.
2. **What has Scient decided to implement, in what sequence?** The unification proposal owns accepted
   architecture and delivery decisions.

An observation here does not become planned work merely because it looks inconsistent. During each
provider migration:

- confirm the current implementation and official provider behavior;
- classify the difference as a shared invariant, an intentional provider-specific capability, a
  missing capability, or behavior that should be removed;
- record live or packaged-app evidence when mocks and source inspection cannot prove the behavior;
- update this audit when the evidence changes; and
- update the proposal and canonical implementation documentation only after accepting a design or
  behavior change.

This prevents accidental parity work from erasing real protocol differences, while keeping genuine
omissions visible. After implementation, this file should either become the canonical provider
capability matrix or be merged into the canonical lifecycle documentation without losing the
provider-specific rationale.

## Evidence and confidence

Initial investigation began against Scient `main` at `dc07474af931877d4b94747d241df6c2af7d35c4`.
The published audit was performed against the planning branch based on:

```text
118420c908594f0d9ca3124d341a5ce47cc3505a
```

That baseline includes PR #151 and the Codex managed-package completeness fix in
`5f52a1420823c0f311d5755f6a715294fba48fe1`.

Use the following evidence labels when this document is updated:

- **Code-confirmed:** present in the inspected server, contract, renderer, and focused tests.
- **Provider-documented:** supported by current official provider documentation, but not necessarily
  qualified through Scient.
- **Live-qualified:** exercised successfully in the named isolated or packaged Scient app, with the
  runtime source and account state recorded.
- **Open:** plausible from current evidence but requiring further investigation before it becomes an
  implementation decision.

Source inspection can establish structure and declared capability. It cannot by itself prove browser
handoff, credential propagation, entitlement, cancellation, update behavior, packaging, or a
provider's current hosted service.

## Lifecycle dimensions

Provider parity should be evaluated across independent dimensions rather than one generic connected
state:

1. **Runtime discovery:** custom, system, Scient-managed, missing, unknown, remote, or unsupported.
2. **Runtime acquisition:** reviewed plan, download, checksum verification, extraction, staging,
   provider-specific package-completeness validation, smoke test, activation, cancellation, and
   recovery.
3. **Runtime maintenance:** managed update, repair, removal, and the inherited T3 update path for an
   external installation.
4. **Authentication:** available methods, browser owner, URL recovery, device code, optional returned
   code, cancellation, verification, and sign-out.
5. **Entitlement and readiness:** authenticated account, subscription or billing mode, available
   models, and actual ability to start a session.
6. **Provider enablement:** the user's canonical enabled/disabled choice, independent from runtime,
   credentials, and account readiness.
7. **Presentation:** concise capability-driven actions, optional diagnostics, truthful account
   metadata, and no additional step unless safety or a real choice requires one.

## Current provider matrix

The table describes the currently inspected architecture. Managed actions remain conditional on a
reviewed artifact, local desktop mode, and a supported target.

| Provider    | Runtime lifecycle                                                                                                                                                               | Assisted account flow                                                                                                                                                                                                  | Sign-out behavior                                                                                                                                                                        | External/system update                                                                                                                                                               | Current classification                                                                                                                                                                                                |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Codex       | Custom, system, and Scient-managed. Install, managed update, repair, and private removal. It can also offer a secondary switch from a healthy system runtime to Scient-managed. | ChatGPT browser or device-code login through Codex app-server. Device code is copied from Scient to the provider page; it is not a code pasted back into Scient.                                                       | Available for interactive ChatGPT account authentication. Hidden when Codex reports that OpenAI authentication is not required, including API-key or workload-controlled configurations. | Existing package-manager-aware T3 updater.                                                                                                                                           | The system-to-managed capability is valid but must remain explicitly advertised and provider-qualified.                                                                                                               |
| Claude      | Custom, system, and Scient-managed. Install, managed update, repair, private removal, and an optional system-to-managed handoff.                                                | Claude subscription or Anthropic Console login. The provider-owned flow may accept a returned one-time code.                                                                                                           | Available for Claude-owned credentials. Hidden when API key, Bedrock, Vertex, Foundry, or equivalent external configuration owns authentication.                                         | Existing package-manager-aware updater plus the qualified native `claude update` path.                                                                                               | Subscription versus Console, provider browser ownership, and optional returned-code handling are intentional differences.                                                                                             |
| Antigravity | Custom, system, and Scient-managed. Install, managed update, repair, private removal, and an optional system-to-managed handoff.                                                | Google subscription login. The live process may support browser completion or a returned authorization code. Scient intentionally does not turn this into Gemini API-key setup.                                        | Provider logout followed by verification, with a bounded local credential-store fallback where the official logout is insufficient.                                                      | Scient-managed updates use the reviewed catalog. External installations are currently manual-only in Scient.                                                                         | Subscription-only product scope and returned-code behavior are provider-specific. The renderer must rely on the live operation rather than infer code entry from the provider name.                                   |
| Grok        | Custom, system, and Scient-managed. Install, managed update, repair, private removal, and an optional system-to-managed handoff.                                                | Normal browser login or an explicit device-code path. A pasted-code input is valid only when the exact live ACP operation advertises it.                                                                               | Available for Grok-owned account credentials. It must not pretend to clear an environment-provided API key.                                                                              | Currently manual-only in Scient. Official documentation exposes `grok update` and `grok update --check`.                                                                             | The authentication alternatives are intentional. External update support is an open qualification gap, not permission to run the native updater blindly.                                                              |
| Droid       | Custom, system, and Scient-managed. Install, managed update, repair, private removal, and an optional system-to-managed handoff.                                                | ACP device pairing only when the exact initialized peer advertises the capability and an external Factory API key is not controlling authentication. The provider may open a browser without exposing a URL to Scient. | Available only when the exact ACP peer advertises logout. It is hidden for externally supplied API-key configuration.                                                                    | Currently manual-only in Scient. Official documentation distinguishes npm, Homebrew, standalone, and direct-binary installations and exposes `droid update` for applicable installs. | ACP capability negotiation and conditional logout are intentional. External update support requires installation-source-aware qualification.                                                                          |
| Cursor      | Custom, system, and Scient-managed. Install, managed update, repair, private removal, and an optional system-to-managed handoff.                                                | Browser login. Scient captures and validates the provider URL while preventing duplicate browser launches. There is no generic pasted-code step.                                                                       | Available for Cursor-owned credentials and hidden when API endpoint, API key, or token configuration owns authentication.                                                                | Existing native `cursor-agent update` path.                                                                                                                                          | Its no-browser launch mode and login environment are provider-specific reliability and security policy.                                                                                                               |
| OpenCode    | System, custom, or remote runtime use. No Scient-managed runtime lifecycle is currently advertised.                                                                             | No single account flow: OpenCode manages credentials for many upstream LLM providers using different API-key, OAuth, environment, and local-model configurations.                                                      | A universal OpenCode sign-out would be misleading because there is no single upstream account to revoke.                                                                                 | Existing package-manager-aware and native `opencode upgrade` paths.                                                                                                                  | Keep manual/provider-specific management unless a separate multi-provider OpenCode connection project proves a truthful design. Managed local installation is a possible future capability, not a parity requirement. |

## Phase 1-3 presentation evidence and accepted corrections

This section records current evidence so later migrations can distinguish an intentional provider
difference from a shared presentation defect. The accepted implementation requirements themselves
remain in the proposal.

- **Code-confirmed:** Grok and Droid currently implement their disabled cards inside provider-specific
  inline views; the other assisted providers do not share the same presentation.
- **Code-confirmed:** the management dialog can focus exclusively on managed-runtime content when the
  top-level disabled snapshot reports `installed: false`, even when runtime metadata proves a managed
  copy exists. This can hide the Enable/account handoff after a successful install.
- **Manually observed:** Grok install, repair, removal, cancellation, and account actions work when the
  provider is enabled. When it remains disabled after install, login becomes reachable only after the
  separate provider toggle is changed. Droid's disabled card explains the state more clearly, but it
  still requires leaving the lifecycle surface to enable the provider.
- **Initial code evidence:** system-to-Scient-managed switching began as a Codex-qualified capability
  with partly provider-specific presentation. The Phase 4B result below records the subsequent
  provider-by-provider qualification and shared capability-driven presentation.

Classification: enabled/disabled is a shared independent lifecycle dimension, and an in-surface
Enable handoff is a shared presentation requirement where settings are writable. System-to-managed
permission remains an explicit provider declaration after selection, health, credential, removal,
fallback, update, multi-instance, and platform review; the renderer never infers it.

## Phase 4A shared presentation outcome

The shared setup host now owns the provider-disabled state for every assisted provider. A permitted
Enable action performs one canonical settings update, keeps the surface open, waits for the refreshed
provider snapshot, and never starts installation, authentication, or a browser as a side effect.
Remote or read-only clients without operate permission receive a concise non-actionable explanation.
Settings provider rows remain a single neutral Manage entry point; the explicit Enable action lives
inside the lifecycle surface so it does not duplicate the existing provider toggle.

The shared presentation also treats a verified managed runtime as installed during the short handoff
before the top-level provider probe catches up, so completion cannot collapse into a blank or
runtime-only surface. Managed maintenance remains available while disabled when the server advertises
it. Runtime-source presentation uses provider metadata, keeps a healthy system runtime primary, and
shows a qualified system-to-managed action only once outside diagnostics.

These are renderer and settings-handoff rules, not new provider capabilities. Authentication method
choice, browser ownership, code entry, logout, runtime actions, and system-to-managed eligibility
remain provider- and server-owned.

## Phase 4B runtime-source qualification

Phase 4 makes the renderer generic: if the server advertises managed installation beside a healthy
system runtime, Settings and Manage can present one compact `Use Scient-managed <provider>` action.
That renderer capability is not permission to advertise the action. The server remains the source of
truth, and each provider has a separate qualification result:

| Provider    | Result                         | Evidence and reason                                                                                                                                                                                                                                                                                                                                                 |
| ----------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Codex       | **Supported (code-confirmed)** | Codex keeps its bespoke capability-health selection, shadow-home binding, managed-health fallback, removal back to system, and external-versus-managed updater ownership. Existing state remains selected across the state-schema migration.                                                                                                                        |
| Claude      | **Supported (code-confirmed)** | The shared explicit-selection state keeps the system runtime active until verified activation, then reloads every default-runtime instance. Claude keeps the same account home and provider-owned credentials, suppresses native self-update only while managed is selected, preserves custom paths, and returns to the external runtime/update path after removal. |
| Antigravity | **Supported (code-confirmed)** | The shared selection and rollback contract applies to its reviewed native artifacts. The managed binary keeps Antigravity's existing Google account environment, managed catalog/update policy, subscription-only authentication scope, and custom-path authority; no credential migration or Gemini API-key behavior is introduced.                                |
| Grok        | **Supported (code-confirmed)** | The shared selection contract leaves the system runtime active through failure or cancellation and reuses Grok's existing account environment after activation. Browser/device-code behavior and the current manual-only external update policy remain provider-owned; removal re-probes the system runtime.                                                        |
| Droid       | **Supported (code-confirmed)** | The shared selection contract is independent of Droid's ACP authentication negotiation. The managed runtime uses the same provider account environment, retains API-key/pairing rules, disables provider self-update only while managed, preserves custom paths, and falls back through the provider-wide reload after removal.                                     |
| Cursor      | **Supported (code-confirmed)** | The reviewed archive/package contract, existing account home, browser-launch policy, and managed auto-update suppression remain unchanged. Explicit selection switches only default-runtime instances after verified activation; custom paths remain authoritative, and removal restores the system runtime and its native update capability when healthy.          |
| OpenCode    | **Intentionally unsupported**  | OpenCode has no Scient-managed runtime lifecycle or single account lifecycle. A managed-install project would require a separate product and provider qualification rather than renderer parity.                                                                                                                                                                    |

The five shared-runtime providers opt in explicitly at their server wrapper; the generic helper does
not infer permission from a provider name or artifact. The option remains unavailable for custom
paths, remote/read-only hosts, unsupported targets, and targets without a fully assisted reviewed
artifact. Unit and contract coverage prove the shared selection, rollback, package, environment, and
reload boundaries. Packaged-app qualification on every advertised operating-system/architecture row
remains a release gate rather than an assumption from local tests.

Legacy state is migrated conservatively. State schema v1 records only the last activated private
copy, so a healthy system runtime keeps today's priority. A successful install, update, or repair
writes schema v2 with an explicit managed selection in the same atomic state commit. Failure or
cancellation cannot write that selection. When no healthy system runtime exists, a legacy private
copy remains usable; users are never forced to reinstall merely because the schema changed.

## Phase 5 Antigravity migration outcome

Antigravity management now routes through the same explicit assisted host as the other supported
providers. The host owns the shared disabled-provider state, runtime maintenance section, transient
repair feedback, and capability-gated sign-out placement. The generic connection dialog contains no
Antigravity-specific state or rendering branches and remains the fallback for manual, unknown, and
future provider drivers.

This is a presentation migration, not a new shared authentication policy. Antigravity still owns its
Google subscription method, primary-versus-fallback browser behavior, returned authorization-code
delivery to the live PTY, fresh model verification, and bounded local credential cleanup when the
official logout cannot finish. An authenticated account without models remains an attention state,
not another sign-in prompt. The renderer infers no runtime action; the optional system-to-managed
handoff remains the explicit server capability qualified in Phase 4B.

## Shared invariants all assisted providers should satisfy

These are common guarantees, not requirements for every provider to display the same controls:

- Provider enablement, runtime, authentication, entitlement, and readiness remain independent facts.
- Disabling a provider preserves its runtime and credentials. A writable lifecycle surface
  offers an explicit Enable action without automatically installing, signing in, or opening a
  browser; remote and read-only surfaces fail closed with concise guidance.
- A disabled provider retains access to advertised managed repair/remove controls. Completing an
  install while disabled must lead to the Enable/account handoff rather than a blank or runtime-only
  surface.
- A healthy custom or system runtime is used without forcing a private installation.
- Scient mutates only its own managed runtime root. Repair and remove never target custom or system
  installations.
- Install, managed update, and repair keep the previous usable runtime until the replacement is
  verified and activated.
- Smoke-test success does not prove package completeness. Provider conformance must verify required
  companion executables and files before a managed runtime is selected; the expected contents remain
  explicit provider policy rather than a universal shared manifest.
- Remove deletes only Scient's private copy and preserves provider credentials.
- Sign-out revokes only provider-owned credentials and preserves the runtime.
- Every advertised runtime or connection operation is cancellable and publishes authoritative state.
- Runtime mutation and credential revocation stop affected sessions before changing executable or
  account state.
- Starting sign-in first refreshes provider state so an existing account does not enter another login
  flow unnecessarily.
- Successful login is followed by fresh-process verification where the provider permits it.
- Authentication does not imply subscription or model entitlement. An authenticated account with no
  usable models must not be presented as merely signed out.
- Runtime diagnostics are available behind a low-prominence disclosure when the server has truthful
  diagnostics to report, including recovery and signed-out states.
- T3's external update machinery remains authoritative for the active system or custom source. The
  reviewed managed update path remains authoritative for an active Scient-managed source.
- Account email and plan are optional presentation data. Show them when the supported provider probe
  returns them; never infer them from secrets or unsupported credential storage.
- Remote, read-only, manual-only, and unsupported environments fail closed without a broken managed
  action.

## Intentional provider-specific behavior

The following differences should not be normalized without new evidence:

- whether Scient or the provider opens the browser;
- whether an authorization URL is primary, fallback-only, or unavailable;
- whether a user copies a device code out of Scient or pastes a returned code into Scient;
- which login methods are meaningful, such as subscription, Console, browser, device pairing, or
  device code;
- whether the active CLI or ACP peer supports logout;
- how API keys, workload identity, custom endpoints, or cloud backends suppress assisted account
  controls;
- which environment variables may reach login and execution processes;
- how the provider verifies stored credentials and usable models;
- whether email or subscription tier is available;
- which targets have official reviewed artifacts;
- which companion executables and files define a complete provider package;
- which updater is safe for a detected external installation source; and
- whether switching from a healthy system runtime to Scient-managed has been explicitly qualified.

Shared infrastructure may carry these capabilities, but the provider adapter remains responsible for
declaring their truth.

## Behavior that should be removed or prevented

The following patterns are not valid lifecycle capabilities:

- inferring authorization-code entry, browser ownership, repair, removal, or account actions from a
  provider name when the server can publish the capability;
- hardcoding a provider name into otherwise shared runtime action presentation;
- showing a generic sign-out action for environment-controlled or unsupported authentication;
- repairing, updating, removing, or overwriting a custom or system installation through the managed
  runtime controls;
- adding a Scient-owned account-creation wizard when the official provider flow owns account creation;
- treating disabled as equivalent to not installed or signed out;
- requiring a writable client to leave the lifecycle surface solely to enable the provider;
- enabling a provider implicitly as a side effect of install, sign-in, or opening the lifecycle
  surface;
- treating authentication alone as proof of paid subscription or model access;
- treating transient operation success, such as a completed repair, as durable provider status;
- presenting one universal OpenCode account lifecycle over multiple unrelated upstream credential
  systems; or
- adding a common UI step only to make unlike provider flows look structurally identical.

## Open findings requiring further investigation

These findings are intentionally not accepted implementation requirements yet.

### 1. Removing an inactive Scient-managed copy

**Code-confirmed:** the generic runtime policy advertises repair and remove when the active source is
`scient_managed`. If a private copy still exists while a healthy system or custom runtime is active,
the private copy may not have a reachable removal action. Codex partially handles a system fallback,
but the policy and presentation are not consistent across providers or disconnected states.

**Question:** should every provider expose a low-prominence **Remove managed copy** action whenever
`managedVersion` proves a private copy exists, regardless of the active runtime source?

**Required qualification:** confirm that removal cannot change custom configuration, re-probes the
active runtime, preserves authentication, refreshes all affected instances, and remains reachable
while signed out. Repairing an inactive copy is a separate decision and should not be added merely for
symmetry.

### 2. Session-safe disconnect for Codex and Claude

**Code-confirmed:** Antigravity, Grok, Droid, and Cursor currently compose disconnect with adapter
session shutdown through the shared mechanical wrapper, while retaining provider-owned error wording
and logout behavior. Codex and Claude do not opt into that wrapper.

**Open question:** can Codex and Claude safely stop every affected session before revoking credentials
when one credential store may be shared by multiple provider instances or accounts? Do not infer that
behavior from the shared wrapper or add it for visual parity. First establish the credential-store and
session ownership boundary, then add provider-specific composition only if it can stop the complete
affected set. Focused tests must prove provider-specific failure mapping and that a failed shutdown
never revokes credentials while an affected session may remain active.

### 3. External update qualification for Grok and Droid

**Provider-documented:** Grok exposes `grok update` and `--check`. Droid documents different npm,
Homebrew, standalone, and direct-binary behavior and exposes `droid update` for applicable installs.
Scient currently declares both providers manual-only for external updates.

**Question:** can the existing T3 maintenance resolver safely identify the actual installation source
and choose the right updater without creating a second update system?

**Required qualification:** version discovery, package-manager versus native detection, command
allowlisting, session shutdown, cancellation, failure reporting, remote behavior, and restoration of
the correct update presentation when switching between system and Scient-managed sources.

### 4. Consistent diagnostics reachability

**Code-confirmed:** managed providers publish optional runtime diagnostics, but renderer reachability
can vary with authentication, active source, and the setup surface.

**Question:** can every runtime-backed provider expose the same low-prominence diagnostics disclosure
in Manage and recovery states without adding diagnostics to the fast composer path or fabricating data
for OpenCode?

### 5. Retiring the Antigravity rolling-compatibility fallback

**Code-confirmed:** the generic dialog now relies only on the explicit
`acceptsAuthorizationCode` capability. Antigravity's provider-specific renderer still accepts the
older server shape where that optional field is absent only for an active `antigravity_google`
operation with a primary authorization URL. An explicit `false` always suppresses code entry.

**Question:** after the supported client/server rolling window no longer includes that older shape,
can the Antigravity-local fallback be removed so absence also fails closed?

## Provider migration checklist

Before declaring a provider aligned with the shared lifecycle:

1. Refresh the exact implementation branch and relevant upstream T3 range.
2. Revalidate its row in this matrix against code, focused tests, and current official documentation.
3. Record runtime-source behavior for custom, system, Scient-managed, missing, and unsupported states.
4. Verify disabled-without-runtime and disabled-with-runtime states, direct Enable where writable,
   read-only behavior, post-install handoff, and managed maintenance while disabled.
5. Exercise every advertised login method, browser owner, device or returned-code path, cancellation,
   fresh-process verification, and sign-out.
6. Exercise authenticated-but-unentitled or no-model behavior where the provider permits it.
7. Verify managed install, provider-specific package completeness, failed/cancelled install, repair,
   update, removal, restart recovery, and multiple instances on each advertised target.
8. Verify the inherited external update path for every supported installation source.
9. Qualify the optional system-to-managed switch separately: capability advertisement, compact
   presentation, system/custom preservation, failure/cancel behavior, account reuse, multi-instance
   reload, managed removal/fallback, update ownership, and platform support. Record an explicit reason
   when the capability remains unavailable.
10. Confirm Settings and composer preserve the fastest safe path, share proven visual/interaction
    structure, and render only server-advertised capabilities.
11. Run the final cross-provider visual and interaction audit in both surfaces without forcing
    provider-specific authentication semantics into shared UI.
12. Classify every discovered difference before changing it. Do not turn an open finding into shared
    infrastructure without evidence that its truth and failure model are actually shared.
13. Update this audit, the proposal if a decision changes, and the canonical lifecycle documentation
    in the same implementation PR.

## Initial recommendation

The current architecture direction remains sound: share runtime mechanics, coordination, canonical
state, and presentation structure while keeping provider authentication and exceptional behavior
local. The highest-value questions to resolve during implementation are inactive managed-copy
removal, Codex/Claude session-safe disconnect, Grok/Droid external update qualification, and
diagnostics reachability.

The accepted presentation work remains narrow and evidence-backed: Phase 4 established one shared
disabled-provider/Enable handoff, normalized Settings entry and runtime-source actions, and qualified
system-to-managed switching provider by provider. Phase 5 moved Antigravity onto that foundation
without changing its authentication policy. The final pass should audit Settings and composer
together for residual routing, spacing, copy, action hierarchy, and capability inconsistencies rather
than create another abstraction layer.

Do not otherwise pursue button-for-button parity. Codex and Claude alternative account methods,
Antigravity's subscription-only scope, Grok's conditional code path, Droid's ACP-negotiated actions,
Cursor's browser handling, OpenCode's multi-provider model, optional account metadata, and platform
artifact differences all have legitimate reasons to remain distinct unless stronger evidence changes
that conclusion.

## Primary references

### Scient implementation

- `packages/contracts/src/providerLifecycle.ts`
- `apps/server/src/scient/providerLifecycle/ProviderConnectionManager.ts`
- `apps/server/src/scient/providerLifecycle/ProviderRuntimeManager.ts`
- `apps/server/src/scient/providerLifecycle/ManagedProviderRuntimeActions.ts`
- `apps/server/src/scient/providerLifecycle/CodexManagedRuntimeActions.ts`
- `apps/server/src/provider/providerMaintenance.ts`
- `apps/web/src/scient/providerConnection/ProviderConnectionDialog.tsx`
- `apps/web/src/scient/providerConnection/ProviderRuntimeSection.tsx`

### Official provider documentation

- [Codex authentication](https://developers.openai.com/codex/auth)
- [Claude CLI reference](https://docs.anthropic.com/en/docs/claude-code/cli-usage)
- [Antigravity CLI installation](https://antigravity.google/docs/cli/install/)
- [Grok CLI reference](https://docs.x.ai/build/cli/reference)
- [Droid CLI reference](https://docs.factory.ai/droid-cli/cli-reference)
- [Cursor CLI authentication](https://docs.cursor.com/en/cli/reference/authentication)
- [OpenCode providers](https://opencode.ai/docs/providers/)
- [OpenCode server](https://dev.opencode.ai/docs/server/)
