# CI quality gates

> For maintainers. Using Scient? See [docs/user](../user/).

Branch protection requires both the product and documentation status contexts. Both workflows
therefore run on every pull request and every push to `main`; workflow-level path filters could
otherwise leave a required context permanently pending. The lightweight
[`documentation.yml`](../../.github/workflows/documentation.yml) workflow checks:

- whitespace errors in the change;
- formatting of changed Markdown files;
- existence of changed Markdown files' local link targets; and
- the local-link checker's own Node test suite.

External links and in-document anchors are outside this fast check. When no Markdown file changes,
the workflow still reports whitespace and checker-test results without inventing documentation
work. The full product suite also runs for documentation-only changes so every protected context
is present and the repository cannot merge around its own branch policy.

Release-note changes run the full lanes like any other change. The Web suite validates the
shipped catalog (`releaseNotes/model.test.ts`) and renders it in Chromium
(`ScientReleaseNotes.browser.test.tsx`).

For every pull request, merge-queue candidate (`merge_group`), and push to `main`, [`.github/workflows/ci.yml`](../../.github/workflows/ci.yml) runs these quality
gates (a queue candidate or main push may reuse an exact earlier qualification, described below):

- **Check**: `knip:check` rejects unused files/dependencies repository-wide and unused exports in the enabled application/runtime workspaces. `brand:check` verifies Scient product identity on shipped code and `docs/user`; its reviewed exemptions live in `scripts/scient-brand-allowlist.json`, each with a reason, and an entry that no longer exempts anything fails the check. `vp check` (format and lint; this repo sets `typeCheck: false` in its lint options),
  then `vpr typecheck` for the workspace type check. The same job
  builds the desktop pipeline (`vp run build:desktop`) and verifies the preload bundle exists,
  imports only modules that Electron's sandbox can load, and still exports callable expected APIs.
  The verifier first parses imports, then executes the trusted artifact with controlled bridge stubs.
- **Test**: `vp run --parallel --concurrency-limit 4 ... test` across workspace packages except the
  server, web app, and monorepo root, dropping the dependency-ordering wait that only bought idle
  runner time. Six runners share it: `Test` runs every package the others don't name, so a new
  package always runs; `Test 3` runs client-runtime, scripts, provider-runtime and shared;
  `Test 2` and `Test 4` run halves of mobile (`--shard 1/2`, `2/2`); `Test 5` runs the oxlint
  plugin; and `Test 6` runs desktop with its Electron runtime, browser secret helper libraries and
  export smokes. The 20-minute job ceiling is wider than upstream's 10 because Scient's suite is
  roughly three times larger on a runner with half the vCPUs.
- **Test Web**: twelve shards of `vp run --filter @t3tools/web test --shard N/12`, each on its own
  runner, covering both unit tests and `*.browser.test.{ts,tsx}` in headless Chromium. This keeps
  the large web suite from competing with other workspace packages. **Test Web performance** runs
  beside them: it builds and boots the production web client and runs the editor timing budgets. The Test step sets
  `SCIENT_BROWSER_LIFECYCLE_DIAGNOSTICS`, so the Playwright provider
  (`apps/web/src/testUtils/browserLifecycleDiagnostics.ts`) records page close/crash, navigation
  category, browser disconnect and browser-API socket open/close/error as fixed event names and
  per-process ordinals, never URLs, payloads or error messages. It marks the first close no
  shutdown or page replacement explains and keeps that window. Only a failed shard uploads it,
  as `browser-lifecycle-<shard>-attempt-<n>` for 14 days; it is evidence for investigating a
  lost browser connection, not a qualification input, and does not change test results. Raw
  TCP close carries no WebSocket close code or reason.
- **Test Server**: sixteen shards of `vp run --filter t3 test --shard N/16 --fileParallelism
  --maxWorkers=4`. The server config keeps `fileParallelism: false` for local runs; CI runs four
  files at a time, each in its own process, and spends no Electron download on these shards.
  **Test Server performance** runs beside them: the compute session Python bridge tests and the
  server timing budgets. Both suites split by the durations of recent main runs (see
  [Shard weights](#shard-weights)). Chromium is installed explicitly for the server browser integration tests. Exactly one shard writes the thread transfer budget
  report; a presence-gated upload keeps a single `thread-transfer-results` artifact, the exact name
  [`thread-transfer-report.yml`](../../.github/workflows/thread-transfer-report.yml) resolves when
  it posts the PR comment. Web and server shards also preserve their normal human-readable output
  while uploading native Vitest JSON results for 14 days. The reports expose exact discovered,
  passed, failed, and skipped tests for performance and failure investigations; report upload does
  not control the test command's result.
- **Dependency caches**: `.github/actions/setup-ci-deps` restores the pnpm store and lockfile
  verification record. Merge-queue runs never save them: a `gh-readonly-queue/...` ref's caches
  serve only reruns of that entry, and their ~1 GB stores would evict main's within the 10 GB limit.
- **Rust**: `cargo fmt --check` and `cargo test --locked` for the native resource monitor, split
  out of Check and Test so neither lane pays a ~7-9s Rust toolchain install for checks that take
  under 3s.
- **Mobile Native Static Analysis**: `vp run lint:mobile` on macOS, wrapping
  `scripts/mobile-native-static-check.ts`. A cheap Linux **Mobile Native Changes** job gates it:
  the macOS runner only boots when the diff touches `apps/mobile` Swift/Kotlin sources, the
  SwiftLint/detekt/ktlint configuration, the `Brewfile`, the check script, the root `package.json`
  that defines `lint:mobile`, or `ci.yml`. Otherwise the job is skipped, which GitHub reports as
  success for the required check. Like the other change gates, it diffs the run's comparison base
  against the tested commit with Git on every event, not a PR's live file list. Renames are matched on both their
  old and new path. The gate fails open in every other case: if the base is missing, the
  changed-file list cannot be resolved, or the gate job itself fails, the lint runs. The macOS job installs only the dependency closure needed
  by `@t3tools/scripts`, does not restore or save the repository-wide dependency cache, and fails if
  SwiftLint, ktlint, or detekt is unavailable before invoking the canonical native checker directly.
  It deliberately avoids `vp run` because Vite+ resolves task configuration for unrelated workspace
  packages before starting a root script, which would reintroduce a whole-repository install.
- **Release Smoke**: exercises release-only workflow steps through `scripts/release-smoke.ts`, so
  release breakage surfaces on PRs rather than at tag time.
- **Overleaf Windows** (required) and **Overleaf macOS** (advisory): each platform file listed in
  `.github/scripts/overleaf-platform-tests.cjs` must run without skips. Files run three at a time,
  each in its own process, rather than the server configuration's one at a time. Neither job
  restores a dependency store: on these hosted runners restoring the whole-workspace store took
  longer than installing the server and desktop closures without one. Overleaf macOS runs on every
  nightly run and every main push that cannot reuse, but on a pull request only when its diff can
  reach what only macOS can show (`.github/scripts/overleaf-macos-ci-gate.mjs`: the Overleaf,
  workspace and file-publication sources, the native publication helper, the Electron sign-in
  smoke and setup, and the toolchain). The same files run on Linux and Windows in required lanes,
  so a change that breaks them everywhere still fails there. Its steps cannot fail Changes: unless
  a passing gate says `false`, the job runs.

Every change gate diffs the tested commit against one comparison base
(`.github/scripts/ci-comparison-base.cjs`): the group's base for a queue run, `main` before the
push for a push, and for a PR run the `main` its tested merge was made on, the merge's first
parent. A PR event's `base.sha` can lag that merge (about one PR run in ten), so it is used only
when the tested commit is not a merge of the PR head, and no receipt is then written.

A fully successful run records a qualification receipt: the exact content it tested (the
commit's tree) and the comparison base its change gates used, with its repository, workflow,
run and attempt. Queue runs and PR runs from this repository record one; fork PRs never do.
The receipt certifies all applicable lanes, including web browser tests and mobile static analysis.

- **Queue candidate.** A `merge_group` run reuses the PR's passing run only when that run
  tested the same content against the same base: nothing has landed on `main` since and nothing
  is queued ahead of it. The queue commit must merge exactly that PR head onto the group base,
  and the PR run's tested merge commit, which its workflow ran from, must have the same tree and
  parents, so every change gate gets the same input. A path-limited history read, Compute recipe
  sealing, would find each merge commit itself when both `main` and the PR changed the recipes;
  that case, like any other mismatch, runs normal CI.
- **Main push.** A push reuses queue qualification when every queue entry it lands qualified
  that exact commit from its first parent, back to the commit `main` held before the push. The
  queue lands up to `max_entries_to_merge` (6) entries in one push; a longer chain runs normal
  CI. A queue run that itself reused PR qualification counts as qualified. A push the queue
  never ran runs normal CI, and the nightly `schedule` run qualifies main's tip fresh on every
  computer.

Documentation and upstream provenance keep their event-specific checks; required check names and
branch protections are unchanged. On valid reuse, the expensive jobs are skipped; `Test` reports
the source qualification and `Transfer report artifact` still verifies the restored measurement.
A matrix job skipped as a whole reports one unexpanded name, so a reusing queue candidate runs
small `Test Web N` and `Test Server N` jobs that report the required shard names.

Before confirming reuse, the run validates and republishes `thread-transfer-results` and every
shard's Vitest JSON report under the normal artifact names, using its own run attempt. The reuse job and
`Test` summaries link to the source run. This preserves the successful main-push baseline
consumed by the transfer reporter. Native packaging artifacts remain on the linked source run;
releases still build their own artifacts.

A source qualifies through its gates, not its overall result: the newest run of that head must
be in progress or completed with success or failure, and its latest attempt must hold exactly one
successful `Check` and one successful `Qualification receipt`. Advisory jobs (Overleaf macOS and
the main caches) may still be running or may have failed. A cancelled, timed-out or
unstarted run never qualifies, and an older run is never used behind a newer one of the same head.

Missing, expired, malformed or mismatched proof/reports, API failures, and restoration failures
run normal CI. A partially restored report is overwritten by the fresh test result on fallback.
Runs without a current receipt are ineligible. Reuse never chains through a push run, and an
unavailable or failed probe cannot suppress the normal suites.

[`.github/workflows/windows-tests.yml`](../../.github/workflows/windows-tests.yml) is a manual
Windows lane (`workflow_dispatch` only) on Scient's GitHub-hosted Windows 2025 runner family. The suite does not
pass on Windows yet, so it is not a required check; it exists so the work to get there can be
iterated against a real Windows box without one on hand. Dispatch it with `gh workflow run
windows-tests.yml --ref <branch>`, optionally with `-f package=<dir>` to run one workspace package
and `-f files="<paths>"` to run specific test files inside it. Once it is green, fold it into
`ci.yml`.

[`.github/workflows/scient-library-deep-tests.yml`](../../.github/workflows/scient-library-deep-tests.yml)
runs the long forms of the Library's rule tests and the Sources eval's large import on main, on a
schedule or by hand, never on a pull request, and is not a required check. The Sources guide's
[Rules the stores keep](scient-sources.md#rules-the-stores-keep) says what it runs on which
computer and how a failure is reported.

[`promote-release.yml`](../../.github/workflows/promote-release.yml) manually fast-forwards
`release/stable` to an exact green `main` commit. The manual-only
[`release.yml`](../../.github/workflows/release.yml) then builds macOS (`arm64` and `x64`), Linux
(`x64`), Windows (`x64`), and the matching remote-server artifact from that exact commit. A
publishing candidate waits at the protected `production` environment after assembly so its exact
artifact can be accepted before publication. macOS publication requires signing and notarization;
Windows uses Azure Trusted Signing unless an unsigned installer is explicitly approved for that
candidate. Non-publishing rehearsals may be unsigned, but they never create or overwrite a tag or
release.

Preflight shares pnpm's lockfile verification results with the desktop build jobs through a small
artifact. This avoids repeating dependency checks, especially on Windows, without transferring the
large registry metadata cache. pnpm checks the current lockfile and policy before it reuses a result.
If the artifact is unavailable, installation runs the checks again.

See the [Scient release runbook](../operations/scient-release.md) for the full release/signing setup checklist.

## Shard weights

Server and web shards use longest-file-first allocation with package-relative path tie breaking and
the lowest shard index on equal load. New files receive the sequencer's fallback weight (server
0.6 seconds; web 1 second). Weights schedule tests; they never select or exclude them. They are the
checked-in `apps/{server,web}/src/testUtils/shardWeights.json`, so every shard of a run derives the
same split with no job before the shards. Refresh them from main's newest timings (successful
reports only, medians over up to three runs per suite) after large test changes, or when one shard
runs well behind the others:

```sh
out="$(mktemp -d)/weights"
GITHUB_REPOSITORY=ScientFactory/scient-desktop node .github/scripts/ci-shard-weights.mjs "$out"
cp "$out/web.json" apps/web/src/testUtils/shardWeights.json
cp "$out/server.json" apps/server/src/testUtils/shardWeights.json
node .github/scripts/verify-ci-shards.mjs
```

A suite takes a main run only when that run has a successful report from every shard, using each
shard's latest attempt; otherwise its file is not written and its `cp` fails, so the checked-in
weights stay. The verifier loads the actual Vitest configurations, discovers every test
specification, and checks that the configured partitions cover each exactly once. Vitest's
`list --filesOnly --shard` does not apply the sequencer.

## Native Compute suites

The required `Check` gate includes applicable native Compute suites, selected by
`.github/scripts/compute-ci-gate.mjs`:

- Preview-scanner changes and the real-kernel integration test files run the Linux/macOS/Windows
  real-kernel matrix, without provisioning managed toolkits.
- Managed live-test files and the managed `pyproject.toml`/`uv.lock` fixtures run managed Python
  qualification, without the system-Python matrix.
- Shared runtime, process ownership, persistence and Compute contracts run both. `ManagedPython*.ts`
  is shared too: the existing-Python runtime imports it even when not provisioning an environment.
- Broad inputs (package manifests, the lockfile, workspace and root Vite configuration, server
  configuration and settings, `ci.yml`, workspace code and test infrastructure) run both suites on
  Linux only; the nightly run covers all four computers.
- Unit tests, which run in the ordinary lanes, and the server's RPC fixture
  `ComputeRpcServerTests.ts` run neither, as do unrelated UI and docs changes. Mixed changes take
  the union; uncertain diffs run everything.

Both suites stay enabled on every platform by default for reusable callers and manual dispatch,
which can also select either suite. The nightly run, and any main push that cannot reuse queue
qualification, runs both on all four computers.

Mac runner slots are the scarcest (the organization runs five macOS jobs at a time), so a full
run uses three of them. `Compute on Mac / macos-15` runs real R and Julia, managed Python and
real Python one after another; `Compute on Mac / macos-15-intel` runs managed and real Python,
and the Intel Mac's R and Julia keep their own job. Each role runs the same steps as its own job
(`scripts/compute-ci-workflows.test.ts` compares them) and runs even after an earlier role
failed. R and Julia run the same way on every computer: one job each on Linux, Windows and the
Intel Mac, whose three proofs (plain Python, real files, R and Julia kernels) are roles too. [`compute-roles.mjs`](../../.github/scripts/compute-roles.mjs) starts each one clean: its
own temporary directory, and after it ends its leftover processes stopped, what it added to
per-user directories (`~/.julia`, caches, Jupyter data) and the checkout (the sealed recipe
metadata) removed, and the Python it installed into returned to its packages. R and Julia go
first, so their plain-Python proof sees a Python nothing was installed into. Tools a setup step
put on `PATH` stay there for later roles: GitHub cannot take a path back off. The job's last
step names each role that failed, and fails when an expected role did not run.

The separate [Scient upstream provenance workflow](../../.github/workflows/scient-upstream-provenance.yml) runs on pull requests, merge-queue candidates and pushes to `main`. It checks recorded literal upstream ancestry and runs the Scient seam check across all manifests. For a pull request, the seam check reads GitHub's merge of the pull request into its base, so commits that reached main after the branch left it are not counted as its changes. Event-specific base/head references and queue-merge allowances stay in that workflow. The advisory divergence inventory cannot replace those checks or live behavior tests.

Merge-queue candidates and their pushes to `main` may contain several PRs. The provenance
guard admits only the contiguous two-parent integration chain from the event head back to
its exact base. It still checks merges inside every PR history for official upstream,
previously owned ancestry, or an exact recorded historical exception. A broken chain or an
octopus integration merge fails qualification.
