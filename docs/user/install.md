# Install Scient

Scient is distributed as a desktop app for macOS, Windows, and Linux. The
desktop app includes its own Scient server; you do not need Node.js or a
provider CLI merely to install and open it.

## Download the desktop app

Use the [official Scient download page](https://scientfactory.com/download/),
which resolves installers from
[ScientFactory/scient-desktop releases](https://github.com/ScientFactory/scient-desktop/releases).
Those are the only current public Scient desktop distribution channels.

| Platform            | Current public artifact |
| ------------------- | ----------------------- |
| macOS Apple Silicon | Arm64 DMG               |
| macOS Intel         | x64 DMG                 |
| Windows             | x64 installer           |
| Linux               | x64 AppImage            |

Scient is not currently published through the T3 npm package, Homebrew cask,
WinGet package, or T3's GitHub releases. Do not use `npx t3@latest` to install
Scient: that resolves a T3-owned package rather than the Scient release.

## First launch

### macOS

Open the DMG and move **Scient** to **Applications**. Current macOS releases
are Developer ID signed and notarized. If macOS still blocks the first launch,
Control-click **Scient**, choose **Open**, and review the system prompt. Do not
disable Gatekeeper or other operating-system security controls.

Choose the Apple Silicon build for an M-series Mac and the Intel build for an
Intel Mac. An Intel build can run under translation on Apple Silicon, but the
native Arm64 build is preferred.

### Windows

Run the x64 installer. Early-access release notes identify whether that exact
installer is signed. An unsigned build may show **Unknown Publisher** or a
SmartScreen warning; verify that the file came from the official ScientFactory
release before deciding whether to continue.

### Linux

Download the x64 AppImage, make it executable if your file manager did not do
so, and run it. Keep running the AppImage itself if you want Scient's built-in
desktop updater; an extracted or differently packaged build does not have that
update contract.

## Connect an AI provider

Provider authentication is required only when you want to start work with that
provider. You can open Scient, add a project, and configure providers later.

The first-run **Choose your AI** step and **Settings → Providers** can install
reviewed private runtimes for supported providers, start their official sign-in
flows, or keep using a healthy system or custom installation. Scient does not
silently replace a provider CLI that you chose to manage yourself.

For the current provider list, setup choices, and authentication boundaries,
see [AI providers](./providers.md). The composer and provider settings identify
whether a runtime is missing, sign-in is required, or a usable model is ready.
Run manual recovery commands in the environment where the Scient project runs,
which may be a remote machine rather than the computer displaying the app.

## Existing Scient data

Installing a newer Scient desktop release over the same production identity
keeps the established Scient data location. Some internal directories retain
the `scient-next` name as a compatibility value; that is not T3 branding and
should not be renamed or moved manually.

Scient does not automatically import state from T3 Code, Synara, development
builds, or another retired application. A data migration is a separate,
explicit operation—not part of installation.

## Next steps

- [Getting started](./getting-started.md)
- [AI providers](./providers.md)
- [Permission modes](./permission-modes.md)
- [Updating Scient](./updating.md)
- [Remote environments](./remote-access.md)
- [Advanced background server](./background-service.md)
