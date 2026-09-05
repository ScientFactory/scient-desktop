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

The **Read more** link in the download notification opens that version's
Scient release notes. Reading the notes does not install the update; return to
Scient and use the update control to restart and install it.

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

**Settings → General → Continue threads after restarts** is off by default.
When enabled, supported active threads can resume after an update, crash, or machine restart.
Scient must start again on that machine; this does not enable automatic startup. Threads without
saved provider resume state need a new message, and terminal commands may still be interrupted.
Changes apply to connected environments that support the setting. After an offline environment
reconnects, use **Apply to all** to reconcile a different value; older servers need updating first.
If you previously enabled continuation only for updates, enable this setting once to allow recovery
without a connected client.

The action depends on how that environment started:

| Action                     | Meaning                                                                                                           |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| **Update the desktop app** | Update Scient on the machine that owns the bundled local server.                                                  |
| **Update server**          | Prepare and trial an exact replacement for a supported background service, then reconnect only after it is ready. |
| **Copy update command**    | Copy the exact Scient release-asset command for a manually managed server and run it on that server machine.      |

For a server owned by a current Scient desktop app, **Update server** can close
and relaunch that desktop app on its machine. If installation fails, the app
stays open and reconnects to its existing server.

Run the copied update command exactly as Scient provides it. Changing its
package, version, or release URL can install a server that does not match the
desktop client.

## Background-service updates

A supported background service prepares the target version before replacing
the active server. It reports one of these outcomes:

- **committed**: the target version is ready and becomes the normal runtime;
- **rolled back**: the trial failed before commit and the previous runtime and
  database snapshot were restored; or
- **failed**: the launcher could not safely complete the operation.

Keep Scient open while the server restarts. The update is complete only when
the replacement server reports ready, not merely when the initial update
request is accepted. A failure remains visible for review and retry.

An older service installation may require one local repair or update first.
Use the exact command supplied by Scient or the procedure
in [Run Scient in the background](./background-service.md).

## Nightly desktop release notes

The desktop app shows a compact release-notes preview when a nightly update is available. Changes
appear newest first within each release. Each release links to its exact page on GitHub, even when
all changes fit in the preview.

The preview shows up to eight changes from each of six releases. When it leaves out changes or older
releases, it shows the exact number and links to the rest. Contributor credits do not count as
changes.

## Troubleshooting

1. Confirm that you are updating the machine named in the warning.
2. Let active work finish, then retry the offered action once.
3. For a manually managed server, copy the command again instead of reusing an
   older version or changing its release URL.
4. If a desktop update cannot be checked or downloaded, install the same or a
   newer official release manually; do not remove the existing data directory.
