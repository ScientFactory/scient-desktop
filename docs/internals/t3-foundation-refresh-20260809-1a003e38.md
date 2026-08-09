# T3 foundation refresh — 2026-08-09 through `1a003e38`

Status: verified private candidate update; not a release or cutover record.
Owner: Yaacov
Purpose: Record the complete official T3 range, conscious conflict resolutions,
and protected-boundary evidence for the refresh after `89ee692b`.

## Exact ancestry

- Owned repository: `ScientFactory/scient-desktop-next`
- Official donor: `pingdotgg/t3code` through the fetch-only `upstream` remote
- Owned branch base: `200915db5a207cf476cf56c8abce2f25a4b0bfd4`
- Previous integrated T3 tip: `89ee692bf0436505d008c1d70215e70836eba4e2`
- Fetched official tip: `1a003e383ac6b10258b8100c2617d938c4f06c69`
- Nearest official tag: `v0.0.33-nightly.20260809.1043`
- Required range: 20 commits, `89ee692b..1a003e38`
- Candidate merge commit: `24bd387022d874c4bbdba83c69475d42dc7adf87`
- Update branch: `chore/t3-foundation-refresh-1a003e38-20260809`
- Merge method: ordinary non-fast-forward merge; no cherry-picks, replay, or
  squash of official T3 history

All 20 commits were reviewed before mutation. Every commit has an explicit
disposition:

| Commit                                     | User or operational effect                                                                                | Disposition                                                                                                                                   |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `c2f8cb7ca1576afd70294b98dfe1de9be17aacae` | Shows the number of running subagents without requiring the user to open their details.                   | Adopt through ordinary upstream history.                                                                                                      |
| `be01b287b92b4686023a5e213078a2f51b3c1880` | Restores pointer feedback on dropdowns and interactive buttons.                                           | Adopt through ordinary upstream history; visual acceptance remains human follow-up.                                                           |
| `e70cdb478d34342d13ba4f433992394bf7303c1d` | Prevents a Claude resume handshake from falsely completing a turn that never ran.                         | Adopt through ordinary upstream history.                                                                                                      |
| `49964e38c02ca26783449e56a3083b124a1d04c8` | Adds a contributor to T3's trusted-contributor list.                                                      | Reject the policy effect: preserve ancestry but remove the entry because T3 trust is not Scient trust.                                        |
| `7b2cf4374f5d92cc01eff482ad1af92ab7a87f41` | Adds another contributor to T3's trusted-contributor list.                                                | Reject the policy effect for the same reason.                                                                                                 |
| `89c320df0b0884a8c4df1cf596564c6bc725eb54` | Stops the active Codex turn correctly when queued follow-ups exist.                                       | Adopt through ordinary upstream history.                                                                                                      |
| `70c423a5e48ab34d8b1a033e798ab378b48dde5d` | Simplifies Usage by removing the cost-quality panel and adds direct back navigation.                      | Adopt through ordinary upstream history.                                                                                                      |
| `a6c9b41f902fba2a4137806c09e829935e91baac` | Lets agents open image files attached to chat through the authorized asset seam.                          | Adopt through ordinary upstream history.                                                                                                      |
| `5208bdeb0db95063091a29f97af3548436c5f291` | Prevents pinned items from reshuffling while reorder writes land.                                         | Adopt through ordinary upstream history.                                                                                                      |
| `288d8e3457f0466da2cbef2eab648331c969b8a7` | Gives projects a dedicated settings page and reusable settings controls.                                  | Adopt through ordinary upstream history.                                                                                                      |
| `886195ec1e6335d46d34fb3819ab4f3440b42b6d` | Keeps usage totals stable while device reports arrive.                                                    | Adopt through ordinary upstream history.                                                                                                      |
| `5bb8c0366447b1bb94c0ac41f2d4cd06730ffb94` | Settling a thread now stops its monitors, dev servers, and other provider-session work.                   | Adopt; combine with Scient's fork completion in the shared dispatch seam.                                                                     |
| `6dbffa022d9e44091d0edc496181011e3acfb695` | Lets each project default new threads to either a worktree or the current checkout, with migration `039`. | Adopt; preserve the compatible `t3.json` contract while using Scient in visible copy.                                                         |
| `6f69b4407f1e6e1aa56e46bbb51a0b133374eeae` | Restores the branch name in sidebar rows instead of showing a truncated plan step.                        | Adopt through ordinary upstream history.                                                                                                      |
| `ddaa6afef55e0da53950c7ed45f7d91b717475a5` | Adds a developer utility that can seed a worktree DB from the live T3 dev DB.                             | Adapt: retain source and tests as upstream evidence, but do not expose the root command because Scient policy forbids live-user-data copying. |
| `05eb051184ac4d486795ac6f8be29129b8b8845f` | Persists unsent composer drafts and keeps them reachable from the sidebar.                                | Adopt through ordinary upstream history.                                                                                                      |
| `076e9048dc57ab09b3692def050e12d690a1b027` | Lets users choose project icons, with authorized asset access and migration `040`.                        | Adopt through ordinary upstream history.                                                                                                      |
| `ba9c9ae81dce4e554b4dd52abfd28d0c01b5c651` | Uses systemd `OOMPolicy=continue` so one memory-hungry agent process does not take down the server.       | Adopt through ordinary upstream history.                                                                                                      |
| `963ebf5bd7cce00d40ff60c258b34c12dcab271e` | Adds a label-triggered Vercel web-preview deployment.                                                     | Adapt: retain the workflow source but disable its job, remove the Blacksmith runner, and leave publication authority dark.                    |
| `1a003e383ac6b10258b8100c2617d938c4f06c69` | Adds a cross-platform mobile usage dashboard backed by shared usage aggregation and formatting.           | Adopt through ordinary upstream history; visual/mobile acceptance remains human follow-up.                                                    |

## Conflict resolutions and adaptations

The merge produced three predicted conflicts:

1. `apps/server/src/ws.ts`: preserved Scient's durable conversation-fork
   completion receipt and typed error while adopting T3's archive/settle
   provider-session cleanup. Neither behavior was weakened.
2. Root `package.json`: preserved Scient's stable/local dev-app, canonical-sync,
   branding, and voice scripts. The live-data `migrate-dev-db` convenience
   command was intentionally not exposed.
3. `packages/shared/package.json`: exported both Scient's identity helper and
   T3's new thread-environment and shared usage helpers.

Post-merge policy adaptations removed the two T3-only vouch entries, disabled
the hosted preview deployment, replaced its Blacksmith runner declaration with
GitHub's `ubuntu-24.04`, and changed one newly introduced visible `T3 Code`
description to `Scient`. No upstream contract, persistence shape, or runtime
identity was renamed.

## Protected-boundary audit

- Scient identity, visible branding, collision-safe runtime IDs, and isolated
  state roots remain intact.
- Scient project initialization, local voice, conversation forks, provider
  onboarding work, RTL direction, analytics privacy controls, and their owned
  tests/docs remain present.
- The new image access follows the existing environment-authorized asset seam;
  the project-icon migration is additive and reversible.
- Contributor trust remains Scient-owned. T3 vouch changes do not silently
  grant Scient workflow authority.
- The dev-DB copier is not exposed as a Scient command and was not run. No live
  user data was read, converted, or changed during this refresh.
- Telemetry and OTLP remain fail-closed; cloud, relay, hosted previews, service,
  updater, signing, release, mobile publication, and screenshot workflows
  remain production-dark.
- T3 package names, CLI names, environment variables, `t3.json`, history, and
  license attribution remain intact where they are compatibility or lineage
  surfaces rather than visible Scient branding.

## Verification

Executed in the isolated update worktree with Node `v24.19.0` and pnpm
`11.10.0`:

- Focused server gate: 8 files and 275 tests passed across fork completion,
  settle cleanup, provider runtimes, icons, migrations, and server integration.
- Focused web gate: 7 files and 199 tests passed across sidebar, drafts, usage,
  settings search, and project icons.
- Full `pnpm run test`: all 17 test projects passed. Desktop passed 60 files / 459
  tests; mobile 100 / 620; web 228 / 2,068; server 229 files and 2,127 tests
  passed, with 2 files and 7 tests intentionally skipped.
- `pnpm run fmt:check`, `pnpm run lint`, `pnpm run typecheck`, `pnpm run build`,
  `pnpm run test:desktop-smoke`, `pnpm run release:smoke`,
  `pnpm run brand:check`, and `pnpm run icons:check` passed. Lint and typecheck
  emitted inherited warning/suggestion diagnostics only; the build emitted
  normal bundle-size and sourcemap warnings.
- `git diff --check`, clean-worktree, exact ancestry, and workflow-guard checks
  are required again after this evidence commit and before publication.
- No browser automation, screenshots, geometry checks, visual regression, or
  manual UI acceptance were performed. New mobile and project-settings visuals
  therefore remain explicit human follow-up.

## Rollback and follow-up

Before publication, abandon this isolated branch. After publication, revert the
refresh through the normal reviewed pull-request process; do not weaken a
candidate safety guard to accommodate upstream behavior. Before any merge,
refresh origin/upstream/GitHub state, confirm hosted CI, and reconcile any newer
official tip as a later observed tip rather than changing this exact range.
