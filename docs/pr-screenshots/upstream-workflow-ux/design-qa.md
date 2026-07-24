# Workflow UX native acceptance

## Environment

- macOS arm64, Scient (Dev), current PR source after merging `origin/main`
- Isolated backend home: `/tmp/scient-pr111-native-home-2`
- Isolated Electron profile under `/tmp/scient-pr111-electron-appdata`
- Project: this PR's clean Git worktree
- Starting branch: `maintenance/upstream-workflow-ux-20260724`

## Native branch-copy acceptance

1. Opened the branch picker in a new local chat.
2. Right-clicked the listed `main` branch and selected Electron's native
   **Copy branch name** menu item.
3. Before the native text bridge fix, the renderer showed **Failed to copy
   branch name** and `pbpaste` retained the previous branch name. See
   `before-native-context-copy-failure.png`.
4. After the fix, the picker reported **Branch name copied**, `pbpaste`
   returned exactly `main`, and `git rev-parse --abbrev-ref HEAD` still returned
   `maintenance/upstream-workflow-ux-20260724`. See
   `after-native-context-copy-success.png`.
5. Right-clicked another listed branch and cancelled the native menu. The
   clipboard remained `main`, the active branch remained unchanged, and no
   error notification appeared. See `after-native-context-cancel.png`.
6. Reopened the picker, filtered to `main`, and used keyboard navigation. Two
   Tab presses moved accessibility focus from the filter to the branch list and
   then to `Copy branch name: main`; Enter invoked the same native bridge path.
   Accessibility reported `Branch name copied`, `pbpaste` returned exactly
   `main`, and the Git branch and status were still unchanged.

No branch checkout, branch creation, thread workspace mutation, repository
write, or provider turn occurred during this acceptance pass.

## Representative state proof

The native Electron app was also exercised against fixture records written only
to the isolated `/tmp` state database. A renderer reload projected those records
through the normal desktop server snapshot; no production profile or user data
was read or changed.

- The real sidebar announced three status labels: `Working`, `Pending
Approval`, and `Completed`. Holding Command displayed the compact `⌘1`,
  `⌘2`, and `⌘3` jump hints in those same native rows.
- The real Automations route grouped the fixture records under **Needs
  review**, **Current**, and **Paused**. Its accessible rows announced
  `Running`, `Waiting for approval`, `Last run failed`, `New result`, `Paused`,
  and the resolved enabled automation's ordinary `Hourly` cadence. The route
  and sidebar badge both reported three automations needing attention.

Focused browser coverage independently renders and checks `Running`, `Waiting
for approval`, `Last run failed`, `New result`, `Paused`, and `Every 1h`.
Sidebar browser and geometry coverage renders shortcut hints beside `Working`,
`Pending Approval`, and `Completed`, including compact macOS and wide `Ctrl`
layouts. These fixtures exercise the exact extracted row and indicator
components used by the product.
