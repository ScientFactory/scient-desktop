# T3 foundation refresh — 2026-08-07 (second range)

Status: verified private candidate update; not a release or cutover record.
Owner: Yaacov
Purpose: Record the exact official T3 range merged immediately before the
Scient project-initialization slice.

## Exact ancestry

- Owned repository: `ScientFactory/scient-desktop-next`
- Official donor: `pingdotgg/t3code` through the fetch-only `upstream` remote
- Owned branch base: `456bc41bf1e1441fac889e8eb2f88e92445081f9`
- Previous owned T3 tip: `a8cd2ad2ebb32ad789e8e0ecd2fc713c2edc38f4`
- Fetched official tip: `b98a0f0d2292d180db0ac7c6ae8ccdbc9f6478f7`
- Nearest official tag: `v0.0.32-nightly.20260807.1022`
- Required range: 3 commits, `a8cd2ad2..b98a0f0d`
- Candidate merge commit: `237fb951900b2cbd328344ce722daccf26892e73`
- Update branch: `chore/t3-foundation-refresh-20260807-b`
- Merge method: ordinary non-fast-forward merge; no cherry-picks, replay, or
  squash of official T3 history

The merge was conflict-free. It received the removal of the default composer
Build/Plan toggle, per-device provider settings, and the mobile fix that keeps
invisible T3 Connect devices manageable.

## Protected-boundary audit

- Candidate identity, visible Scient branding, collision-safe runtime IDs, and
  isolated state roots are unchanged.
- Telemetry and OTLP remain fail-closed; cloud and relay remain production-dark.
- Service, updater, signing, release, relay-deployment, mobile-publication, and
  screenshot workflow guards remain disabled.
- T3 package names, CLI names, environment-variable names, file formats,
  history, and license attribution remain intact.
- No user-data conversion, production credential, scientific-state, or release
  authority was introduced.

No Scient-owned code adaptation was required in this refresh.

## Verification

Executed in the isolated update worktree with Node `v24.14.0` and pnpm
`11.10.0`:

- `pnpm run brand:check` — pass across 950 product-surface files
- Focused affected suites — 4 files, 32 tests passed
- `pnpm exec vp fmt --check` — pass across 2,453 files
- `pnpm exec vp lint --report-unused-disable-directives` — pass
- `pnpm run typecheck` — pass with inherited suggestion diagnostics only
- `pnpm run test` — 210 files (2 skipped), 1,910 tests (7 skipped) passed
- `pnpm run build` — pass with inherited chunk-size and sourcemap warnings
- `pnpm run test:desktop-smoke` — pass
- `pnpm run release:smoke` — pass
- `pnpm run icons:check` — pass; no icon assets changed
- `git diff --check` — pass

No browser automation, screenshots, geometry checks, visual regression, or
manual UI acceptance were performed.

## Rollback

Before publication, abandon the isolated branch. After publication, revert the
merge through the normal reviewed pull-request process; do not weaken a
candidate safety guard to accommodate upstream behavior.
