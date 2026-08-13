# T3 upstream sync through 5015d7cf

Status: locally verified integration candidate. This record does not authorize
a release, enable cloud or mobile publication, or modify `release/stable`.

## Executive decisions

1. Receive the complete official T3 range through `5015d7cf` as one bounded,
   history-preserving merge. Users gain the maintained PR center, Open VSX
   theme discovery, mobile/thread refinements, improved composer/sidebar/diff
   behavior, and multiple source-control and connection fixes.
2. Preserve Scient product authority at the five conflict points: assisted
   provider onboarding, visible Scient identity, minimum-width wordmark
   geometry, server-update copy, and branded documentation.
3. Keep T3's contributor-trust change in ancestry without applying its
   repository-local trust effect. No upstream commit authorizes Scient release,
   cloud, mobile publication, production credentials, or live-user-data work.

## Authoritative gate and exact boundaries

- Owned repository: `ScientFactory/scient-desktop-next`
- Owned base: `d623ec6ef3d1a4645d08483be539ef9609e2dac8`
- Previous literal T3 boundary:
  `2db08457f2f4eaaa713a067b2ea480ca2b583025`
- Official T3 target: `5015d7cf9f98fe551115b625031f01e3f022cd2d`
- Official tag at the target: `v0.0.34-nightly.20260813.1084`
- Exact donor range: `2db08457f..5015d7cf`, 30 commits
- Previously covered in this range: 0
- Newly dispositioned: 30
- Remaining undispositioned: 0
- History-preserving merge: `4d812e742298b5023cae40b05ece9446935914f7`
- Integration branch: `agent/t3-sync-5015d7cf-20260813`
- Inspection time: 2026-08-13 14:21 Asia/Jerusalem / 11:21 UTC
- Donor write boundary: the `upstream` push URL remains `DISABLED`

The target was freshly fetched from official `pingdotgg/t3code:main`. Every
received commit is official T3 `main` ancestry. Open PRs #69, #70, and #74 and
their worktrees were inspected for overlap and left untouched.

## Complete commit ledger

Quality is scored from 1 (poor) to 5 (excellent). “Portability” describes
concept/direct-code fit into the current T3-derived Scient host, after checking
the relevant current Scient seams.

| Commit    | User or operational effect                                                                                                                   | Quality                                                                         | Scient fit, portability, difficulty, and risk                                                                                      | Disposition                 |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | --------------------------- |
| `f0b57ca` | Search and import community themes from Open VSX.                                                                                            | 4/5: integrity, resource, license, and atomic-import controls are well bounded. | High concept/direct-code fit; Medium due to network and archive validation. Uses the inherited theme seam.                         | Adopt.                      |
| `c196f42` | Smoother, interruptible composer resizing with reduced-motion handling.                                                                      | 4/5: focused FLIP cleanup and toolbar-fit behavior.                             | High fit and portability; Easy. Preserve Scient voice/provider/fork mounts.                                                        | Adopt.                      |
| `52e5a75` | More compact sidebar footer actions.                                                                                                         | 4/5: small, coherent presentation improvement.                                  | High fit; Easy. Preserve Scient release and brand controls.                                                                        | Adopt.                      |
| `560d4a4` | Keep the desktop wordmark visible at the sidebar's legal minimum width.                                                                      | 4/5: clear layout contract and regression.                                      | High concept fit; Easy adaptation. Retain the Scient wordmark and stage label threshold.                                           | Adapt.                      |
| `d37a9b0` | Regenerate mobile thread titles from the thread menu.                                                                                        | 4/5: capability-gated behavior with focused tests.                              | High fit and portability; Easy. Uses the existing thread engine.                                                                   | Adopt.                      |
| `63e6fae` | Adds a contributor to T3's local trust list.                                                                                                 | 3/5 for T3 governance; no Scient user value.                                    | No Scient authority transfer; direct effect is unsafe to port. Commit remains in ancestry only.                                    | Reject effect / learn-only. |
| `5a84614` | Align the composer model picker and footer spacing.                                                                                          | 4/5: small visual correction.                                                   | High fit; Easy adaptation. Keep Scient's assisted provider lifecycle instead of T3's disabled fallback.                            | Adapt.                      |
| `e1378a1` | Keep ordered lists inside mobile user-message bubbles.                                                                                       | 4/5: bounded rendering correction with tests.                                   | High fit and portability; Easy.                                                                                                    | Adopt.                      |
| `b54bfc9` | Add a useful launcher when the right panel has no surfaces.                                                                                  | 4/5: keyboard and availability behavior are explicit.                           | High fit; Medium because Scient Sources adds another surface. Added `S` as its launcher shortcut.                                  | Adapt.                      |
| `6fd088a` | Improve mobile onboarding header alignment.                                                                                                  | 4/5: focused responsive polish.                                                 | High fit; Easy adaptation. Visible product copy remains Scient.                                                                    | Adapt.                      |
| `849bac8` | Preserve CLI OAuth parameters through browser sign-in.                                                                                       | 5/5: repairs the complete authorization handoff with tests.                     | High foundation fit; Medium protected auth lane. Scient cloud remains fail-closed.                                                 | Adopt.                      |
| `e321667` | Prevent the changed-files header from overlapping controls.                                                                                  | 4/5: focused layout correction.                                                 | High fit and portability; Easy.                                                                                                    | Adopt.                      |
| `f131228` | Make Clerk profile surfaces follow the selected theme.                                                                                       | 4/5: centralized appearance mapping and tests.                                  | High future-cloud fit; Medium auth/UI risk. Capability stays dormant until Scient's cloud gate.                                    | Adopt foundation.           |
| `b73232b` | Reset sidebar width by double-clicking the resize handle.                                                                                    | 4/5: familiar recovery interaction with regression coverage.                    | High fit; Easy.                                                                                                                    | Adopt.                      |
| `8601797` | Route the update toast's release-notes action consistently.                                                                                  | 4/5: narrow updater UX fix.                                                     | High fit; Medium protected updater lane. Kept inside Scient's owned updater/release boundary.                                      | Adapt.                      |
| `770946d` | Render tooltips above dropdown menus.                                                                                                        | 4/5: fixes a reusable stacking defect.                                          | High fit and portability; Easy.                                                                                                    | Adopt.                      |
| `8d24b51` | Open modified PR links in the external browser.                                                                                              | 4/5: consistent desktop link policy with tests.                                 | High fit; Easy.                                                                                                                    | Adopt.                      |
| `18918d1` | Use the shared glass surface for the mobile command popover.                                                                                 | 4/5: removes inconsistent rendering.                                            | High fit; Easy.                                                                                                                    | Adopt.                      |
| `e3a9c25` | Seed snoozed threads in mobile showcase fixtures.                                                                                            | 4/5: improves representative test evidence.                                     | High test-infrastructure fit; Easy, no product-state authority.                                                                    | Adopt.                      |
| `9666b87` | Preserve light/dark/system appearance when changing themes.                                                                                  | 5/5: fixes a real preference invariant with broad tests.                        | High fit and portability; Easy.                                                                                                    | Adopt.                      |
| `d0b8d63` | Deregister connected environments from any client.                                                                                           | 4/5: coherent contract/runtime behavior.                                        | High future-cloud fit; Medium lifecycle risk. Dormant behind Scient's cloud gate.                                                  | Adopt foundation.           |
| `b28f9bf` | Major PR-center upgrade: filtering, qualifiers, multi-server listing, update branch, checks, reactions, in-place editing, and smarter diffs. | 4/5: large but cohesive, heavily tested, and green upstream.                    | High generic-host value; Hard due to breadth and shared UI/server contracts. Preserve General Chat/project guards and Scient copy. | Adopt.                      |
| `2eb099f` | Command-click sidebar PR numbers into the browser.                                                                                           | 4/5: consistent modifier-click behavior.                                        | High fit; Easy.                                                                                                                    | Adopt.                      |
| `ac1264e` | Show project favicons and workspace icons in command subtitles.                                                                              | 4/5: improves context without changing navigation.                              | High fit; Easy adaptation for `projectId === null`; General Chat supplies no project path/icon.                                    | Adapt.                      |
| `da6253b` | Fix source-control scanning through relay environments.                                                                                      | 4/5: bounded environment propagation correction.                                | High fit; Medium remote/runtime lane.                                                                                              | Adopt.                      |
| `33f9705` | Make the reset-zoom control visible on hover.                                                                                                | 4/5: small accessibility/discoverability fix.                                   | High fit; Easy.                                                                                                                    | Adopt.                      |
| `1e59b4c` | Keep a typed prompt when a draft changes repository.                                                                                         | 5/5: protects user work across a lifecycle transition with tests.               | High fit; Medium because of Scient General Chat/draft semantics; compatible as merged.                                             | Adopt.                      |
| `6bc6cb6` | Keep diff file lists scrollable when files are expanded.                                                                                     | 5/5: clear failure case and focused correction.                                 | High fit and portability; Easy.                                                                                                    | Adopt.                      |
| `df19f6c` | Align Codex collaboration prompts with current agent behavior.                                                                               | 4/5: compatibility-focused server instruction update.                           | High fit; Medium provider-behavior lane. Preserves Scient's provider instructions around it.                                       | Adopt.                      |
| `5015d7c` | Keep the turn minimap stable while the composer grows.                                                                                       | 4/5: focused layout stabilization.                                              | High fit; Easy.                                                                                                                    | Adopt.                      |

## Friction measurement and resolutions

Before resolution:

- T3 paths changed: 171
- Scient paths changed since the prior T3 boundary: 771
- Same-path overlaps: 40
- Textual conflicts: 5
- Trust-list effect deliberately removed: 1

Conflict resolutions:

1. `ChatComposer.tsx`: adopted T3's corrected horizontal inset while retaining
   the Scient provider-onboarding picker for missing, uninstalled, or
   disconnected providers.
2. `MobileClientsUserProfilePage.tsx`: adopted T3's refined typography while
   retaining visible Scient identity.
3. `index.css`: adopted wordmark visibility across the entire legal desktop
   sidebar range while retaining Scient's compact wordmark, stage art, and
   stage-label threshold.
4. `_chat.pull-requests.tsx`: adopted the full PR-center implementation and
   retained the Scient server-update message.
5. `thread-sidebar.md`: combined title-regeneration documentation with the
   Scient palette/identity explanation.

Type checking found and resolved two semantic integrations that did not create
Git markers: projectless General Chat cannot be used as a project-map key, and
the Scient Sources action needed the shortcut required by T3's new right-panel
launcher contract.

## Protected-boundary audit

- The Scient contributor trust list is byte-identical to the owned base.
- Scient identity, `scient-next` state roots, provider lifecycle, local voice,
  General Chat, Sources, scientific packages, and desktop schemes remain owned.
- T3 cloud, relay, mobile publication, hosted deployment, and release authority
  remain fail-closed unless separately approved.
- The exact T3 target and owned base are literal parents of the merge commit.
- Open PRs #69, #70, and #74 were not edited, rebased, merged, or closed.
- `upstream` remains fetch-only with push URL `DISABLED`.

## Verification

Local verification on the exact merge completed:

- `pnpm install --frozen-lockfile`
- `pnpm exec vp fmt --check`
- `pnpm exec vp lint --report-unused-disable-directives` (six inherited
  non-blocking warnings, no errors)
- `pnpm run typecheck`
- `pnpm run test` (all tasks passed on the final rerun; server: 2,762 passing
  and seven expected skips; web: 2,577 passing)
- `pnpm run build`
- `pnpm run test:desktop-smoke`
- `pnpm release:smoke`
- `pnpm brand:check`
- `pnpm icons:check`
- `pnpm general-chat:seams:check`
- `pnpm lint:mobile` (optional local Swift/Kotlin linters unavailable and
  reported as skipped)
- `git diff --check`

The first full test attempt exposed the wordmark contract mismatch and a
load-related `MessagesTimeline` import timeout. The CSS was corrected; the
timeline suite passed independently and the complete final rerun passed.
Hosted CI remains a draft-PR gate and is not represented as complete here.

## Publication boundary

This synchronization targets owned `main` only through a draft pull request.
It does not modify or merge `release/stable`, publish artifacts, enable T3
relay/mobile/web publication, or change Scient release authority.
