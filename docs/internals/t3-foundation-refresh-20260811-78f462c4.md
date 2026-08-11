# T3 foundation refresh — 2026-08-11 through `78f462c4`

Status: locally verified private candidate update; not a release or cutover record.
Owner: Yaacov
Purpose: Record the phase-one official T3 range, bounded conflict resolutions,
and protected-boundary evidence before the larger pull-request-center phase.

## Exact ancestry

- Owned repository: `ScientFactory/scient-desktop-next`
- Official donor: `pingdotgg/t3code` through the fetch-only `upstream` remote
- Owned branch base: `7c22a1d3408356b84a7e769c6269b8edbb6c2af7`
- Previous integrated T3 tip: `0d38866dcf63d133b2ed732bbb303dc533b5934f`
- Integrated official checkpoint: `78f462c4e18c8ea5e5037dc916389a3b72246025`
- Stable tag in range: `v0.0.33` at `3b72d17cbca691f0b64e6d4a10c9e349f42873a5`
- Tag at the checkpoint: `v0.0.34-nightly.20260810.1059`
- Newer observed official `main`: `9c7622dac3d1a385351e6c74354a9e6b9c2037d5`
- Required range: 18 commits, `0d38866d..78f462c4`
- Candidate merge commit: `81cfc51256edc5a40591738e20734fea8a8628cf`
- Update branch: `agent/t3-phase-1-20260811`
- Merge method: ordinary non-fast-forward merge; no cherry-picks, replay, or
  squash of official T3 history

The previous refresh had already placed `0d38866d` in owned `main` ancestry,
but `upstream-state.json` still named the older `1a003e38` checkpoint. This
record corrects the machine state to the real previous boundary before
advancing it to the tested phase-one checkpoint.

## Commit dispositions

Scient follows ordinary T3 host-platform changes by default. Only clear
downstream policy or feature contradictions receive an adaptation or rejection.

| Commit      | User or operational effect                                                                | Disposition                                                                                                                                                       |
| ----------- | ----------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `2abe66800` | Sandboxes user-provided SVG assets against script and origin access.                      | Adapt: apply T3's CSP while preserving Scient's range-capable PDF/asset handler and Scient desktop origins.                                                       |
| `9a1472d95` | Aligns Usage title-bar typography.                                                        | Adopt.                                                                                                                                                            |
| `f21d5e444` | Moves project settings into contextual project routes.                                    | Adopt.                                                                                                                                                            |
| `5da45337f` | Preserves project state and Back navigation while settings are open.                      | Adopt.                                                                                                                                                            |
| `73b2e8fdd` | Automatically builds, submits, and publishes mobile production updates from `main`.       | Reject the operational effect: retain official ancestry but keep Scient's manual disabled production workflow and omit the associated fingerprint-label workflow. |
| `96906805f` | Adds settings, Usage, and thread breadcrumbs.                                             | Adapt: preserve the Scient General Chat leading context and move control inside the shared breadcrumb layout.                                                     |
| `cbd55d637` | Corrects model-picker trigger padding.                                                    | Adopt.                                                                                                                                                            |
| `0ca9fb3fb` | Identifies worktree threads in Sidebar v2.                                                | Adopt.                                                                                                                                                            |
| `ef051bdb8` | Makes theme restore-default detection include mixed light/dark changes.                   | Adopt.                                                                                                                                                            |
| `d43210050` | Closes the trait menu after a selection.                                                  | Adopt.                                                                                                                                                            |
| `f0e297518` | Aligns the project selector with the draft headline.                                      | Adapt: take the baseline alignment while preserving Scient's workspace wording and projectless target behavior.                                                   |
| `3d74474f6` | Improves update-pill foreground contrast.                                                 | Adopt.                                                                                                                                                            |
| `9821bca1c` | Replaces native confirmation boxes with themed renderer dialogs and destructive variants. | Adapt: adopt the renderer service while preserving Scient's dropped-file and local-voice desktop bridges.                                                         |
| `fbcae59ef` | Uses directionally correct theme import/export icons.                                     | Adopt.                                                                                                                                                            |
| `67ef189d8` | Recognizes more PowerShell failure text in mobile work logs.                              | Adopt.                                                                                                                                                            |
| `d440442db` | Prevents Android user bubbles with code blocks from overlapping.                          | Adopt.                                                                                                                                                            |
| `3b72d17cb` | Repairs JSON parsing in T3's automatic EAS publication workflow.                          | Reject the operational effect with the disabled automatic mobile workflow.                                                                                        |
| `78f462c4e` | Advances inherited T3 package metadata after `v0.0.33`.                                   | Adopt as lineage metadata only; it does not version or release Scient.                                                                                            |

## Conflict resolutions and protected seams

The merge produced seven conflicted files, resolved as five bounded seams:

1. Mobile publication: kept `.github/workflows/mobile-eas-production.yml`
   manual and fail-closed, with no `push` trigger, no automatic store/OTA
   steps, and no Blacksmith runner. The new advisory fingerprint-label
   workflow was omitted with the rejected automation.
2. Asset security: composed T3's case-insensitive SVG CSP helper with Scient's
   authenticated asset revision, MIME, ETag, HEAD, and byte-range behavior.
   Scient production and development schemes remain the allowed desktop
   renderer origins.
3. Desktop confirmations: adopted the renderer-hosted confirmation queue and
   destructive styling, removed the superseded native confirmation IPC, and
   retained Scient's `getPathForFile` and local voice preload/contract seams.
4. Thread breadcrumb: adopted the shared accessible breadcrumb while retaining
   the General Chat context, move-to-project control, inline rename, thread
   actions, and project-only Git controls.
5. Draft headline: adopted baseline alignment without replacing Scient's
   workspace wording or projectless-thread selection behavior.

## Protected-boundary audit

- Scient identity, visible branding, desktop schemes, isolated state roots,
  and compatibility names remain intact.
- General Chat behavior is preserved; no additional commits were imported from
  the still-open T3 projectless-thread PR.
- Local voice and dropped-file/PDF seams remain present and typed.
- Telemetry, cloud, relay, updater, signing, release, and mobile publication
  authority remain unchanged and fail-closed.
- `release/stable` remained at
  `7c22a1d3408356b84a7e769c6269b8edbb6c2af7`; no tag, release, artifact, or
  publication operation occurred.
- The newer T3 pull-request center and current nightly tip are not ancestors of
  this candidate and remain a separate phase.

## Verification

Executed in the isolated update worktree with Node `v24.19.0` and pnpm
`11.10.0`:

- Focused conflict-path gate: 9 files and 48 tests passed across HTTP assets,
  confirmations, local API, chat-header rules, settings search, grouping,
  mobile wide blocks, and Electron dialogs/menu behavior.
- Full `pnpm run test`: all 18 test workspaces passed. Desktop passed 60 files /
  455 tests; mobile 101 / 623; web 242 / 2,143; server 242 files / 2,214 tests,
  with 2 files and 7 tests intentionally skipped.
- `pnpm exec vp fmt --check`, `pnpm exec vp lint
--report-unused-disable-directives`, `pnpm run typecheck`, `pnpm run build`,
  `pnpm run test:desktop-smoke`, `pnpm run release:smoke`, `pnpm run
brand:check`, and `pnpm run icons:check` passed.
- Lint reported one existing unused-disable warning in `ThemeEditorPanel.tsx`;
  typecheck emitted suggestion-only Effect diagnostics. The build emitted the
  normal bundle-size and generated-sourcemap warnings.
- `pnpm run lint:mobile` passed its repository check; optional SwiftLint,
  ktlint, and detekt binaries were not installed, so those external native
  linters were skipped as reported by the script.
- `git diff --check`, exact two-parent ancestry, excluded-nightly ancestry, and
  release/mobile workflow guards were verified before this record.
- No browser automation, screenshots, geometry checks, visual regression, or
  manual UI acceptance were performed.

## Rollback and follow-up

Before publication, abandon this isolated branch. After publication, revert the
refresh through the normal reviewed pull-request process. Do not weaken a
Scient-owned safety guard to accommodate upstream automation. The pull-request
center and later nightly fixes require a new clean worktree, exact refreshed
base, and separate bounded merge after this phase lands.
