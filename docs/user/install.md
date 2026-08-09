# Install T3 Code

T3 Code is a web and desktop GUI for running coding agents on your machine.

## Requirements

Node.js `^22.16 || ^23.11 || >=24.10` on the machine that runs the T3 Code server.

At least one provider CLI, installed and authenticated. See [Providers](#providers) below.

## Run Without Installing

```bash
npx t3@latest
```

This starts the T3 Code server on your machine and opens the local web app. Use
`npx t3@latest --help` for the full CLI reference.

## Desktop App

Download the latest release from
[GitHub Releases](https://github.com/pingdotgg/t3code/releases), or install from a package
registry.

Windows:

```bash
winget install T3Tools.T3Code
```

macOS:

```bash
brew install --cask t3-code
```

Arch Linux:

```bash
yay -S t3code-bin
```

## Providers

Scient drives provider-owned tools. In the local desktop app, **Choose your AI** can privately
install reviewed Codex and Claude runtimes and start their official sign-in flows. A healthy system
or custom installation remains supported and is never silently replaced. Other providers still use
their externally installed tools.

| Provider   | CLI                                                   | Default binary | Manual recovery command       |
| ---------- | ----------------------------------------------------- | -------------- | ----------------------------- |
| Codex      | [Codex CLI](https://developers.openai.com/codex/cli)  | `codex`        | `codex login`                 |
| Claude     | [Claude Code](https://claude.com/product/claude-code) | `claude`       | `claude auth login --console` |
| Cursor     | [Cursor CLI](https://cursor.com/cli)                  | `cursor-agent` | `agent login`                 |
| Grok Build | [Grok Build CLI](https://x.ai/cli)                    | `grok`         | `grok login`                  |
| OpenCode   | [OpenCode](https://opencode.ai)                       | `opencode`     | `opencode auth login`         |

Cursor is the one to watch: install Cursor CLI, which provides the `cursor-agent` binary that
T3 Code looks for, but authenticate with `agent login`, not `cursor-agent login`.

Run a manual recovery command on the machine running the Scient server, not on the device you browse
from.

### Binary Discovery

Each provider CLI must be on the server's `PATH`, or have an explicit binary path set in
**Settings** → the provider instance → **Binary path**. Use the explicit path when a version
manager or a non-standard install location keeps the CLI off the `PATH` of the shell that
started T3 Code.

### When Auth Is Needed

Provider auth is required before you start a session with that provider, not before you start
Scient. You can open Scient and connect providers afterwards. The composer and **Settings >
Providers** show whether the tool is missing, sign-in is required, or a usable model is ready.

For multi-account setups, see [Codex](./providers-codex.md) and [Claude](./providers-claude.md).

## Next Steps

- [Permission modes](./permission-modes.md): how much T3 Code asks before acting
- [Remote access](./remote-access.md): connect from a phone, tablet, or another desktop
- [Keeping T3 Code in sync](./updating.md): client and server version skew
- [Running in the background](./background-service.md): Linux background service
