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
3. Uncommitted or untracked changes, including tracked files hidden by `assume-unchanged` or
   `skip-worktree`, and file names Git reports that aren't valid UTF-8.
4. A process naming the checkout in its command line (by the `--root` spelling or the real
   path), or working inside it.
5. A thread in the Scient database that runs there: its worktree, or its project's folder when it
   has none. Archived threads count.
6. Dev app state (`.scient-next/`), merged or not: it holds the candidate's own threads and
   projects, so the owner removes it by hand after reviewing them.
7. A nested repository anywhere inside it, bare or not and in any letter case (the folder is
   walked, since Git doesn't always list one), a folder that can't be read, or ignored files other
   than rebuildable outputs and symlinks, for example `.env.local`, notes, logs or an older dev
   app's `.t3/userdata`. Git would delete them with the checkout. Rebuildable means conventional
   build and cache folders anywhere (`node_modules`, `dist*`, `build`, `out`, `target`,
   `coverage`, `.next`, `.turbo`, `.vite`, `.vitest`, `.cache`, `.astro`, `__pycache__`,
   `.electron-runtime`), generated outputs only at the exact path their generator writes, and a
   `.t3` folder holding only setup marker files. A secret saved inside a conventional build folder
   would still be removed with it.

If `ps`, `lsof` or the database can't be read at the start, the sweep stops before removing
anything. If a check fails later, for one checkout or during its recheck, that checkout is kept
and reported, and the others still run.

## What it removes

- **Merged:** HEAD is in the live default branch (read with `git ls-remote`; a stale local copy
  counts as unknown), or a PR into that branch merged this exact head. A checkout used in the last
  6 hours stays, since a fresh checkout from main is "in main" before it has any work.
- **Idle:** unmerged, and no commit, checkout or index change for the idle period. It first tags
  HEAD as `archive/<folder>-<first 12 hex of the commit>`.

Removal is `git worktree remove` without `--force`. Branches are never deleted, so every commit
stays reachable from its branch or tag. Each removal rechecks the facts first. Activity is read
from Git metadata, so a long build or test in an otherwise untouched checkout is not seen unless
its process is running. Scient's own managed worktrees (`~/.scient-next/worktrees`) have their
own cleanup and are not in scope.
