# Scient Local Dev App

Status: Active maintainer runbook
Owner: ScientFactory
Last updated: 2026-10-18
Purpose: Defines the isolated worktree runtimes used to develop and review changes safely, and points to the standing stable review app.

## Contributor Quickstart

This guide belongs to the `scient-desktop` repository and travels with its
code. You do not need a maintainer's personal skill installation, profile, or
signing credentials to follow it. Use your own provider authentication when
testing agent turns.

Install the Node and package-manager versions declared in `package.json`; see
[development setup](./development.md#first-checkout). Before installing native
dependencies on Windows, read the [Windows prerequisites](./local-dev-app-windows.md#prerequisites).
From your existing clone, create a separate feature worktree (replace the
example branch and directory names):

```sh
git fetch origin main
git worktree add -b your-feature ../scient-desktop-your-feature origin/main
cd ../scient-desktop-your-feature
pnpm install --frozen-lockfile
```

Do not switch or reset a checkout that already owns a running app. The linked
worktree gives the dev runner an isolated `.scient-next` state directory and
its own port preferences. Check the actual resolved paths and ports in output.

- **macOS:** follow [Daily Commands](#daily-commands). The managed app runs in
  the background; ordinary feature review does not require installing or
  replacing the stable launcher.
- **Windows:** follow [Windows dev app](./local-dev-app-windows.md). Keep its
  PowerShell terminal open; background-service and clickable-launcher commands
  below are macOS-only.
- **Other hosts:** use the [development guide](./development.md), including
  native prerequisites. Do not assume macOS lifecycle support.

### Verify and hand off

Before reporting ready, record the worktree, branch, exact commit, dirty status,
state root, and selected ports. Confirm the desktop window opens, the backend
is ready, and the web origin and backend `/.well-known/t3/environment` endpoint
respond on the ports reported for this run. Check that the processes/listeners
belong to this candidate, not another app. A running window or status message
alone does not prove feature behavior or exclude orphan processes.

Keep the candidate running while the user reviews it. Stop with the owning
platform's procedure only when requested or review is finished; verify its
processes and listeners have exited without affecting other candidates. Report
startup, feature tests, and manual acceptance separately. Microphone access,
OAuth callbacks, and packaged-release behavior need their own checks.

## Agent-Assisted Development

The optional shared [scient-dev-app skill](../../.scient/skills/scient-dev-app/SKILL.md)
guides lifecycle work; this runbook and its platform instructions remain the
source of truth for commands. Humans can follow the same guide without a skill.

In Scient, open the checkout as an initialized project. Project-owned skills
are discovered from `.scient/skills`; after discovery, `scient-dev-app` can be
selected automatically or explicitly as `$scient-dev-app`, subject to its
Settings policy. See [project skill discovery](../internals/scient-skills.md#project-owned-skills).
This does not install or replace anyone's personal skills.

Other agents need not support Scient's skill discovery. Ask them to read
`.scient/skills/scient-dev-app/SKILL.md` in this checkout explicitly, or use
their supported repository-skill mechanism. Do not assume that a skill hosted
on GitHub has been installed or activated in every agent tool.

Example request:

> Read `.scient/skills/scient-dev-app/SKILL.md`. Launch an isolated development
> app from this feature worktree, verify readiness, and leave it running for
> my review. Do not change other running candidates.

Use this skill for lifecycle operations, not as a claim of visual acceptance.
Browser/UI testing is a separate task; where the required tools are available,
the existing [test-t3-app skill](../../.agents/skills/test-t3-app/SKILL.md) covers
that workflow. Neither skill grants new tools, permissions, or release authority.

## Outcome And Boundary

The managed roles, services, clickable launchers, and signing instructions
below describe macOS. Windows shares the isolation and review principles but
uses the separate foreground procedure linked above.

There are two deliberately different local-development roles:

1. **Scient (Dev) Stable** is the one standing, clickable development app,
   switched to the branch, pull request or commit under review with
   `pnpm dev:app:review`. See [reviewing in Scient (Dev) Stable](./dev-app-review.md);
   it covers macOS and Windows.
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
candidate safety envelope. Switching the stable review app between references
is not a product updater. A working local dev app does not authorize release,
cutover, or user-data import.

## Stable Review App

`Scient (Dev) Stable` is installed once with `pnpm dev:app:stable install` and
then switched with `pnpm dev:app:review <#123 | branch | commit:<sha>>`. Its
lifecycle, state profiles and safety rules are in
[reviewing in Scient (Dev) Stable](./dev-app-review.md). The commands below are
for candidates; `--stable` on them is refused in favour of
`pnpm dev:app:stable <start|stop|status|logs>`.

## Daily Commands

Run from the checkout whose code must be tested:

```sh
pnpm dev:app:start
pnpm dev:app:logs
pnpm dev:app:status
pnpm dev:app:stop
```

`dev:app:start` first builds and signs the macOS app bundle in the calling
terminal when it needs it (the first launch, or after Electron, the icon or the
app identity changes), then asks the per-worktree macOS service to launch and
returns; compilation continues in the background. The initial cold build can
still take tens of seconds. Use status and logs instead of keeping an agent
shell or terminal open. `pnpm dev:app` remains available when a maintainer
explicitly wants the same lifecycle attached to the foreground terminal.

Each checkout and role has its own deterministic service label, state root,
ports, app identity, and visible name. Different worktrees can therefore run
concurrently, while a second instance of the same worktree is refused.
`dev:app:logs` prints the last 200 background-launch lines. `dev:app:stop`
validates and stops only that checkout's recorded service, runner, Electron
app, and backend PIDs, waits for those processes to exit, and removes its launch
files. If any of them is still running after the forced stop, it fails with an
error and keeps the launch records instead of reporting success. Never stop
Electron, Node, pnpm, or ports by name or pattern.

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

### Scratch conversations in a dev candidate

The dev runner derives `SCIENT_DEV_SCRATCH_ROOT` from the resolved candidate state
root, overwriting any inherited value. Scratch files live under
`~/.scient-next/dev-scratch/<sha256 of candidate state root>/scratch`, outside the
checkout. Databases, settings, credentials, and Electron state keep their existing
worktree-local locations; this does not move or import a profile.

The desktop primary forwards this location only for development. WSL and production
launches scrub it, and the server accepts it only with a dev URL and the candidate
safety envelope. The selected scratch parent is still checked for Git inheritance;
detection failures hide the option. Advertisement and Scient workspace admission
use the same configured root, with each conversation scoped to its own direct
canonical subfolder. Stop/restart the owning candidate after changing this setup.

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

The bundle is signed only in the foreground: by `dev:app:start` before it hands
off, or by `pnpm dev:app`. macOS can refuse the background service permission
to sign it (`Operation not permitted`), so the service never signs. If it finds
the bundle needs rebuilding, it stops before copying anything and
`dev:app:status` reports what to run. The signed bundle stays identical between
launches: its native Electron executable loads a static bootstrap inside the
bundle, while volatile environment values live in a private file beside it in
`apps/desktop/.electron-runtime/`. Each
bundle there has its own build record, so a production-mode smoke build in the
same checkout does not invalidate the dev app. A rebuild is staged beside the
bundle and replaces it only after signing succeeds.

Each bundle identity also has its own storage key in the login keychain,
`scient-next-dev-<worktree> Safe Storage`, which the app creates on its first
launch. macOS lets an app read an entry it created without asking, so a new
candidate does not ask for the login password. The key protects that
candidate's saved connections and browser sign-ins, so it stays in the keychain
when the app is uninstalled; remove it in Keychain Access once the worktree and
its state are gone. A candidate last built before this rule shared one key with
every other candidate: its first launch afterwards starts a fresh key, and
sign-ins it saved under the shared key have to be made again.

Grant microphone access to the visible `Scient (Dev) · <label>` entry in
System Settings when macOS asks. Reloading the renderer cannot repair an
incorrect app identity or permission grant; stop and start the exact candidate
after changing either one.

## State And Project Safety

- Never point `SCIENT_NEXT_HOME`, `--home-dir`, or `--base-dir` at `.t3`, the
  current Scient application, or another worktree's state.
- The stable app keeps one state profile per reviewed reference under
  `~/.scient-next/scient-dev-stable/profiles/`
  ([state profiles](./dev-app-review.md#state-profiles)). Candidate worktrees
  always use their own isolated state roots.
- Do not copy data into a stable profile by hand.
- Never seed the dev app from live T3 or current-Scient data. Use synthetic or
  deliberately created candidate state.
- A project folder may be opened by the dev app, but app sessions, settings,
  browser partitions, credentials, and databases remain in the owning dev
  state root.
- Provider CLI authentication remains external-provider state. Do not copy
  production credentials into the repository or dev state.
- One folder is shared by every development app on the machine:
  `~/.scient-next/dev-shared/`. It holds only public, checksum-verified
  downloads and one preference (the voice helper, voice models, and the voice
  model last chosen), so a new candidate does not set voice up again. It never
  holds sessions, settings, credentials, or databases. See
  [`scient-voice.md`](../internals/scient-voice.md).

## Status, Recovery, And Removal

If the launcher opens but the Electron app does not appear, inspect the
managed log with `pnpm dev:app:logs`. It identifies dependency, build, port,
and backend startup failures without guessing.

If the desktop app cannot launch (for example its bundle must be re-signed),
the runner stops and `dev:app:status` prints the recorded reason and the command
that fixes it.

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
