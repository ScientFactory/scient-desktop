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

For every pull request, merge-queue candidate (`merge_group`), and push to `main`, [`.github/workflows/ci.yml`](../../.github/workflows/ci.yml) runs these quality
gates (a queue candidate or main push may reuse an exact earlier qualification, described below):

Release-note-only changes use **Release notes qualification** instead of the full lanes below.
The event's immutable base and tested commit must differ only in `releaseNotes/catalog.ts`
and optionally its existing `model.test.ts` and `ScientReleaseNotes.browser.test.tsx` files
under `apps/web/src/scient/`. The catalog must change, both versions must contain literal
data only, and all changed files must remain regular files. Empty or unresolved diffs,
additions, deletions, renames, mode changes, executable catalog code, and any other path
run full CI. Workflow, component, dependency and test-configuration changes therefore
qualify through full CI, including changes to this optimization itself.

The focused lane runs catalog/model validation, release-note Chromium tests, web type checking,
and release-note formatting and lint. Only after all pass does it suppress unrelated workspace,
server, full web shards, Rust, mobile, Compute, packaging and release-smoke qualification.
The existing required shard names explicitly report that focused qualification passed and
their suites were not applicable. No transfer measurements or full-suite reuse receipt are
fabricated: focused runs do not produce them and are independently qualified on each event.
Failures or absent qualification output retain full CI. Beta and Stable release workflows
still build, sign, package and check their actual release artifacts normally.

- **Check**: `knip:check` rejects unused files/dependencies repository-wide and unused exports in the enabled application/runtime workspaces. `brand:check` verifies Scient product identity on shipped code and `docs/user`; its reviewed exemptions live in `scripts/scient-brand-allowlist.json`, each with a reason, and an entry that no longer exempts anything fails the check. `vp check` (format and lint; this repo sets `typeCheck: false` in its lint options),
  then `vpr typecheck` for the workspace type check. The same job
  builds the desktop pipeline (`vp run build:desktop`) and verifies the preload bundle exists,
  imports only modules that Electron's sandbox can load, and still exports callable expected APIs.
  The verifier first parses imports, then executes the trusted artifact with controlled bridge stubs.
- **Test**: `vp run --parallel --concurrency-limit 4 --filter '!t3'
--filter '!@t3tools/web' --filter '!@t3tools/monorepo' test` across workspace packages except the
  server, web app, and monorepo root, dropping the dependency-ordering wait that only bought idle
  runner time. The 20-minute job ceiling is wider than upstream's 10 because Scient's suite is
  roughly three times larger on a runner with half the vCPUs.
- **Test Web**: three shards of `vp run --filter @t3tools/web test --shard N/3`, each on its own
  runner, covering both unit tests and `*.browser.test.{ts,tsx}` in headless Chromium. This keeps
  the large web suite from competing with other workspace packages.
- **Test Server**: three shards of `vp run --filter t3 test --shard N/3`. The server sets
  `fileParallelism: false`, so its test files run strictly serially and sharding spreads them over
  separate runners instead of workers: files within a shard execute serially, and no
  Electron download is spent on these shards. Chromium is installed explicitly for the server browser integration tests. Exactly one shard writes the thread transfer budget
  report; a presence-gated upload keeps a single `thread-transfer-results` artifact, the exact name
  [`thread-transfer-report.yml`](../../.github/workflows/thread-transfer-report.yml) resolves when
  it posts the PR comment. Web and server shards also preserve their normal human-readable output
  while uploading native Vitest JSON results for 14 days. The reports expose exact discovered,
  passed, failed, and skipped tests for performance and failure investigations; report upload does
  not control the test command's result.
- **Rust**: `cargo fmt --check` and `cargo test --locked` for the native resource monitor, split
  out of Check and Test so neither lane pays a ~7-9s Rust toolchain install for checks that take
  under 3s.
- **Mobile Native Static Analysis**: `vp run lint:mobile` on macOS, wrapping
  `scripts/mobile-native-static-check.ts`. A cheap Linux **Mobile Native Changes** job gates it:
  the macOS runner only boots when the diff touches `apps/mobile` Swift/Kotlin sources, the
  SwiftLint/detekt/ktlint configuration, the `Brewfile`, the check script, the root `package.json`
  that defines `lint:mobile`, or `ci.yml`. Otherwise the job is skipped, which GitHub reports as
  success for the required check. Like the other change gates, it diffs the event's base against the
  tested commit with Git on every event, not a PR's live file list. Renames are matched on both their
  old and new path. The gate fails open in every other case: if the base is missing, the
  changed-file list cannot be resolved, or the gate job itself fails, the lint runs. The macOS job installs only the dependency closure needed
  by `@t3tools/scripts`, does not restore or save the repository-wide dependency cache, and fails if
  SwiftLint, ktlint, or detekt is unavailable before invoking the canonical native checker directly.
  It deliberately avoids `vp run` because Vite+ resolves task configuration for unrelated workspace
  packages before starting a root script, which would reintroduce a whole-repository install.
- **Release Smoke**: exercises release-only workflow steps through `scripts/release-smoke.ts`, so
  release breakage surfaces on PRs rather than at tag time.

A fully successful run records a qualification receipt: the exact content it tested (the
commit's tree) and the comparison base its change gates used, with its repository, workflow,
run and attempt. Queue runs and PR runs from this repository record one; fork PRs never do.
The receipt certifies all applicable lanes, including web browser tests and mobile static analysis.

- **Queue candidate.** A `merge_group` run reuses the PR's passing run only when that run
  tested the same content against the same base, and the PR head already holds that content:
  the PR contained the latest `main` when its CI ran, nothing has landed since, and nothing is
  queued ahead of it. The queue commit must merge exactly that PR head onto the group base, and
  the PR run's tested merge commit, which its workflow ran from, must have the same tree and
  parents. Every change gate compares the event's base with the tested commit, so equal base and
  content give each gate the same input. Because the merge then changes nothing, a path-limited
  history read such as Compute recipe sealing follows the PR head rather than the merge commit,
  whose timestamp differs between the two merges. Otherwise the candidate runs normal CI.
- **Main push.** A push reuses queue qualification when every queue entry it lands qualified
  that exact commit from its first parent, back to the commit `main` held before the push. The
  queue lands up to `max_entries_to_merge` (4) entries in one push; a longer chain runs normal
  CI. A queue run that itself reused PR qualification counts as qualified.

Documentation and upstream provenance keep their event-specific checks; required check names and
branch protections are unchanged. On valid reuse, the expensive jobs are skipped; `Test` reports
the source qualification and `Transfer report artifact` still verifies the restored measurement.
A matrix job skipped as a whole reports one unexpanded name, so a reusing queue candidate runs
small `Test Web N` and `Test Server N` jobs that report the required shard names.

Before confirming reuse, the run validates and republishes `thread-transfer-results` and all six
Vitest JSON reports under the normal artifact names, using its own run attempt. The reuse job and
`Test` summaries link to the source run. This preserves the successful main-push baseline
consumed by the transfer reporter. Native packaging artifacts remain on the linked source run;
releases still build their own artifacts.

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

See [Release Checklist](../operations/release.md) for the full release/signing setup checklist.

The separate [Scient upstream provenance workflow](../../.github/workflows/scient-upstream-provenance.yml) runs on pull requests, merge-queue candidates and pushes to `main`. It checks recorded literal upstream ancestry and runs the Scient seam check across all manifests. Event-specific base/head references and queue-merge allowances stay in that workflow. The advisory divergence inventory cannot replace those checks or live behavior tests.
