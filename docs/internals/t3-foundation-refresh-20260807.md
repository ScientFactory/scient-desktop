# T3 foundation refresh — 2026-08-07

Status: verified private candidate update; not a release or cutover record.
Owner: Yaacov
Purpose: Record the exact official T3 range merged after the D4 candidate and
the evidence that the protected Scient boundaries remained intact.

## Exact ancestry

- Owned repository: `ScientFactory/scient-desktop-next`
- Official donor: `pingdotgg/t3code` through the fetch-only `upstream` remote
- Owned branch base: `13b30b6c4af2d928ecd38d31dcc8be72ae1598d2`
- Previous owned T3 tip: `4f5834ba72c5905a318c00456dd21271b2fa9d6f`
- Fetched official tip: `a8cd2ad2ebb32ad789e8e0ecd2fc713c2edc38f4`
- Nearest official tag: `v0.0.32-nightly.20260807.1022` (the fetched tip is
  newer than that tag)
- Required range: 17 commits, `4f5834ba..a8cd2ad2`
- Candidate merge commit: `f7ef81eb00aeca94cffb7b9cdda805a0be205a54`
- Update branch: `chore/t3-foundation-refresh-20260807`
- Merge method: ordinary non-fast-forward merge; no cherry-picks, replay, or
  squash of official T3 history

The Git virtual merge was conflict-free, and the actual merge preserved both
parents. The update contains T3's thread-pagination and projection-index
migration, orchestration and connection-stability work, plan-to-chat and chat
timeline changes, mobile synchronization changes, and transfer-budget CI
reporting.

## Protected-boundary audit

- Candidate identity and visible Scient branding remain in place. Runtime
  identifiers remain collision-safe `scient-next` values.
- Candidate state roots, legacy-path refusal, preview partitions, client
  persistence, provider identity, telemetry, and OTLP fail-closed behavior
  remain owned by the candidate.
- Cloud and relay remain production-dark; no cloud credential or live endpoint
  was enabled.
- Service, updater, signing, release, relay-deployment, mobile-publication,
  and screenshot workflow guards remain disabled.
- T3 package names, CLI names, environment-variable names, file formats,
  remote names, license notices, and history remain intact. The upstream
  `T3CODE_*` transfer-report variables are compatibility seams, not public
  branding.
- Migration `037_ProjectionTurnsKeysetIndex` is a generic T3 host migration;
  no Scient scientific tables, legacy-data import, or user-data conversion was
  added.

The only product-owned code change in the refresh is the transfer-budget report
heading: `T3 Code thread transfer budget` became `Scient thread transfer
budget` so the candidate brand guard continues to pass. No donor source was
cherry-picked or copied outside the ordinary merge.

## Verification

Executed in the isolated update worktree with Node `v24.14.0` and pnpm
`11.10.0`:

- `pnpm run brand:check` — pass
- Focused affected suites — 11 files, 375 tests passed
- `pnpm exec vp fmt --check` — pass (2,444 files)
- `pnpm exec vp lint --report-unused-disable-directives` — pass
- `pnpm run typecheck` — pass with inherited suggestion diagnostics only
- `pnpm run test` — 212 files (2 skipped), 1,917 tests (7 skipped) passed
- `pnpm run build` — pass; existing chunk-size and sourcemap warnings retained
- `pnpm run test:desktop-smoke` — pass
- `pnpm run release:smoke` — pass
- `pnpm run icons:check` — pass; no icon assets changed
- `git diff --check` — pass

No browser automation, screenshots, geometry checks, visual regression, or
manual UI acceptance were performed. No production credentials, live cloud,
release, signing, updater, mobile publication, or user data were used.

## Rollback and follow-up

Before publication, the branch can be abandoned without touching the old
continuity application or any live state. After publication, rollback is a
repository-level revert of this refresh merge through the normal reviewed PR
process; individual D4 guards must not be weakened to make a failing check
pass. Hosted CI must be observed on the published draft PR, especially the
provider-registry test that had a prior intermittent failure on candidate main.
