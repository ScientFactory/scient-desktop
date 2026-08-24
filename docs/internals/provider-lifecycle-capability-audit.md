# Provider Lifecycle Capability Audit

> Status: pre-implementation investigation, last refreshed 2026-08-24.
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

The initial audit was performed against Scient `main` at:

```text
dc07474af931877d4b94747d241df6c2af7d35c4
```

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
2. **Runtime acquisition:** reviewed plan, download, checksum verification, extraction, staging, smoke
   test, activation, cancellation, and recovery.
3. **Runtime maintenance:** managed update, repair, removal, and the inherited T3 update path for an
   external installation.
4. **Authentication:** available methods, browser owner, URL recovery, device code, optional returned
   code, cancellation, verification, and sign-out.
5. **Entitlement and readiness:** authenticated account, subscription or billing mode, available
   models, and actual ability to start a session.
6. **Presentation:** concise capability-driven actions, optional diagnostics, truthful account
   metadata, and no additional step unless safety or a real choice requires one.

## Current provider matrix

The table describes the currently inspected architecture. Managed actions remain conditional on a
reviewed artifact, local desktop mode, and a supported target.

| Provider | Runtime lifecycle | Assisted account flow | Sign-out behavior | External/system update | Current classification |
| --- | --- | --- | --- | --- | --- |
| Codex | Custom, system, and Scient-managed. Install, managed update, repair, and private removal. It can also offer a secondary switch from a healthy system runtime to Scient-managed. | ChatGPT browser or device-code login through Codex app-server. Device code is copied from Scient to the provider page; it is not a code pasted back into Scient. | Available for interactive ChatGPT account authentication. Hidden when Codex reports that OpenAI authentication is not required, including API-key or workload-controlled configurations. | Existing package-manager-aware T3 updater. | The system-to-managed capability is valid but must remain explicitly advertised and provider-qualified. |
| Claude | Custom, system, and Scient-managed. Install, managed update, repair, and private removal. | Claude subscription or Anthropic Console login. The provider-owned flow may accept a returned one-time code. | Available for Claude-owned credentials. Hidden when API key, Bedrock, Vertex, Foundry, or equivalent external configuration owns authentication. | Existing package-manager-aware updater plus the qualified native `claude update` path. | Subscription versus Console, provider browser ownership, and optional returned-code handling are intentional differences. |
| Antigravity | Custom, system, and Scient-managed. Install, managed update, repair, and private removal. | Google subscription login. The live process may support browser completion or a returned authorization code. Scient intentionally does not turn this into Gemini API-key setup. | Provider logout followed by verification, with a bounded local credential-store fallback where the official logout is insufficient. | Scient-managed updates use the reviewed catalog. External installations are currently manual-only in Scient. | Subscription-only product scope and returned-code behavior are provider-specific. The renderer must rely on the live operation rather than infer code entry from the provider name. |
| Grok | Custom, system, and Scient-managed. Install, managed update, repair, and private removal. | Normal browser login or an explicit device-code path. A pasted-code input is valid only when the exact live ACP operation advertises it. | Available for Grok-owned account credentials. It must not pretend to clear an environment-provided API key. | Currently manual-only in Scient. Official documentation exposes `grok update` and `grok update --check`. | The authentication alternatives are intentional. External update support is an open qualification gap, not permission to run the native updater blindly. |
| Droid | Custom, system, and Scient-managed. Install, managed update, repair, and private removal. | ACP device pairing only when the exact initialized peer advertises the capability and an external Factory API key is not controlling authentication. The provider may open a browser without exposing a URL to Scient. | Available only when the exact ACP peer advertises logout. It is hidden for externally supplied API-key configuration. | Currently manual-only in Scient. Official documentation distinguishes npm, Homebrew, standalone, and direct-binary installations and exposes `droid update` for applicable installs. | ACP capability negotiation and conditional logout are intentional. External update support requires installation-source-aware qualification. |
| Cursor | Custom, system, and Scient-managed. Install, managed update, repair, and private removal. | Browser login. Scient captures and validates the provider URL while preventing duplicate browser launches. There is no generic pasted-code step. | Available for Cursor-owned credentials and hidden when API endpoint, API key, or token configuration owns authentication. | Existing native `cursor-agent update` path. | Its no-browser launch mode and login environment are provider-specific reliability and security policy. |
| OpenCode | System, custom, or remote runtime use. No Scient-managed runtime lifecycle is currently advertised. | No single account flow: OpenCode manages credentials for many upstream LLM providers using different API-key, OAuth, environment, and local-model configurations. | A universal OpenCode sign-out would be misleading because there is no single upstream account to revoke. | Existing package-manager-aware and native `opencode upgrade` paths. | Keep manual/provider-specific management unless a separate multi-provider OpenCode connection project proves a truthful design. Managed local installation is a possible future capability, not a parity requirement. |

## Shared invariants all assisted providers should satisfy

These are common guarantees, not requirements for every provider to display the same controls:

- Runtime, authentication, entitlement, and readiness remain independent facts.
- A healthy custom or system runtime is used without forcing a private installation.
- Scient mutates only its own managed runtime root. Repair and remove never target custom or system
  installations.
- Install, managed update, and repair keep the previous usable runtime until the replacement is
  verified and activated.
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
session shutdown. Codex and Claude do not use the same composition.

**Current proposal direction:** add one small shared stop-sessions-before-disconnect wrapper and
migrate providers under focused tests. Revalidate provider-specific failure mapping and make sure a
failed shutdown does not revoke credentials under an active session.

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

### 5. Removing authorization-code inference

**Code-confirmed:** the connection operation now publishes whether it accepts an authorization code,
but Antigravity renderer compatibility paths can still infer code entry from method and URL kind when
that field is absent.

**Question:** after checking client/server rolling compatibility, can the renderer fail closed when the
capability is absent and remove every provider-name fallback?

## Provider migration checklist

Before declaring a provider aligned with the shared lifecycle:

1. Refresh the exact implementation branch and relevant upstream T3 range.
2. Revalidate its row in this matrix against code, focused tests, and current official documentation.
3. Record runtime-source behavior for custom, system, Scient-managed, missing, and unsupported states.
4. Exercise every advertised login method, browser owner, device or returned-code path, cancellation,
   fresh-process verification, and sign-out.
5. Exercise authenticated-but-unentitled or no-model behavior where the provider permits it.
6. Verify managed install, failed/cancelled install, repair, update, removal, restart recovery, and
   multiple instances on each advertised target.
7. Verify the inherited external update path for every supported installation source.
8. Confirm Settings and composer preserve the fastest safe path and render only server-advertised
   capabilities.
9. Classify every discovered difference before changing it. Do not turn an open finding into shared
   infrastructure without evidence that its truth and failure model are actually shared.
10. Update this audit, the proposal if a decision changes, and the canonical lifecycle documentation
    in the same implementation PR.

## Initial recommendation

The current architecture direction remains sound: share runtime mechanics, coordination, canonical
state, and presentation structure while keeping provider authentication and exceptional behavior
local. The highest-value questions to resolve during implementation are inactive managed-copy
removal, Codex/Claude session-safe disconnect, Grok/Droid external update qualification, and
diagnostics reachability.

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
