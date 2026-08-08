# T3 foundation refresh — 2026-08-09

Status: verified private candidate update; not a release or cutover record.
Owner: Yaacov
Purpose: Record the exact official T3 range merged after the conversation-fork
refresh and the evidence that the protected Scient boundaries remained intact.

## Exact ancestry

- Owned repository: `ScientFactory/scient-desktop-next`
- Official donor: `pingdotgg/t3code` through the fetch-only `upstream` remote
- Owned branch base: `60bdec17f6d1981ad526e77a78fcf8c05ec3d066`
- Previous integrated T3 tip: `2c7267ad43a05cf3e30343400c76fd9ac47698e7`
- Fetched official tip: `89ee692bf0436505d008c1d70215e70836eba4e2`
- Nearest official tag: `v0.0.33-nightly.20260808.1033`
- Required range: 5 commits, `2c7267ad..89ee692b`
- Candidate merge commit: `698d8d0b53efa8ab37e11d021bffff19a6450346`
- Update branch: `chore/t3-foundation-refresh-20260809`
- Merge method: ordinary non-fast-forward merge; no cherry-picks, replay, or
  squash of official T3 history

The merge was conflict-free. Every commit in the required range has an
explicit disposition:

| Commit                                     | User or operational effect                                                                                                            | Disposition                                                                                  |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `06404107261cae24394d6abe39984fb445c5aff5` | Desktop View-menu zoom always targets the main app window, even when the embedded preview owns focus.                                 | Adopt through ordinary upstream history.                                                     |
| `30164cb1ba8ea05fdd6be69215dba2cc2f0e2aa8` | Mobile users get one coordinated model/thread-settings sheet with safer keyboard and focus handling.                                  | Adopt through ordinary upstream history; visual mobile acceptance remains a human follow-up. |
| `8101cd044911c7dc2a2adf7c7a9ba7962abf57b6` | Adds authenticated, local transcript-based usage aggregation, pricing provenance, bounded scan caching, and an aggregated usage page. | Adopt through ordinary upstream history; retain Scient privacy/cloud gates.                  |
| `a20923ce463335e89e92f5983d98a180536e8e7d` | Corrects the usage chart so provider series are absolute rather than misleadingly stacked.                                            | Adopt as the paired correction to `8101cd04`.                                                |
| `89ee692bf0436505d008c1d70215e70836eba4e2` | Persists the user's stacked/split diff-panel preference.                                                                              | Adopt through ordinary upstream history.                                                     |

No commit was reimplemented or selectively copied. The upstream merge is the
smallest honest integration because these commits are one contiguous official
range and the candidate's update mode is `thin-fork-merge`.

## Protected-boundary audit

- Scient identity, visible branding, collision-safe runtime IDs, and isolated
  state roots remain unchanged.
- Scient project initialization, local voice, conversation forks, RTL content
  direction, and their owned tests/docs remain outside the T3 diff.
- The new usage reader is server-side and environment-authorized. Raw provider
  transcript records remain local; only aggregated buckets and bounded source
  diagnostics cross the RPC. No cloud publication, telemetry policy, scientific
  persistence, or user-data conversion was introduced.
- Telemetry and OTLP remain fail-closed; cloud and relay remain
  production-dark. Service, updater, signing, release, relay-deployment,
  mobile-publication, and screenshot workflow guards remain unchanged.
- T3 package names, CLI names, environment-variable names, file formats,
  history, and license attribution remain intact.

## Verification

Executed in the isolated update worktree with Node `v24.19.0` and pnpm
`11.10.0`:

- Desktop tests — 60 files, 459 tests passed.
- Web unit tests — 229 files, 2,074 tests passed; mobile tests — 100 files,
  620 tests passed.
- Server tests — 222 files (2 skipped), 2,003 tests (7 skipped) passed.
- Aggregate `pnpm run test` — all 16 test projects passed; no test failures.
- `pnpm run fmt:check`, `pnpm run lint`, `pnpm run typecheck`,
  `pnpm run build`, `pnpm run test:desktop-smoke`, `pnpm run release:smoke`,
  `pnpm run brand:check`, and `pnpm run icons:check` passed. Lint and
  typecheck reported only inherited warning/suggestion diagnostics.
- No browser automation, screenshots, geometry checks, visual regression, or
  manual UI acceptance were performed. Mobile sheet and usage-page appearance
  therefore require human review after the draft is available.

## Rollback and follow-up

Before publication, abandon the isolated branch. After publication, revert the
refresh through the normal reviewed pull-request process; do not weaken a
candidate safety guard to accommodate upstream behavior. Before any merge,
refresh GitHub CI and confirm the server/full-suite results and the stale
machine-state cursor has been reconciled to this record.
