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

When upstream replaces a subsystem, remove Scient's copy of the old subsystem in the same
alignment. Never keep superseded execution code compiling beside its replacement: green tests
of dead code hide lost behavior. Preserve required immutable formats/migrations through bounded
readers, and port Scient behavior into the live replacement.

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

### Compose reviewed owned implementation branches

Preserve authored Scient branch history when integrating an independently reviewed
implementation batch. Record each introduced owned merge in
`upstream-state.json`'s `ownedIntegrationMerges`: a unique ID, full merge commit,
its two full ordered parent commits, and a committed maintainer review record
under `docs/`. The provenance checker requires the exact actual parent vector,
the merge in the inspected candidate's history, and a regular nonempty review
record committed in that candidate. A local or symlinked report is insufficient.

This records only the exact reviewed merge edges. Every nested merge introduced
by the implementation branch is still checked; an owned branch must not carry
an unreviewed upstream PR parent. Keep the original owned base, official target,
historical donor exceptions and trusted queue/push modes unchanged. An owned
composition does not advance `integrationBase` or qualify runtime behavior.

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

### Keep Scient implementation outside upstream hosts

Keep Scient policy and scientific capability bodies in their existing Scient-owned modules.
An upstream-owned service, component, driver or contract should retain only the narrow import and
call/mount needed to compose that behavior. Mark both boundaries with paired `SCIENT-FORK:START`
and `SCIENT-FORK:END` delimiters appropriate to the file format. A single explanatory comment is
not equivalent to a paired region in the divergence inventory. Do not move a whole upstream
function or renderer merely because one branch is Scient-specific; keep its generic host logic
upstream and extract only the Scient decision or capability. The
[current separation map](./scient-fork-divergence.md#extracted-owners-and-host-mounts) names the
maintained owners and mounts.

Never copy a helper to establish a second owner: import the existing implementation. Consolidate
helpers only when their behavior is identical, including property-read order, short-circuiting and
error precedence. Similar-but-different provider policies remain separate. Delete code with no live
consumer instead of moving it, while preserving any assertion that also protects a live path.

Preserve genuinely consumed public or legacy import surfaces, including their types, with a marked
re-export when the existing surface remains part of the live contract. This is not permission to
restore retired aliases, compatibility shims or unused re-exports; migrate cutover callers and remove
their obsolete paths. Keep extracted boundaries on named concrete input/output or service-shape
types, rather than deriving a public contract from a helper's implementation return type. Avoid value
import cycles that read a binding during module initialization.

Preserve the semantic continuation, not just a copied body. Keep the original order of awaits,
currentness checks, side effects, error mapping, SQL writes and publication. An asynchronous helper
that checks ownership and then returns can introduce a scheduling boundary before the caller's
protected side effect; revalidate at the original side-effect boundary or retain that continuation
together. A synchronous same-stack helper call/return does not itself open a scheduling turn.
Capture the same mutable owner and read it at the same point; do not substitute a later snapshot.

On hot paths, extraction must not add Effect operations, generator/suspension wrappers or yielded
no-ops to inactive branches. Keep originally synchronous predicates synchronous. Even an
uninterruptible region does not make extra Effect steps scheduling-equivalent. Preserve lock order,
scope/finalizer ownership and live callback/ref identity, as well as React hook order, component
identity, keys and mount conditions.

For the declared extraction scope, reduce Scient implementation left inside upstream files and
aggregate added non-test source lines across that scope, while keeping scoped inventory debt nonincreasing.
Already-marked code can move out with zero debt before and after; strictly decreasing an already-zero
debt count is neither possible nor required. Record exact official/base/candidate inputs for the
comparison. Source-line and inventory findings measure different things; neither is behavior proof
or a blanket line budget. The existing inventory remains advisory unless its separate reviewed
activation procedure actually enables a ratchet.

#### Reproducible separation measurements

Count **Scient lines inside upstream files** as added non-test lines in `apps/` and `packages/`
files that exist at the exact official upstream snapshot. This is the host metric, not the total
size of all Scient-owned modules. Compare the same paths and exclusions at the extraction base
and candidate. The reproducible example below uses the historical separation interval recorded in
the [alignment receipt](./t3-upstream-sync-20261003-ca7df394ed.md); it is not a claim about the final
receiving tree or a change to the qualified upstream cursor. For another interval, replace `BASE`
and `CANDIDATE` with its full 40-character commit IDs and record all three inputs.

```sh
UPSTREAM=ca7df394ed8151fa77f856beefa90bc60a785d60
BASE=6ced7918d858ba35aec6b4f85d2ba6b2bf15436e
CANDIDATE=f835e5adf9b33725f20dcc92bc44c77ed0a8fcdc
for revision in "$BASE" "$CANDIDATE"; do
  printf '%s: ' "$revision"
  git diff --numstat --no-renames "$UPSTREAM" "$revision" -- apps packages |
    awk -F'\t' -v up="$UPSTREAM" '
      BEGIN { cmd = "git ls-tree -r --name-only " up " -- apps packages"
              while ((cmd | getline p) > 0) base[p] = 1 }
      $1 != "-" && ($3 in base) &&
      $3 !~ /(\.(test|spec|testkit|fixture)\.|\/(testkit|testUtils|fixtures|__tests__|e2e)\/)/ {
        lines += $1; files++ }
      END { print lines " lines in " files " files" }'
done
```

Pair that measurement with the existing
[divergence inventory](./scient-divergence-inventory.md), using the same full commit IDs:

```sh
node scripts/scient-divergence-inventory.mjs \
  --upstream "$UPSTREAM" --candidate "$BASE" > divergence-base.json
node scripts/scient-divergence-inventory.mjs \
  --upstream "$UPSTREAM" --candidate "$CANDIDATE" > divergence-candidate.json
```

For the declared separation scope, neither the host-line metric nor `counts["new-debt"]` may rise;
line reduction is expected while debt may stay zero or otherwise unchanged. `counts.marked` may
rise when an unmarked edit becomes a marked mount or fall when a marked implementation moves out.
Preserve reports and the comparison scope as structural evidence, not as new source-count tests,
automatic CI activation or behavioral qualification.

## 5. Validate progressively

While composing, run focused tests for every touched contract and protected seam. Then audit the
entire staged diff for conflict markers, duplicated branches, stale product copy, accidental package
changes, and silently reintroduced upstream authority. Regenerate generated artifacts and lockfiles
from the composed sources; do not hand-edit generated conflict blocks.

Before deleting superseded code, inventory Scient-added assertions and fixture or parameter
conditions, including those inside inherited upstream tests. Exclude only untouched upstream-only
conditions. Group the remaining promises by feature; mark a behavior **covered** only when a live
replacement test asserts its deciding conditions, and port real gaps. Test titles, file origin,
import reachability and test counts do not establish origin or equivalent behavior. Unresolved
Scient conditions block deletion of their only proving path.

Retire one dependency-cleared family at a time: preserve its needed helpers and readers,
confirm its replacement conditions, disconnect the old execution path, then remove its source
and obsolete tests in a compiling commit. Unrelated unresolved families do not create a global
deletion gate. Shared interfaces with multiple live consumers still require an atomic cutover.

Reuse genuine existing behavior coverage when it asserts the same deciding conditions; do not add
duplicate cases merely to make a retirement inventory look complete. Coverage of a historical
reader does not qualify live execution, and source structure does not establish app behavior.

Permanent tests must exercise consumer-visible behavior and its deciding boundaries, not read
upstream source text, count imports/files/lines or assert a relocated call's spelling. Retire
obsolete source-text/wiring guards rather than repin them to an extracted module. Keep genuine
behavior coverage and use source/locator review only as bounded structural evidence.

Hand back each completed family with its immutable commit/tree, scoped qualification and a completed
independent review by a different reviewer. Preserve failed attempts and limits alongside the handback.
One integrator owns the receiving tree, index, final qualification and authorized app delivery;
isolated authors own only their reserved source or documentation paths. A draft or review in progress
is not an accepted input, and source acceptance does not advance the qualified upstream cursor.

The [Scient divergence inventory](./scient-divergence-inventory.md) records ownership drift.
Exact reviewed historical debt and unsupported-format exceptions are different inputs; neither
can waive missing objects, encoding failures or supported-language parser failures. Keep the
existing seam and upstream-provenance checks alongside it. Import reachability is an advisory
about code ownership, not proof that a test asserts a production guarantee.

### 5.1 Read an error count only when the syntax gate is open

`tsc` suppresses semantic diagnostics **program-wide** while any file in the program has a syntax
error. With one unparseable file, `tsc` reports zero type errors even in sibling files with
obvious mismatches. A "0 errors" reading taken while syntax errors remain means only that the
file parsed.

This is not theoretical. During the 2026-10 alignment several packages reported zero errors while
their program was semantically unchecked; when the last syntax error cleared in `apps/server`, the
same command went from "clean" to thousands of real errors. The marker count and the error count
were both correct and both misleading.

So, before quoting any diagnostic count:

1. Measure the syntax gate first, with an explicit error-class list. Do **not** use a `TS1[0-9]{3}`
   pattern — it also matches `TS18046`, a semantic code, and over-reports badly.
2. If the gate is open, the count is meaningful. If it is not, say "parses" and nothing more.
3. Re-check the gate after any bulk edit. One bad file silently invalidates every other number.

```text
grep -cE "error TS(1128|1135|1109|1005|1010|1011|1161|1434|1129|1110|1136)"
```

The same caution applies to `Cannot find module`: it reads zero while the gate is shut, for the
same reason. Treat "zero missing modules" as evidence only alongside an open syntax gate.

### 5.2 Zero conflict markers is not resolution

A file with no conflict markers can still be wrong. Concatenating both sides of a region removes
the marker and leaves the breakage behind — duplicated declarations, an orphaned block spliced
after a construct upstream replaced, or a comment left describing code that is no longer there.

Marker count, parse success, and semantic correctness are three different claims. Only the third
one is worth reporting as "resolved", and the only reliable way to reach it is the compiler.

When a region needs re-deriving, prefer the pre-resolution blobs over the concatenated text:

```text
git show :1:<path>    # merge base
git show :2:<path>    # ours
git show :3:<path>    # theirs
```

### 5.3 Structural hazards that recur on every alignment

Each of these cost real debugging time during the 2026-10 alignment and will recur unless the
check is written down.

**Duplicate wire strings defeat constant-based searches — historical V1/V2 collision.**
During the cutover, `ORCHESTRATION_WS_METHODS` and `ORCHESTRATION_V2_WS_METHODS` both mapped
`dispatchCommand` to the literal `"orchestration.dispatchCommand"`. A search for clients calling
the V1 constant therefore returned nothing even while the V1 transport was live: callers reached
it under the V2 constant's name. Those duplicate execution owners are retired; the lesson remains.
Before deleting a registration as dead, search the literal and inspect which body survives in the
handler map. One string can select only one body; deleting a duplicate silently chooses for you.

**Identical union tags cannot separate owners — historical V1/V2 collision.** The V1 and V2
command unions both declared `thread.fork` during the cutover. The tag alone could not distinguish
the payloads; routing had to inspect their fields. This is not a current dual-execution contract.

**Migration numbering drifts non-uniformly.** Upstream and the fork insert different migrations,
so the same logical migration can sit at a different id on each side, and the offset changes
along the tail. Never assume "migration NNN is the same migration on both sides". The fork's
ledger contract is pinned in `apps/server/src/persistence/Migrations.compatibility.test.ts`; a
test asserting ids must track **that** ledger, and the number in the filename and the asserted id
must agree. A name-based slot-collision check cannot detect a drift that changes what runs.

**A generated file shorter than both parents may be correct.** `effect-acp`'s generator now emits
two outputs — `_generated/schema.gen.ts` (ACP v2) and `_generated/schema-v1.gen.ts` (ACP v1).
Seeing v1 declarations "missing" from `schema.gen.ts` is the split working as designed. Check the
generator's output list before concluding anything was lost, and never hand-edit generated output
to make a count look better.

**A deleted test is only worth restoring if its behaviour still exists.** Before restoring a
deleted suite, find what it tested and whether that module was superseded. `threads-pagination`
was replaced upstream by a history-merge model (`mergeOlderHistoryIntoProjection`), so restoring
its 664-line suite would have tested a subsystem that no longer exists. Restoring the file would
have bought a green line and cost the reader a false assurance.

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
