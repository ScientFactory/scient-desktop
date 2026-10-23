# Reviewing Changes In Scient (Dev) Stable

Status: Active maintainer runbook
Owner: ScientFactory
Last updated: 2026-10-18
Purpose: How the one standing development app is installed, switched to the branch, pull request or commit under review, and kept safe on macOS and Windows.

`Scient (Dev) Stable` is one installed development app that stays put while
the code under it changes. Switching it to a pull request takes one command;
the app stops, its review checkout moves to that commit, dependencies are
installed when they changed, and the app starts again on a state profile of
its own. Candidates (`pnpm dev:desktop` or `pnpm dev:app:start` in a feature
worktree, see [local dev app](./local-dev-app.md)) remain the way to run
uncommitted work.

## Install Once

From any up-to-date checkout of this repository, with Node 24 active:

```sh
pnpm dev:app:stable install
```

This copies the controller (`scripts/dev-app/`) to
`~/.scient-next/scient-dev-stable/controller/` and creates the review checkout
`~/scient-dev-stable` as a detached worktree of the same clone. Pass
`--checkout <path>` to use another clean worktree instead. Every later command
runs the installed controller, never the code of the commit it is replacing.
Re-run `install` from a newer checkout to update the controller; it refuses
while the app is running.

On Windows, `install` also registers an on-demand scheduled task and a
`Scient (Dev) Stable` Start-menu entry. Neither needs administrator rights. On
macOS, the first successful start installs `~/Applications/Scient (Dev) Stable.app`;
an earlier stable app keeps its bundle identity, keychain item and microphone
grant, its state becomes the `legacy-stable` profile, and the old `main`
watcher is removed.

## Switch

```sh
pnpm dev:app:review '#574'          # a pull request (also pr:574)
pnpm dev:app:review main            # a branch (also branch:<name>)
pnpm dev:app:review commit:57602d2544
pnpm dev:app:review '#574' --fresh  # start that reference with empty state
pnpm dev:app:review --restore-previous
```

`review` fetches and resolves the reference first and refuses a commit whose
`scientDevApp.protocol` (root `package.json`) differs from the installed
controller's. Only then does it stop the app, confirm nothing still runs from
the review checkout or a profile, check out, install, and start. It returns
once the window has finished loading against its backend. An older commit
without the protocol is reviewed as a candidate in its own worktree instead.

## State Profiles

Each reference gets its own profile under
`~/.scient-next/scient-dev-stable/profiles/` (`pr-574`, `branch-main-…`,
`commit-…`): database, settings, Electron data and logs.

- Reviewing the same reference again reuses its profile while the new commit
  descends from the one that last ran on it. A rewound or force-pushed
  reference starts fresh; the previous state is kept as a `.retired-…` copy.
- Before newer code runs on a profile, it is copied to `<profile>.snapshot`.
  `--restore-previous` brings that state and its commit back together.
- Different references never share state, so switching from a pull request
  back to `main` never runs older code on newer data.
- The six most recently used profiles and two retired copies are kept.

Never point a profile at `.t3`, the current Scient app or another worktree's
state, and never seed it from live data.

## Day To Day

```sh
pnpm dev:app:stable status   # state, reference, commit, profile, log path
pnpm dev:app:stable logs     # last 200 lines
pnpm dev:app:stable stop
pnpm dev:app:stable start    # the last reviewed reference
```

Clicking the app (Start menu, or `~/Applications` on macOS) brings the window
forward, or starts the last reviewed reference. On Windows, quitting the app
ends the launch. Logs rotate at 10 MB and keep three files at
`~/.scient-next/scient-dev-stable/local-dev-app.log`.

Voice uses the machine's shared runtime (`pnpm voice:runtime:stage` once per
machine). On Windows, allow microphone access for desktop apps in Settings >
Privacy & security > Microphone. Staging voice on Windows needs Visual Studio
2022 or later with the C++ desktop workload (Build Tools are enough); see
[Scient voice](../internals/scient-voice.md).

## How It Stays Safe

- One operation at a time: `review`, `start`, `stop`, `install` and `uninstall`
  hold `operation.lock` for their whole transaction. The app's runner holds a
  separate lock for its lifetime, so a second runner cannot start.
- A launch only runs with a profile prepared by the controller in that
  transaction; the macOS bootstrap and the Windows runner refuse anything else
  before storage opens.
- Windows runs each launch inside a named Job Object that its processes cannot
  leave, started by the scheduled task under a headless console (no console
  windows, outside any terminal's or agent's job). Stopping asks the app to
  quit normally, then empties the job and requires it to report zero
  processes. Nothing is killed by name or by a bare process ID.
- macOS keeps launchd ownership through `scripts/local-dev-app.mjs`, run from
  the installed controller against the review checkout.
- The app answers the controller on a local socket or named pipe only with the
  launch's one-time token (`apps/desktop/src/scient/devLaunch/`).
- A dependency install that stops printing for six minutes or runs past 45
  minutes is stopped and retried once from a clean `node_modules`; the old
  folder is set aside under the stable root, not deleted.

## Remove

```sh
pnpm dev:app:stable uninstall
```

This stops the app and removes the controller, scheduled task and Start-menu
entry (macOS: the Applications launcher). Profiles and the review checkout stay
until you delete them yourself.
