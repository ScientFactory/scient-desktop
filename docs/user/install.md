# Install Scient

Scient is available as a desktop app for macOS, Windows, and Linux. A normal
local installation does not require Node.js or a separate server.

## Download the desktop app

Choose the installer for your computer below. Each link downloads the latest
public build from the official Scient release.

| Platform            | Current public artifact                                            |
| ------------------- | ------------------------------------------------------------------ |
| macOS Apple Silicon | [Arm64 DMG](https://scientfactory.com/api/download/macArm64)       |
| macOS Intel         | [x64 DMG](https://scientfactory.com/api/download/macX64)           |
| Windows             | [x64 installer](https://scientfactory.com/api/download/windowsX64) |
| Linux               | [x64 AppImage](https://scientfactory.com/api/download/linuxX64)    |

## First launch

### macOS

Choose the Apple Silicon build for an M-series Mac and the Intel build for an
Intel Mac. Open the DMG and move **Scient** to **Applications**. If macOS asks
you to confirm the first launch, verify that you downloaded Scient from the
official page and follow the system prompt. Do not disable Gatekeeper or other
operating-system security controls.

### Windows

Run the x64 installer. If Windows displays a SmartScreen warning, verify that
you downloaded the installer from the official Scient page before deciding
whether to continue.

When Scient runs a project through Windows Subsystem for Linux, choose the distro
in **Settings → Sharing & access** to run agents and projects there, and install the
provider CLIs inside that distro. Scient keeps a Linux-local copy of the matching
server runtime there and installs it automatically. The first launch after an app
update can take longer while that copy is prepared. Later launches reuse it,
keep one previous working runtime for rollback, and repair the cache
automatically if the selected copy can no longer start.

### Linux

Download the x64 AppImage, make it executable if your file manager did not do
so, and open it. Keep the AppImage in a permanent location if you want Scient's
built-in desktop updater to continue finding it.

## Use Scient from a terminal

In **Settings → About**, install the **scient command** to put the
desktop app's bundled CLI on your terminal's PATH. Open a new terminal after
installation. If Settings reports that the installation folder is outside PATH,
add that folder to your shell's PATH.

Run `scient --help` to see the available commands. With the desktop app already
running on the same machine:

```bash
scient app
scient app ../my-project
```

The first command opens a new thread for the current directory, adding the
project if needed; the second opens another directory. A standalone server or
an SSH session is not enough. If the command cannot reach the app, start or
update the desktop app and try again. `scient start` and `scient serve` start
a backend server; use `scient app` to open a project in the running desktop app.

Settings offers **Install scient** when the command is not installed and
**Remove** when a Scient-owned terminal shortcut exists. A fresh installation
has nothing to remove. Older Scient-installed `t3` shortcuts are handled
automatically and keep working after an update; no separate migration action
is needed. **Remove** cleans up owned shortcuts and leaves unrelated commands
and user-managed PATH entries alone. Internal bundled launchers remain
available to the app; an update does not recreate a removed `t3` shortcut.

If another `scient` command would run first, Settings refuses to overwrite or
hide it and reports its path. Resolve that conflict yourself or run the
bundled launcher directly at the path shown. You can still remove an owned
legacy shortcut when this conflict prevents installation.

Recovery commands printed by Scient may use an absolute launcher or runtime
instead of the short name. Paste them as shown: they select the installation
and profile that reported the problem, including Linux browser setup under
`sudo`. Windows operational snippets use PowerShell.

When **Settings → Maintenance** suggests reclaiming database space, run the command
it shows; see [Reclaim database space](./background-service.md#reclaim-database-space).

## Start using Scient

If the app shows **Scient could not load**, check your connection and select
**Reload** to try again.

When Scient opens, the optional [Getting started](./getting-started.md) flow can
help you connect an AI provider and add your first project. You can skip it and
configure providers later from **Settings → Providers**. Provider setup is not
required before Scient itself starts: install or connect a provider when you
are ready to begin a conversation.

Scient can use a healthy provider tool already installed on the environment or,
when supported, install and verify a private Scient-managed copy. See
[AI providers](./providers.md) for setup and lifecycle details, or
[Projects](./projects.md) for adding a workspace.

To add projects on this computer from the desktop app, drag one or more folders
from Finder, Explorer, or your file manager onto the sidebar. Each one opens as
a project, the same as `scient app`. Files dropped on a thread still attach to
that thread. Browsers do not share folder paths, so in the web app use
**Add project** instead.

## Providers

Open **Settings → Providers** in the web or desktop app, select the environment,
and enable the provider you want. Installation, login, and configuration belong
to that environment's machine, even when you connect from a phone or another
computer.

| Provider    | Install and authenticate                                                                                                                                  |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Codex       | [Connect with ChatGPT](./providers-codex.md#connect-with-chatgpt), or install [Codex CLI](https://developers.openai.com/codex/cli) and run `codex login`. |
| Claude      | Install [Claude Code](https://claude.com/product/claude-code), then run `claude auth login`.                                                              |
| Cursor      | Install [Cursor CLI](https://cursor.com/cli), then run `agent login`.                                                                                     |
| Grok        | Install [Grok CLI](https://x.ai/cli), then run `grok login`.                                                                                              |
| Kiro        | Install [Kiro CLI](https://kiro.dev/docs/cli/), then run `kiro-cli login`.                                                                                |
| OpenCode    | Install [OpenCode](https://opencode.ai), then run `opencode auth login`.                                                                                  |
| Antigravity | Install and sign in with Google from Scient's provider settings.                                                                                          |
| Pi          | Use Scient's managed **Install** action or [set up Pi](./providers-pi.md#setup) with Node.js 22.19 or newer, then run `pi` and `/login`.                  |
| Muse Code   | Install [Muse Code](https://dev.meta.ai/docs/muse-code) on the server, run `muse login`, then enable it in Settings → Providers.                          |
| fx          | Install [fx](https://fx.sh) with `curl -fsSL https://fx.sh/setup.sh \| bash`, then run `fx login`.                                                        |

Provider CLIs must be on the server's `PATH`. If Scient cannot find one, set its
**Binary path** in provider settings, especially when using a version manager.
Cursor's executable is `cursor-agent`, although its login command is
`agent login`. Codex connected through ChatGPT and Antigravity can use their
managed runtimes without a `PATH` entry.

Scient warns when a provider version has known compatibility problems with your
release. Check **Settings → Providers** on that environment for the recommended
version or range. When its package manager supports installing a specific version,
you can install the recommendation there. Otherwise use the provider's installer
on the environment's machine. An unlisted version is unverified.

When a provider CLI is behind its latest release, its provider card shows the
available version. **Update now** runs the installer that owns the CLI
(Homebrew, or a global npm, pnpm, Yarn, Bun, Volta, or Vite+ install), or the
CLI's own update command when Scient cannot tell. Claude, Codex, and OpenCode
installs Scient cannot identify stay manual: update them through the installer
you used. Update a CLI installed with mise through mise, and one installed with
Nix through Nix. Cursor and Antigravity update with Scient. Homebrew and
Chocolatey installs compare against the version their package manager offers,
which can trail the npm release; update Claude installed with Chocolatey through
Chocolatey.

The managed runtimes for Antigravity and for Codex connected through ChatGPT
first install the release Scient qualified. When a newer qualified release is
available, their setup in **Settings → Providers** offers an update.

Add another provider instance for a separate account or configuration. Each
instance can have its own environment variables, such as API keys or a custom
base URL. Mark secret values as sensitive; after saving, Scient does not display
their original values.

For provider-specific setup and accounts, see [Codex](./providers-codex.md),
[Claude](./providers-claude.md), [Cursor](./providers-cursor.md),
[Grok](./providers-grok.md), [Droid](./providers-droid.md),
[OpenCode](./providers-opencode.md), [Antigravity](./providers-antigravity.md),
[Kiro](./providers-kiro.md), [Muse Code](./providers-muse.md), [Pi](./providers-pi.md),
[Oh My Pi](./providers-omp.md), and [fx](./providers-fx.md).

### Provider check timeouts

If a provider works in its CLI but Scient reports a timeout while checking it,
allow more time in the Scient server's environment. For example, give Codex and
Claude readiness checks 60 seconds:

```bash
T3CODE_CODEX_PROBE_TIMEOUT_MS=60000 T3CODE_CLAUDE_PROBE_TIMEOUT_MS=60000 scient serve
```

For a remote environment, set these on the machine running the Scient server.
Keep them in your launcher or process manager configuration to retain them
across updates, then restart the server. For systemd, add
`Environment=T3CODE_CODEX_PROBE_TIMEOUT_MS=60000` under `[Service]` in a service
override, reload systemd, and restart the service. Provider instances can also
set their own overrides in Settings → Providers.

Each variable extends that provider's readiness-probe deadlines; a phase whose
default is already longer keeps its default. Providers with several phases can
take longer than one deadline in total. Values must be whole milliseconds no
greater than 2147483647; unset or invalid values keep the defaults.

| Provider            | Environment variable                   |
| ------------------- | -------------------------------------- |
| Codex               | `T3CODE_CODEX_PROBE_TIMEOUT_MS`        |
| Claude              | `T3CODE_CLAUDE_PROBE_TIMEOUT_MS`       |
| Cursor              | `T3CODE_CURSOR_PROBE_TIMEOUT_MS`       |
| Antigravity         | `T3CODE_ANTIGRAVITY_PROBE_TIMEOUT_MS`  |
| Grok                | `T3CODE_GROK_PROBE_TIMEOUT_MS`         |
| Kiro                | `T3CODE_KIRO_PROBE_TIMEOUT_MS`         |
| fx                  | `T3CODE_FX_PROBE_TIMEOUT_MS`           |
| Pi                  | `T3CODE_PI_PROBE_TIMEOUT_MS`           |
| Muse Code           | `T3CODE_MUSE_PROBE_TIMEOUT_MS`         |
| OpenCode            | `T3CODE_OPENCODE_PROBE_TIMEOUT_MS`     |
| ACP Registry agents | `T3CODE_ACP_REGISTRY_PROBE_TIMEOUT_MS` |

Longer deadlines also take longer to report a stalled check. These overrides
cover readiness and discovery, including OpenCode server startup. Usage and
config enrichment retain their own shorter limits. Turn execution, package
installation, update checks, and shutdown limits keep their existing behavior.

## Next steps

- [Working with threads](./thread-sidebar.md): start tasks and organize parallel work.
- [Permission modes](./permission-modes.md): choose when agents ask before acting.
- [Remote access](./remote-access.md): connect from another device.
- [Running a server without the desktop app](./background-service.md): host an environment on another machine.
- [Updating Scient](./updating.md): update the app and connected servers.
- [Managed policy](./managed-policy.md): configure Scient for everyone on a machine.
