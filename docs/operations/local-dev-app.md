# Scient Next Local Dev App

Status: Active maintainer runbook
Owner: ScientFactory
Last updated: 2026-08-06
Purpose: Keeps one recognizable local Scient development app available while allowing any candidate worktree to be tested quickly and safely.

## Outcome And Boundary

The local development application is named **Scient Next (Dev)**. It is a live
Electron development runtime, not an installed release snapshot. The owning
checkout runs the backend, renderer, and Electron shell together with rebuild
and reload behavior.

The development identity stays separate from the current Scient app and from
future release identity:

- display name: `Scient Next (Dev)`;
- development protocol: `scient-next-dev://`;
- worktree-specific macOS bundle identifier;
- worktree-specific ports;
- linked-worktree state below `<worktree>/.scient-next/`; and
- main-checkout development state below `~/.scient-next/scient-next-dev/`.

Cloud, telemetry delivery, background service installation, updater polling,
signing, and publication remain disabled by the candidate safety envelope. A
working local dev app does not authorize release, cutover, or user-data import.

## Stable Baseline Launcher

One checkout may own the clickable launcher at:

```text
~/Applications/Scient Next (Dev).app
```

From the selected clean checkout:

```sh
# Activate the repository-supported Node 24 runtime first.
pnpm install --frozen-lockfile
pnpm dev:app:install
```

The installer creates the generated Electron development bundle, copies it to
the user Applications directory, records the exact owning checkout inside the
bundle, and registers it with macOS. It refuses to overwrite an unrecognized
application or a launcher owned by another checkout.

To deliberately transfer launcher ownership after selecting a new stable
checkout:

```sh
pnpm dev:app:install -- --replace
```

Never use `--replace` merely because another worktree is convenient. Confirm
the previous owner is stopped, clean, and intentionally superseded first.

Clicking the installed app directly starts `pnpm dev:app` in its recorded
checkout using the exact Node and pnpm runtime captured during installation. It
does not use Terminal automation or request permission to control another app.
Launches from the installed app write an append-only development log to
`<checkout>/.scient-next/local-dev-app.log`. Direct terminal launches keep
their output in that terminal instead.

## Daily Commands

Run from the checkout whose code must be tested:

```sh
pnpm dev:app
pnpm dev:app:logs
pnpm dev:app:status
pnpm dev:app:stop
```

`dev:app` prevents a second managed instance from starting for the same
checkout. `dev:app:logs` prints the last 200 lines produced by clickable app
launches. `dev:app:stop` signals only the exact runner PID recorded by that
checkout; do not stop Electron, Node, or pnpm processes by name or pattern.

The lower-level command remains available when its managed lifecycle is not
needed:

```sh
pnpm dev:desktop
```

## Reviewing A Change

A single installed app can represent only the checkout embedded when it was
installed. It cannot automatically become an arbitrary pull request or
uncommitted branch.

For a candidate change:

1. identify the owning worktree, branch, exact head, and cleanliness;
2. read that worktree's `AGENTS.md` and install its locked dependencies;
3. run `pnpm dev:app` from that exact worktree;
4. report the worktree, head, state root, and resolved ports shown by
   `[dev-runner]`; and
5. inspect `pnpm dev:app:logs` when startup details are needed; and
6. stop it through `pnpm dev:app:stop` when inspection is complete.

Do not reinstall the stable launcher for ordinary feature review. A linked
worktree automatically receives isolated `.scient-next` state and a unique
development bundle identifier. This prevents experimental migrations,
settings, sessions, and browser state from contaminating the stable baseline.

Use one visible dev instance at a time unless concurrency itself is the test.
All instances have the same user-facing development name, so the reported
worktree, state root, ports, and exact Git head are the authority for which code
is running.

## Updating The Stable Baseline

Agents must not switch, reset, clean, or repurpose an active dev checkout. To
advance the baseline:

1. stop the local dev app and confirm `pnpm dev:app:status` reports stopped;
2. confirm the checkout is clean and identify its current branch and head;
3. fetch without pulling;
4. advance only through the repository's accepted integration process;
5. install locked dependencies when the lockfile changed;
6. run the applicable focused checks; and
7. rerun `pnpm dev:app:install` if the Electron runtime, icon, launcher, or
   checkout path changed.

Ordinary T3 movement is not applied directly to this launcher. The candidate's
bounded upstream-merge process decides which exact owned head becomes the next
baseline.

## State And Project Safety

- Never point `SCIENT_NEXT_HOME`, `--home-dir`, or `--base-dir` at `.t3`, the
  current Scient application, or another worktree's state.
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

If status reports a stale runner after an abnormal exit, rerun
`pnpm dev:app:status`; it removes a stale lock only after confirming the
recorded PID is no longer alive.

To remove the clickable launcher owned by the current checkout:

```sh
pnpm dev:app:uninstall
```

The command refuses to remove an unrecognized app or one owned by another
checkout. Removing the launcher does not delete repository files or dev state.
Any later state deletion is a separate, explicitly confirmed operation.
