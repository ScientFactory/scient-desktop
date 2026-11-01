# Scripts

> For maintainers. Using T3 Code? See [docs/user](../user/).

## First checkout

T3 Code uses [Vite+](https://viteplus.dev/guide/). Install the global `vp` command, install
dependencies, then start the dev stack:

```bash
curl -fsSL https://vite.plus | bash   # Windows: irm https://vite.plus/ps1 | iex
vp i
vp run dev
```

Node 24 is required. Bun is not: the server picks Bun adapters when it detects Bun and falls back to
Node otherwise, and nothing in contributor setup needs it.

`vp run dev` prints a one-time pairing URL. Open it so the first browser navigation is
authenticated.

## Dev

- `vp run dev`: Starts contracts, server, and web in watch mode.
- `vp run dev --share`: Also publishes the web port over HTTPS on this machine's tailnet. The
  startup pairing URL is built against the shared origin, and the mapping is removed on exit.
  Shared runs default to Vite's bundled dev mode (`T3CODE_BUNDLED_DEV=1`): a remote browser pays a
  network round trip per import level in unbundled dev, which turns a cold module graph into
  minutes of waterfall. Set `T3CODE_BUNDLED_DEV=0` to opt a shared run back out.
  The web entry loads the app with a dynamic import so React refresh starts before shared UI
  chunks run. Keep app imports out of that entry. A static import can work on the first load
  and then fail on reload after Vite splits code for lazy routes.
  Bundled dev uses Tailwind's watched files to rebuild CSS. Its Vite-only hot-update hook is
  disabled in this mode because Rolldown does not supply the Vite server or module graph.
- `vp run dev --browser`: Auto-opens a browser. Off by default. The dev runner writes
  `T3CODE_NO_BROWSER` itself from this flag, so setting `T3CODE_NO_BROWSER=0` in your environment has
  no effect; use `--browser`.
- `vp run dev:server`: Starts just the server. It runs on Node (`node --watch src/bin.ts`), so
  without Bun present it selects `NodePtyAdapter` and `NodeHttpServer`.
- `vp run dev:web`: Starts just the Vite dev server for the web app.
- `vp run dev:desktop`: Starts the Electron shell against the dev server.
- `vp run dev:marketing`: Starts the Astro marketing site.
- Pass dev-runner flags directly after the root task name, for example:
  `vp run dev --home-dir /tmp/t3code-dev`

### Dev state directories

- Dev commands run from a linked **git worktree** default to that worktree's gitignored `.scient-next`, even
  when `T3CODE_HOME` is set, storing development state in `<worktree>/.scient-next/scient-next-dev`. Pass `--home-dir <path>` to
  choose another isolated directory explicitly. Submodules are not worktrees and keep the normal
  precedence.
- From the **main checkout**, dev commands implicitly use `~/.scient-next/scient-next-dev`, keeping development state
  separate from `~/.scient-next/userdata`. An explicit `--home-dir <path>` stores development state under
  `<path>/userdata`; the base directory remains available for caches, worktrees, and other shared
  data.
- First start warms the web dependency cache when needed. Database seeding is **off by default**.
  Only after explicit authorization to copy that profile, `--seed` (or `T3CODE_DEV_SEED=1`)
  can seed an empty worktree from `~/.t3/userdata/statev2.sqlite` through `migrate-dev-db`.
  The runner targets the candidate's `scient-next-dev`, the same state directory
  the dev server opens. Either existing V1 or V2 database there prevents source
  inspection and seeding. Ordinary development uses synthetic data;
  a dev command is not permission to read or copy a live profile.

## Build, check, test

- `vp run build`: Fans out over `apps/*`, `packages/*`, `oxlint-plugin-t3code`, and `scripts`.
  Workspaces that define a build task run one: desktop, marketing, server (which depends on web), and
  web. Shared packages are consumed and bundled transitively rather than built separately.
- `vp run build:desktop`: Builds the desktop pipeline (desktop plus server).
- `vp run start`: Runs the production server (serves the built web app as static files).
- `vp check`: Vite+ format, lint, and type checks. This repo sets `typeCheck: false` in its lint
  options, so workspace type checking runs separately.
- `vp run typecheck`: Strict TypeScript checks for all packages.
- `vp run test`: Runs workspace tests.
- From `apps/server`, `vp run test:performance` runs the explicit, serial benchmark
  lane: portable/native imports with 100,000 warnings (each strictly under 1,000 ms),
  large conversation imports and near-limit SCIC validation, and 28/100/500-entry
  skill orientation. It measures real execution; synthetic Effect clocks fix domain
  timestamps only. CI server shard 1 runs all three benchmark files. Ordinary
  correctness remains in the normal test lane. Run without concurrent heavy suites.
- From `apps/web`, `SCIENT_MARKDOWN_PERF_STRICT=1 vp run test:performance` runs the
  strict scientific-editor benchmark lane; see [its budgets](./scient-rich-markdown-editor.md#performance-budgets).
- `vp run lint:mobile`: Mobile native static analysis (`scripts/mobile-native-static-check.ts`).
- `node apps/server/scripts/t3-sqlite-state.ts <query|exec> --base-dir <path> ...`: Inspects or seeds
  an isolated T3 SQLite database; writes create a private backup first.

## Alignment consumer checks

`pnpm alignment:checks` selects existing consumer suites for early composition feedback.
The maintained [boundary map](../../scripts/scient-alignment-checks.json) records affected
owners and untouched consumers, deciding assertions, commands, prerequisites and limits
for provider guidance/skills/MCP/native input, Stop/Resume ownership, provider adapters and
native process lifecycle (every suite under `orchestration-v2/Adapters/`, with every native
provider integration suite mapped to its owning boundary), queue admission and
restart, settings precedence and instance identity, immutable persistence, native
conversation-fork capture, one server owner per state directory, and chat reader
interaction. Maintain the assertions and consumer triggers together when those contracts move.
This is a bounded impact map, not an exhaustive dependency graph or a qualification policy.
A check entry ending in `/` runs every suite in a directory the boundary owns, except
`*.live.test.ts` suites, which run only as listed native checks behind `--native`.

Print a plan before executing it:

```sh
pnpm alignment:checks --base <owned-base-sha>
pnpm alignment:checks --path apps/server/src/provider/PiDriverComposition.ts
pnpm alignment:checks --boundary queue --boundary stop
pnpm alignment:checks --all --run
SCIENT_PI_TEST_BINARY=/absolute/path/to/pi pnpm alignment:checks --all --native --run
```

`--base` includes committed, staged, working changes and non-ignored untracked paths
by unioning base-to-HEAD, HEAD-to-index, index-to-working-tree and untracked inputs.
A later restoration cannot cancel an earlier staged or committed impact. Deletes and
renames retain their paths, including both rename sides. `--path` is repeatable and describes
repository-relative consumer impact; it need not be an existing file. Choose exactly one
selection mode. Unknown paths and shared contracts, client runtime, execution/provider
cores, mobile surfaces, shared ChatComposer/ComposerPrimaryActions hosts, dependencies
or test setup select all boundaries. Recognized chat reader owners select reader
checks; other chat paths retain the unknown-path fallback. ChatView also selects settings;
Scient `threadQueue/` paths select the queue boundary and its existing client dispatch witnesses. Maintainer prose under `docs/internals/` and
`docs/operations/`, and read-only `.repos/` references, are explicit exclusions; runtime
instructions such as `AGENTS.md` are not. Review all exclusions for the actual range.

For an independent unlanded lane, run its absolute selector against another checkout:

```sh
node /absolute/phase1-worktree/scripts/scient-alignment-checks.mjs \
  --cwd /absolute/composed-worktree --base <owned-base-sha>
```

The selector and map remain in the implementation lane. `--run` executes the target
checkout's own suites with its installed dependencies; it never copies test or product
source into the target or changes its index. Missing/moved suites or an unresolved index
refuse execution (exit 2) instead of silently producing an empty pass. Printed plans can
still be reviewed before conflicts are resolved. Commands run serially with the existing
package configurations; a failing group does not stop later groups, and the run ends by
listing every failed group. Execution is synchronous and does not cache, resume, install
dependencies, coordinate other lanes or launch an app.

Every command runs without the variables a Scient desktop host gives its agents
(`ELECTRON_RUN_AS_NODE`, `T3CODE_HOME`, `T3CODE_CLI_PATH`, `SCIENT_NEXT_*`,
`SCIENT_ANALYTICS_*`) and with `SCIENT_NEXT_HOME` and `T3CODE_HOME` set to a fresh
temporary directory, so a check cannot fall back to a live profile. Explicit test inputs
such as `SCIENT_PI_TEST_BINARY` pass through.

`--web-unit` adds the whole web `unit` project, which hosted CI shards as Test Web and the
boundary map otherwise samples only through mapped suites (a source-text assertion elsewhere
in it is otherwise first seen in hosted CI). It runs alone or beside one selection mode. It is
opt-in because it is slow: about 14 minutes (811 s measured) on a Windows 11 workstation,
where a few suites also fail or flake on unmodified main. The lane fails on any failure: it
passes only when Vitest exits 0 with a readable report covering at least one test file, so an
interrupted, empty or partial run never passes. With `--run` it writes the failing tests
(`file > test name`, and `file > (file error)` for a file's own import or hook error) to
`web-unit-failures.json` in a new temporary directory. To tell which failures the candidate
introduced, run the lane once against an unmodified base checkout with `--cwd` and pass that
file to the candidate's run:

```sh
node /absolute/candidate/scripts/scient-alignment-checks.mjs \
  --cwd /absolute/base-checkout --web-unit --run
pnpm alignment:checks --base <owned-base-sha> --web-unit \
  --web-unit-baseline /absolute/tmp/scient-web-unit-lane-XXXX/web-unit-failures.json --run
```

The baseline never changes the verdict. It labels each failure as new or pre-existing for the
reader and lists baseline failures that no longer fail (fixed, removed or skipped). Labels are
best effort: a hook error inside a suite may appear only as its tests' failures, and a flaky
test can appear new; rerun its file before attributing it to the candidate.

## Alignment gates and receipt facts

`pnpm alignment:gates` runs the final local gate list from the
[alignment protocol](./upstream-alignment-protocol.md#5-validate-progressively) serially in
the same environment, each gate with its own temporary Scient/T3 state root. It continues past failures,
writes `results.json` and a log per gate to a new temporary directory after every gate,
and prints a Markdown table with the candidate commit, tree, platform and tool versions.
The knip gate runs `knip:check`, the unused files, dependencies and exports check that hosted
CI runs before `vp check`.
Typecheck uses `pnpm run typecheck`, including workspace Vite tasks without matching npm
scripts. The task runner may stop scheduling after a failure; a failed aggregate does not
prove every workspace was checked. Record task coverage and qualify missing packages separately. A desktop
smoke run that leaves its temporary home empty resolved state elsewhere and fails.
`--only fmt,lint` runs a subset and labels the result partial.

On Windows the repository-wide test aggregate is reported as not run: the local aggregate
is not a supported Windows lane yet (see `windows-tests.yml`), so hosted test
qualification of the pushed candidate remains pending. `--tests` runs it anyway. Run
Windows-sensitive focused suites by name instead, for example
`scripts/managed-provider-runtime-workflow.test.ts` (publication guards) from `scripts/`
with `pnpm exec vp test run --config ../vite.config.ts --dir . managed-provider-runtime-workflow.test.ts`.

`pnpm alignment:facts --merge <upstream-merge>` prints the receipt's boundary facts for
a committed upstream merge: owned base, previous boundary, target and its exact tags,
commit and path counts, initially unmerged paths reconstructed with the same merge
simulation as `plan`, the merge tree, and later merges on the branch, each labelled as an
owned-main catch-up or an official extension.
Shared model curation and project/settings reducers run before server integration checks.
Affected compilation and static checks remain separate required composition checks.
For older target revisions, review the actual assertion bodies too: an existing suite
may predate a deciding assertion in this map. Run a reviewed external witness for that gap.

Install from the committed lockfile with the repository Node/pnpm versions. The reader
geometry checks use the separate Playwright Chromium `layout` project, even though normal
web tests run only `unit`. Native Pi is opt-in: set `SCIENT_PI_TEST_BINARY` explicitly and
pass `--native`. The real RPC process uses a fresh synthetic profile and loopback model/MCP
endpoint; this proves instruction delivery and transport, not authenticated model quality.
Without `--native`, the plan reports that group's exclusion; no native pass is claimed.

Preserve the printed plan, exact candidate revision/diff, environment, commands, exits,
elapsed times and suite-reported skips externally. A zero exit with only excluded paths
means no behavioral checks were selected. Coordinate expensive checks with the owning
alignment integrator. These checks do not replace any complete local, hosted, native,
migration, provenance, protected-seam, or visual qualification required by
[AGENTS.md](../../AGENTS.md) and the [alignment protocol](./upstream-alignment-protocol.md).

## Desktop artifacts

- `vp run dist:desktop:artifact --platform <mac|linux|win> --target <target> --arch <arch>`: Builds a desktop artifact for a specific platform/target/arch.
- `vp run dist:desktop:dmg`: Builds a shareable macOS `.dmg` into `./release`. Architecture defaults
  to the host, so this produces an arm64 DMG on Apple Silicon. Use `dist:desktop:dmg:arm64` or
  `dist:desktop:dmg:x64`, or pass `--arch <arm64|x64|universal>`, to force one.
- `vp run dist:desktop:linux`: Builds a Linux AppImage into `./release`.
- `vp run dist:desktop:win`: Builds a Windows NSIS installer into `./release`. `:arm64` and `:x64`
  variants exist.

### Linux AppImage prerequisites

Linux AppImage packaging compiles the Rust resource monitor and the libsecret browser import
helper. Install a Rust toolchain, the standard C/C++ build tools, libsecret development headers,
pkg-config, and ImageMagick before running `vp run dist:desktop:linux`.

Ubuntu and Debian:

```bash
sudo apt-get update
sudo apt-get install cargo rustc build-essential libsecret-1-dev pkg-config imagemagick
```

Fedora:

```bash
sudo dnf install rust cargo gcc gcc-c++ make libsecret-devel pkgconf-pkg-config ImageMagick
```

Arch Linux:

```bash
sudo pacman -S rust base-devel libsecret pkgconf imagemagick
```

Linux desktop development also needs the C compiler, pkg-config, and libsecret headers. Its build
and launch commands compile `native/browser-secret/main.c` into the gitignored native build
directory. Releases place the executable in `resources/browser-secret`, outside `app.asar`.
The helper performs a read-only Chromium schema lookup through libsecret and writes the exact
secret bytes to its stdout pipe. Exit codes are 2 for a missing key, 3 for denied/locked access,
and 4 for other keyring failures; the desktop importer preserves these distinctions.

The artifact script checks these capabilities before starting the web and desktop builds. If
anything is unavailable, it reports every failed check together and prints the Ubuntu/Debian
installation command. The check compiles and links tiny temporary programs, so it also catches
installed runtime X11 libraries that are missing their development headers or linker symlinks.

### macOS DMG prerequisites

Install the Xcode Command Line Tools and Rust before building a DMG:

```bash
xcode-select --install
```

Install Rust from [rustup.rs](https://rustup.rs). The artifact script checks Cargo, Clang, Make,
`sips`, and `iconutil`. Universal builds additionally require `lipo`. It also verifies that Rust
has every requested target; add missing targets with:

```bash
rustup target add aarch64-apple-darwin x86_64-apple-darwin
```

Unsigned local builds need no Apple credentials. Builds using `--signed` additionally require the
certificate, provisioning profile, team ID, and notarization configuration described below.

### Windows installer prerequisites

Install Rust from [rustup.rs](https://rustup.rs), Python 3, and Visual Studio Build Tools. In the
Visual Studio Installer, select **Desktop development with C++** and include:

- MSVC x64/x86 build tools
- A Windows 10 or Windows 11 SDK
- MSVC Spectre-mitigated libraries

ARM64 installers require the corresponding MSVC ARM64 build tools and Spectre-mitigated libraries
instead of the x64/x86 components.

Add the Rust target matching the installer architecture:

```powershell
rustup target add x86_64-pc-windows-msvc
# For an arm64 installer:
rustup target add aarch64-pc-windows-msvc
```

Windows supplies `tar.exe`; it is checked when `--wsl-prebuild` makes the artifact include the WSL
runtime. NSIS is downloaded by electron-builder and does not need a separate installation.
When `T3CODE_DESKTOP_REUSE_RESOURCE_MONITOR=true` points the build at an existing resource monitor,
the artifact script skips the Rust and Visual Studio checks because it does not compile the monitor.
Unsigned local builds need no Azure credentials. Builds using `--signed` additionally require the
Azure Trusted Signing configuration described below.

### Desktop `.dmg` packaging notes

- Default build is unsigned/not notarized for local sharing.
- D4 rejects `--signed` and does not authorize distribution, notarization, or
  publication. Signing can be re-enabled only through a later release and
  credential review.
- The DMG build uses `assets/prod/black-macos-1024.png` as the production app icon source.
- The DMG chrome follows the release channel: neutral for Latest and the Nightly sky artwork for
  Nightly. Blueprint artwork remains exclusive to Dev builds. Packaging rasterizes the selected
  SVG into standard and Retina PNGs inside the disposable staging directory.
- The Finder window is 540×412 while its background is 540×380; the extra 32px accounts for the
  title bar included in Finder's window bounds.
- Desktop production windows load the bundled UI from the `scient-next://app/` root URL (not a
  `127.0.0.1` document URL, and not an explicit `index.html` path).
- Desktop packaging includes `apps/server/dist` (the `t3` backend) and starts it on loopback with an
  auth token for WebSocket/API traffic.
- Your tester can still open it on macOS by right-clicking the app and choosing **Open** on first
  launch.
- To keep staging files for debugging package contents, run: `vp run dist:desktop:dmg --keep-stage`
- The inherited `--signed` path is intentionally unavailable in this candidate
  during D4.
- Signed macOS builds also require `T3CODE_APPLE_TEAM_ID` and
  `T3CODE_MACOS_PROVISIONING_PROFILE`. The passkey RP domain is derived from
  `T3CODE_CLERK_PUBLISHABLE_KEY` unless `T3CODE_CLERK_PASSKEY_RP_DOMAINS` overrides it.
- Windows `--signed` uses Azure Trusted Signing and expects:
  `AZURE_TRUSTED_SIGNING_ENDPOINT`, `AZURE_TRUSTED_SIGNING_ACCOUNT_NAME`,
  `AZURE_TRUSTED_SIGNING_CERTIFICATE_PROFILE_NAME`, and `AZURE_TRUSTED_SIGNING_PUBLISHER_NAME`.
- Azure authentication env vars are also required (for example service principal with secret):
  `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`.

## Browser development

`dev` and `dev:web` leave `VITE_HTTP_URL` and `VITE_WS_URL` unset so the browser resolves the backend
from `window.location.origin`. Vite proxies `/api`, `/ws`, `/oauth`, and `/.well-known` to the
server, allowing the same bundle to work from localhost or a tailnet hostname.

## Running multiple dev instances

Worktrees derive a preferred port offset from their path.

- Default ports: server `13773`, web `5733`
- Shifted ports: `base + offset`
- Example: `T3CODE_DEV_INSTANCE=branch-a vp run dev:desktop`

Offset resolution, in order:

1. `T3CODE_PORT_OFFSET`, which must be a non-negative integer. Negative values are rejected.
2. `T3CODE_DEV_INSTANCE`. An all-digit value is used directly as the offset; any other non-empty
   value is hashed into one.
3. The worktree path hash.

Collision scanning depends on the mode. `dev:web` scans only the web port and shifts only the web
offset. `dev:server` scans only the server port. `dev` and `dev:desktop` scan both and shift them
together as one shared offset. Explicit server or dev-URL overrides remove the corresponding port
from the availability check. Treat the `[dev-runner]` output as authoritative.
