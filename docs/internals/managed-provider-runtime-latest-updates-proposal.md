# Managed Provider Runtime Latest-Release and Safe-Fallback Proposal

Status: implementation proposal; no implementation has started.

This document records the intended direction for review and implementation. It is not canonical
documentation for shipped behavior. Every decision must be revalidated against the code, provider
release format, and test evidence while it is implemented. If evidence shows that a decision is
unsafe, unnecessarily complex, or incompatible with a provider, update this proposal before
continuing.

## Objective

Give users the newest eligible provider runtime when they install or update a Scient-managed
provider, while retaining a known-good version bundled with Scient for repair and fallback.

The result should:

- preserve the existing system/custom provider update behavior inherited from T3;
- reuse Scient's current staged, verified, atomic managed-runtime transaction;
- keep the current working runtime active until its replacement has passed every required check;
- avoid a second updater, provider registry, credential store, or UI state machine;
- remain usable offline and when provider release metadata is temporarily unavailable;
- keep provider-specific packaging and compatibility policy at the provider boundary;
- avoid automatic downgrades from an older Scient build; and
- require no Scient-hosted service in the first implementation.

## Primary decision

Do not run provider self-updaters against Scient's active private executable.

Instead, add a small latest-artifact resolution layer that produces the existing immutable
`ManagedRuntimeArtifact`. Feed that artifact into the existing managed-runtime transaction:

```text
Resolve exact candidate
        ↓
Download into private staging
        ↓
Verify host, size, digest, archive, and package completeness
        ↓
Run the provider-specific compatibility check
        ↓
Atomically activate
        ↓
Reload and publish provider state
```

The current transaction already owns downloading, staging, verification, extraction safety, smoke
testing, cancellation, atomic state replacement, and cleanup. Artifact selection and stronger
pre-activation qualification are the missing pieces.

## Meaning of "latest"

The product promise should be **latest eligible release**, not blindly newest.

A release is eligible only when it:

1. belongs to the provider's normal production channel rather than an alpha or preview channel;
2. supports the current operating-system and architecture target;
3. can be acquired from a provider-authoritative source with an acceptable integrity contract;
4. contains every executable and companion file Scient depends upon; and
5. passes the provider-specific deterministic compatibility check before activation.

If a provider cannot currently satisfy these conditions, keep using the latest version that Scient
can honestly describe as reviewed. Do not weaken the shared installation guarantee to force
artificial parity.

## User-visible lifecycle semantics

| Action          | Candidate                                           | Failure behavior                                                                          |
| --------------- | --------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| First Install   | Latest eligible official release                    | Try the bundled reviewed release once if the latest candidate is unavailable or rejected. |
| Update          | Latest eligible release, only when strictly newer   | Keep the currently active runtime unchanged.                                              |
| Repair          | The reviewed release bundled with this Scient build | Keep the currently active runtime unchanged if repair fails.                              |
| Remove          | Existing managed-runtime removal                    | Leave system/custom installations and provider credentials untouched.                     |
| Offline startup | Current active runtime                              | Continue normally; do not manufacture an update warning.                                  |

Additional rules:

- Cancellation never starts a fallback attempt.
- Latest and bundled resolving to the same artifact must produce only one installation attempt.
- A transient catalog failure must not degrade an otherwise ready provider.
- An older Scient build must never offer Update merely because its bundled version is different.
- Repair may deliberately install an older bundled version, but only after showing the exact target
  version to the user.
- Provider authentication, entitlement, and network failures are not runtime incompatibility and
  must not trigger executable replacement or rollback.

## Architecture

### 1. Provider-owned release policy

Replace the single static artifact input to managed runtime actions with a small policy:

```ts
interface ManagedRuntimeReleasePolicy {
  readonly bundledArtifact: ManagedRuntimeArtifact | undefined;

  readonly resolveLatestArtifact: (
    target: ManagedRuntimeTarget,
  ) => Effect.Effect<ManagedRuntimeArtifact | undefined, ManagedRuntimeCatalogError>;

  readonly compareVersions: (
    current: string,
    candidate: string,
  ) => "older" | "equal" | "newer" | "unknown";

  readonly qualifyStagedCandidate: (
    candidate: StagedManagedRuntimeCandidate,
  ) => Effect.Effect<void, ManagedRuntimeCompatibilityError>;
}
```

The exact names may change during implementation, but the boundary should remain this small.

Shared code owns mechanical safety. Provider code owns release interpretation, version syntax,
package layout, protocol expectations, environment policy, and supported targets.

Codex may continue using its bespoke managed-runtime action wrapper where its package-health behavior
requires it. It should consume the same release-selection and qualification mechanics without being
forced into a generic abstraction that loses Codex-specific guarantees.

### 2. Scoped managed-runtime catalog

Add one server-scoped `ManagedRuntimeCatalog` service. It should:

- fetch only provider-authoritative metadata;
- use a short bounded timeout;
- cache successful and unavailable results in memory for about one hour;
- validate schemas, targets, immutable URLs, allowed hosts, size, and digest;
- return `undefined` when no eligible release exists for the current target;
- fail softly during passive provider refresh;
- refresh deliberately when planning a user-requested Install or Update; and
- produce a stable `catalogRevision` containing provider, version, target, and digest identity.

The service is not a second provider registry. It does not own provider state, credentials, models,
or sessions. It only resolves an exact artifact candidate.

The frontend must never receive download URLs, checksums, or mutable catalog internals. It only needs
the current version, the available version, and the advertised action.

### 3. Staged compatibility hook

Extend `ManagedProviderRuntime.install()` with one optional `qualifyStagedCandidate` callback. Invoke
it after existing materialization and smoke checks, but before activation.

The callback receives only the staged payload and the exact artifact. It must be bounded and
cancellable. If it fails, the candidate remains staging data and the active runtime is untouched.

The check must:

- avoid provider login and logout;
- avoid real prompts, model requests, and paid inference;
- avoid opening a browser;
- avoid writing to the user's real provider configuration or credential store;
- use an isolated temporary home when possible;
- bound output, execution time, and child-process cleanup; and
- exercise the local protocol surface Scient actually depends upon.

No general post-activation rollback engine is required for the first implementation. The update is
qualified through the real local integration path before activation, and the existing active version
is retained until that point. An unexpected later incompatibility remains recoverable through the
bundled Repair action.

### 4. Strict version policy

Replace `installedVersion !== artifact.version` with provider-aware strict comparison.

Update is available only when the candidate is provably newer. Equal, older, malformed, or
uncomparable values must fail closed.

- Codex, Claude, Antigravity, Droid, and Grok use strict semantic-version comparison after their
  provider-specific normalization.
- Cursor keeps a provider-specific date/build comparator.

This prevents an older Scient build from downgrading a newer active managed runtime.

### 5. Runtime summary

Add one nullable presentation field to `ProviderRuntimeSummary`:

```ts
availableManagedVersion: string | null;
```

`runtime.actions` remains the capability authority. A managed update candidate exists only when:

```text
runtime.actions includes "update"
and availableManagedVersion is not null
```

This avoids overloading the external package-manager advisory with managed-runtime state.

## Detailed flows

### Passive startup and refresh

1. Read the selected managed-runtime state.
2. Continue launching the currently active executable.
3. Resolve latest metadata asynchronously through the bounded cache.
4. If resolution succeeds and the candidate is strictly newer, advertise Update.
5. If resolution is unavailable, keep the provider ready and omit the update action.

The provider's readiness path must not become dependent upon its release service being online.

### First managed install

1. Resolve the latest eligible candidate.
2. If resolution is unavailable, select the bundled artifact immediately.
3. Plan the exact version, size, source label, and catalog revision.
4. Revalidate the catalog revision at execution time.
5. Run the existing staged installation with provider qualification.
6. If the latest candidate fails and the operation was not cancelled, attempt the different bundled
   artifact once.
7. Publish the actual installed version and whether fallback was used.

Fallback is bounded to one attempt. It does not loop and does not try multiple historical versions.

### Managed update

1. Advertise Update only for a strictly newer eligible release.
2. Plan and pin its exact artifact revision.
3. Stage, verify, qualify, and activate through the existing transaction.
4. If any candidate step fails, report that the update failed and that the old version remains
   active.

Do not install the bundled fallback after an Update failure. The current active runtime is already
the better fallback and should not be replaced.

### Repair

Repair always selects the artifact bundled with the current Scient build. It does not resolve latest
and is therefore available even when release metadata is offline or malformed.

The confirmation displays the exact bundled version. The operation downloads a fresh copy, verifies
and qualifies it, and atomically activates it. If repair fails, the previous active runtime remains.

### App update

Updating Scient does not force a provider update.

1. The previously active managed runtime remains selected and launchable.
2. The new Scient build contributes a newer or different bundled Repair fallback.
3. Latest-release discovery runs asynchronously.
4. A newer eligible provider release appears as Update.
5. The user chooses when to update.

### System and custom installations

No behavior changes:

- T3's existing version advisory, update notification, and `server.updateProvider` execution remain
  authoritative for external/system installations.
- Custom executable paths remain authoritative and are never overwritten.
- **Use Scient-managed** remains an explicit user action alongside a healthy system installation.
- Removing the managed copy re-probes and restores the system runtime and its external updater when
  healthy.

## Provider-specific release and qualification policy

### Codex

Release source:

- OpenAI's official Codex release-channel metadata:
  <https://releases.openai.com/codex/channels/latest>
- Select the complete platform package and its published SHA-256 digest.
- Do not install the standalone binary when the complete package is required.

Qualification:

- validate every required regular executable companion, including `codex-code-mode-host`;
- run the existing version smoke test; and
- initialize Codex app-server through the same local protocol Scient uses.

### Claude

Release source:

- Anthropic's official latest endpoint and immutable per-version manifest;
- validate the per-platform SHA-256 value described in
  <https://code.claude.com/docs/en/installation>.

Qualification:

- run native executable/package validation;
- exercise the no-prompt initialization path Scient depends upon; and
- keep subscription, Console, API-key, Bedrock, Vertex, Foundry, and custom-endpoint ownership
  distinctions unchanged.

### Antigravity

Release source:

- Google's official Antigravity release manifest used by the platform installers documented at
  <https://antigravity.google/docs/cli/install/>;
- validate the provider-published SHA-512 value.

Qualification:

- verify the local flags and process behavior used by Scient's bridge;
- include model, effort, conversation, print timeout, and permission-policy flags;
- do not perform model discovery, authentication, or a real turn.

The Google subscription flow remains distinct from Gemini API-key/custom-endpoint configuration.

### Droid

Release source:

- resolve the normal production release;
- use Factory's immutable direct binary layout and `.sha256` sidecar documented at
  <https://docs.factory.ai/droid-cli/cli-reference>.

Qualification:

- retain Droid's provider-specific target and environment rules;
- initialize its local JSON-RPC/ACP-compatible execution path without signing in or sending a turn.

### Grok

Preferred release source:

- official package metadata with registry integrity rather than executing a mutable installer script;
- use only the stable production channel described in
  <https://docs.x.ai/build/cli/reference>.

Qualification:

- materialize the exact native package;
- initialize `grok agent stdio` without browser authentication.

This requires a bounded packaging spike before dynamic latest is enabled. If the official package
cannot be materialized without weakening integrity guarantees, leave Grok on its bundled reviewed
artifact and record the reason. Do not block the other providers on this exception.

### Cursor

Cursor documents automatic and manual updates at
<https://docs.cursor.com/en/cli/installation>, but its public installer currently does not expose an
independent checksum catalog comparable to the other providers.

Initial policy:

- keep Scient-managed Cursor on the latest reviewed artifact shipped through the scheduled manifest
  workflow;
- keep Cursor's updater authoritative for system-installed Cursor;
- do not describe a mutable installer acquisition as independently verified; and
- evaluate a staged official-installer acquisition only as a separate Cursor-specific proposal.

This is an intentional provider exception, not a reason to weaken the shared contract.

## Shared update notification

Reuse the existing provider update notification, sidebar indication, dismissal behavior, Settings
entry point, and multi-environment presentation.

Normalize two internal candidate kinds:

```ts
type ProviderUpdateCandidate =
  | {
      readonly kind: "external";
      readonly provider: ServerProvider;
      readonly availableVersion: string;
    }
  | {
      readonly kind: "managed";
      readonly provider: ServerProvider;
      readonly availableVersion: string;
    };
```

Execution remains deliberately different:

- external candidate: existing `server.updateProvider` and maintenance runner;
- managed candidate: existing `planProviderRuntime("update")` and `startProviderRuntime` path.

The candidate key must include environment, provider, candidate kind, and available version so
dismissal never suppresses a different update.

The UI should remain concise:

- show **Update** instead of **Manage** while a safe update is advertised;
- use the compact action style already used by provider lifecycle controls;
- do not introduce a second wizard or redundant review card;
- show **Manage** normally when no update is available; and
- keep all current sign-in, repair, remove, sign-out, and enable behavior unchanged.

Suggested terminal messages:

- fallback install: `Antigravity 1.1.20 installed. The newest release could not be verified, so Scient used its reviewed version.`
- failed update: `Update failed. Antigravity 1.1.20 remains active.`
- successful repair: `Antigravity was repaired successfully.`

## Daily manifest workflow

Run the workflow every day at 16:00 in `Asia/Jerusalem` without depending on a maintainer computer.

GitHub cron is UTC and does not follow daylight-saving transitions. Schedule both 13:00 and 14:00
UTC, then continue only when the current `Asia/Jerusalem` local hour is 16.

Workflow responsibilities:

1. Discover production releases from official provider sources.
2. Regenerate exact bundled fallback manifests.
3. Run schema/parser and integrity tests.
4. Download and qualify changed candidates on supported GitHub-hosted runner platforms.
5. Open a PR only when generated files changed and qualification passed.
6. Never auto-merge.

Security and permission boundaries:

- discovery and qualification jobs receive no repository-writing token or production credentials;
- candidate processes receive no repository secrets;
- a separate final job receives the minimum permission needed to create or update the PR;
- concurrency prevents duplicate update PRs; and
- a no-change run exits successfully without opening a PR.

The workflow keeps the bundled Repair fallback fresh and is initially the only managed latest source
for Cursor. For dynamically resolved providers it is an early-warning and release-fallback mechanism,
not a prerequisite for users to discover updates.

## Failure handling

### Release service unavailable

- Passive refresh: no update action; current runtime remains ready.
- First install: use bundled fallback.
- Explicit update: report that update information is unavailable; do not touch the active runtime.
- Repair: unaffected.

### Malformed or incomplete release

Fail closed. Do not infer missing URLs, sizes, digests, package paths, or target support.

### Download, checksum, extraction, or qualification failure

- First install from latest: try the different bundled fallback once.
- Update: preserve the active runtime.
- Repair: preserve the active runtime.

### Cancellation

Stop immediately, clean staging, and do not start fallback.

### Activation-state failure

Use the existing atomic state-write rollback. The previous active state and executable must remain
usable.

### Authentication, entitlement, or provider outage

Do not classify these as runtime incompatibility. Do not replace or roll back the executable.

## Required tests

### Managed runtime transaction

- Candidate cannot become active before all generic and provider-specific checks pass.
- Failed download, digest, extraction, package completeness, or qualification preserves active state.
- Activation-state failure restores the previous destination and state.
- Staging cleanup does not remove active or previous runtime directories.
- Cancellation cleans up and never invokes fallback.
- First-install fallback runs no more than once.
- Latest equal to bundled produces one download.

### Catalog and planning

- Valid official metadata fixtures for every supported provider and target.
- Malformed schema, unsupported target, missing artifact, bad digest, and bad size.
- Unapproved host and redirect rejection.
- Timeout and partially published release behavior.
- Stable cache behavior and explicit refresh.
- Catalog revision mismatch prevents stale execution.
- Strictly newer, equal, older, malformed, and unknown version comparisons.
- An older Scient build never advertises downgrade as Update.

### Provider qualification

- Browser opener is blocked.
- Real provider home and credential files remain untouched.
- No account login, logout, model request, or inference occurs.
- Timeout and output bounds are enforced.
- Child processes are interrupted and reaped.
- Required companions and actual local protocol startup are covered.

### Actions and fallback

- First latest install success.
- Catalog unavailable to bundled fallback.
- Latest candidate rejection to bundled fallback.
- Failed fallback reports the real terminal error.
- Update failure keeps the old active version.
- Repair always selects bundled artifact.
- Remove and system fallback remain unchanged.
- Default-runtime instances reload together; custom paths remain untouched.

### Frontend and routing

- Managed and external candidates share presentation but route to different backends.
- Managed update never invokes an external package-manager command.
- External provider update behavior remains unchanged.
- Version-specific dismissal and multi-environment grouping remain correct.
- Offline catalog resolution produces no false warning.
- Settings, composer lifecycle surfaces, sidebar, and launch toast agree on the advertised action.

### Workflow

- Jerusalem timezone guard.
- No-change run.
- Changed release generation.
- Failed qualification prevents PR creation.
- Minimal permission boundaries.
- Concurrent runs do not create duplicate PRs.

## Delivery sequence

Use bounded pull requests targeting `main`. If one implementation step genuinely depends on an
unmerged predecessor, stack it temporarily and retarget it to `main` after the predecessor lands.

### PR A: release-selection foundation

- shared release-policy contract;
- scoped catalog cache and bounded fetch;
- strict version comparison;
- staged qualification hook;
- `availableManagedVersion` contract;
- install/update/repair candidate-selection and fallback tests.

No provider should switch to dynamic latest solely because this foundation exists.

### PR B: provider resolvers and qualification

- Codex and Claude first because they have strong release metadata;
- Antigravity and Droid next;
- Grok only after its package-integrity spike passes;
- Cursor remains explicitly bundled-only.

Each provider is enabled independently after its resolver and qualification suite is complete.

### PR C: shared update presentation and routing

- normalize managed and external candidates;
- route each kind to its existing backend;
- preserve notification, sidebar, Settings, multi-environment, and dismissal behavior;
- no general provider-card redesign.

This PR requires targeted visual/manual review because it changes an existing visible update action.

### PR D: scheduled fallback refresh and documentation

- daily 16:00 Jerusalem workflow;
- generated bundled manifests;
- platform qualification jobs;
- least-privilege PR creation;
- canonical lifecycle documentation and provider-specific rationale.

## Manual review checklist

- Missing runtime installs latest eligible version.
- Failed latest first-install clearly falls back to bundled reviewed version.
- Managed update keeps the old version usable until completion.
- Failed update leaves the provider ready on the old version.
- Repair uses the displayed bundled version and reports success.
- System provider continues using inherited external update behavior.
- Healthy system provider can still explicitly switch to Scient-managed.
- Removing managed runtime restores the healthy system runtime and its updater.
- Offline mode creates no blocking or misleading update state.
- Custom executable paths remain untouched.
- Provider sign-in, sign-out, returned-code, device-code, and API-key distinctions remain unchanged.

## Explicit non-goals

- No automatic unattended provider installation.
- No Scient-hosted release service in this phase.
- No generic credential or authentication abstraction.
- No attempt to make OpenCode a single managed provider runtime.
- No execution of arbitrary remote installer scripts as a shared mechanism.
- No multi-version picker or manual rollback UI.
- No central approval guarantee for releases published after the installed Scient build ships.
- No UI redesign beyond integrating managed candidates into the existing update presentation.

## Known trade-off without a Scient-hosted catalog

An app released today cannot centrally approve or deny a provider version published tomorrow. The
local deterministic compatibility check is therefore the immediate safety gate for dynamically
resolved providers.

This trade-off is acceptable for the first implementation because:

- activation occurs only after local verification and real protocol qualification;
- update failure preserves the active runtime;
- first install has a bundled fallback;
- Repair restores the shipped reviewed version; and
- the daily workflow gives maintainers early warning and keeps the fallback current.

If central approval becomes necessary later, `resolveLatestArtifact` can consume a signed
Scient-hosted catalog without changing the installation transaction, runtime state, provider UI, or
action contracts.

## Acceptance criteria

The implementation is complete only when:

1. every dynamically enabled provider has an authoritative release resolver and deterministic
   staged qualification;
2. unsupported or unverifiable providers fail closed without losing their current managed behavior;
3. first install, update, repair, remove, cancellation, offline behavior, and system fallback are
   covered by focused tests;
4. system/custom update behavior remains unchanged;
5. managed updates appear through the existing concise update presentation and execute through the
   managed runtime manager;
6. the daily workflow is permission-minimal, no-op safe, and opens reviewable PRs rather than merging;
7. canonical internal and user documentation explains what is shared, what is provider-specific,
   and why; and
8. manual cross-provider review confirms the visible lifecycle remains fast, simple, and truthful.
