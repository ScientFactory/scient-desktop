# Development

## First checkout

Install `vp` using the [root README](../../README.md#install-vp). The checkout requires Node 24;
Bun is optional. From the repository root:

```sh
vp i
vp run dev
```

Open the one-time pairing URL printed by the dev runner. The bare origin does not authenticate
a new browser.

## Choosing a dev process

Use `vp run dev` for server and web. For persistent isolated Electron candidates, follow the
[Scient local dev app runbook](./local-dev-app.md) and use `pnpm dev:app:start` in the exact worktree.
`dev:server` and `dev:web` start those processes separately.
See the [mobile README](../../apps/mobile/README.md) for native builds and Metro.

Flags go directly after the task name, for example `vp run dev --home-dir /tmp/t3code-dev`.
Add `--browser` to open a browser automatically.

### Stopping a manually launched process

For a foreground dev runner, use Ctrl-C in its owning terminal. For a background
run, use its retained terminal session or the runner PID recorded when it started.
Confirm that PID still belongs to the same run before sending SIGTERM.
For an orphaned process, inspect the listening port, command, working directory,
and parent process together before stopping it. On macOS, `lsof -nP -iTCP:<port> -sTCP:LISTEN`
can identify a listener, but a port or worktree match alone does not establish
ownership. Never pipe a process search into a kill command. Managed Electron
candidates use the [local dev app stop command](./local-dev-app.md) instead.

### State and ports

Scient candidate apps use their worktree-owned `.scient-next` state. The stable development
launcher has a separate identity and state root; see the local dev app runbook before launching.
Never read or copy live Scient or T3 data into a candidate. Use synthetic fixtures, and confirm
the actual state root in the dev-runner output before testing.

For `vp run dev`, a nonblank `--home-dir` takes precedence over the linked worktree's
`.scient-next` directory; outside a linked worktree, the fallback is `~/.scient-next`.
The runner sets `SCIENT_NEXT_HOME` and the compatibility variable `T3CODE_HOME` for
its children from that resolved path, rather than inheriting ambient home overrides.
This is the dev runner's precedence, not a rule for every server or desktop entry point.

Read ports from the `[dev-runner]` output. Worktrees derive stable preferences from their paths,
but occupied ports can shift them. `T3CODE_PORT_OFFSET` or `T3CODE_DEV_INSTANCE` can select a
different preference when needed.

### Sharing and remote debugging

`vp run dev --share` publishes the web port over the machine's tailnet and prints a pairing URL
for that origin. Give the tester the complete URL, including its token. The dev runner removes
its mapping on exit.

Leave `VITE_HTTP_URL` and `VITE_WS_URL` unset. Vite proxies the backend through the browser's
origin so the same build works over localhost and remote connections.

Shared runs enable bundled dev to avoid a network round trip for each import level.
`T3CODE_BUNDLED_DEV=0` opts out when debugging bundler differences. Two reload traps matter
when changing this setup:

- The web entry must dynamically import the app so React refresh initializes before application
  chunks. Static imports can work on first load and fail after a route split.
- Bundled dev rebuilds Tailwind through watched files. Its ordinary Vite hot-update hook expects
  a server/module graph that Rolldown does not provide.

The workarounds live in the [web entry](../../apps/web/src/bootstrap.ts) and
[Tailwind plugin](../../apps/web/vite/tailwind.ts).

### Replacing a consumed or expired pairing URL

From the repository root, mint a fresh link for the already-running test server:

```sh
node apps/server/src/bin.ts pair --base-dir "/absolute/path/to/the-running-test-profile"
```

Replace the placeholder with the exact `baseDir` from that run's output, not an
assumed `userdata/` subdirectory or an installed app's profile. The explicit path
avoids automatic discovery selecting another environment. This creates a credential;
use it only for the test environment you are authorized to access. Give the intended
tester the complete URL without consuming it in another browser first.

The `pair` command grants standard client scopes, not the administrative scopes
needed to manage access in Settings → Connections. It does not replace an
administrative session. See the [remote-access guide](../user/remote-access.md)
for creating scoped links from an existing authorized session. For remote testing,
the URL's origin must also be reachable from the tester's device.

## Checks

Run checks for the files and packages you changed:

```sh
vp test run <files>
vp lint <files>
vp run --filter <package> typecheck
```

Use `vp run lint:mobile` for native mobile changes. Scient's final local verification gate is
defined in [AGENTS.md](../../AGENTS.md#verification); focused checks do not replace it.
See [ci.yml](../../.github/workflows/ci.yml) for hosted checks.
The [manual Windows lane](../../.github/workflows/windows-tests.yml) is available for focused
Windows investigation while that suite is not a required gate.

### Unused code

`vp run knip:check` checks unused files and dependencies across the repo, then
unused runtime exports in `apps/web` and every internal package under `packages/`.
CI enforces both checks.
Exported types and Effect schemas are allowed without consumers. The schema preprocessor
recognizes schema types, including aliases and schema classes; functions that create or decode
schemas remain checked. Completely unused files remain checked too.
Named exports in web UI component modules are kept as complete component sets. Knip ignores
unused exports in `apps/web/src/components/ui/*.tsx`, while still reporting an entire unused file.
Use `vp run knip --workspace apps/web` to audit one workspace, including exports,
or `vp run knip:production --workspace apps/web` to find code kept alive only by tests.
The full export audit still has findings and is not a repo-wide CI gate. Extend the
export check's workspace selectors as more workspaces become clean. Review callers before
deleting code; production mode can also report development scripts and test fixtures.
Runtime-discovered entrypoints and dependency exceptions belong in [knip.jsonc](../../knip.jsonc).

## Desktop artifacts

Local artifact builds are unsigned by default and write to `release/`:

```sh
vp run dist:desktop:dmg
vp run dist:desktop:linux
vp run dist:desktop:win
```

DMGs default to the host architecture. Use `--arch` to choose another target and `--keep-stage`
to retain packaging files for inspection. Run `vp run dist:desktop:artifact --help` for other
options.

### Linux AppImage prerequisites

Build on Linux because the browser-secret helper links against the host's libsecret. Install
Rust, C/C++ build tools, libsecret development headers, pkg-config, and ImageMagick.

Ubuntu and Debian:

```sh
sudo apt-get update
sudo apt-get install cargo rustc build-essential libsecret-1-dev pkg-config imagemagick
```

Fedora:

```sh
sudo dnf install rust cargo gcc gcc-c++ make libsecret-devel pkgconf-pkg-config ImageMagick
```

Arch Linux:

```sh
sudo pacman -S rust base-devel libsecret pkgconf imagemagick
```

The C toolchain, pkg-config, and libsecret headers are also needed for Linux desktop development.

### macOS DMG prerequisites

Install the Xcode Command Line Tools with `xcode-select --install` and install Rust.
For a cross-architecture or universal build, add the requested Rust targets:

```sh
rustup target add aarch64-apple-darwin x86_64-apple-darwin
```

### Windows installer prerequisites

Install Rust, Python 3, and Visual Studio Build Tools with **Desktop development with C++**.
Include the Windows SDK and the MSVC build tools and Spectre-mitigated libraries for the target
architecture. Add its Rust target:

```powershell
rustup target add x86_64-pc-windows-msvc
# For an ARM64 installer:
rustup target add aarch64-pc-windows-msvc
```

NSIS is downloaded by electron-builder. WSL support additionally needs a Linux node-pty prebuild;
see the [release runbook](./release.md#windows-payload-topology-and-update-validation).

### Signing and passkeys

Add `--signed` after configuring the platform credentials in the
[release runbook](./release.md). macOS passkeys need a signed, provisioned app; follow the
[Connect setup](./connect-setup.md#desktop-passkeys) for local signing and renderer HMR.
