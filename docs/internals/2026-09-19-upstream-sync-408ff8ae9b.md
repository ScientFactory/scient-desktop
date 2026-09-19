# T3 upstream alignment through 408ff8ae9b

Status: the history-preserving alignment merge is committed and the automated/source
review gates passed. This receipt records the delivery candidate; it does not claim
release publication, cloud activation, or any new publication authority.

## Frozen history

- Owned starting point: 943e0119d5961d89778464cd051ddbfd0e084ca5, the owned-main
  revision from which this candidate was created.
- Previous official integration: 3fd5d6439d8fd49d173503ecda96500463a39bd2.
- Official target: 408ff8ae9bd7eb2e7e90cbfd8b3fcfe63641bf23. The range contains
  76 official commits after the previous boundary.
- Nearest official tag: v0.0.43-nightly.20260919.1948. The target is three
  official commits after that tag.
- Alignment branch: codex/t3-sync-408ff8ae9b-20260919.
- History-preserving merge: 0c141c73e109d51369e8b95ca21e15573292bab2, with
  the owned starting point as first parent and the exact official target as
  second parent.
- The fetch-only upstream remote remains configured with push URL DISABLED.
- The merge is one bounded alignment. It is not a squash, replay, cherry-pick,
  or split implementation.

## Adopted upstream behavior

The alignment receives the upstream settings, activity, pull-request/files-viewed,
mobile, composer, browser/preview, source-control, provider-runtime, orchestration,
persistence, Effect, and dependency improvements through the exact target. It also
receives the upstream editor discovery, checkpoint/retry, thread activity, usage,
model/provider, theme, file-context, and client-runtime changes where they fit the
existing Scient architecture.

Notable composed outcomes include:

- updated pull-request review/file-view state, search, comments, stacks, and file
  actions;
- upstream checkpoint/orchestration and VCS retry behavior with the Scient project
  and environment guards;
- upstream settings, mobile, native-header, theme, activity-row, composer, and
  provider-runtime improvements;
- Effect rc.115 and its matching patches/lockfile updates;
- the upstream CLI/build external-package handling needed by the composed runtime;
- the upstream HTML/file-path, preview, custom-model, and workspace behavior that
  passed the existing Scient-specific tests.

## Deliberately retained or deferred

- Scient remains the product authority for identity, labels, state roots, provider
  lifecycle, scientific/compute surfaces, browser authorization, storage policy,
  privacy, and release decisions.
- Migration history remains immutable. No migration was renumbered or reused to
  match T3; this range did not make the upstream migration counter authoritative.
- Scient's signed/pinned runtime, stable-release workflow, manual publication
  boundary, Azure Trusted Signing, cloud-disabled policy, and relay publication
  hold remain in force.
- The upstream archive runtime/publication path and unsupported upstream publication
  channels remain excluded from Scient's runtime and release authority.
- No new provider update discovery, cloud/relay activation, mobile publication,
  telemetry destination, or release channel was enabled by this alignment.

## Conflict composition and semantic review

The meaningful overlaps were composed at the narrowest stable seams rather than
taking either side wholesale:

- server settings retain upstream secret-change collect/apply/rollback behavior
  alongside Scient custom-model and Droid persistence;
- GitVcsDriver retains upstream transient-failure retries alongside Scient's
  no-Git CommandAvailability guard;
- CodexAdapter retains upstream approvable-permission handling alongside Scient
  citation and generated-image behavior;
- Effect ACP retains upstream elicitation support and generated schemas;
- desktop configuration/observability retain Scient identity and fail-closed
  telemetry gates while adopting safe upstream configuration mechanics;
- release and relay workflows retain the Scient stable/manual/publication boundary
  while adopting safe upstream relay-state parsing;
- mobile thread controls, web settings/auth/sidebar/theme surfaces, contracts,
  provider runtime, HTTP, analytics, cloud boot, and CLI seams retain their
  Scient-owned guards while taking the compatible upstream mechanics;
- obsolete upstream checkpoint projection files and archive-runtime seams were
  removed only where the composed orchestration/runtime no longer references them.

## Protected-boundary results

The source audit found no reintroduced publication authority, cloud enablement,
relay deployment, unsupported update channel, outbound OTLP bypass, identity/state
root change, provider-lifecycle replacement, or migration renumbering. OTLP traces,
metrics, and logs remain fail-closed under the Scient safety envelope. The relay
deploy path remains explicitly disabled, and the stable release workflow retains
its canonical-repository and manual-publication guards.

## Qualification

The following gates passed on the composed candidate:

- pnpm exec vp fmt --check;
- pnpm exec vp lint --report-unused-disable-directives, with only the repository's
  existing advisory warning set;
- pnpm run typecheck, with only existing Effect suggestion diagnostics;
- the full pnpm run test workspace matrix;
- pnpm run build;
- pnpm run test:desktop-smoke;
- pnpm run brand:check across the product-surface files;
- focused server settings, VCS/process, Codex adapter/logger, ACP, packaging,
  migration, telemetry, and provider-runtime regressions;
- conflict-marker, unmerged-index, and scoped diff checks.

The vendored .repos reference synchronization contains upstream-owned trailing
whitespace in a small number of files; it was retained verbatim. The scoped
non-vendored diff check passed. Visual acceptance remains the owner's separate
manual gate and is not established by these automated checks.

## Publication boundary

The next step is the requested pull request from this branch, with auto-merge enabled
subject to repository CI and review requirements. This alignment commit itself does
not publish a release or activate any cloud, relay, mobile, or signing workflow.
