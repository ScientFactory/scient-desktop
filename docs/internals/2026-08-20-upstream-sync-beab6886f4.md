# Upstream sync through `beab6886f4`

Date: 2026-08-20

## Provenance

- Scient parent: `99328f8c0c66b7c33c49a075795a56e6747b760c`
- Official T3 tip: `beab6886f45bf42906d0bd01aefe5dfe9e66a867`
- Previous official cursor: `f2d5fc91e3030e5c3956fdadc13e1eaa25bcabe3`
- Integrated range: `f2d5fc91e3..beab6886f4`
- Official commits: 19
- Official files changed: 115
- Merge commit: `de52862d1a50eacb1cf71145a183d7d13cbf5baf`
- Worktree:
  `/Users/yaacov/REPOs/ScientFactory-worktrees/scient-desktop-next-t3-sync-beab6886f4-20260820`
- Branch: `agent/t3-sync-beab6886f4-20260820`

The merge commit has the owned Scient parent first and the exact official T3
tip second. No official commit was replayed, rebased, squashed, or
cherry-picked.

## Official range received

1. `68d569138b` aligns the displayed application version with its label.
2. `4347f14b89` refreshes the selected file together with the file tree.
3. `cf251c3bd0` adds OpenCode skill discovery.
4. `07f8027d9a` unifies workspace navigation and page headers.
5. `80c37f1a72` hides OpenCode's plan agent when legacy plan mode is disabled.
6. `3c0665543f` refines thread action menus and separators.
7. `8c85b4933f` redesigns usage insights.
8. `51341f2ac1` distinguishes an outdated GitHub CLI from missing authentication.
9. `a354dd9ddc` refreshes queued desktop updates before installation.
10. `0508792c57` confirms before closing a terminal.
11. `a850895f68` refreshes pull-request details.
12. `62654d279f` orders hourly usage chronologically.
13. `105cd5e0c5` removes the terminal pane's application-canvas gutter.
14. `792a1404f6` attaches composer state drawers.
15. `b2e2ccfdb4` preserves tool lifecycle identity.
16. `9027d62679` adopts stable Clerk Electron dependencies.
17. `4a9edff4c1` collapses tool activity into one line.
18. `f708f63fa9` removes redundant timestamp assertions.
19. `beab6886f4` supports dependency-heavy Open VSX themes.

## Conflict composition

| File                                                     | T3 behavior adopted                                      | Scient behavior retained                                           |
| -------------------------------------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------ |
| `apps/web/src/components/ChatView.tsx`                   | Workspace-header and terminal-close structure.           | Quick Chat queue, Sources, file opening, and scientific mounts.    |
| `apps/web/src/components/chat/ChatComposer.tsx`          | Composer drawers, tasks, stash, and approval structure.  | Queue/steer callbacks, voice, provider onboarding, and Quick Chat. |
| `apps/web/src/components/chat/MessagesTimeline.logic.ts` | Active-turn tool grouping and compact live activity.     | Sources anchors, fork markers, and BiDi direction inheritance.     |
| `apps/web/src/components/composerInlineChip.ts`          | Shared chip geometry for ordinary and skill chips.       | The Scient reading-profile class on chat chips.                    |
| `apps/web/src/components/files/FileBrowserPanel.tsx`     | Selected-file refresh alongside tree refresh.            | The Scient source-opening action.                                  |
| `apps/web/src/components/files/FilePreviewPanel.tsx`     | Refresh callback propagation to the file browser.        | Source opening and scientific preview routing.                     |
| `apps/web/src/components/sidebar/SidebarChrome.tsx`      | Reusable utility navigation and compact footer controls. | Scient symbol, product name, stage label, and release surfaces.    |

## Scient adaptations

### Composer and Quick Chat

The merged composer uses T3's new drawer and task architecture as the base.
Scient's provider-onboarding picker remains in the existing model-control slot,
and the voice control remains a single narrow insertion beside the primary
actions. The send callback still carries the queue/steer option to `ChatView`,
and projectless Quick Chat retains its dedicated disconnected prompt and
capability boundaries.

### Timeline, Sources, and scientific surfaces

T3's active-turn tool grouping and compact live-activity row are composed with
Scient's completed-assistant anchors, conversation-fork marker, inherited BiDi
direction, and generated-image rendering. File refresh keeps the existing
source-opening callback, so Sources, PDF, LaTeX, static artifacts, generated
images, Plotly, Vega-Lite, and attachments remain on their existing mounts.

### Identity and navigation

The footer adopts T3's reusable icon navigation while the sidebar header
continues to render the Scient symbol, product name, environment stage label,
release notes, provider updates, and update-architecture warning. No inherited
T3 wordmark enters the Scient product surface.

### Provider and updater policy

OpenCode skill discovery and plan-agent filtering compose with Scient's
environment-scoped provider enablement and lifecycle controls. T3's updater
action reservation and downloaded-version preservation retain Scient's
compiled D4 safety-envelope check, mock-update guard, Windows warning, and
product naming.

This alignment does not enable cloud, relay, mobile publication, hosted web,
npm publication, signing, or release publication.

## Validation

- focused merge tests: 315 passed
- protected Quick Chat, queue, voice, Sources, and BiDi tests: 152 passed
- focused timeline tests: 146 passed
- remaining focused UI and desktop tests: 193 passed
- simplification review: no composition, reuse, quality, or efficiency findings
- `pnpm exec vp fmt --check`
- `pnpm exec vp lint --report-unused-disable-directives`
- `pnpm run typecheck`
- `pnpm run test`
- `pnpm run build`
- `pnpm run test:desktop-smoke`
- `pnpm brand:check`
- Quick Chat, analysis, and LaTeX seam verifiers
- `git diff --check`

The full lint gate completed with 14 non-blocking warnings and no errors. The
production build retained the known bundle-size, dependency-bundle,
direct-eval, and sourcemap warnings.

No browser automation, live-data access, publication, signing, or release
action was performed.
