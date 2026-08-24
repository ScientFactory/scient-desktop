# Provider Lifecycle Unification Proposal

> Status: shared architecture proposal only. No implementation has started.
> This is a living proposal, not a fixed implementation mandate. Every decision must be re-evaluated
> against the code, tests, provider behavior, platform evidence, and user experience during
> implementation. Update this document whenever evidence shows that a decision should change.

## Executive summary

Scient should keep its current provider lifecycle foundation and improve it incrementally. The
right target is not one universal provider implementation. It is one dependable shared lifecycle
platform with small, truthful provider-specific adapters.

The shared platform should own:

- managed runtime download, verification, extraction, smoke testing, activation, repair, removal,
  cancellation, and recovery;
- operation serialization and publication;
- process/scope cleanup;
- the frontend lifecycle controller and common setup host;
- common visual structure and capability-driven actions; and
- canonical lifecycle state derived from the server snapshot.

Each provider must continue to own:

- its authentication protocol and commands;
- whether the provider or Scient opens the browser;
- device-code and pasted-code behavior;
- login verification and logout;
- credential persistence and revocation;
- subscription or entitlement interpretation;
- model discovery;
- artifact metadata and provider-specific environment policy; and
- provider-specific UX copy and exceptional recovery steps.

This direction makes the system easier to reason about, safer to change, more consistent for users,
and less likely to conflict with future T3 updates.

## Current baseline

This proposal starts from Scient `main` at:

```text
dc07474af931877d4b94747d241df6c2af7d35c4
```

The worktree was created from that exact commit. At investigation time, a fresh fetch placed
official T3 `upstream/main` at:

```text
b60a2c0b99c8d5d8f02b6705171da694d12e77e3
```

That tip is eleven commits beyond Scient's currently recorded integration base
`b1670ac7d9b5b7bb9d7ebd969f27384daee22813`. The pending range modifies more provider-adjacent
surface than `ChatComposer.tsx` alone, including `ProviderInstanceIcon.tsx`, `SettingsPanels.tsx`,
`settingsSearch.ts`, `usageProviders.ts`, `session-logic.ts`, and `packages/contracts/src/settings.ts`.

Therefore, the bounded upstream synchronization should be reviewed and landed independently before
provider lifecycle refactoring begins. Provider architecture changes must not be mixed into the T3
merge.

## Collaboration and delivery workflow

This proposal has a shared remote planning branch, `feat/provider-lifecycle-unification`. The branch
and its draft pull request are the review and coordination home for the proposal. They are not a
long-lived integration branch for accumulating implementation.

### Planning phase

- The shared branch contains this proposal and planning-only changes while the architecture is under
  review.
- Collaborators should make substantive proposal changes on short-lived branches and open focused
  pull requests against `feat/provider-lifecycle-unification`. Direct edits should be limited to small,
  coordinated corrections.
- Do not add product implementation, generated artifacts, local runtime state, credentials, or
  machine-specific files to the planning branch.
- Do not force-push the published planning branch. Preserve review history and coordinate any history
  repair explicitly.
- Use the draft pull request to `main` for architecture discussion, ownership, sequencing, and open
  decisions. Acceptance of the proposal is a review gate, not evidence that any product behavior has
  been implemented or qualified.
- Once the proposal is accepted, merge it as a documentation-only change so implementation branches
  can update the same living document from `main`.

### Implementation phase

- The bounded T3 synchronization remains a separate prerequisite branch and pull request to `main`.
  It must not be based on, or mixed with, lifecycle implementation.
- After that prerequisite lands, create every lifecycle PR from the latest verified `main`. Use one
  short-lived branch with one clear owner and one dominant purpose for each stage below.
- Implementation pull requests target `main`, not the planning branch. If a change genuinely depends
  on an unmerged predecessor, it may be stacked temporarily, but must be rebased or retargeted after
  the predecessor lands and reviewed against the resulting `main` diff.
- Collaborators must not share one mutable checkout or push unrelated work into another owner's
  implementation branch. Coordinate through branch ownership, draft pull requests, and explicit
  dependency notes.
- No implementation PR may silently reinterpret this proposal. When evidence changes an architectural
  decision, update this document and the relevant canonical internal documentation in the same PR,
  recording the reason, affected providers, compatibility impact, and validation required.

### Review and merge discipline

Each pull request must be checked against its exact current base and should remain independently
reviewable and reversible. Green CI alone is not a merge decision. The relevant gate includes:

- a focused diff with no unrelated cleanup;
- preservation of the T3-owned seams and provider-specific behavior described here;
- the automated contract, provider, and compatibility tests appropriate to the change;
- isolated real-app validation for affected user-visible lifecycle paths;
- platform qualification when runtime packaging or process behavior changes; and
- synchronized architecture, provider-matrix, and user documentation.

This workflow is deliberately lightweight: one shared proposal and review hub, followed by small
branches and focused PRs. It allows several collaborators to contribute without turning the work into
one conflict-heavy integration branch.

## First principles

### 1. Share behavior only when its truth and failure model are the same

Downloading a pinned artifact, verifying it, staging it, smoke testing it, and atomically activating
it is the same problem for multiple providers. It belongs in one shared implementation.

Starting Codex app-server login, supervising Claude Code's browser callback, running Antigravity in a
PTY, and performing ACP device pairing are not the same problem. They should remain separate,
provider-owned adapters.

### 2. The server and provider are authoritative

A button click does not prove that installation or authentication succeeded. The server must publish
the operation, supervise it, refresh the provider, and derive the resulting state from the actual
runtime and provider probe.

Renderer-local state may bridge publication latency, but it must never become durable provider truth.

### 3. Runtime, authentication, entitlement, and readiness are independent

- A runtime may be installed while no account is connected.
- An account may remain connected after Scient's managed runtime is removed.
- A user may be authenticated but lack subscription or model entitlement.
- A provider may require no interactive account at all.

The lifecycle must never collapse these facts into one generic `connected` flag.

### 4. Every destructive or replacement operation must be recoverable

- Repair and update must keep the previous runtime usable until the new one is verified.
- A failed activation must restore the previous runtime.
- Remove must affect only Scient's private runtime root.
- Cancellation must terminate the owned process and release reservations.
- Restart must derive truth again rather than resurrect a stale wizard.

### 5. Provider capabilities drive the UI

The UI should render only methods and actions advertised by the server:

- `connection.methods` selects available login methods;
- `connection.canDisconnect` controls sign-out;
- `runtime.actions` controls install, update, repair, and remove;
- operation fields control cancellation, browser recovery, device codes, and pasted codes.

The UI must not infer repair, removal, code entry, or browser ownership from a provider name.

### 6. T3 remains the generic host

T3 should continue to own provider instances, adapters, sessions, model discovery, the model picker,
provider enablement, and the surrounding application UI. Scient should mount lifecycle functionality
through small optional seams and keep nearly all implementation in Scient-owned directories.

### 7. Assisted setup must remove work, not add ceremony

Sharing infrastructure must not introduce an intermediate page, repeated confirmation, or second click
solely to make providers look architecturally uniform. Preserve each provider's validated fast path.
Add a review or choice only when the user must understand a runtime replacement, choose among genuinely
different account methods, or confirm a destructive action.

Never start a browser/login operation from component mount or a render-driven effect. A user action may
open the lifecycle surface and begin an already-established primary sign-in path in the same event, but
it must do so exactly once. This prevents duplicate browser tabs and login loops while keeping setup
fast.

### 8. Evidence may change the proposal

The sequence and boundaries below are the best current hypothesis, not requirements to defend after
they stop being useful. At each PR boundary, compare the proposed change with the current code,
upstream T3, automated tests, real provider behavior, supported platforms, and manual UX evidence.

If implementation reveals different failure semantics, an unnecessary abstraction, a provider
exception, a safer simpler design, or an interaction regression, pause that part, update this proposal,
and continue with the improved decision. Preserve the first principles and product goals; do not
preserve a planned mechanism merely because it was written here.

## Target architecture

```text
T3 ProviderInstance / ProviderRegistry
        |
        |-- optional provider-specific connectionActions
        `-- optional provider-specific managedRuntimeActions
                              |
                  ProviderLifecycleCoordinator
                    /                      \
       ProviderConnectionManager    ProviderRuntimeManager
                    \                      /
                  lifecycle overlay publication
                              |
                   canonical ServerProvider snapshot
                              |
                 useProviderLifecycleController
                              |
                   AssistedProviderSetupHost
                              |
          provider-specific setup and authentication view
```

### Canonical T3 layer

Keep the existing `ProviderInstance` and `ProviderRegistry` as the only provider registry and routing
authority. Do not introduce a second provider catalog, session router, credential store, or readiness
model.

The two optional lifecycle action fields on `ProviderInstance` are the correct seam and should remain
small.

### Shared Scient orchestration layer

Keep:

- `ProviderLifecycleCoordinator` for reservations;
- `ProviderConnectionManager` for account operations;
- `ProviderRuntimeManager` for app-private runtime operations; and
- `packages/scient-provider-runtime` for the filesystem and artifact trust boundary.

Harden these components instead of replacing them.

### Provider adapter layer

Every provider keeps a small adapter that translates its official behavior into the shared action
interfaces.

Provider adapters may reuse low-level primitives, but they retain their own:

- methods;
- URL allowlists and path predicates;
- browser ownership;
- timeouts;
- authorization-code behavior;
- verification;
- logout behavior;
- environment additions; and
- user-facing errors.

### Frontend layer

Use one lifecycle controller and one setup host. The host selects the existing provider-specific
inline view and supplies explicit surface context.

The provider-specific view remains responsible for the meaningful differences in its flow. The host
owns only common placement, runtime ownership, account-action placement, and fallback routing.

## What is currently strong and should be preserved

### Backend orchestration

`ProviderConnectionManager` already:

- refreshes account state before starting login;
- rejects unavailable, disabled, uninstalled, or unsupported targets;
- uses explicit initial operation status rather than inferring from method names;
- binds authorization-code submission to the matching live operation;
- serializes code submissions;
- handles start/cancel publication races;
- verifies provider state after login; and
- refreshes the authoritative provider snapshot after disconnect.

`ProviderRuntimeManager` already:

- validates reviewed plans and catalog revisions;
- reserves the provider-wide runtime resource;
- stops active sessions before mutation;
- coalesces semantic progress;
- reloads every instance sharing the provider runtime;
- keeps the operation visible while reload is occurring; and
- publishes explicit terminal success, failure, or cancellation.

`ProviderLifecycleCoordinator` correctly distinguishes instance-scoped connection work from
provider-wide runtime mutation.

### Managed runtime boundary

The provider-runtime package already provides:

- pinned artifact manifests;
- redirect-host allowlists;
- exact sizes and checksums;
- bounded extraction;
- symbolic-link and path traversal rejection;
- smoke testing with a restricted environment;
- atomic activation;
- replacement recovery;
- target-aware state; and
- private-root removal.

Routine reconciliation intentionally does not delete staging. Abandoned staging is cleaned only
after the next serialized runtime mutation acquires ownership. This invariant must be preserved.

### Frontend infrastructure

Keep and build around:

- `useProviderLifecycleController`;
- `ProviderRuntimeSection`;
- `ProviderAuthorizationCodeForm`;
- runtime diagnostics;
- transient repair success;
- shared setup status/actions components; and
- capability-driven connection presentation.

### Inherited T3 update infrastructure

Keep T3's existing version-advisory, provider-maintenance runner, update notifications, update command,
and `server.updateProvider` path. The shared lifecycle work must not replace or fork this machinery.

Scient's managed-runtime `update` action and T3's external/system-provider update are two inputs to one
concise Settings presentation, not competing update systems. The UI must continue to respect
`versionAdvisory.status`, `versionAdvisory.canUpdate`, managed `runtime.actions`, and T3's existing update
progress and failure publication.

## Problems to solve

### 1. Detached manager operations lack an explicit layer-shutdown contract

The connection and runtime managers spawn detached supervisor fibers but are currently mounted with
`Layer.effect`. They do not register a service finalizer that explicitly closes all active operation
scopes and releases coordinator reservations.

Normal process exit limits the impact, but shutdown, layer replacement, tests, and development reloads
should have a deliberate cleanup contract.

### 2. Lifecycle overlay logic needs strong characterization, not automatic extraction

The registry currently stores and applies connection-operation and managed-runtime overlays directly.
The behavior is correct, including the publication-order protection against stale terminal state.
The relevant Scient divergence is modest, follows T3's existing transient-maintenance-state pattern,
and the currently pending upstream range does not touch this file.

Moving the refs and setters into a separate store would add an abstraction without presently removing
a demonstrated conflict. Keep the overlays in `ProviderRegistry`, strengthen their characterization
tests, and reconsider extraction only if a future upstream sync produces repeated conflicts or the
registry acquires provider-specific lifecycle policy.

### 3. Low-level provider adapter code is repeated

Claude, Cursor, and Antigravity repeat terminal ANSI/OSC normalization and HTTPS URL scanning.
Several adapters repeat the mechanical environment-filtering loop, although their reviewed key sets
intentionally differ. Cursor, Droid, Grok, and Antigravity repeat the pattern of stopping active
sessions before logout.

These are good candidates for small shared primitives, provided provider-specific policies remain
arguments rather than being hidden.

### 4. Frontend provider dispatch is duplicated

`ProviderConnectionDialog` and `ProviderOnboardingPicker` independently select among assisted
provider components. The picker also contains six nearly identical controller wrappers.

This makes adding or changing a provider easy to do in one surface but forget in another.

### 5. Antigravity is split across two frontend architectures

Codex, Claude, Cursor, Droid, and Grok use the assisted dialog. Antigravity still uses the generic
dialog, which consequently contains Antigravity-specific state and rendering branches.

Antigravity should use the assisted host after its current behavior is characterized and protected.

### 6. Repeated frontend state predicates and helpers

Most inline setup views duplicate:

- active runtime status sets;
- error extraction;
- account-label derivation;
- host/computer labels;
- repair result handling; and
- runtime/action placement flags.

Only pure helpers and stable visual structure should be shared. Provider-specific view state should
remain local.

### 7. Codex has a special Settings-row mutation path

Codex performs install, sign-in, and update directly from its row while other providers open their
lifecycle surface. The install still uses a server-reviewed pinned plan, but it skips the visible
review surface; direct sign-in also assumes Codex's browser method. The quick Update path, however,
is capability-driven and valuable.

All lifecycle-enabled providers should share one Settings-row component. Install, sign-in, retry,
continue, and manage should open the correct lifecycle surface, while the existing safe one-click
Update affordance should be preserved and generalized from advertised managed-runtime or external
update capability. Provider-specific login methods must remain inside the provider setup view.

### 8. Documentation drift

The internal provider document's list of current vertical implementations omits Cursor even though
Cursor is implemented on current `main`.

## What should be shared

### Backend

- operation reservations;
- manager supervision and shutdown cleanup;
- canonical operation publication;
- reviewed runtime planning;
- artifact download and validation;
- staging and atomic activation;
- repair, removal, and recovery;
- terminal control-sequence normalization;
- safe HTTPS URL scanning with a provider predicate;
- a case-insensitive environment picker supplied with each provider's complete explicit allowlist;
- stop-sessions-before-disconnect composition; and
- lifecycle overlay publication and pruning tests.

### Frontend

- lifecycle RPC controller;
- setup host and surface context;
- title, icon, spacing, status, error, and action structure;
- runtime management section;
- authorization-code form;
- diagnostics;
- transient success notification;
- operation predicates;
- account-label and computer-label formatting; and
- lifecycle entry-button presentation.

## What should not be shared

- one universal authentication state machine;
- one generic login command or browser policy;
- credential storage or credential-file parsing;
- provider-specific verification;
- entitlement inference from authentication alone;
- provider model discovery;
- provider-specific timeouts and fallback behavior;
- provider-specific artifact manifests;
- provider-specific environment variables;
- provider-specific copy and alternative methods; or
- a callback-heavy managed-runtime factory for Codex's genuinely different runtime selection.

The five small native managed-runtime wrappers may look repetitive, but they are clear declarations of
provider policy. They should not be replaced merely to reduce line count.

## Provider behavior that must survive migration

Before changing a provider surface or adapter, pin its existing behavior with focused tests. The
shared infrastructure must accommodate these differences rather than erase them:

- **Codex:** browser and device-code methods remain available; the browser fast path may begin from the
  existing one-click Settings action; managed and T3 external updates remain distinct underneath one
  concise presentation.
- **Claude:** subscription and Console methods remain selectable; Claude owns the primary browser
  launch; the captured URL is only recovery; pasted one-time-code handling remains available when the
  live operation accepts it.
- **Antigravity:** Google-account subscription access remains the acceptance criterion; its PTY-backed
  authorization-code path, existing-account detection, browser recovery, verified sign-out fallback,
  and connected-without-model state must survive.
- **Grok:** normal account and explicit device-code methods remain separate; Grok owns browser launch;
  code UI appears only for the path and live operation that actually requires it.
- **Droid:** ACP device pairing remains provider-owned, including the case where Droid opens a dynamic
  browser page but exposes no URL to Scient; sign-out remains conditional on advertised ACP capability.
- **Cursor:** Scient continues to capture, validate, and open the official browser URL exactly once;
  its intentionally narrower login environment and provider-specific verification remain local.

For every provider, preserve the distinction between a working system/custom installation and a
Scient-managed runtime. If the existing installation works, use it without requiring a private
reinstall. If no working installation exists and the target is fully assisted, offer the reviewed
private install directly. Never remove, repair, or overwrite a system/custom installation through the
managed-runtime controls.

## Optional switch from a system runtime to Scient-managed

A user with a healthy system installation may optionally prefer Scient's pinned, repairable private
runtime. Preserve Codex's existing capability and make the architecture extensible to other providers,
but do not assume every provider can support the switch safely.

The rules are:

1. **Capability, not inference.** Show the option only when the server reports `source: "system"`,
   `supportTier: "fully_assisted"`, and `runtime.actions` includes `install`. Do not infer it from the
   driver name or from the mere existence of a managed artifact.
2. **No automatic generalization.** Codex currently has bespoke, tested source selection and is the
   only provider that advertises managed installation beside a healthy system runtime. The shared
   native policy currently does not. Add another provider only after its selection, health, credential,
   removal, and fallback semantics are proven.
3. **Custom paths remain authoritative.** An explicitly configured custom executable must not be
   silently replaced by the private runtime. Do not advertise this switch for `source: "custom"`
   without a separate explicit product decision.
4. **Secondary presentation.** A healthy system runtime remains the dominant Ready state. Present a
   compact secondary action such as `Switch to Scient-managed` near runtime details, not a large
   primary button suggesting that the working installation is defective.
5. **Reviewed but minimal.** The action opens the real reviewed install plan directly. Explain that
   Scient installs a private copy and leaves the system installation untouched; one confirmation
   starts installation.
6. **Provider-wide scope is explicit.** Managed runtime mutation is shared by the provider, not only the
   card that initiated it. The review must state that default-runtime instances in this environment
   will use the private copy after activation, while explicit custom paths remain unchanged.
7. **No early cutover.** Keep the system runtime active while Scient downloads, verifies, stages, and
   smoke-tests the private copy. Cancellation or failure before successful activation must leave the
   system source and T3 update path unchanged.
8. **Post-activation proof.** Stop active sessions through the existing provider-wide runtime manager,
   activate atomically, reload every affected instance, and re-probe the managed binary and account.
   Do not report the switch as successful merely because files were installed.
9. **Fallback and removal.** A provider may fall back automatically to the healthy system binary only
   when that fallback has provider-specific health coverage. Removing the managed copy must re-probe
   and return default instances to the system runtime when it remains healthy; otherwise publish a
   truthful missing/error state.
10. **Credentials stay provider-owned.** Never copy, transform, or migrate credentials. Bind the managed
    binary to the provider's established account/home environment and verify the resulting account
    state. If versions use incompatible stores, do not advertise the switch until handled safely.
11. **Update ownership follows the active source.** While system is active, preserve T3's external
    version advisory/update path. Once the managed runtime is active, suppress updates aimed at the
    system executable and use only the reviewed managed update action. Reversing to system restores
    T3's external update presentation.
12. **Platform qualification remains mandatory.** Offer the switch only in the local desktop app on a
    target with a reviewed artifact and completed install/switch/remove/fallback qualification.

## Resolution after independent review

An independent review of this proposal was checked against the same `main` commit and the current T3
upstream range. The useful corrections are incorporated here:

- the T3 prerequisite must account for the full provider-adjacent incoming surface, not only
  `ChatComposer.tsx`;
- the shutdown gap is real enough to fix and test, particularly for provider-owned child processes;
- the generic managed-runtime lifecycle currently receives most of its invariant coverage through
  `managedCodexRuntime.test.ts`, and Grok has no managed-runtime wrapper test;
- Codex's quick Update is already capability-driven and should be preserved, while direct install and
  sign-in should converge on the reviewed lifecycle surface; and
- per-PR manual testing should cover only affected behavior, followed by one complete cross-provider
  matrix at the end.

The review also proposed abstractions that are deliberately not adopted:

- **No dynamic frontend provider registry.** One explicit, exhaustive host switch is enough for six
  assisted providers and is easier to trace than another registration/configuration system.
- **No shared account-environment policy.** A helper may perform case-insensitive filtering, but every
  provider must retain its complete reviewed allowlist and forced values locally. Changing a common
  base must never silently widen several provider login environments.
- **No dedicated lifecycle-overlay store yet.** The current registry logic is modest, correct, and not
  touched by the pending T3 range. Characterize it; extract only in response to demonstrated conflict
  or policy growth.
- **No full lifecycle suite multiplied by provider or archive format.** Test generic lifecycle
  invariants once at the shared class boundary, archive materialization/security in the existing
  raw/tar/zip file tests, and only thin provider conformance in each wrapper.
- **No eight-PR program merely for granularity.** Use the smallest set of focused PRs that keeps
  behavioral migrations independently reviewable.

## Proposed implementation sequence

Every stage should be a focused, independently reviewable PR. Do not use one large migration PR.
Each PR must update the relevant internal documentation alongside the behavior it establishes; do not
defer all architectural knowledge to the final PR.

### Prerequisite: bounded T3 synchronization

1. Review and integrate official T3 through the selected exact checkpoint.
2. Preserve Scient's existing provider setup callbacks in `ChatComposer` while adopting T3's new
   slash-menu behavior.
3. Run the normal upstream provenance, protected-divergence, focused automated, and manual gates.
4. Keep all lifecycle refactoring out of this PR.

### PR 1: Lifecycle reliability and reusable runtime characterization

This may remain one reliability PR while both changes are small and independently committed. If the
manager-lifetime fix or runtime characterization uncovers substantive product changes, split them into
separate PRs rather than forcing two failure domains through one review.

#### Manager lifetime

- Change the connection and runtime manager layers to scoped services.
- Give each active operation one cleanup path that owns interruption, scope closure, and reservation
  release.
- Register a layer finalizer that invokes that cleanup path for every active operation without
  publishing a user-facing failure during server teardown.
- Do not add a second competing release/close path; prove cleanup is idempotent at the manager
  boundary.
- Add tests proving shutdown leaves no active process, scope, or reservation.

#### Managed runtime contract suite

Move shared lifecycle invariants into one reusable base contract suite against
`ManagedProviderRuntime`, rather than relying primarily on the Codex-specific wrapper test.

Cover:

- install stage order;
- update and previous-version recording;
- repair of the same reviewed version;
- checksum failure;
- smoke-test failure;
- cancellation before activation;
- state-commit failure and rollback;
- interrupted replacement reconciliation;
- target mismatch;
- staging ownership;
- idempotent removal; and
- preservation of unrelated files and external installations.

Do not repeat this whole suite for every provider or every archive format:

- keep raw, tar.gz, and zip materialization and extraction-security coverage in `runtimeFiles.test.ts`;
- add a small composition seam using the real ZIP materializer inside `ManagedProviderRuntime.install`:
  malformed ZIP and extraction-limit failure must preserve the previous active runtime, commit no new
  activation, and leave staging/reconciliation in the expected recoverable state;
- keep thin per-provider tests for manifest resolution, target support, private-root wiring, smoke
  policy, and provider-specific environment; and
- add the currently missing `managedGrokRuntime.test.ts` conformance coverage.

Also strengthen the existing `ProviderRegistry` characterization for transient connection/runtime
overlay publication, persistence exclusion, pruning, refresh, and stale-terminal-state ordering. This
is the evidence that permits overlay extraction to remain deferred.

Characterize Codex's existing system-to-managed switch before changing its presentation: healthy
system availability, custom-path precedence, failed/cancelled install retaining system selection,
successful provider-wide cutover and reload, account re-verification, managed-health fallback, removal
returning to system, and external-versus-managed update ownership.

No user-interface changes.

### PR 2: Small backend adapter primitives

Extract and test:

1. A terminal URL scanner that:
   - preserves OSC 8 hyperlink targets;
   - strips remaining terminal controls;
   - scans bounded HTTPS candidates;
   - rejects malformed/control-bearing output; and
   - accepts a provider-specific URL predicate.

2. A mechanical environment picker that:
   - receives the source environment;
   - receives the provider's complete explicit allowed-key list;
   - treats platform key casing safely.

   The helper must not own a common key set, provider additions, or forced values. Those security
   decisions remain visibly declared in each provider adapter.

3. A session-shutdown wrapper that:
   - stops active provider sessions;
   - maps the provider-specific shutdown error; and
   - runs provider-owned disconnect only after shutdown succeeds.

Migrate one provider at a time with parity tests. Do not alter auth method semantics.

### PR 3: One explicit assisted setup host and stable pure helpers

Create a Scient-owned setup host that:

- uses one explicit exhaustive switch from assisted driver to its existing inline component;
- constructs the lifecycle controller once;
- receives only the surface context actually needed by the views;
- uses existing provider metadata for names and icons; and
- returns `null` for an unsupported driver/surface so the caller retains its existing generic fallback.

Replace:

- the assisted-provider conditional chain in `ProviderConnectionDialog`;
- the six controller wrappers in `ProviderOnboardingPicker`; and
- the second conditional chain in `ProviderLifecycleSetupSurface`.

Do not introduce a runtime registration API, a configuration schema, a redundant `flow` field, or
duplicate provider metadata. Keep provider-specific props and behavior explicit at the switch.
Until PR 5, the host may select Antigravity for the composer surface but must return `null` for its
management surface so the existing generic dialog remains authoritative.

Remove the Grok-only layout translation by making the shared composer layout stable for every
assisted provider.

Extract only stable pure helpers whose behavior is already identical:

- active connection/runtime operation predicates;
- failure-message normalization;
- account and host/computer labels; and
- reviewed runtime plan/start plus capability-driven update selection.

Keep provider-specific view state, copy, browser behavior, preferred method selection, and fallback
behavior local. This PR intends no product-flow or visual redesign, but changing the shared layout can
still move pixels. Require before/after screenshots for Grok and at least one other assisted provider,
plus focused interaction checks, before calling it behavior-preserving. Antigravity continues using
its current generic management-dialog path until PR 5.

### PR 4: Settings entry normalization

- Replace the Codex-specific row component with one shared lifecycle entry action.
- Render Install, Sign in, Continue, or Manage from canonical lifecycle presentation.
- For Install, open directly on the reviewed install plan by passing `initialRuntimeAction: install`;
  do not add a separate setup/review landing page.
- Preserve the current sign-in interaction budget. Where a validated existing Settings action already
  starts one unambiguous primary path safely, the same click may open the lifecycle surface and start
  that provider-owned action exactly once. Where the user must choose between meaningful methods, open
  the chooser without auto-starting either method.
- Keep any provider-specific primary-start decision in a small explicit Scient-owned resolver or the
  existing provider action helper, not in inherited `ProviderInstanceCard` and not in a mount effect.
- Preserve and generalize the one-click Update action when either `runtime.actions` advertises
  `update` or an external version advisory is `behind_latest` and explicitly advertises `canUpdate`.
- Route managed Update through `planRuntime` then `startRuntime`; do not bypass the pinned plan or
  catalog revision.
- Keep T3's `server.updateProvider`, update notifications, update commands, and external update-state
  publication unchanged.
- When the server advertises managed `install` beside a healthy system source, render the optional
  `Switch to Scient-managed` action as a compact secondary runtime action. Open its reviewed plan
  directly and preserve the provider-wide/custom-path explanation.
- Do not add this action to providers whose backend does not advertise and prove the capability.

Do not redesign the provider card in this architecture PR. Characterize Codex's current Install,
Sign in, Update, Retry, Continue, and Manage paths, plus T3 external-update presentation, before
replacing its special component.

### PR 5: Antigravity assisted-dialog migration and documentation completion

Before moving it, add characterization for every current state:

- missing runtime;
- install and cancellation;
- managed update and repair;
- existing authenticated Google account;
- account unknown;
- browser sign-in;
- manual fallback URL;
- authorization-code submission to the live PTY;
- sign-in cancellation;
- authenticated without models;
- sign-out and local credential fallback;
- removal; and
- repair/remove transient publication.

Then route Antigravity through the assisted host and remove all Antigravity-only code from the generic
dialog. The generic dialog remains a truthful fallback for manual, unknown, and future fork drivers.

Update documentation to include Cursor and describe exact product semantics:

- Install adds a verified app-private runtime.
- Repair downloads a fresh copy of the reviewed artifact, verifies and smoke-tests it, then atomically
  replaces the managed runtime while preserving the previous working copy until activation.
- Update follows the same safe replacement path for a newer reviewed version.
- Remove deletes only Scient's app-private runtime.
- Sign out delegates credential revocation to the provider and does not remove the runtime.
- Removing a runtime does not sign out the provider account.
- System and custom installations are never modified by managed removal.

Complete the canonical internal lifecycle documentation described below and verify it against the
landed implementation.

## Required implementation documentation

The implementation is not complete until Scient has one clear internal entry point for provider
lifecycle architecture. Prefer extending the existing provider and connection/runtime documentation
over creating overlapping documents; add a focused new document only if no existing page can remain
canonical.

The documentation must explain:

1. **Ownership boundaries:** what T3 owns, what shared Scient infrastructure owns, what each provider
   adapter owns, and what the provider's official CLI/account system owns.
2. **Shared lifecycle:** the canonical runtime, authentication, entitlement, readiness, operation,
   cancellation, publication, recovery, and shutdown model.
3. **Capability-driven UI:** how `connection.methods`, `connection.canDisconnect`, `runtime.actions`,
   operation fields, runtime source, support tier, and version advisories determine visible actions.
4. **Runtime sources:** the behavior and safety rules for system, custom, Scient-managed, missing,
   manual-only, and unsupported installations.
5. **Provider behavior matrix:** for Codex, Claude, Antigravity, Grok, Droid, and Cursor, record the
   authentication methods, browser owner, optional code/device behavior, verification, sign-out,
   environment policy, managed-runtime support, update path, and known platform constraints.
6. **Why differences remain:** document the concrete protocol, security, reliability, or UX reason for
   every provider-specific exception. Do not describe intentional differences as unfinished sharing.
7. **Extension guide:** the smallest checklist for adding a provider or capability without duplicating
   the managers, runtime engine, routing tables, update machinery, or visual state model.
8. **Testing and qualification:** which contract, provider-specific, T3-compatibility, packaged-app,
   platform, and manual lifecycle evidence is required before advertising support.
9. **Change discipline:** how to revise the architecture and this proposal when implementation evidence
   reveals a better boundary, while keeping documentation synchronized with the code.

Use tables for ownership and provider differences where they improve scanning, but keep the prose
focused on behavior and rationale rather than file-by-file narration. Link to provider-specific user
documentation for installation/account instructions instead of duplicating it internally.

## User-experience target

### Interaction and visual budget

The shared work must preserve or reduce the number of user decisions:

- **Install:** one click from Settings/composer opens the actual reviewed plan; one confirmation starts
  installation. No intermediate "review setup" card before the plan.
- **Switch to Scient-managed:** when a healthy system runtime advertises the option, keep it secondary
  and open the same reviewed install plan. The Ready state remains primary.
- **Repair:** one click from Manage starts the safe same-version replacement; show a short transient
  success message when verification completes.
- **Update:** retain T3's existing one-click update where advertised; managed update still uses the
  reviewed pinned plan internally without requiring a redundant second review screen.
- **Remove:** one concise confirmation because it deletes Scient's private copy; make it explicit that
  the account and system/custom installations remain unchanged.
- **Sign in:** preserve the provider's current fastest safe path. Ask the user to choose only when the
  methods are meaningfully different. Show pasted-code/device-code UI only when requested or when the
  live operation requires it.
- **Sign out and cancel:** one clear action in the active management surface, with no nested dialog
  unless the provider itself requires another step.

The visual surface stays compact: one outer card, no cards nested for ordinary status rows, no duplicate
Close button when the title-bar close control exists, diagnostics behind a disclosure, concise copy,
and no percentage bar unless the backend supplies meaningful progress. Success notices are transient;
raw paths, commands, and provider diagnostics never dominate the primary state.

### Settings

Each lifecycle-enabled provider row has one concise entry action:

- `Update` when the server explicitly advertises a safe managed or external update;
- `Install` when a supported runtime is missing;
- `Sign in` when the runtime works but the account is disconnected;
- `Continue` while an operation is active; or
- `Manage` when the provider is connected or needs attention.

The management dialog shows only server-advertised actions. Diagnostics remain behind details.

A working system/custom runtime should show the account action or ready state, not an Install prompt.
Managed repair/remove controls appear only when the server reports a Scient-managed runtime and
advertises those actions.

### Composer

The composer remains optimized for quick setup:

- install when missing;
- sign in with the provider's primary method;
- expose alternatives only when meaningful;
- show device or pasted code only when the active provider operation supplies or accepts it; and
- return automatically to T3's normal model list when the canonical provider snapshot becomes ready.

Full maintenance and sign-out controls belong in the management dialog unless a specific product
decision says otherwise.

### Truthful states

The UI must distinguish:

- checking;
- disabled/unavailable;
- not installed;
- runtime operation active;
- installed but sign-in required;
- connection operation active;
- authenticated and ready;
- authenticated but no eligible model/access;
- provider requiring no account;
- recoverable runtime failure; and
- manual/advanced-only setup.

## Validation strategy

### Automated layers

1. Contract decoding and backward compatibility.
2. Lifecycle coordinator reservations across instances and drivers.
3. Connection-manager race, cancellation, code-submission, verification, disconnect, and shutdown
   tests.
4. Runtime-manager plan, cancellation, reload, publication, shared-runtime, and shutdown tests.
5. Registry overlay publication, persistence exclusion, pruning, refresh, and stale-state tests.
6. Managed-runtime filesystem and rollback contract suite.
7. Provider-specific connection-action tests.
8. Provider-specific managed-runtime resolution and manifest tests.
9. Frontend setup host and all provider inline-view tests.
10. Settings and composer seam tests, including the preserved fast-path click counts.
11. T3 version-advisory, external update, managed update, notification, command, and failure-state
    regression tests.
12. Affected package typechecks, lint, and final repository gate.

### Manual isolated-app matrix

For each PR, manually exercise only the providers and lifecycle states that PR can affect. After PR 5
and one final T3 refresh, run the complete matrix below once as the release gate.

For Codex, Claude, Antigravity, Grok, Droid, and Cursor, exercise where supported:

- missing system and managed runtime;
- install review;
- cancelled install;
- successful install;
- app restart after install;
- existing logged-in account detection;
- each advertised sign-in method;
- provider-owned versus Scient-opened browser behavior;
- no duplicate browser tabs;
- optional code visibility and submission;
- cancelled sign-in;
- failed sign-in and retry;
- account without eligible subscription/model access;
- repair success;
- failed repair preserving the old runtime;
- sign-out with runtime preserved;
- remove while connected and disconnected;
- reinstall;
- system/custom runtime preservation;
- optional system-to-managed switch where advertised, including concise review copy;
- failed and cancelled switch preserving the active system runtime and external update path;
- successful switch reloading all default-runtime instances while preserving custom-path instances;
- managed removal returning to a healthy system runtime and restoring its update presentation;
- multiple instances sharing one runtime;
- Settings and composer surfaces; and
- remote/read-only behavior.

### Platform qualification

Artifact metadata and unit tests are not sufficient proof for every host. Each advertised operating
system and architecture still requires packaged-app qualification for install, cancellation, smoke
test, authentication, repair, update, interruption, and recovery before release.

Target resolution, archive/path rules, checksum selection, executable naming, and unsupported-target
presentation should also be tested without depending on the developer's current host. A provider/target
must not be labeled `fully_assisted` until Scient has a pinned artifact and the complete lifecycle has
been qualified there. Unsupported or manual-only targets must fail closed with a concise alternative,
never a broken Install button.

### T3 compatibility gate

Before each PR merges:

- refresh official T3;
- inspect whether T3 changed any inherited seam touched by the PR;
- run a merge-tree conflict analysis;
- verify the inherited diff did not grow without necessity; and
- keep upstream synchronization separate from feature commits.

At the end, compare the lifecycle-related inherited diff against the pre-refactor baseline. Success
means fewer provider-specific routing branches and no unnecessary growth in inherited files; moving
correct state into a new abstraction is not itself a success metric.

## Non-goals

- Replacing T3's provider registry.
- Replacing provider adapters or session transports.
- Creating a Scient credential store.
- Making all providers use ACP.
- Treating every browser flow as identical.
- Inferring subscription entitlement from authentication alone.
- Refactoring model discovery or execution.
- Redesigning every provider card during infrastructure work.
- Adding managed repair or removal where the backend does not advertise it.
- Creating a universal provider UI state hook.
- Extracting the lifecycle overlays before conflict or policy evidence justifies it.
- Mixing this work with an upstream T3 merge.

## Success criteria

The work is successful when:

- all existing provider behaviors remain accessible;
- lifecycle operations have explicit shutdown cleanup;
- runtime filesystem invariants have reusable contract coverage;
- provider-specific authentication remains local and truthful;
- the renderer derives actions from canonical capabilities;
- no provider gains an extra landing page, confirmation, or sign-in click without a safety or choice
  requirement;
- T3's inherited version-advisory, update notification, external update, and update-command behavior
  remains available;
- working system/custom installations remain first-class and are never mutated by managed controls;
- a system-to-managed switch appears only as a secondary server-advertised capability, preserves
  custom paths, and has proven failure, removal, fallback, account, multi-instance, and update behavior;
- every advertised provider/target passes its specific lifecycle characterization and platform gate;
- Settings and composer no longer maintain separate provider routing tables;
- Antigravity no longer contaminates the generic dialog path;
- Codex no longer needs a separate Settings component, while its validated browser fast path remains
  explicit and one-click;
- inherited T3 lifecycle code is smaller rather than larger;
- no second registry, credential store, or model state is introduced;
- canonical internal documentation clearly records shared ownership, every provider-specific exception
  and its rationale, the extension path, and required qualification evidence;
- focused automated suites and isolated real-app lifecycle matrices pass; and
- the final architecture is easier to extend without copying an entire provider flow.

## Final first-principles check

This revised plan remains aligned with the root goals:

- **Simpler:** it adds no second registry, no universal authentication machine, no provider plugin
  system, and no shared environment policy. The new frontend seam is one explicit host switch; the
  backend extractions are limited to three already-repeated mechanical operations.
- **Fast for users:** sharing presentation does not impose one universal wizard. Existing safe one-click
  paths remain one-click, method choice appears only where meaningful, and maintenance actions open on
  the actionable state rather than an intermediate explanation.
- **More reliable:** it first closes the manager-lifetime gap, puts generic runtime invariants at the
  generic runtime boundary, preserves archive-security tests, and adds the missing Grok conformance
  test before changing provider UI routing.
- **Truthful to provider differences:** browser ownership, device/code behavior, verification,
  credentials, entitlement, environment policy, and copy remain provider-owned.
- **Safer for users:** runtime and account state remain orthogonal; install/update/repair/remove stay
  capability-driven and pinned-plan-backed; system and custom installations remain untouched.
- **Lower T3 conflict risk:** the upstream sync lands separately, routing duplication moves into
  Scient-owned code, and correct inherited registry logic is left alone until evidence supports moving
  it.
- **Incremental and reversible:** each PR has one dominant purpose, preserves existing behavior under
  characterization tests, and can be reviewed or reverted independently.

During implementation, reject a low-level backend extraction if it needs provider-name branches beyond
an explicit URL predicate or provider-supplied allowlist, or if it makes the provider-specific flow
harder to read. If characterization reveals that two apparently similar paths have different failure
semantics, keep them separate.

## Final recommendation

Proceed incrementally after the separate T3 synchronization. Preserve the existing coordinator,
managers, runtime package, optional provider action seams, and canonical server snapshot. Harden
manager lifetime, strengthen generic runtime characterization, extract only low-level duplicated
mechanics, establish one explicit assisted frontend host, preserve a generic quick Update path,
normalize the Settings entry, and only then migrate Antigravity under strong characterization tests.

The goal is not maximum abstraction. It is one reliable shared lifecycle where the underlying
behavior is genuinely shared, with explicit provider-specific adapters everywhere the providers
actually differ.
