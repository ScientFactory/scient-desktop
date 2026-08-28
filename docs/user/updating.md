# Update Scient

Scient keeps the desktop app and the server attached to each environment as
separate versioned runtimes. A local desktop environment is bundled with the
app, while an SSH or manually managed environment may run its own Scient server.

## Update the desktop app

Packaged Scient releases check the selected update channel after startup and
periodically while the app is open. Updates are deliberate:

1. Select the update control near the bottom of the sidebar, or use
   **Scient → Check for Updates…** on macOS.
2. When a release is available, choose the control again to download it.
3. After the download finishes, review the restart confirmation and install it.

Scient does not install an update silently while work is running. Let active
agent turns and terminal commands finish before restarting. Threads, settings,
and project files remain in their existing locations.

**Settings → General → Desktop updates** selects **Stable** or **Nightly**.
Stable follows full public releases. Nightly is a preview channel and can move
more often; switch back to Stable when you no longer want preview builds.

Automatic update checks require an official packaged build and a configured
release feed. On Linux they additionally require running the AppImage. If the
updater is unavailable, download the current installer from the
[official Scient download page](https://scientfactory.com/download/).

## Keep a connected server in sync

If a connected environment uses a different server version, Scient shows the
version warning above the composer and in **Settings → Connections**. Hiding
the composer warning does not change either runtime.

The action depends on how that environment started:

| Action                     | Meaning                                                                                                           |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| **Update the desktop app** | Update Scient on the machine that owns the bundled local server.                                                  |
| **Update server**          | Prepare and trial an exact replacement for a supported background service, then reconnect only after it is ready. |
| **Copy update command**    | Copy the exact Scient release-asset command for a manually managed server and run it on that server machine.      |

Scient does not publish a package under T3's npm identity. Current update
commands use the immutable `scient-server-<version>.tgz` asset from the matching
`ScientFactory/scient-desktop` GitHub release. The command may end with the
internal executable name `t3`; that name is retained for upstream compatibility
and does not mean the runtime was fetched from T3.

Do not replace the copied command with `npx t3@latest`: that can fetch a
different product and cannot guarantee a server matching the Scient client.

## Background-service updates

A supported background service stages the exact target runtime before stopping
the active server. It then starts the target as a trial, applies migrations,
and reports one of these outcomes:

- **committed**: the target version is ready and becomes the normal runtime;
- **rolled back**: the trial failed before commit and the previous runtime and
  database snapshot were restored; or
- **failed**: the launcher could not safely complete the operation.

Keep Scient open while the server restarts. The update is complete only when
the replacement server reports ready, not merely when the initial update
request is accepted. A failure remains visible for review and retry.

An old service launcher may require one local repair/update before it supports
transactional trials. Use the exact command supplied by Scient or the procedure
in [Run Scient in the background](./background-service.md).

## Troubleshooting

1. Confirm that you are updating the machine named in the warning.
2. Let active work finish, then retry the offered action once.
3. For a manually managed server, copy the command again instead of reusing an
   older version or changing its release URL.
4. If a desktop update cannot be checked or downloaded, install the same or a
   newer official release manually; do not remove the existing data directory.

Scient has no current public mobile release or Scient-hosted web client with a
separate update channel. Mobile and hosted T3 update instructions do not apply
to the Scient desktop product.
