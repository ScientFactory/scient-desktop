# Worktree sweep

Each installed checkout adds about 250,000 files that file watchers and Spotlight track. Dozens of
idle checkouts once kept macOS `fseventsd` at a full core for days. `pnpm worktrees:sweep` lists
the linked Git worktrees directly under one folder and, with `--apply`, removes the finished and
idle ones.

```sh
pnpm worktrees:sweep --root ~/REPOs/ScientFactory-worktrees          # report only
pnpm worktrees:sweep --root ~/REPOs/ScientFactory-worktrees --apply  # remove
```

`SCIENT_WORKTREES_ROOT` can replace `--root`. `--idle-days` (default 3) sets the idle period,
`--state-db` the Scient database used for thread bindings (default
`$T3CODE_HOME/userdata/statev2.sqlite`, opened read-only), and `--json` prints the facts.

## What it keeps

Checked in this order; the first match wins:

1. `scient-desktop-identity`, a checkout holding a `.keep-worktree` file, or a locked worktree.
2. A standalone clone (only linked worktrees are removed).
3. Uncommitted or untracked changes.
4. A process running from the checkout (its command line or working directory).
5. A thread bound to the checkout in the Scient database (archived threads count).

## What it removes

- **Merged:** HEAD is in the default branch, or the branch's merged PR has this exact head. This
  includes a dev app's state, matching the workspace rule. A checkout used in the last 6 hours
  stays, since a fresh checkout from main is "in main" before it has any work.
- **Idle:** unmerged, no dev app state (`.scient-next/`), and no commit, checkout or index change
  for the idle period. It first tags HEAD as `archive/<folder>`.

Removal is `git worktree remove` without `--force`. Branches are never deleted, so every commit
stays reachable from its branch or tag. Each removal rechecks the facts first. Scient's own managed
worktrees (`~/.scient-next/worktrees`) have their own cleanup and are not in scope.
