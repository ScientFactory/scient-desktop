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

For every change, [`.github/workflows/ci.yml`](../../.github/workflows/ci.yml) runs these quality
gates on pull requests and pushes to `main`:

- **Check**: `vp check` (format and lint; this repo sets `typeCheck: false` in its lint options),
  then `vpr typecheck` for the workspace type check. The same job
  builds the desktop pipeline (`vp run build:desktop`) and verifies the preload bundle exists,
  imports only modules that Electron's sandbox can load, and still exports callable expected APIs.
  The verifier first parses imports, then executes the trusted artifact with controlled bridge stubs.
- **Test**: the desktop, mobile, and web suites run sequentially because each creates its own Vitest
  worker pool; co-scheduling those pools can starve the lower-core hosted runner. The remaining
  package suites run with `vp run --parallel --concurrency-limit 4`, excluding the server app and
  monorepo root. No suite is omitted. The 20-minute job ceiling is wider than upstream's 10 because
  Scient's suite is roughly three times larger on a runner with half the vCPUs.
- **Test Server**: three shards of `vp run --filter t3 test --shard N/3`. The server sets
  `fileParallelism: false`, so its test files run strictly serially and sharding spreads them over
  separate runners instead of workers: no two server test files ever share a machine, and no
  Electron download is spent on these shards. Exactly one shard writes the thread transfer budget
  report; a presence-gated upload keeps a single `thread-transfer-results` artifact, the exact name
  [`thread-transfer-report.yml`](../../.github/workflows/thread-transfer-report.yml) resolves when
  it posts the PR comment.
- **Rust**: `cargo fmt --check` and `cargo test --locked` for the native resource monitor, split
  out of Check and Test so neither lane pays a ~7-9s Rust toolchain install for checks that take
  under 3s.
- **Mobile Native Static Analysis**: `vp run lint:mobile` on macOS, wrapping
  `scripts/mobile-native-static-check.ts`. A cheap Linux **Mobile Native Changes** job gates it:
  the macOS runner only boots when the diff touches `apps/mobile` Swift/Kotlin sources, the
  SwiftLint/detekt/ktlint configuration, the `Brewfile`, the check script, the root `package.json`
  that defines `lint:mobile`, or `ci.yml`. Otherwise the job is skipped, which GitHub reports as
  success for the required check. Renames are matched on both their old and new path. The gate fails
  open in every other case: if the changed-file list cannot be resolved, GitHub truncates it, or the
  gate job itself fails, the lint runs.
- **Release Smoke**: exercises release-only workflow steps through `scripts/release-smoke.ts`, so
  release breakage surfaces on PRs rather than at tag time.

[`promote-release.yml`](../../.github/workflows/promote-release.yml) manually fast-forwards
`release/stable` to an exact green `main` commit. The manual-only
[`release.yml`](../../.github/workflows/release.yml) then builds macOS (`arm64` and `x64`), Linux
(`x64`), Windows (`x64`), and the matching remote-server artifact from that exact commit. A
publishing candidate waits at the protected `production` environment after assembly so its exact
artifact can be accepted before publication. macOS publication requires signing and notarization;
Windows uses Azure Trusted Signing unless an unsigned installer is explicitly approved for that
candidate. Non-publishing rehearsals may be unsigned, but they never create or overwrite a tag or
release.

See [Release Checklist](../operations/release.md) for the full release/signing setup checklist.
