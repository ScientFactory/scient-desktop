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
in **Settings → Connections** to run agents and projects there, and install the
provider CLIs inside that distro. Scient keeps a Linux-local copy of the matching
server runtime there and installs it automatically. The first launch after an app
update can take longer while that copy is prepared. Later launches reuse it,
keep one previous working runtime for rollback, and repair the cache
automatically if the selected copy can no longer start.

### Linux

Download the x64 AppImage, make it executable if your file manager did not do
so, and open it. Keep the AppImage in a permanent location if you want Scient's
built-in desktop updater to continue finding it.

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

### Open a project from a terminal

With the desktop app already running on the same machine:

```bash
t3 app
```

This opens a new thread for the current directory, adding the project if needed.
Pass a path, such as `t3 app ../my-project`, to open another directory. It requires
the desktop app, so a standalone server or an SSH session is not enough. If the
command cannot reach the app, start or update the desktop app and try again.

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
| OpenCode    | Install [OpenCode](https://opencode.ai), then run `opencode auth login`.                                                                                  |
| Antigravity | Install and sign in with Google from Scient's provider settings.                                                                                          |
| Pi          | Install [Pi](https://pi.dev), then run `pi` once to finish its login or API-key setup.                                                                    |

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
available version. **Update now** appears only when Scient can tell which
installer owns the CLI (its own update command, Homebrew, or a global npm, pnpm,
bun, or Vite+ install) and runs that installer. Otherwise update the CLI the same
way you installed it. Homebrew installs compare against the version Homebrew
offers, which can trail the npm release by a few hours.

Add another provider instance for a separate account or configuration. Each
instance can have its own environment variables, such as API keys or a custom
base URL. Mark secret values as sensitive; after saving, Scient does not display
their original values.

For provider-specific setup and accounts, see [Codex](./providers-codex.md),
[Claude](./providers-claude.md), [Cursor](./providers-cursor.md),
[Grok](./providers-grok.md), [Droid](./providers-droid.md),
[OpenCode](./providers-opencode.md), [Antigravity](./providers-antigravity.md),
[Pi](./providers-pi.md), and [Oh My Pi](./providers-omp.md).

## Next steps

- [Working with threads](./thread-sidebar.md): start tasks and organize parallel work.
- [Permission modes](./permission-modes.md): choose when agents ask before acting.
- [Remote access](./remote-access.md): connect from another device.
- [Running in the background](./background-service.md): keep a Linux or macOS host available.
- [Updating Scient](./updating.md): update the app and connected servers.
