# T3 alignment through 77bca8b2

Status: automated qualification passed; owner visual review pending.
This is the final receipt for one complete alignment, extended in place through eight additional
official commits rather than split, cherry-picked, or replayed.

## Frozen history

- Original owned base: `b9f26396fbf1754c16ecb50753c5e01a2232a36c`.
- Current owned main incorporated during the alignment:
  `39dd77cb5d2417f0c7c1eb6834e1bcafe8e60bba`, through history-preserving merge
  `42d774ca1399b1b8e68463e79c3644978ac0b285`.
- Previous official integration: `f814983c262b42bd79247bae377a709925c70d63`.
- Previous qualification target: `e6286839369a29d829aee3c64dd64ce39c626d2f`, recorded in the
  [preceding receipt](2026-09-13-upstream-sync-e6286839.md).
- Final official target: `77bca8b2d76a1f42552e5eee7d277fcb1160347a`.
- Official range: 127 first-parent commits in total, including eight added after the preceding
  target.
- Target describe: `v0.0.41-nightly.20260913.1658-10-g77bca8b2d7`.
- Branch: `codex/t3-sync-a43f9b45-20260912`.
- Final history-preserving extension merge: `5d74e19265f900a272d4bf82b7b02d359e6dd1ea`, whose first
  parent is the previously qualified candidate and whose second parent is the exact official target.
- `upstream` remains fetch-only (`https://github.com/pingdotgg/t3code.git`, push `DISABLED`).

## Additional upstream behavior

- Optional compact sidebar rail, including compact settings navigation, titlebar alignment, and a
  four-mode Appearance setting. The default remains the existing expanded sidebar.
- Optional compact thread rows, short completion timestamps, and drag geometry for the compact
  layout. The default remains the existing card layout.
- Sparse snoozed and settled shelves stay anchored at the bottom of the sidebar.
- Connections are organized around a selectable environment list. Per-environment connection,
  thread-placement, and GitHub-routing controls move together without changing Scient's local,
  network, WSL, or relay policy.
- In-app thread notifications are independently opt-in and coexist with the existing system
  notification modes.
- Background thread notifications can badge the browser favicon, Windows taskbar, and supported
  native desktop surfaces.
- New-worktree bootstrap safely falls back to the project checkout when the selected directory is
  not a Git repository or its requested base has no commit. This does not restore projectless
  conversations: the thread remains attached to its real project.
- Cursor internal agent-loop errors are preserved as useful provider diagnostics rather than
  rewritten as transport failures.

## Conflict composition

Four files conflicted textually:

1. `apps/desktop/src/preload.ts` exposes both Scient's durable unread-answer bridge and upstream's
   notification-badge bridge.
2. `apps/web/src/components/settings/NotificationSettings.tsx` adopts upstream's more complete
   notification semantics while retaining the Scient product name.
3. `apps/web/src/components/settings/SettingsSidebarNav.tsx` adopts compact navigation, search,
   labels, and footer behavior while retaining Scient's navigation subsections, intentional settings
   order, and desktop-only Voice visibility.
4. `apps/web/src/components/sidebar/SidebarChrome.tsx` adopts compact chrome behavior while retaining
   Scient branding, stage presentation, release notes, provider updates, and updater warnings.

Auto-merged overlap was also reviewed in both sidebar implementations, settings, connections,
desktop IPC, worktree bootstrap, and notification coordination. Scient's answer-attention imports,
scientific settings surfaces, provider lifecycle, and project ownership remain present.

## Composition findings

The upstream notification coordinator and Scient's answer-attention coordinator initially both
wrote the macOS dock badge with different lifecycles. Leaving both active would let focus-cleared
notification state overwrite Scient's durable unread-answer count. The composed coordinator keeps
Scient as the sole macOS dock-badge owner while retaining upstream favicon badging and Windows/Linux
desktop badging. System and in-app notifications remain unchanged. Regression tests cover both the
macOS ownership rule and retained Windows behavior.

Upstream's two new server fallback tests also omitted Scient's required queue protocol version.
Their fixtures now advertise queue protocol 2, preserving the production compatibility boundary.
The expanded Git workflow service exposed one stale Scient fork-reactor test double; it now supplies
the two new unused methods without changing production fork behavior.

## Protected boundaries

No migration, dependency, provider inventory, persisted-state identity, telemetry, cloud, relay,
hosted deployment, mobile publication, updater, signing, notarization, tag, npm, release, or
deployment authority changed. Scient identity, provider lifecycle, scientific capabilities,
project-only conversation ownership, queue protocol 2, and publication holds remain intact.

## Qualification

- Focused alignment tests: 538 passed across notification, badge, settings, sidebar drag/time,
  worktree, Cursor, desktop settings, contracts, and Scient fork-reactor coverage.
- Formatting, lint, typecheck, build, desktop smoke, and brand checks passed. Lint retained only the
  repository's existing non-blocking warning set.
- The full workspace test run passed every package except one transient socket closure in the server
  package while build and tests were competing concurrently. The complete server package was rerun
  alone and passed: 481 files and 6,603 tests, with 15 files and 63 tests skipped by their declared
  platform or environment conditions. All other workspace packages passed in the original run.
- Analysis, onboarding, Skills, and LaTeX seam checks passed against the exact final target.
- Repository integrity, merge-parent ancestry, upstream push protection, and provenance passed.
- No computer use or visual acceptance was performed.

## Owner manual review

1. In **Settings → Appearance → Sidebar**, exercise Off, Rail only, Threads only, and Both. Confirm
   the preview, main sidebar, settings sidebar, Scient branding, and setting persistence all agree.
2. With compact thread rows on, inspect active, completed, pinned, snoozed, and settled threads;
   drag between sections and confirm sparse shelves remain at the bottom.
3. In **Settings → Connections**, switch between the primary and saved environments. Confirm the
   correct connection, local/WSL/network, thread-placement, and GitHub-routing controls follow the
   selected environment without horizontal overflow or stale state.
4. Confirm **In-app notifications** defaults off. When enabled, complete or fail a background thread
   while Scient is focused and confirm one actionable toast appears. Recheck system notifications
   separately while Scient is in the background.
5. On macOS, confirm Scient's unread-answer dock count remains until the completed thread is visited
   and is not cleared merely by focusing the app. Windows/Linux notification badges remain an
   upstream implementation and were covered automatically, not manually on this host.
6. Start a thread in **New worktree** mode from both a non-Git project and an unborn Git repository;
   confirm each safely uses its project checkout and does not create a projectless conversation.
7. If a Cursor internal retry-limit error can be produced, confirm its diagnostic text is preserved.

This receipt does not authorize a push, pull request, main merge, release, or publication. Owner
visual and interaction acceptance remains a separate gate.
