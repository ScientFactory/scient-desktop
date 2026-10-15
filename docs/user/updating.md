# Update Scient

Scient keeps the desktop app and the server attached to each environment as
separate versioned runtimes. A local desktop environment is bundled with the
app, while an SSH or manually managed environment may run its own Scient server.

## Update the desktop app

Packaged Scient releases check their selected update track after startup and
periodically while the app is open. Updates are deliberate:

1. Select the update control near the bottom of the sidebar, or use
   **Scient → Check for Updates…** on macOS.
2. When a release is available, choose the control again to download it.
3. When the download finishes, a notice appears just above the control. Choose
   **Restart now** to install the update.

The notice closes after about five seconds, or when you dismiss it. The update
control then shows **Restart**. Choosing **Restart** in the sidebar, or
**Install** in **Settings**, restarts Scient right away, with no extra
confirmation. The
**Read more** link in the notice opens that version's Scient release notes;
reading them does not install the update. On Windows, Scient can stay closed for
a few minutes while the update installs, then reopens.

On a narrow sidebar, **Import conversation** and **Usage** move into the
three-dot **More sidebar actions** menu while the update control is active.
Widening the sidebar brings their icons back into the footer row.

Scient never installs an update on its own. Restarting interrupts running agent
turns and terminal commands, so let them finish before choosing **Restart**.
Threads, settings, and project files remain in their existing locations.

Choose **Stable** or **Beta** in **Settings → General → Update track**. Existing
Stable installations stay on Stable until you choose Beta. Beta offers previews
from a separate release feed. Before the first Beta is published, choosing Beta
simply reports no available update. Your choice is saved across restarts.

You can return to Stable at any time. If the installed Beta is ahead of Stable,
Scient waits for a stable version at least as new as that Beta; it never
installs an older version automatically. Stable and Beta use the same app and
saved data. Legacy Nightly preferences return to Stable and do not enroll you
in Beta.

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
A thread is not resumed while it waits for your approval, answer, or secret, or
while it is archived, snoozed, or settled. After three automatic resumes in a row,
the thread waits for your next message.

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

| Action                     | What to do                                                                                                                                                                                      |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Update server**          | Keep the client open while it installs and reconnects. Supported background services update remotely. For a desktop-hosted server, this also closes and relaunches the desktop app on the host. |
| **Update the desktop app** | Update the desktop app on the machine running the server, then reopen it if needed.                                                                                                             |
| **Copy update command**    | Run the command on the named host to update the detected global npm install, then restart the server with your usual options.                                                                   |
| **Copy relaunch command**  | Stop the command-line server on its host and relaunch with the copied command, keeping your usual subcommand and options. This does not update an installed `t3` command.                       |

An older service installation may require one local repair or update first.
Use the exact command supplied by Scient or the procedure
in [Run Scient in the background](./background-service.md).

## Troubleshooting

1. Confirm that you are updating the machine named in the warning.
2. Let active work finish, then retry the offered action once.
3. For a manually managed server, copy the command again instead of reusing an
   older version or changing its release URL.
4. If a desktop update cannot be checked or downloaded, install the same or a
   newer official release manually; do not remove the existing data directory.

## Update providers

The sidebar's **Update everything** action shows the eligible updates for each
connected environment before you confirm. It updates providers first, then
supported remote servers, and installs this desktop app last. Servers requiring
an exact Scient release artifact are included only when that artifact is
available from Scient's release repository. Disconnected environments, missing
maintenance permissions, and incompatible release channels are excluded.

The confirmation identifies the servers that will restart and whether they can
resume interrupted threads. Continuation still requires that server's supported
capability and enabled setting; it does not revive stopped or settled work.

**Settings → Providers** shows provider updates for the selected environment.
**Update all** updates every outdated provider on every connected environment.
Hover it to see each one with its installed and new version, and whether
Scient manages it or it is a system installation. A runtime several provider
instances share is updated once.

Scient-managed runtimes take their qualified release through Scient's own
update: it downloads and verifies the release, then switches over once the
provider's running work has finished. **Update all** waits for that, even if
you leave Settings, and shows **Waiting…** while running work holds the switch.
Providers that only offer a manual update command, and custom paths, are left
out. One notice reports how many updated and names each one that failed or was
cancelled; a failure on one machine does not stop the others.

If a machine goes offline or starts reconnecting during a managed update,
Scient waits up to two minutes for it to come back. If it does not, or its
connection is closed or fails, that update is reported as failed because Scient
lost contact; review the provider in Settings once the machine is back.

**Update everything** restarts a server, or installs this desktop app, only
once that machine is connected and no managed runtime on it is still updating,
including updates you started elsewhere. If Scient cannot confirm that, because
it lost contact with the machine, it leaves that server or this app as it is
and says so; update it once the machine reconnects.
