# Scient Local Dev App

Status: Active maintainer runbook
Owner: ScientFactory
Last updated: 2026-08-24
Purpose: Defines the one canonical Scient development baseline and the isolated worktree runtimes used to review changes safely.

## Outcome And Boundary

There are two deliberately different local-development roles:

1. **Scient (Dev) Stable** is the one canonical, clickable development app.
   Its checkout follows the owned repository `main` branch and is refreshed
   through the guarded main-sync process described below.
2. **Scient (Dev)** is a disposable candidate runtime started from a separate
   feature worktree when a change needs to be reviewed. It never owns or
   silently replaces the stable launcher.

Both are live Electron development runtimes, not installed release snapshots.
The owning checkout runs the backend, renderer, and Electron shell together
with rebuild and reload behavior.

Both roles stay separate from the current Scient app and from future release
identity:

- stable launcher display name: `Scient (Dev) Stable`;
- candidate worktree display name: `Scient (Dev) · <worktree label>`;
- development protocol: `scient-next-dev://`;
- worktree-specific macOS bundle identifier;
- worktree-specific ports;
- candidate state below `<worktree>/.scient-next/`; and
- stable state below `~/.scient-next/scient-dev-stable/`.

“Stable” here describes the local development role only. It is not a release
channel, signing status, production guarantee, or permission to publish.

Cloud, telemetry delivery, product background-service installation, product
updater polling, release signing, and publication remain disabled by the
candidate safety envelope. The local `main` watcher below only refreshes this development
checkout; it is not a product updater. A working local dev app does not
authorize release, cutover, or user-data import.

## Stable Baseline Launcher

Only the canonical clean `main` checkout may own the clickable launcher at:

```text
~/Applications/Scient (Dev) Stable.app
```

From the selected clean checkout:

```sh
# Activate the repository-supported Node 24 runtime first.
pnpm install --frozen-lockfile
pnpm dev:app:install -- --stable
```

The stable installer creates the generated Electron development bundle, copies
it to the user Applications directory, records the exact owning checkout and
stable role inside the bundle, and registers it with macOS. It refuses to
overwrite an unrecognized application or a launcher owned by another
checkout. The stable role also sets the fixed candidate-owned state root
`~/.scient-next/scient-dev-stable/`; it does not import or copy another
worktree's data.

The visible name and icon may evolve without weakening isolation. The
development protocol, bundle identifier, state root, and launcher-ownership
marker remain development-specific compatibility values unless a separate
migration explicitly changes them.

To deliberately transfer launcher ownership after selecting a new stable
checkout:

```sh
pnpm dev:app:install -- --stable --replace
```

Never use `--replace` merely because another worktree is convenient. Confirm
the previous owner is stopped, clean, and intentionally superseded first.

Clicking the installed app directly starts the stable background runtime in its
recorded checkout using the exact Node and pnpm runtime captured during
installation. It does not use Terminal automation or request permission to
control another app.
Stable launches write an append-only development log to
`~/.scient-next/scient-dev-stable/local-dev-app.log`; candidate launches write
to `<worktree>/.scient-next/local-dev-app.log`. Direct terminal launches keep
their output in that terminal instead.

## Daily Commands

Run from the checkout whose code must be tested:

```sh
pnpm dev:app:start
pnpm dev:app:logs
pnpm dev:app:status
pnpm dev:app:stop
```

`dev:app:start` asks the per-worktree macOS service to launch and returns
immediately; compilation continues in the background. The initial cold build
can still take tens of seconds. Use status and logs instead of keeping an agent
shell or terminal open. `pnpm dev:app` remains available when a maintainer
explicitly wants the same lifecycle attached to the foreground terminal.

For the canonical stable role, pass `--stable` to status, logs, and stop so
the command addresses `~/.scient-next/scient-dev-stable/` rather than a
candidate worktree:

```sh
pnpm dev:app:logs -- --stable
pnpm dev:app:status -- --stable
pnpm dev:app:stop -- --stable
```

Each checkout and role has its own deterministic service label, state root,
ports, app identity, and visible name. Different worktrees can therefore run
concurrently, while a second instance of the same worktree is refused.
`dev:app:logs` prints the last 200 background-launch lines. `dev:app:stop`
validates and stops only that checkout's recorded service, runner, Electron
app, and backend PIDs, waits for those processes to exit, and removes its launch
files. Never stop Electron, Node, pnpm, or ports by name or pattern.

The desktop renderer hot-reloads, but its local backend runs from the server
bundle built when the candidate starts. After changing `apps/server`, an HTTP
contract used by the server, or a workspace package bundled into the server,
stop and rerun that candidate before testing the change. Do not trust renderer
reload alone. Contract-derived features may explicitly report that the app and
server are out of sync, but logic-only server changes cannot always be detected
from the renderer.

The lower-level command remains available when its managed lifecycle is not
needed:

```sh
pnpm dev:desktop
```

## Reviewing A Change In A Worktree

A single installed app can represent only the checkout embedded when it was
installed. It cannot automatically become an arbitrary pull request or
uncommitted branch.

For a candidate change:

1. identify the owning worktree, branch, exact head, and cleanliness;
2. read that worktree's `AGENTS.md` and install its locked dependencies;
3. run `pnpm dev:app:start` from that exact worktree;
4. report the worktree, head, state root, and resolved ports shown by
   `[dev-runner]`; and
5. inspect `pnpm dev:app:logs` when startup details are needed; and
6. stop it through `pnpm dev:app:stop` when inspection is complete.

Do not reinstall or replace the stable launcher for ordinary feature review. A
linked worktree automatically receives isolated `.scient-next` state and a
unique development bundle identifier. This prevents experimental migrations,
settings, sessions, and browser state from contaminating the stable baseline.

Concurrent candidates are supported by default. The stable role is identified
by its `Scient (Dev) Stable` name; each candidate shows a short worktree label.
Still confirm the worktree, state root, ports, and exact Git head before acting;
never infer code or data ownership from a window title alone.

## macOS Identity And Microphone Access

The generated candidate app launches through macOS LaunchServices instead of
being spawned as an anonymous child of Node. When an Apple Development signing
identity is available, the launcher signs the generated Electron bundle with a
stable per-worktree bundle identity. That gives macOS a stable identity to
which microphone permission can be attached. Set
`SCIENT_DEV_CODESIGN_IDENTITY` only when a specific development certificate is
required. If no development identity exists, the launcher falls back to ad hoc
signing and warns that macOS may request microphone permission again after the
bundle changes.

Grant microphone access to the visible `Scient (Dev) · <label>` entry in
System Settings when macOS asks. Reloading the renderer cannot repair an
incorrect app identity or permission grant; stop and start the exact candidate
after changing either one.

## Updating The Stable Baseline

The stable baseline follows the repository's `main` branch. A local macOS
`launchd` watcher may check `origin/main` at a modest interval (for example,
once per minute); it is a fetch-and-fast-forward helper, not a release updater.
When no new `main` commit exists it does nothing. When a new commit exists, it
may update only if all guards pass:

- the recorded stable checkout is actually on `main`;
- the checkout is clean and the stable runner is managed by this checkout;
- `origin/main` is a descendant of the current head; and
- no competing update is in progress.

The guarded update stops the managed app, fast-forwards to `origin/main`,
installs locked dependencies only when required, and restarts the same stable
checkout. It never resets, cleans, force-updates, switches branches, imports
another worktree's data, or runs a feature branch into the stable launcher. A
dirty, divergent, or feature-branch checkout pauses and records an actionable
status instead of mutating anything.

Until the stable checkout has been explicitly transitioned to clean `main`,
the watcher must remain paused. Agents must not switch, reset, clean, or
repurpose an active dev checkout. To advance the baseline manually:

1. stop the stable local dev app and confirm
   `pnpm dev:app:status -- --stable` reports stopped;
2. confirm the checkout is clean and identify its current branch and head;
3. fetch without pulling;
4. advance only through the repository's accepted integration process;
5. install locked dependencies when the lockfile changed;
6. run the applicable focused checks; and
7. rerun the stable installer if the Electron runtime, icon, launcher, or
   checkout path changed.

Ordinary T3 movement is not applied directly to this launcher. The candidate's
bounded upstream-merge process decides which exact owned head reaches
`origin/main`; the stable watcher then follows that owned `main` history.

The one-shot check and the user-level watcher are managed from the canonical
checkout:

```sh
# Check once; this is also what launchd invokes.
pnpm canonical:sync

# Install or remove the guarded macOS watcher. Installation refuses a
# feature branch, dirty checkout, divergent history, or foreign launcher.
pnpm canonical:sync:install
pnpm canonical:sync:uninstall
```

The watcher checks every 60 seconds and also runs once when loaded. It records
pause reasons and update events under
`~/.scient-next/scient-dev-stable/canonical-main-sync.log`.

## State And Project Safety

- Never point `SCIENT_NEXT_HOME`, `--home-dir`, or `--base-dir` at `.t3`, the
  current Scient application, or another worktree's state.
- The stable app uses one explicitly designated stable development state root
  so changing the `main` checkout does not make its projects and conversations
  disappear. Candidate worktrees always use their own isolated state roots.
- Do not change the stable state root or copy data into it as part of an
  ordinary refresh. Any one-time state-root transition requires a separate,
  explicit preservation plan.
- Never seed the dev app from live T3 or current-Scient data. Use synthetic or
  deliberately created candidate state.
- A project folder may be opened by the dev app, but app sessions, settings,
  browser partitions, credentials, and databases remain in the owning dev
  state root.
- Provider CLI authentication remains external-provider state. Do not copy
  production credentials into the repository or dev state.

## Status, Recovery, And Removal

If the launcher opens but the Electron app does not appear, inspect the
managed log with `pnpm dev:app:logs`. It identifies dependency, build, port,
and backend startup failures without guessing.

If a shell, service, or app exits abnormally, `dev:app:status` validates the
recorded command and checkout before treating state as live. A later
`dev:app:start` or `dev:app:stop` removes stale service files and handles any
exactly identified app or backend process; it never performs a global cleanup.

To remove the clickable launcher owned by the current checkout:

```sh
pnpm dev:app:uninstall
```

The command refuses to remove an unrecognized app or one owned by another
checkout. Removing the launcher does not delete repository files or dev state.
Any later state deletion is a separate, explicitly confirmed operation.
