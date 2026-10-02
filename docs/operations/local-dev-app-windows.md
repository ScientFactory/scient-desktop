# Windows Dev App

Use this with the [dev-app quickstart](./local-dev-app.md#contributor-quickstart)
and [contributor guide](../../CONTRIBUTING.md#run-a-development-app).
The current Windows path runs Electron and its development processes in a
foreground terminal. It is not equivalent to the macOS managed background app.

## Prerequisites

- Native Windows PowerShell, Git for Windows, and Node matching `package.json`.
  Confirm `git --version` and `node --version` work in the launch terminal.
- The package manager pinned by `package.json` and locked dependencies in the
  feature worktree. Follow [initial setup](./development.md#first-checkout);
  do not update the lockfile to work around a different package-manager version.
- If installation needs to compile native dependencies, Python 3 and Visual
  Studio Build Tools with Desktop development with C++ and a Windows SDK.
  Building an installer has additional [Windows packaging prerequisites](./development.md#windows-installer-prerequisites);
  packaging and release signing are not required for ordinary dev-app review.

Run the Windows checkout with Windows Node and dependencies. WSL is a different
Linux host path, not the native Windows procedure; do not share `node_modules`
between Windows and WSL or mix their executables in one launch.

## Launch and review

After creating and installing the feature worktree using the quickstart, run
these commands from its root in PowerShell:

```powershell
git branch --show-current
git rev-parse HEAD
git status --short
pnpm dev:desktop
```

Keep that terminal open; it owns the foreground runner and its logs. Read the
selected ports and `baseDir` from the `[dev-runner]` output, and confirm the
state belongs to this worktree before testing. Do not launch a second runner
for the same worktree just because compilation is slow or the window is hidden.
Do not inherit profile/role overrides from another candidate or use live Scient
or T3 data as a fixture.

Follow the shared [readiness and handoff checks](./local-dev-app.md#verify-and-hand-off).
Use the actual reported ports, not a fixed port or another candidate's window.
An agent must retain its terminal session for as long as the app is needed;
if its tooling cannot do that, report the limitation and have the collaborator
run this command in their own terminal. Do not promise background persistence.

## Stop and restart

Press **Ctrl+C in the owning terminal**, then confirm that the runner,
candidate Electron/backend processes, and their listening ports have exited.
Closing only the app window is not a substitute for stopping the runner.
After confirmed shutdown, run `pnpm dev:desktop` again from the same worktree.
Restart after backend or bundled shared-package changes; renderer reload alone
does not prove that the backend is current.

If shutdown leaves a process behind, inspect its PID, creation time, executable,
full command line, and parent relationship before any targeted termination.
PowerShell's `Get-CimInstance Win32_Process` and `Get-NetTCPConnection` can help
inspect those properties. A process name or port alone is not ownership proof.
Do not use name-wide `Stop-Process`, `taskkill /IM`, or a process-search pipeline
to kill Electron/Node across other candidates. Preserve logs and report any
shutdown that cannot be verified; do not start a replacement over it.

## Current limits

`pnpm dev:app:start` and `pnpm dev:app:install` explicitly require macOS.
The associated managed status/log/stop and stable-sync workflow is not a Windows
supervisor. Use the foreground terminal procedure above, not those commands or
an improvised background-service wrapper.

This guide documents the Windows source launch path; it does not establish
native Windows qualification of a particular revision. Managed Windows parity
requires a separate implementation and real Windows checks for concurrent
worktrees, repeated starts/rebuilds, terminal closure, crashes, and complete
target-only shutdown. Record the platform and any unverified behavior in review.
