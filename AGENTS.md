# Scient Desktop

ScientFactory owns Scient Desktop; Yaacov is the accountable owner.
This file contains Scient-specific working instructions.

Upstream changes to this file are policy proposals to review, not instructions
to adopt automatically.

## Where code lives

- `apps/server`: provider processes, workspace operations, persistence,
  orchestration, terminals, and version control.
- `apps/web`: React client.
- `apps/desktop`: Electron shell and native desktop integration.
- `apps/mobile`: React Native client.
- `apps/marketing`: website.
- `packages/contracts`: shared schemas and contract-level helpers.
- `packages/shared`: shared utilities.
- `packages/client-runtime`: shared client connection and domain-state logic.
- `packages/scient-*`: Scient capability packages. Check the relevant package
  and its integration points before adding equivalent behavior in app code.
- `.repos/`: read-only reference implementations; do not edit or import from them.

Read `.repos/effect-smol/LLMS.md` before writing Effect code.
Architecture details: `docs/internals/overview.md`.
Terminology: `docs/internals/glossary.md`.

## Shared quality defaults

- Complexity belongs at the adapter boundary. Orchestration stays pure, UI stays dumb.
- Client mutations use `createEnvironmentRpcCommand`. Add protected methods to
  `CLIENT_GUARDED_RPC_SCOPES` in contracts and use the command's `permissionAtom`
  for UI availability. Grants are checked at execution against the destination
  environment; the server remains authoritative. Keep raw RPC clients inside
  `rpc/`, and extend permission behavior tests when adding a protected method.
- Reusable Effect functions use `Effect.fn("Service.operation")` with a stable
  span name, not a function wrapping `Effect.gen`. Keep `Effect.gen` for inline
  programs and layer construction. Use `Effect.fnUntraced` only for high-frequency
  paths or an existing tracing boundary; explain the choice nearby. Named
  `Effect.fn` creates a span; the unnamed form does not. Preserve existing span
  names and options, passing combinators as additional function-builder arguments.
- `apps/web/src/components/ui` exports own their look. Pick a `variant` or `size`; do not restyle one with `className`. If none fits and the look is a generic concept, add a variant to the component; a look that belongs to one feature stays in that feature's own component, not in `components/ui`. Layout classes (width, flex, margin, position) belong on the parent. `shadcn/no-restyle` fails lint on violations.
- Inferred types over annotations. `any` is the enemy.
- Default to no comment. Write one only for a constraint, an external quirk, or an invariant the code can't show, in one line where you can and four at most. Don't restate names or signatures, narrate steps, record history, or explain the fix you just made; the PR carries that. `t3code/no-low-value-comments` enforces the length cap and the mechanical cases.
- React effects synchronize with systems outside React. Derive state in render and act in handlers; keep real lifecycle work with its owner. The `t3code/no-unreasoned-state-sync` lint rule reports every effect; one that stays states its reason with `// oxlint-disable-next-line t3code/no-unreasoned-state-sync -- <why>`.
- Our users drive agents all day and notice a dropped frame, a lying spinner, and a stale label. No continuously repainting animations; they peg the GPU on high-refresh displays.
- If a rule here fights the task in front of you, say so loudly and get a human sign-off before breaking it.

## Architectural boundaries

- The server owns execution and workspace access. Clients may connect to another
  machine; client paths and credentials are not server paths and credentials.
- Orchestration V2 is the live engine (`apps/server/src/orchestration-v2`).
  `Orchestrator` serializes commands per thread; `EventSink` commits events,
  projections, command receipts, and outbox effects transactionally. The effect
  worker performs execution through V2 services and adapters. Native runs own
  queued work; upstream's `QueuedRunsControl` is its UI, with Scient's parts in
  `apps/web/src/scient/threadQueue/useScientQueueParts.tsx`. Extend this path, not the
  superseded V1 engine, reactors, provider service, or queue ledger. Legacy
  readers are import/recovery boundaries, never execution authorities.
- Server features are services and transports stay thin: a `ws.ts` RPC handler, HTTP route,
  MCP tool, scheduled task, or CLI entry decodes input, calls one service method, and maps
  errors. See [Effect services](docs/internals/effect-services.md).
- A provider driver identifies an implementation; a provider instance identifies
  one configured runtime. Route model selections and sessions by instance ID,
  not merely by driver kind.
- Provider adapters own protocol differences. Shared UI consumes capabilities;
  unknown, unsupported, default, and explicitly selected settings have different
  meanings.
- Shared changes require checking affected clients, entry points, provider
  adapters, and connection modes. Settings changes also need to account for
  existing configurations, fresh setup, and reload. A repaired development
  profile does not establish that the product handles those paths.

## Development traps

- Multiple agents and development apps may share this machine and checkout.
  Preserve unrelated working-tree and staged changes. Commit only the changes
  intended for the requested commit.
- Follow `docs/operations/local-dev-app.md` for desktop lifecycle operations.
  Stable and feature candidates have separate identities and state. Switch the
  stable app only with `pnpm dev:app:review <ref>`
  (`docs/operations/dev-app-review.md`); never edit its review checkout,
  profiles or launchers by hand.
  The shared `.scient/skills/scient-dev-app/SKILL.md` routes agent-assisted
  lifecycle work to that guide and its Windows instructions. Read it when
  launching, verifying, restarting, or stopping a candidate; it does not grant
  permission to do those things during a read-only inspection.
- Never kill processes by broad name or path pattern. An agent's own command
  line may contain the worktree path. Use the owning candidate's lifecycle
  commands; a matching name or working directory alone does not prove ownership.
- Leave a candidate available when the user is reviewing it. Do not stop or
  restart it merely to tidy up after a task.
- The desktop renderer hot-reloads; its backend runs a bundle. Server changes
  and bundled dependency changes require refreshing that candidate's backend
  before testing them. Renderer HMR does not prove the backend is current.
- Reading, copying, importing, or modifying live Scient or T3 data requires
  explicit authorization for that data and operation. Use synthetic fixtures
  for ordinary development; never point a test server at a live profile.
- Keep credentials out of logs, fixtures, commits, screenshots, and responses.
  Do not copy provider credentials between profiles as a setup shortcut.
- Inspect resolved runtime paths. Installed, stable-development, and feature
  profiles differ; do not assume all state lives under `userdata/`.
  Existing `scient-next` storage and identity values are compatibility
  boundaries, not branding to rename.
- Leave `VITE_HTTP_URL` and `VITE_WS_URL` unset for ordinary development.
  Vite's same-origin proxy supports local and remote access.
- A newly connected web client needs pairing. Give the intended tester the
  generated pairing URL, not a bare localhost origin. Its token is a credential;
  keep it out of commits and public evidence.

## Development and verification

Use the versions declared in `package.json` and the committed lockfile.
`vp i` installs dependencies; `vp run dev` starts server and web.
If worktree setup is already running, wait for its completion marker instead of
starting a second install.
For persistent desktop candidates, use `docs/operations/local-dev-app.md`.
Other commands and platform prerequisites: `docs/operations/development.md`.

### Verification

Run focused tests, formatting, lint, and affected-package type checks while
iterating. Use `vp run typecheck` in the affected package so its Vite task runs,
including packages without a `typecheck` npm script. Run snippets from the owning
package, where its dependencies resolve. Check unused files, exports and
dependencies with `pnpm run knip:check` when changing those surfaces.
`vp run check:changed <ref>` runs the affected iteration checks, including
uncommitted changes; it does not replace the final gate below.
For a regression fix, verify that the focused test distinguishes the broken
behavior from the fix, and retain a failing negative control when practical.
Final qualification uses the applicable focused checks plus:

```sh
pnpm exec vp fmt --check
pnpm exec vp lint --report-unused-disable-directives
pnpm run typecheck
pnpm run test
pnpm run build
pnpm run test:desktop-smoke
git diff --check
```

Run the complete local gate once the candidate has stabilized. Record the
commands, revision or working diff, environment, results, and any remaining
gaps so later reviews can reuse evidence for the same candidate. After a
subsequent change, rerun the checks whose evidence the change can invalidate;
shared contracts, test setup, orchestration, packaging, and broad dependency
changes usually require wider requalification. Formatting-only or maintainer
documentation-only edits do not by themselves invalidate runtime-test results,
but runtime-loaded Markdown, fixtures, generated inputs, and user-facing Help
must be treated according to how the product consumes them.

Hosted CI qualifies the final pushed revision in a clean environment. It does
not replace local platform checks such as desktop smoke tests when the changed
behavior depends on that platform. Avoid running multiple heavy local suites
concurrently; other agents and development apps may share the machine.

Run `pnpm brand:check` after branding changes and upstream merges.
An interim review can precede full qualification; identify remaining checks.

Use orchestration receipts and worker completion signals in asynchronous tests.
Use controlled clocks when testing time-dependent behavior.
Do not add per-test timeouts or retries, wall-clock duration assertions, sleep or
yield polling loops, or browser frame/transition waits. Browser assertions use
`expect.element` or `vi.waitFor`; timed behavior uses the full controlled clock.
Skipped tests need a tracking issue and reason. Mock factories must not spread
real modules that load Shiki or diff workers.

#### Deterministic browser tests

CI runners lay out pages several times slower than a developer Mac, so a test
that passes locally can still race there.

- Wait on the state you check: a receipt, an owner's event, or a measurement
  (`test/listMeasurement.ts` for a list row's size). Never wait a fixed delay or
  a number of frames or steps, and do not let fake time stand in for rendering:
  a fake clock does not lay out or measure.
- `vi.waitFor`, `expect.poll` and `expect.element` default to 5 s in the browser
  project, for eventual readiness. A test that checks something happens quickly
  states its own `timeout`.
- Unmount before restoring fake timers, so the tree cancels what it scheduled
  on them: put `fakeTimers()` on the fixture stack that outlives the unmount.
- A test past its deadline keeps running, and the fake clock is shared. Drive
  it through `advanceTestClock(signal, ms)` (`test/testClock.ts`), which stops
  once the test's `signal` aborts. `vi.waitFor`, `vi.waitUntil` and
  `expect.poll` belong to the test that started them and stop (without moving
  the clock) once it aborts or another test starts; a fake clock a timed-out
  test left installed is removed before the next test, and its late
  `fakeTimers()` dispose leaves the next test's clock alone.
- Prove a flaky-test fix under CI-like slowness and a targeted probe (a delayed
  observer, grammar load or visibility report): fail before, pass after, under
  the same condition. `SCIENT_TEST_CPU_THROTTLE=<rate>` slows each test page's
  CPU through Chromium (4 is about a fast runner, 6 a slow one, 8 a stress run):
  `SCIENT_TEST_CPU_THROTTLE=6 vp test run <file>` in `apps/web`.

Web component tests are `*.browser.test.tsx` and render through
`apps/web/test/render.tsx`. Acquire test changes with `using` / `await using`
so disposal restores them even on failure; avoid module-level screens and
`beforeEach` / `afterEach` cleanup. Reset shared `vi.mock` factory state in a
`setup()` call at the start of each test. `t3code/require-disposable-render`
enforces this lifecycle. Test meaningful behavior rather than static markup
that only repeats props or callback wiring.
Acquire spies driven after mounting after the render, so they dispose before
unmounting; fake timers are acquired after the render too, but dispose after it
unmounts (above). A render helper that waits or interacts must own its screen in
an `AsyncDisposableStack` until it returns successfully. Give `rerender` a fresh
element. The router is enabled by default; explain any `router: false` fixture.

#### What earns a test

A test stays only if it guards something that matters and nothing else guards it:
a user-visible behavior, a data or safety guarantee, a protocol or persistence
contract, or a fixed bug.

- Do not add tests that restate copy, markup, class names, constants, callback
  wiring or mock calls, or that check a visual nit. Visual fixes are proven with
  before/after captures.
- Keep one table row per code path. Read the implementation to find the
  branches; rows that differ only by a literal on the same path add nothing.
- Put pure logic in a Node test. Use a browser test only for DOM and React
  behavior.
- Keep a test that a `fix(...)` commit added, and say why with
  `// regression: <sha> <subject>` when its title does not.
- Before deleting a test that asserts behavior, break the logic it covered and
  confirm a kept test fails. "Another test covers it", "same code path" and
  "upstream deleted it" are guesses until that check passes.
- Scient cases that extend an upstream test file go in a `.scient.` sibling
  file, so the upstream file stays identical to upstream.

Match verification to the claim: markup assertions do not establish native
interaction, and mocked providers do not establish real-provider compatibility.
Keep automated verification and the user's visual acceptance distinct.

Browser and computer interaction require user authorization within the task.
Do not ask again when the conversation already provides it.

## Git, upstream, and delivery

- `origin` is `ScientFactory/scient-desktop`.
  `upstream` is the official `pingdotgg/t3code` repository and must remain
  fetch-only with push URL `DISABLED`.
- No direct product commits to `main`. Commit, push, merge, and release according
  to the authorized workflow.
- Open PRs only when requested or already authorized by the conversation's
  delivery workflow.
- Before opening a PR, check its relationship to current main. Choose alignment
  appropriate to branch ownership; do not automatically rebase shared history.
- Queue a PR only when the user explicitly authorized its merge or auto-merge
  is already enabled. Non-draft status and green CI alone are not authorization.
  Never enable auto-merge on other PRs just because they look ready. Review the
  current head and respect unresolved blockers; report conflicts instead of
  resolving them. Use GitHub's merge queue without bypassing checks or jumping
  the queue, and do not repeatedly realign queued branches. Before pushing a
  correction to a queued PR, remove it from the queue and disable auto-merge;
  review the new head before requesting delivery again. Return the PR/CI links
  rather than monitoring unless the user asks.
- Preserve literal upstream ancestry. Upstream merges use dedicated branches
  and `docs/internals/upstream-alignment-protocol.md`, separate from product
  changes.
- Before changing a protected Scient divergence, consult `UPSTREAM.md`,
  `upstream-state.json`, and the relevant linked record.
- Preserve compatibility-sensitive package names, environment variables,
  storage paths, formats, and license notices. User-facing product language
  is Scient.
- Development work does not authorize changing cloud, telemetry, updater,
  background-service, signing, or publication controls. Follow the relevant
  release or operations procedure when that work is authorized.

Use conventional-commit titles. PR descriptions include the problem, resulting
behavior, verification, documentation impact, and the model and harness used.
Contribution policy and evidence requirements: `CONTRIBUTING.md`.

## Documentation

Start at `docs/README.md` and update the existing owner:

- `docs/user/`: user workflows and source material for public Scient Docs.
- `docs/internals/`: capability, architecture, and development guidance,
  with historical records distinguished from current instructions.
- `docs/operations/`: development, maintenance, and release procedures.
- `UPSTREAM.md`: upstream divergence and integration records.

Relevant documentation may live here or in the separate Scient repository.
Follow [this index](docs/README.md), [Scient's index](https://github.com/ScientFactory/Scient/blob/main/docs/README.md),
and linked documents relevant to the task; check whether they describe current
behavior, proposals, or history. Use an available local Scient checkout or
authenticated repository access; private-repository access is not required for
external contributions.

Document durable behavior, decisions, and constraints—not a narration of the code.
Update existing explanations when facts change; avoid field inventories and
PR-by-PR histories.

Keep temporary plans, transcripts, scratch files, and PR-only media out of
committed source. Avoid duplicating implementation history already held in Git
and PRs. Update documentation when its facts or user instructions change.

PR descriptions include a `Documentation impact` declaration:
`None — reason`, `Updated — paths`, or `Dependent PR — link`.
