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

No branch checkout, branch creation, thread workspace mutation, repository
write, or provider turn occurred during this acceptance pass.

## Representative state proof

Focused browser coverage renders and checks the automation row states
`Running`, `Waiting for approval`, `Last run failed`, `New result`, `Paused`,
and `Every 1h`. Sidebar browser and geometry coverage renders shortcut hints
beside `Working`, `Pending Approval`, and `Completed`, including compact macOS
and wide `Ctrl` layouts. These fixtures exercise the exact extracted row and
indicator components used by the product.
