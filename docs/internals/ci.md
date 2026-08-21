# CI quality gates

> For maintainers. Using T3 Code? See [docs/user](../user/).

CI separates documentation-only validation from the full product suite. A change is
documentation-only when every changed path is either under `docs/` or is a Markdown file. Those
changes run the lightweight [`documentation.yml`](../../.github/workflows/documentation.yml)
workflow instead of the full suite, both on pull requests and after merge to `main`. It checks:

- whitespace errors in the change;
- formatting of changed Markdown files;
- existence of changed Markdown files' local link targets; and
- the local-link checker's own Node test suite.

External links and in-document anchors are outside this fast check. A mixed documentation and code
change still runs the full suite, and changes to the documentation workflow or its checker run both
workflows.

For all non-documentation-only changes, [`.github/workflows/ci.yml`](../../.github/workflows/ci.yml)
runs these quality gates on pull requests and pushes to `main`:

- **Check**: `vp check` (format and lint; this repo sets `typeCheck: false` in its lint options),
  then `vpr typecheck` for the workspace type check. The same job
  builds the desktop pipeline (`vp run build:desktop`) and verifies the preload bundle exists and
  still exports its expected symbols.
- **Test**: `vp run --parallel --concurrency-limit 4 --filter '!t3' --filter '!@t3tools/monorepo'
test` across every workspace package except the server app and the monorepo root, dropping the
  dependency-ordering wait that only bought idle runner time. The 20-minute job ceiling is wider
  than upstream's 10 because Scient's suite is roughly three times larger on a runner with half
  the vCPUs.
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
