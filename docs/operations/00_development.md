# Development

## First checkout

Install [Vite+](https://viteplus.dev/guide/) (`vp` provides the pinned Node version from `package.json`):

```sh
curl -fsSL https://vite.plus | bash
# Windows PowerShell: irm https://vite.plus/ps1 | iex
```

On Windows, clone with long paths enabled so `.repos/` checks out cleanly:

```powershell
git clone -c core.longpaths=true https://github.com/pingdotgg/t3code.git
```

From the repository root:

```sh
vp i
vp run dev
```

Open the pairing URL printed by the dev runner (the bare origin does not authenticate a new browser). Prefer a container? See [Dev container](./01_devcontainer.md).

## Forge mirror (optional)

T3's [source.tanstack.com/@pingdotgg/t3code](https://source.tanstack.com/@pingdotgg/t3code) mirror
is useful for read-only upstream research. In Scient, keep `origin` and `upstream` as they are;
see [Scient](#scient) below.

## Running dev servers

- `vp run dev` (server + web), `vp run dev:desktop` (Electron), `vp run dev:server`, `vp run dev:web`. See [apps/mobile/README.md](../../apps/mobile/README.md) for mobile.
- Pass flags directly after the task name (e.g. `vp run dev --home-dir /tmp/t3code-dev`, `--browser`).
- **State and ports:** Linked worktrees default to `<worktree>/.t3/userdata` (outranking `T3CODE_HOME`) and seed on first start from a read-only snapshot of `~/.t3/userdata/statev2.sqlite` when it is at most 500 MiB (`--no-seed` or `T3CODE_DEV_SEED=0` skips; `vp run migrate-dev-db` refreshes manually). Plain clones and the main checkout default to `~/.t3/dev`. Never point a dev server at `~/.t3/userdata`. Read actual ports from `[dev-runner]` output (`T3CODE_PORT_OFFSET` / `T3CODE_DEV_INSTANCE` override).
- **Resource monitor:** First start builds `native/resource-monitor` via Cargo when missing; without Rust, dev starts without process telemetry.
- **Sharing:** `vp run dev --share` exposes the web port over Tailscale and prints a pairing URL. Add `--built` to serve `apps/web/dist` via `vp build --watch` (no HMR, faster over slow links). Never set `VITE_HTTP_URL` or `VITE_WS_URL` in dev—Vite proxies `/api` and `/ws` single-origin.
- **Startup profiling:** `vp run profile:startup` captures the first 20 s of Node processes under `.t3/startup-profiles/<timestamp>`.

### Replay provider

`vp run dev` registers `Replay (dev)` ([dev-replay-agent.ts](../../apps/server/scripts/dev-replay-agent.ts)), a local ACP agent that streams recorded transcripts without calling a paid model. Add scenarios under `SCENARIOS` pointing at a generic ACP fixture (`registry_transcript.ndjson`) or a file in `apps/server/scripts/dev-replay`.

### Reusable dev credential

Only use this on a hostname where you trust every service (browsers share cookies across ports on the same hostname). Generate one secret once and put it in the main checkout's gitignored `.env` (which `t3.json` links into worktrees):

```sh
openssl rand -hex 32
# Add to .env: T3CODE_DEV_AUTH_TOKEN=<value>
```

Restart `vp run dev --share` and open its printed pairing URL once per browser profile. Never commit or publish the token or startup URLs. Desktop and non-dev servers ignore it; see [environment auth](../internals/04_environment-auth.md#reusable-dev-credential).

## Checks

- `vp run check:changed` — CI's fast checks for your branch (format, lint, knip, affected typechecks, nearby tests, and React Compiler coverage).
- Focused iteration: `vp test run <files>`, `vp lint <files>`, `vp run --filter <pkg> typecheck`, `vp run knip:check`, `vp run lint:mobile`.
- `apps/web` uses real Chromium (`*.browser.test.{ts,tsx}`) for DOM/React tests (no jsdom) and Node for `*.test.ts`.
- Typechecking uses `effect-tsgo tsrs --noEmit` (`@effect/tsgo`), not `typescript` (except `apps/marketing` for Astro). On Windows, open the workspace through WSL for VS Code's `.vscode/tsdk/tsgo`.

## Desktop artifacts

Unsigned local builds write to `release/`:

```sh
vp run dist:desktop:dmg
vp run dist:desktop:linux
vp run dist:desktop:win
# Linux ARM64: vp run dist:desktop:artifact --platform linux --target AppImage --arch arm64
```

Run `vp run dist:desktop:artifact --help` for `--arch`, `--signed`, and `--keep-stage`.

### Linux AppImage prerequisites

Build on Linux (the browser-secret helper links against `libsecret`). Install Rust stable (`rustup`), C/C++ build tools, `libsecret` dev headers, `pkg-config`, ImageMagick, and Electron runtime libs (`gtk3`, `nss`, `alsa`, `gbm`):

```sh
# Ubuntu 24.04 / Debian 13 (on 22.04/Debian 12 use libgtk-3-0 and libasound2)
sudo apt-get install build-essential libsecret-1-dev pkg-config imagemagick libgtk-3-0t64 libnss3 libasound2t64 libgbm1

# Fedora
sudo dnf install gcc gcc-c++ make libsecret-devel pkgconf-pkg-config ImageMagick gtk3 nss alsa-lib mesa-libgbm

# Arch
sudo pacman -S base-devel libsecret pkgconf imagemagick gtk3 nss alsa-lib mesa
```

### macOS DMG prerequisites

Install Xcode Command Line Tools (`xcode-select --install`) and Rust. For cross-arch/universal builds:

```sh
rustup target add aarch64-apple-darwin x86_64-apple-darwin
```

### Windows installer prerequisites

Install Rust, Python 3, and Visual Studio Build Tools (**Desktop development with C++**, Windows SDK, MSVC build tools, Spectre-mitigated libraries), then add the Rust target:

```powershell
rustup target add x86_64-pc-windows-msvc   # or aarch64-pc-windows-msvc
```

WSL support also requires passing the Linux CLI archive via `--wsl-runtime`; see [release runbook](./03_release.md#windows-payload-topology-and-update-validation). For signing and macOS passkeys, see [release](./03_release.md) and [Connect setup](./02_connect-setup.md#desktop-passkeys).

## Scient

Where Scient differs from the T3 text above:

- **Remotes.** `origin` is `ScientFactory/scient-desktop` on GitHub; the official T3 repository is
  the fetch-only `upstream` remote with push URL `DISABLED`. Do not point either at the forge
  mirror: it helps read-only upstream research but carries none of Scient's issues, reviews, CI or
  release authority ([AGENTS.md](../../AGENTS.md#git-upstream-and-delivery)).
- **Desktop candidates.** Start isolated Electron candidates from the
  [Scient dev-app quickstart](./local-dev-app.md#contributor-quickstart). macOS supports persistent
  `pnpm dev:app:start`; Windows uses the [foreground workflow](./local-dev-app-windows.md).
- **State.** For `vp run dev`, a nonblank `--home-dir` wins, then a linked worktree's
  `.scient-next`, else `~/.scient-next`; the runner sets `SCIENT_NEXT_HOME` and `T3CODE_HOME` for
  its children from that path. First-start seeding from a live profile is off by default (`--seed`
  or `T3CODE_DEV_SEED=1` only with explicit permission to copy that profile). Use synthetic
  fixtures and confirm the printed `baseDir` before testing.
- **Stopping processes.** Use Ctrl-C in the owning terminal or the runner PID recorded at start;
  managed candidates use the local dev app stop command. A port or worktree match alone does not
  establish ownership, so never pipe a process search into a kill command.
- **A consumed or expired pairing URL.** Mint a fresh one for the running test server with
  `node apps/server/src/bin.ts pair --base-dir "<that run's baseDir>"`. It grants standard client
  scopes, not the administrative scopes Settings → Connections needs; see
  [remote access](../user/remote-access.md).
- **Tests.** Server tests run with `GIT_CEILING_DIRECTORIES` at the checkout root
  (`apps/server/src/testUtils/checkoutIsolation.setup.ts`), so a test that falls back to its working
  directory cannot touch the source repository; give checkpoint tests a real repository with
  `checkpointWorkspace()` from `@t3tools/provider-testing/replayWorkspace`. Shared replay-test
  support lives in `*.testkit.ts` modules, outside product brand checks. Before concurrent desktop
  suites, run `pnpm --filter @t3tools/desktop exec install-electron` so workers do not race
  Electron's lazy installer.
- **Final gate.** Scient's local verification gate is in [AGENTS.md](../../AGENTS.md#verification);
  hosted CI lanes, shards and selectors are in [CI gates](../internals/ci.md). Release signing
  and WSL payloads follow the [Scient release runbook](./scient-release.md).
