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

When Scient runs a project through Windows Subsystem for Linux, it keeps a
Linux-local copy of the matching server runtime. The first launch after an app
update can take longer while that copy is prepared. Later launches reuse it,
keep one previous working runtime for rollback, and repair the cache
automatically if the selected copy can no longer start.

### Linux

Download the x64 AppImage, make it executable if your file manager did not do
so, and open it. Keep the AppImage in a permanent location if you want Scient's
built-in desktop updater to continue finding it.

## Start using Scient

When Scient opens, the optional [Getting started](./getting-started.md) flow can
help you connect an AI provider and add your first project. You can skip it and
configure providers later from **Settings → Providers**. Provider setup is not
required before Scient itself starts: install or connect a provider when you
are ready to begin a conversation.

Scient can use a healthy provider tool already installed on the environment or,
when supported, install and verify a private Scient-managed copy. See
[AI providers](./providers.md) for setup and lifecycle details, or
[Projects](./projects.md) for adding a workspace.
