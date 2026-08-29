# T3 upstream alignment protocol

Status: active maintainer protocol. This document defines how Scient receives ordinary work from the
official `pingdotgg/t3code` `main` branch. It does not authorize a release, publication, cloud or
mobile activation, or a product-policy change.

## First principles

1. Preserve literal upstream ancestry. A normal alignment is one bounded merge of an exact official
   range, not a squash, replay, patch transplant, or hand-reimplementation.
2. Scient remains the product authority. Upstream supplies the generic host; Scient owns identity,
   user experience, scientific behavior, privacy, storage compatibility, provider lifecycle, and
   release/publication decisions.
3. Prefer the upstream structure plus narrow Scient seams. Do not fork a whole component merely to
   retain one policy, and do not move correct Scient behavior into a new abstraction without evidence
   that the abstraction reduces risk.
4. Compatibility is end to end. A shared contract is not safe until every enabled producer and
   consumer—server, web, desktop, mobile, persisted state, and supported older clients—can handle it.
5. Capabilities and command boundaries agree. If a feature is not safe, do not advertise it, render
   its entry point, or accept its command. A UI-only hide is not a safety boundary.
6. Fail closed at authority boundaries. Inherited code never silently enables telemetry, cloud,
   relay, updater, service, signing, hosted deployment, mobile publication, or release authority.
7. Simplicity means one truthful path. Avoid compatibility hacks, mount-time side effects, duplicate
   state owners, provider behavior forced into an unsuitable shared base, and explanatory UI for
   actions that do not exist.
8. Evidence can improve the plan. This protocol is a strong default, not permission to ignore the
   actual range. If implementation evidence invalidates a decision, stop, explain it, and update the
   protocol through review rather than working around it.

## 1. Freeze exact boundaries

Before mutation:

- verify the canonical Scient checkout, current `origin/main`, all worktrees, and dirty state;
- fast-forward local `main` to `origin/main` without overwriting unrelated work;
- fetch `origin` and the official `upstream` remote, and verify upstream's push URL is `DISABLED`;
- read `AGENTS.md`, `UPSTREAM.md`, `upstream-state.json`, the D4 bootstrap record, and the latest
  dated alignment receipt;
- record the owned base, previous `integrationBase`, exact upstream target, commit count, tag
  relationship, and branch name; and
- create a dedicated short-lived worktree and `codex/` branch from the exact owned base.

An observed tip is not an integrated tip. Never update `integrationBase` merely because a commit was
reviewed or fetched.

## 2. Inventory before merging

Read the complete commit list and aggregate diff for `integrationBase..target`. Group the range by
behavior rather than commit title alone: contracts and persistence, server composition, providers,
web/desktop/mobile clients, release and operations, dependencies, and documentation.

Compare upstream-touched paths with Scient-modified paths and simulate the merge to locate textual
conflicts. This predicts work; it does not prove safety. Auto-merged overlapping files require the
same semantic review as conflict files because Git can concatenate incompatible assumptions without
raising a marker.

Before implementation, identify any upstream change that would require a major Scient product
decision—for example enabling a new publication channel, changing user-data identity, weakening a
privacy boundary, replacing provider lifecycle semantics, or shipping a contract incompatible with
an enabled client. Report that decision instead of choosing it implicitly.

## 3. Merge with real history

Merge the exact official target with `--no-ff`. Preserve the official target as the second parent.
Keep unrelated feature work out of the branch. Ordinary donor commits remain unchanged in ancestry;
Scient-specific composition belongs in the merge result or a narrow follow-up commit.

Classify each overlap before resolving it:

- **Upstream-owned mechanics:** adopt the current upstream structure and tests.
- **Scient-owned policy:** retain the existing Scient decision and its guard.
- **Composition:** preserve both behaviors at the narrowest stable seam.
- **Incompatible rollout:** keep the underlying compatible machinery when useful, but gate the
  capability and command path until every required surface is safe.
- **Obsolete Scient divergence:** remove it only when the upstream behavior demonstrably replaces it
  and the relevant Scient acceptance evidence still passes.

Do not resolve a substantial conflict by taking one whole side without checking both stage blobs and
their callers. Preserve immutable migration order; an upstream migration number that collides with a
shipped Scient migration must be renumbered, never reused.

## 4. Audit protected seams

Every alignment explicitly reviews:

- Scient product labels, icons, protocols, package identity, and retained compatibility names;
- `scient-next` state roots, client persistence partitions, and migration history;
- General Chat/projectless behavior, conversation forks, queue/steer semantics, Skills, Sources,
  voice, analysis, compute, PDF, LaTeX, rich chat, and content direction;
- provider inventory, model selection, agent awareness, system-installed and Scient-managed runtime
  paths, assisted sign-in/install/repair/update/remove/sign-out capabilities, and passive-probe safety;
- browser/preview authorization, file and attachment schemas, asset access, and old-client replay;
- analytics allowlists and consent, provider identity, OTLP, cloud, relay, hosted web, and mobile
  release holds;
- service, updater, signing, notarization, tag, npm, stable/nightly, and publication authority; and
- contributor trust, workflow permissions, secrets, and supply-chain policy.

Provider-specific behavior stays provider-specific when the provider protocol differs. Shared
infrastructure should own repeated lifecycle mechanics, not erase capability differences.

## 5. Validate progressively

While composing, run focused tests for every touched contract and protected seam. Then audit the
entire staged diff for conflict markers, duplicated branches, stale product copy, accidental package
changes, and silently reintroduced upstream authority. Regenerate generated artifacts and lockfiles
from the composed sources; do not hand-edit generated conflict blocks.

The final local gate uses the repository versions of Node and pnpm and includes:

```text
pnpm exec vp fmt --check
pnpm exec vp lint --report-unused-disable-directives
pnpm run typecheck
pnpm run test
pnpm run build
pnpm run test:desktop-smoke
pnpm run brand:check
git diff --cached --check
git diff --check
```

Run additional focused gates required by the range, including mobile native checks, release smoke,
provenance, migration, and provider seam tests where applicable. User-facing desktop behavior also
requires an isolated synthetic-state app from the exact candidate head and a proportional visual and
interaction review. Automated checks do not establish visual acceptance.

## 6. Record and review

Create a dated receipt under `docs/internals/` that records:

- exact owned base, previous official boundary, target, range, target tag, merge commit, branch, and
  disabled upstream push boundary;
- adopted behavior and deliberately deferred behavior;
- every meaningful conflict composition and any semantic issue found after Git's merge;
- protected-boundary results and temporary compatibility gates;
- exact verification performed, including skipped platform or live-provider checks; and
- the publication boundary.

Only after the history-preserving merge exists and its gate passes should `upstream-state.json` and
the current pointer in `UPSTREAM.md` advance to that exact target and merge. Push a draft pull request
for review. Do not merge to `main`, publish, or clean the worktree until review and user acceptance
authorize those separate actions.

## Stop conditions

Stop and ask for a product decision when the clean composition would:

- expose a currently unsupported client or persisted-state contract;
- activate a release, cloud, mobile, telemetry, identity, or credential boundary;
- remove an intentionally supported system-managed or Scient-managed provider path;
- require destructive user-data migration or reinterpret an existing migration;
- weaken authorization, privacy, sandbox, or supply-chain controls; or
- demand a large Scient redesign rather than a bounded alignment.

A failing or unavailable platform check is reported honestly; it is never converted into success by
removing the gate. A temporary compatibility gate is acceptable only when it is explicit, tested at
both capability and command boundaries, documented with its removal condition, and simpler than a
partial rollout.
