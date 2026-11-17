# Scient Desktop

ScientFactory owns Scient Desktop; Yaacov is the accountable owner.
Upstream edits to Scient policy are proposals, not automatic adoption, including
policy in linked guides. This file controls Scient-specific policy where a guide
conflicts; report the conflict rather than silently choosing another rule.
If a rule conflicts with the task, explain it and obtain human approval before
breaking it. Do not ask again for an action already explicitly authorized.

## Where code lives

- `apps/server`: provider processes, workspace operations, persistence,
  orchestration, terminals and version control.
- `apps/web`: React client; `apps/desktop`: Electron/native integration;
  `apps/mobile`: React Native; `apps/marketing`: website.
- `packages/contracts`: schemas/contracts; `packages/shared`: utilities;
  `packages/client-runtime`: shared client connections and domain state.
- `packages/scient-*`: Scient capabilities. Check the relevant owner and integration
  points before duplicating a capability in an app.
- `.repos/`: read-only reference code; do not edit it or import from it.

Architecture: [overview](docs/internals/overview.md); terminology:
[glossary](docs/internals/glossary.md).

## Shared quality defaults

Read the relevant owner before choosing or changing an implementation:

- For server features or transports—RPC, HTTP routes, MCP tools, scheduled tasks
  and CLI entries—read [Effect services](docs/internals/effect-services.md).
  Capabilities live in services; transports only decode, call one service method
  and map errors. Protocol complexity belongs in adapters, not shared orchestration
  or presentation code.
- Before writing Effect code, read `.repos/effect/LLMS.md`. The project service guide
  governs project conventions; the local library reference supplies API semantics.
  Reusable functions use named `Effect.fn("Service.operation")`; keep `Effect.gen`
  for inline programs and layers. Preserve span names/options and pass combinators
  as builder arguments. Untraced work follows the guide's listed cases and explains
  its reason nearby; a loop alone is not an exemption.
- For web controls/styles, read [web UI](docs/internals/web-ui.md). Shared controls
  own their appearance: select a variant/size, not a restyling `className`.
  Generic new looks become shared variants; feature-only looks stay in that feature.
  Layout classes belong on the parent.
- Before writing or reviewing tests, read [testing](docs/internals/testing.md).
  The Scient coverage and clock-lifetime rules below define project policy;
  the guide supplies compatible authoring details and examples.

Prefer inferred types; avoid `any`. Default to no comment. Write one only for a
constraint, external quirk or invariant the code cannot show, in one line where
possible and four at most. Do not restate names/signatures, narrate steps, record
history or explain the fix just made; the PR carries that.
React effects synchronize with systems outside React, not derived state or user
actions. Existing lint supplies mechanical checks and suppression syntax; a reason
comment does not justify evading the design constraint.
UI status reflects the work it describes. No continuously repainting animations;
high-refresh displays amplify their GPU cost.

Client mutations use `createEnvironmentRpcCommand`; register protected methods in
`CLIENT_GUARDED_RPC_SCOPES`, use `permissionAtom` for UI availability, and extend
permission behavior tests. The destination server checks grants at execution.
Raw RPC clients stay in `rpc/`.

## Architectural boundaries

The server owns execution/workspace access, including for remote clients. Client
paths and credentials are not server paths and credentials.
Orchestration V2 owns live execution. `Orchestrator` serializes commands per thread
and owns queue admission, order, holds and advancement. `EventSink` commits facts,
projections, receipts and outbox effects transactionally; workers execute after
commit. A command receipt is not effect completion. Extend native queued runs and
[their UI integration](docs/internals/scient-thread-queue.md), not retired engines,
reactors, provider service or queue ledger. Legacy readers only import or recover.

Route models/sessions by provider instance ID, not driver kind. Adapters own protocol
differences; shared UI consumes capabilities. Unknown, unsupported, default and
explicit settings differ. Shared changes cover affected clients, entry points,
adapters and connection modes. Settings cover existing configurations, fresh setup
and reload; repairing a development profile does not prove those product paths.

## Development traps

- Preserve unrelated working/staged changes, including the user's and other agents'
  edits, and running apps. Commit only the changes within the requested scope.
- Before launching, verifying, restarting or stopping a desktop candidate, read the
  checkout's `.scient/skills/scient-dev-app/SKILL.md` if not already supplied, and
  follow the [candidate guide](docs/operations/local-dev-app.md) and its host-specific
  route. Switch the stable app only with `pnpm dev:app:review <ref>` under the
  [stable-review procedure](docs/operations/dev-app-review.md); never hand-edit its
  review checkout, profiles or launchers. Read-only inspection does not authorize
  lifecycle changes.
- Stable and feature candidates have separate identities/state. Use the owning
  candidate's lifecycle commands; a matching process name/path is not ownership.
  Never kill by broad patterns. Leave any candidate the user is reviewing available;
  do not stop or restart it merely to tidy up.
- Renderer HMR does not refresh the backend bundle. Refresh that candidate's backend
  after server/bundled-dependency changes before claiming those changes were tested.
- Reading, copying, importing or modifying live Scient/T3 data requires explicit
  authorization for that data and operation. Use synthetic state; never test against
  a live profile. Keep credentials out of logs, fixtures, captures, commits and replies;
  do not copy provider credentials between profiles.
- Inspect resolved runtime paths. Installed, stable and feature profiles differ;
  do not assume all state lives under `userdata/`. Preserve compatibility-sensitive
  package names, environment variables, storage/migration paths and identities,
  formats and license notices, including `scient-next` values. These are not cosmetic
  branding to rename.
- Leave `VITE_HTTP_URL`/`VITE_WS_URL` unset for ordinary development; use Vite's
  same-origin proxy. Give new web clients the generated pairing URL, not a bare
  origin, and share its credential only with the intended tester.

## Development and verification

Use pinned versions/lockfile. `vp i` installs; `vp run dev` starts server/web.
If `.t3/setup-running` identifies active setup, wait for `.t3/setup-done` or
`.t3/setup-failed`; inspect failure rather than starting a second install.
Do not overlap installs or heavy local suites. Commands/platform prerequisites:
[development](docs/operations/development.md).

### Verification

Use focused tests, formatting, lint and affected-package checks while iterating.
`vp run check:changed <ref>` includes uncommitted changes and does not replace final
qualification. Use `vp run typecheck` in affected packages, including those without
an npm typecheck script; run snippets from the owning package so dependencies resolve.
Run `pnpm run knip:check` when files, exports or dependencies change. For regression
fixes, prove the focused test fails on broken behavior and passes with the repair;
retain a negative control when practical, not a permanently failing test suite.

After the candidate stabilizes, run applicable focused checks plus:

```sh
pnpm exec vp fmt --check
pnpm exec vp lint --report-unused-disable-directives
pnpm run typecheck
pnpm run test
pnpm run build
pnpm run test:desktop-smoke
git diff --check
```

Record commands, revision/diff, environment, results and gaps. Reuse matching evidence;
rerun checks invalidated by later edits. Shared contracts, test setup, orchestration,
packaging and broad dependency changes usually need wider requalification.
Formatting/maintainer-doc edits alone do not invalidate runtime results; runtime-loaded
Markdown, Help, fixtures and generated inputs follow their consumers. Hosted CI
qualifies the pushed revision but does not replace local platform checks when the
changed behavior depends on that platform. Interim reviews identify checks still open.
Run `pnpm brand:check` after branding changes or upstream merges. Alignments follow
[the alignment protocol](docs/internals/upstream-alignment-protocol.md).
`pnpm alignment:gates` adds knip/brand and clears live-profile variables for its gates.
Use the checkout's [runner](scripts/scient-alignment-gates.mjs) and
[runner documentation](docs/internals/scripts.md); package-completion, concurrency
and cross-worktree locking behavior depend on that revision. Do not assume a lock
or parallel execution that the checkout does not implement.

Keep tests for distinct behavior, guarantees and failure modes, not incidental copy,
markup, classes, constants, wiring or mock echoes. Avoid redundant cases; another
row earns its place by guarding a distinct outcome, boundary or failure mode, not
merely a different literal. A shared implementation branch alone proves neither
redundancy nor equivalence. Use Node for pure logic and browser tests for DOM/React.
Keep fix-commit regression tests; if the title omits their purpose, record
`// regression: <sha> <subject>`. Before deleting a test that asserts behavior,
break its covered logic and show a retained test fails. Do not assume equivalence
from a shared code path or an upstream deletion, or evade proof by calling a test
obsolete, low-value or flaky. Intentionally removing the guarded behavior needs
explicit scope, not a claim that another test still covers it.
Keep Scient extensions to upstream tests in `.scient.` siblings.

Use receipts, persisted events and worker completion for asynchronous tests; controlled
clocks for time. The test guide owns wait/retry/skip rules and browser-resource setup.
Scient browser tests use `apps/web/test/render.tsx` and disposable resources. Use its
ownership-aware `fakeTimers()` helper, not raw clock installation/restoration.
Put post-mount fake timers on an outer fixture stack and run screen cleanup/unmount
before disposing that stack, so the tree cancels its fake-clock work while the clock
is still installed. Post-mount spies instead dispose before unmount.
A timed-out test can keep running against a shared clock: use `advanceTestClock(signal,
ms)` from `apps/web/test/testClock.ts`. Custom waits must not advance that clock after
their test aborts. Fake time does not lay out DOM; use `apps/web/test/listMeasurement.ts`
for list readiness. Wait on the state under test, not a fixed delay or frame/step count.
Browser readiness waits default to 5 s; a shorter readiness claim sets its waiter
deadline, not a test-case timeout or retry.
Prove flake fixes fail-before/pass-after under the same targeted slowness/probe:
`SCIENT_TEST_CPU_THROTTLE=6 vp test run <file>` in `apps/web` (about 4 for fast-runner
conditions, 6 for slow-runner conditions, 8 for stress; not a hardware guarantee).

Prove a UI change with before/after screenshots of every screen it changes, in light
and dark, checked against the [UI checklist](docs/internals/web-ui.md#ui-checklist);
capture the before-state before editing. The agent that opens the PR captures them.
Verify user-visible frontend changes once after integration in a real browser or
simulator without asking first, using synthetic state. The primary agent performs
this pass; subagents do not launch duplicate dev servers. This does not override
host/tool restrictions or authorize consequential actions. Mocks/markup do not prove
real-provider/native compatibility; automated proof and the user's visual acceptance
are separate.

## Git, upstream, and delivery

- `origin`: `ScientFactory/scient-desktop`. `upstream`: official `pingdotgg/t3code`,
  fetch-only with push URL `DISABLED`. No direct product commits to `main`.
- Commit/push/open/merge/release only within the authorized workflow. Before opening
  a PR, check its relationship to current main. Choose alignment according to branch
  ownership; do not automatically rebase shared history. Respect unresolved blockers;
  report conflicts rather than resolving them without the relevant authorization.
- Use GitHub's merge queue; do not bypass checks or jump the queue except through
  the approved admin procedure below. When merge is authorized, set auto-merge on the
  conflict-free head that had its review (see the PR template) (`gh pr merge <number> --merge --auto
  --match-head-commit <sha>`); the queue takes it when required checks pass, so
  nobody watches it. Without that authorization leave auto-merge off: non-draft or
  green alone is not permission.
- Do not merge main solely for CI reuse or repeatedly realign a queued branch:
  an update adds another PR run and can serialize work the queue runs together.
  Align for conflicts, dependencies or sensitivity to intervening changes. Before
  correcting a queued or auto-merge-enabled PR, dequeue and disable auto-merge; verify and review the new
  head before requesting delivery again. Push locally verified corrections together,
  not as a series that repeatedly restarts CI. Return PR/CI links; do not monitor
  unless asked.
- After queue removal for `failed_checks` on an unchanged authorized head, inspect
  its timeline and match every failure against open
  [flake signatures](docs/operations/ci-flakes.md). If this is the first removal of
  that head and it qualifies, re-add once right away. If it was removed earlier as
  well, stop and tell the user. Never re-add a typecheck, build, provenance or unknown
  failure. Investigate nonmatching failures and record any newly confirmed flake
  with an owner before further delivery attempts. A row is not a failure waiver.
- Admin-merge only with explicit approval for that PR's reviewed head and accepted
  failures matching open flake signatures. All checks must have finished and the
  head must contain current main. Recheck head, checks and main immediately before
  merging; a head pin does not lock main. If these conditions cannot be maintained,
  return to the queue. Every other underlying check must pass; red aggregates qualify
  only when solely caused by accepted flakes. Never bypass unknown, build/typecheck,
  format/lint, documentation or provenance failures.
- The admin procedure's temporary protection change must be explicitly covered by
  approval; one informed approval can cover both it and the merge, without a second
  ritual prompt. The named procedure is: inspect the `Main merge queue` ruleset,
  record its pre-state, dequeue the PR, temporarily add the `Repository admin` role
  as bypass actor, merge the pinned head with a merge commit, then remove that bypass
  at once in `finally`, on success or failure, and verify restoration. The role bypass
  is repository-wide while present, not scoped by GitHub to this PR. This procedure
  assumes no standing bypass actors; if live controls differ, stop and report rather
  than disabling protection or substituting another actor. Preserve unrelated fields
  and concurrent edits; do not blindly restore a stale full snapshot. `finally` is
  not transactional: report unexpected state or unverified restoration immediately.
  Verify inclusion on main, tell the user that already-queued runs restart, and give
  the main-push CI link. This is not permission for release or unsolicited monitoring.
- Repository protection, deployment environments, secrets, cloud/telemetry/updater,
  background services, signing and publication require explicit scope. Generic merge
  permission does not authorize those controls. When authorized, follow the relevant
  operations/release runbook, not an improvised procedure.
- Preserve literal upstream ancestry and dedicated alignment branches, separate
  from product changes. Before changing protected Scient divergence, read
  `UPSTREAM.md`, `upstream-state.json` and its linked record. User-facing language is Scient.

### Definition of done

Report work as done only when all of these hold on the final head:

- focused tests and typecheck pass, plus the final checks [Verification](#verification)
  asks for;
- a UI change has its before/after screenshots in the PR, as Verification describes;
- every link a reader can follow that the change adds (docs, UI, PR text) was fetched
  once and works;
- the PR states platform behavior, as below, and its review and result;
- the delivery the task allowed is complete: the PR is open, with auto-merge set if
  merge was authorized. Without PR authorization, the handback names the branch, head
  and what is still owed.

Use conventional-commit titles. PRs include problem, resulting behavior, verification,
documentation impact and model/harness attribution; follow
[CONTRIBUTING.md](CONTRIBUTING.md) and the PR template.
PRs and handbacks state expected behavior, actual checks and unproven claims for
macOS, Windows and Linux. Lead with differences, including inherited gaps, skipped
paths and anything never run on a real Windows or Linux computer. Justify “unaffected.”
Shared expected behavior may use one explanation; execution evidence and unproven
platforms must remain explicit. CI mocks do not qualify OS authenticators, installed
browsers, live sites or installed builds.

## Documentation

Update the existing durable owner: `docs/user/` for Help, `docs/internals/` for
architecture/guidance, `docs/operations/` for runbooks and `UPSTREAM.md` for divergence.
Use [docs/README.md](docs/README.md) and its cross-repository links to locate relevant
owners. Read them before working and check whether they describe current behavior,
a proposal or history. Use available local/authenticated Scient access; external
contributors need not obtain private-repository access.
Keep current guidance distinct from proposals/history. Update facts/instructions when
they change; document durable constraints, not field inventories or implementation
narration. Keep temporary plans, transcripts, scratch and PR-only media out of
committed source. PRs include `Documentation impact: None — reason`, `Updated — paths`,
or `Dependent PR — repository and link`.
