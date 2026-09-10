# T3 alignment through 2fa5ef4c

Status: draft review candidate; local automated qualification passed; human acceptance pending.

## Exact boundary

- Owned base: `5fa81d99e3172de8ee7a666c7eb80dababe60cd4` (includes PR #238).
- Previous integration base: `5f878d2a85807618a4c8571cdef5daa3124672d6`.
- Official target: `2fa5ef4c7bf3aafabe98392d25be7eb86847ce8f`.
- Range: 150 official commits; no cherry-picks or unmerged upstream PRs.
- Target description: `v0.0.39-nightly.20260905.1284-9-g2fa5ef4c7b`.
- History-preserving merge: `7dd0eb2fbe84152a9961de13c64a78de0b340b65`.
  Its first parent is the owned base and its second parent is the official target.
- Branch: `codex/t3-sync-2fa5ef4c-20260905`.
- Worktree: `scient-t3-sync-2fa5ef4c-20260905` under `ScientFactory-worktrees`.
- Official remote remains fetch-only, with push URL `DISABLED`.

This is a bounded alignment, not a claim that later upstream commits are integrated.
The initial merge had 80 conflicting paths (74 content, one add/add, five
modify/delete), within 210 paths changed on both sides. Automatic merges were
also reviewed. The merge result changes 595 files relative to the owned base.

## Adopted improvements

The complete official range remains literal ancestry. Important behavior includes:

- Chat/timeline and persistence performance improvements, sent-prompt Up/Down
  history, focus/picker fixes, long-running duration display, retained diagnostics,
  native-question dismissal, and clearer Codex file-change approvals.
- File-editor grammar readiness, stale-highlight rejection, and autosave lifecycle
  fixes; workers are scoped to views that need them.
- Checkpoints captured after edits finish, including interrupted turns.
- Owner-verified external-provider updates, cached maintenance discovery, and safer
  command quoting. Ambiguous ownership stays manual-only.
- Progressive usage loading, price overrides across selected environments, shared
  opt-in restart continuation, custom-model controls, and settings refinements.
- Claude usage-limit pauses, capability/usage discovery improvements, skill-name
  support, preview keyboard isolation and bounded automation waits, Safari import
  permission recovery, terminal truecolor, and Git/PR performance fixes.
- Compatible mobile/connection changes and CI/release reliability fixes, without
  enabling Scient cloud, mobile publication, telemetry delivery, or releases.

## Significant compositions and self-review findings

### Provider lifecycle and caches

Upstream owns generic external-provider maintenance discovery and installer
ownership verification. Scient's managed installation/update/repair/remove path
remains separate: a private managed binary is not handed to a generic native or
package-manager updater. Effective binary paths and environments are used for
external probes. Retired/rebuilt instances cannot be updated using stale registry
configuration. Existing Antigravity model/reasoning selection is retained.

Scient publishes current provider state before writing its disk cache so a slow
write cannot delay terminal lifecycle status. Two inherited cache tests assumed
the reverse ordering and hung. Their test helper now observes the actual atomic
cache-file rename before asserting persistence; production ordering was not
changed. The stale-snapshot regression test remains. Registry tests: 54 passing.

Claude capability/skill initialization remains bounded; optional usage discovery
cannot erase already available skills or leave initialization unbounded. Scient's
per-turn skill preparation stays before send. Missing-working-directory tests use
real synthetic directories rather than bypassing the new upstream preflight.

Portable test fixtures use the test runner's absolute Node executable instead of
assuming `node`/`dirname` are in the child's PATH. A regression test exercises an
empty PATH and a directory containing spaces and an apostrophe. Cursor's symlink
skill test canonicalizes the root (macOS `/var` versus `/private/var`) while still
requiring the link name and excluding traversal below the linked package. No
production path/ownership checks were loosened. These focused suites pass 46 tests.

### Conversation lifecycle and rich output

Scient queue/steer semantics, fork baseline markers, and task plans are composed
with upstream incremental timeline projection and runtime-context queries.
Task-plan streaming has a regression test. Generated-image recovery performs a
full thread read only when that recovery path needs it, not for every token.
Interrupted turns still settle Scient queue barriers after checkpoint handling.

Three upstream PR-merge settlement tests relied on an enabled-by-default setting.
Scient intentionally defaults it off. Those tests now opt in explicitly; an added
test verifies the default opt-out leaves the thread active even after its PR
merges. All 12 settlement tests pass without changing production behavior.

Stable Markdown renderer components preserve rich-output mounting during
streaming. Scient images/gallery, scientific output, floating controls, math,
directionality, citations, and file/media navigation remain. Upstream PR hovercards
and privacy-aware link behavior use the existing routing boundary.

### File editing

Upstream save coordination is composed with Scient revision-based conditional
writes, retry/failure reporting, and explicit discard. Effect replay creates a
fresh active coordinator; callbacks from retired sessions cannot publish saves.
Tests cover confirmed-revision progression and pending edits not adopting a
remote revision. The Pierre patch retains Scient cleanup and adds the upstream
grammar/readiness and stale-highlight fixes.

DOM-only Markdown source tests replace only the browser-worker provider with a
passthrough; the actual editor remains under test. They do not establish integrated
worker rendering. Electron startup smoke likewise is not file-editing acceptance.

### Settings, privacy, and product authority

Scient models-first settings, compact version/name layout, assisted lifecycle,
scientific feature mounts, and existing defaults remain. Retired projectless
creation is not reintroduced; historical replay remains supported.

New upstream turn analytics still pass through Scient's existing consent and
property allowlists. This alignment does not activate delivery or widen that
allowlist. New inherited telemetry documentation incorrectly described upstream
defaults; it was corrected to Scient's actual disabled-by-default policy.

Release changes are confined to the correct Windows Spectre component and Ubuntu
mirror setup. The release-source test allows the exact repository-owned mirror
action, verifies it contains no nested actions, and retains SHA requirements for
remote actions. Manual release/publish guards are unchanged. SSH provider probes
retain Scient's explicit package lifecycle-script allowlist while adopting upstream
executable resolution. No shipped database migration is rewritten or reordered.

### Documentation

Upstream documentation consolidation was not allowed to erase Scient's maintained
feature and operations guidance. Conflicting owner documents retain Scient's
details with narrow updates for actual new behavior. Referenced legacy owner pages
remain; removed-path links were repaired. New development and connection guidance
distinguishes isolated local candidates from inherited cloud infrastructure and
publication authority. Appearance guidance links to the existing theme owner
instead of duplicating it.

## Qualification

Verified with repository Node 24.19.0 and pnpm 11.10.0:

- Frozen-lockfile installation; composed dependency lock regenerated before it.
- Workspace typecheck and production build.
- Desktop startup smoke (not visual acceptance).
- Brand and analysis/Skills/onboarding/LaTeX seam checks.
- Web unit suite: 572 files, 6,043 tests passed; focused provider/runtime/checkpoint
  suite: 17 files, 310 tests passed; registry suite: 54 tests passed.
- Formatter: 4,461 files passed. Lint passed with warnings, no errors.
- Workspace test graph: all non-server packages passed. The final full server
  rerun after the two fixture corrections passed 419 files and 5,356 tests;
  eight files/40 tests remain skipped. This supersedes the earlier server result
  of 5,353 passing/two failing tests. No failing test was excluded from the rerun.
- Typecheck and lint were rerun after the fixture corrections. Production source
  did not change after the successful build and desktop smoke.
- Literal-parent provenance and whitespace checks passed; integration state moved
  only after the successful final server result.

Hosted CI subsequently caught an omitted classification for the extracted
`useFileSaveCoordinator.ts` mount. Local seam checks had validated the manifest
without the PR diff. The hook is now classified as an upstream mount carrying
revision-checked writes, and the analysis/LaTeX checks were rerun with explicit
`--base`, `--head`, and `--upstream-ref` arguments, matching the hosted gate.

An earlier concurrent web run exceeded an existing one-second Mermaid grammar
test wait under load. The unchanged focused test and the full web suite passed
with bounded concurrency. No assertion or timeout was weakened. Final workspace
tests run the same package test graph with package concurrency limited to one:
`pnpm exec vp run -r --concurrency-limit 1 test`.

Qualification commands (repository root unless noted):

```sh
pnpm install --frozen-lockfile
pnpm exec vp fmt --check
pnpm exec vp lint --report-unused-disable-directives
pnpm run typecheck
pnpm exec vp run -r --concurrency-limit 1 test
pnpm exec vp test run # final complete server rerun, from apps/server
pnpm run build
pnpm run test:desktop-smoke
pnpm run brand:check
pnpm run analysis:seams:check
pnpm run skills:seams:check
pnpm run onboarding:seams:check
pnpm run latex:seams:check
node scripts/verify-upstream-provenance.mjs --base 5fa81d99e3172de8ee7a666c7eb80dababe60cd4 --head HEAD --official-ref 2fa5ef4c7bf3aafabe98392d25be7eb86847ce8f
git diff --cached --check
git diff --check
```

Native Windows, iOS, and Android execution is not qualified here. The mobile scan
could not run SwiftLint, ktlint, or detekt because those tools are unavailable.
No live provider turns, OAuth, microphone capture, installed-provider mutation,
production credential copying, or release publication was performed.

## Human review and publication boundary

The user explicitly reserved visual review. No computer use or screenshots were
performed. An isolated candidate app will be left available, with its own ports,
bundle identity, and `.scient-next` state. Process readiness does not mean that
human review passed.

Verified candidate: `Scient (Dev) · scient-t3-sync-2fa5ef4c`, bundle identifier
`com.scientfactory.scient.next.dev.scientt3sync2fa5ef4c20260905`, renderer port 7497,
backend port 15537. Managed launcher status, listener ownership, the well-known
environment HTTP endpoint, renderer HTTP 200, and desktop trace events for
backend readiness/main-window creation were checked. No existing stable launcher
or other agent's app was replaced or stopped.

Prioritize chat streaming/queue/steer and prompt history; file source editing,
save/reopen and preview switches; rich Markdown/media; provider settings and
managed/system ownership; usage/settings; and project/fork navigation. Use a
disposable workspace for edits. A live provider turn and a managed update are
separate manual checks, not claims made by the automated suite.

Do not merge this candidate to main or delete its worktree before user acceptance.
Draft review and automated CI are not publication authorization.
