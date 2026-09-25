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
   This means safe decoding, preservation, and an honest display or fallback, not identical
   upload controls on every client. Missing mobile UI alone is not a reason to disable a working
   desktop/web capability.
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
- use the exact fetched `origin/main` as the owned base when starting the alignment; fast-forward
  local `main` only when its checkout is clean and that move is safe. A dirty or independently used
  local `main` must remain untouched and must not block an isolated alignment;
- fetch `origin` and the official `upstream` remote, and verify upstream's push URL is `DISABLED`;
- read `AGENTS.md`, `UPSTREAM.md`, `upstream-state.json`, the D4 bootstrap record, and the latest
  dated alignment receipt;
- record the owned base, previous `integrationBase`, exact upstream target, commit count, tag
  relationship, and branch name; and
- create a dedicated short-lived worktree and `codex/` branch from the exact owned base.

The helper can inventory the frozen range and create that worktree without touching a dirty
checkout. Fetch both remotes explicitly first; it never fetches or assumes local remote-tracking
refs are fresh:

```sh
git fetch origin main
git fetch upstream main
pnpm alignment:plan --base origin/main --target upstream/main
# Copy the complete base and target SHAs from the plan:
pnpm alignment:start --base <owned-base-sha> --target <official-target-sha> \
  --worktree <new-absolute-path> --branch codex/<alignment-name>
```

`plan` only reads repository state and simulates the merge with temporary, isolated Git objects.
It checks that the owned base contains current `origin/main`, the prior integration is in both
histories, the target belongs to official `upstream/main`, and upstream push remains disabled.
It reports the complete official commit range, changed paths, all overlapping paths, and predicted
textual conflicts. It also highlights changed quality-policy files, shared web UI primitives, and
shared contracts as **advisory downstream-impact signals**. These are not conflict counts, proof of
breakage, or blockers: inspect the actual diff and consumers, including Scient files upstream did
not touch. A changed file outside these categories still requires normal review. `--format json`
provides the complete machine-readable inventory.
For read-only qualification against an older base already in current owned history,
`plan --historical --base <old-sha> --target <old-target-sha>` permits that base;
`start` never accepts `--historical`.
For an existing, committed alignment branch, use
`pnpm alignment:plan --existing --base HEAD --target <new-official-target-sha>` from that
worktree. This read-only mode requires its recorded upstream merge and branch name and reports
when owned main needs a later catch-up; it neither verifies PR identity nor creates a worktree.
Verify the open PR separately. Finish any current merge before using it; do not combine it with
`--historical`. If a legitimate branch rename makes this advisory plan unavailable, verify its
ancestry manually and repair the recorded branch name; do not restart the alignment to satisfy
the helper.
`start` requires full frozen SHAs, creates a new dedicated worktree, and runs Git's ordinary
`--no-ff --no-commit --no-rerere-autoupdate` merge. A clean merge remains uncommitted; a conflict
remains unresolved. It does not stage, advance the cursor, commit, push, or accept a resolution.
If a post-creation step fails, the new worktree is retained for inspection.

An observed tip is not an integrated tip. Never update `integrationBase` merely because a commit was
reviewed or fetched.

## 2. Inventory before merging

Read the complete commit list and aggregate diff for `integrationBase..target`. Group the range by
behavior rather than commit title alone: contracts and persistence, server composition, providers,
web/desktop/mobile clients, release and operations, dependencies, and documentation.

Compare upstream-touched paths with Scient-modified paths and simulate the merge to locate textual
conflicts. This predicts work; it does not prove safety. Auto-merged overlapping files require the
same semantic review as conflict files because Git can concatenate incompatible assumptions without
raising a marker. In particular, trace single-owner mounts and coordinator registration through
their callers; a clean merge can mount the same behavior twice.

Look beyond overlaps when upstream changes a shared API or a quality gate. Trace its untouched
Scient consumers and the affected server, web, desktop, or mobile entry points. For example, a lint
rule changing from advisory to mandatory can fail Scient-only files even when Git reports no
conflict. If a previous receipt records an upstream deprecation, warning ceiling, or migration
debt, check whether this range enforces it; record the scope and stable replacement API before
starting a broad rewrite. An impact signal is a prompt for this review, not an instruction to run
every possible test or to accept an upstream policy without composition.

Git's recorded conflict resolutions (`rerere`) may fill a working-tree file, but `start` leaves
the index unresolved until the agent inspects and stages it. Reuse is not acceptance evidence.
If the old resolution no longer fits, resolve normally; do not preserve an obsolete implementation
to make reuse possible.

Before implementation, identify any upstream change that would require a major Scient product
decision—for example enabling a new publication channel, changing user-data identity, weakening a
privacy boundary, replacing provider lifecycle semantics, or shipping a contract incompatible with
an enabled client. Report that decision instead of choosing it implicitly.

## 3. Merge with real history

Merge the exact official target with `--no-ff`. Preserve the official target as the second parent.
Keep unrelated feature work out of the branch. Ordinary donor commits remain unchanged in ancestry;
Scient-specific composition belongs in the merge result or a narrow follow-up commit.
Every commit in the frozen range is integrated. The classifications below decide how to compose
behavior and whether a capability may be activated; they are not a menu for selecting upstream
commits or dropping an advancement.

Classify each overlap before resolving it:

- **Upstream-owned mechanics:** adopt the current upstream structure and tests.
- **Scient-owned policy:** retain the existing Scient decision and its guard.
  Distinguish an approved product decision from an implementation limitation or an earlier agent's
  assumption; existing code or a historical receipt alone does not establish user intent.
  `AGENTS.md` is Scient-owned policy. Review upstream changes to it even when Git
  merges them without conflicts. Incorporate applicable technical guidance without
  restoring upstream team authority, contradictory instructions, or duplicated
  procedures.
- **Composition:** preserve both behaviors at the narrowest stable seam.
- **Incompatible rollout:** keep the underlying compatible machinery when useful, but gate the
  capability and command path until every required surface is safe.
- **Obsolete Scient divergence:** remove it only when the upstream behavior demonstrably replaces it
  and the relevant Scient acceptance evidence still passes.

Do not resolve a substantial conflict by taking one whole side without checking both stage blobs and
their callers. Preserve immutable migration order; an upstream migration number that collides with a
shipped Scient migration must be renumbered, never reused.

### Extend an existing alignment PR

Continue in its current branch and worktree; do **not** use `alignment:start` or create another
worktree for new upstream commits. Verify the open PR, clean or in-progress merge state, recorded
integration boundary, and current remotes. Finish and review an in-progress merge before beginning
another. Freeze one new official target, use the read-only `plan --existing` to inventory it, then
merge that exact commit with
`git merge --no-ff --no-commit --no-rerere-autoupdate <target-sha>`. Review the new overlap and
downstream impact, qualify the composed candidate, and update the same receipt, state, and PR.
New upstream commits observed while composing are a later extension, not a reason to keep moving
this pass's target. The user can request another extension on the same PR.

### If owned main advances during the alignment

Keep the reviewed alignment branch and its original upstream merge. Once that merge is committed
and the worktree is clean, fetch `origin/main`, freeze its new commit ID, and confirm it contains
the original owned base. Merge that exact owned-main commit into the alignment branch with
`git merge --no-ff --no-commit --no-rerere-autoupdate <new-owned-main-sha>`. Inspect both sides of
new conflicts and all overlapping changes, including cleanly merged files, before staging and
committing the catch-up. A recorded `rerere` resolution is a proposal to review, not acceptance.

This owned-main catch-up preserves the original merge and its official second parent. Do not
cherry-pick main's commits, replay the upstream merge, or restart on a fresh branch merely because
main moved. If the upstream merge is still uncommitted, finish and review it before catching up;
Git cannot begin another merge while it is in progress. If new main already contains the alignment
or changes its upstream or protected-policy boundary, reassess the branch rather than applying the
ordinary catch-up mechanically. Recreate the alignment only when its existing merge cannot be
safely carried forward, and record the reason.

Review the new owned changes against the composed behavior, run focused checks for their overlap,
then run the final gates and the upstream provenance check against the resulting candidate and
current owned main. In the receipt, retain the original owned base and upstream merge ID and also
record the owned-main commit and catch-up merge ID. The catch-up does not advance `integrationBase`
or replace `lastRefreshMerge` with an owned-main merge.

## 4. Audit protected seams

Every alignment explicitly reviews:

- Scient product labels, icons, protocols, package identity, and retained compatibility names;
- `scient-next` state roots, client persistence partitions, and migration history;
- retired projectless-thread cleanup and historical decoding, conversation forks, queue/steer
  semantics, Skills, Sources, voice, analysis, compute, PDF, LaTeX, rich chat, and content direction;
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

When a quality rule, shared UI API, or cross-client contract changes, resolve the merge and run the
**affected broad static check early** (for example web lint or affected-package typecheck), before
an expensive full test run. Group diagnostics by underlying contract and fix repeated patterns
coherently. A mechanical edit is safe only with exact preconditions and reviewed behavior; do not
silence a rule, widen an exception, or create a shared variant solely to make diagnostics disappear.
Use an existing generic variant when it preserves behavior. Put genuinely reusable appearance in a
small shared variant or size; keep feature-specific composition feature-owned. Check focus,
disabled, responsive, pointer, and dark/light behavior when visuals change.

After the upstream merge, expected owned-main catch-up, and code composition stabilize, run the
complete local gate once using the repository versions of Node and pnpm:

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

Record the checked revision and results. If later edits change only maintainer documentation or
formatting, reuse unaffected runtime-test evidence after inspecting the exact diff. For code,
fixtures, generated inputs, contracts, or dependencies, rerun the checks those edits can affect;
shared contracts and test setup commonly require wider requalification. Diagnose a single failed
or load-sensitive lane before rerunning the entire matrix, and report a partial aggregate result
honestly. Hosted CI still checks the final pushed revision. This ordering does not remove any final
gate or replace behavioral, visual, or protected-seam review.

The four Scient seam commands now share one snapshot/diff implementation and their existing
manifests. During composition, run
`pnpm alignment:seams:check --base <owned-base-sha> --upstream-ref <official-target-sha>`;
add `--snapshot index` for staged content or `--head <candidate-sha>` for an exact commit.
Without `--base`, the result checks current locators only and explicitly does **not** audit a
changed-file diff. The local snapshot uses private temporary Git index/objects and includes
deletions and non-ignored untracked files. Reference snapshots under `.repos/` are counted but
not scanned as product code. The command reports `passed`, `review-needed`, `failed`, or
`unavailable`; it proves neither behavior nor ancestry. A moved locator is a review signal:
trace the new implementation and callers, update the manifest only after establishing the same
behavior, then rerun the behavioral tests. Never remove an assertion just to turn the gate green.
The existing per-feature commands, including CI entry points, now use this same implementation;
they are not independent fallbacks. If it needs repair, continue independent review, repair it
with equivalent evidence, and do not claim the affected gate passed prematurely.

Run additional focused gates required by the range, including mobile native checks, release smoke,
provenance, migration, and provider seam tests where applicable. User-facing desktop behavior also
requires an isolated synthetic-state app from the exact candidate head and a proportional visual and
interaction review. Automated checks do not establish visual acceptance.

## 6. Record and review

Create a dated receipt under `docs/internals/` that records:

- exact owned base, previous official boundary, target, range, target tag, upstream merge commit,
  any later owned-main catch-up commits, branch, and disabled upstream push boundary;
- integrated behavior and any activation held behind a tested compatibility or policy gate
  (not omitted upstream commits);
- every meaningful conflict composition and any semantic issue found after Git's merge;
- protected-boundary results and temporary compatibility gates;
- exact verification performed, including skipped platform or live-provider checks;
- emerging upstream enforcement/deprecation debt, with a measured scope and follow-up condition
  when applicable; and
- the publication boundary.

Only after the history-preserving merge exists and its gate passes should `upstream-state.json` and
the current pointer in `UPSTREAM.md` advance to that exact target and merge. Push a draft pull request
for review. Do not merge to `main`, publish, or clean the worktree until review and user acceptance
authorize those separate actions.

In `UPSTREAM.md`, identify the alignment's Scient pull request by number without describing whether
the PR is open, draft, or merged. Its current lifecycle is directly checkable on GitHub, and the
integration record should not need a follow-up edit just to keep that status current.

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
