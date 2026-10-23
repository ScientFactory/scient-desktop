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
three-dot **More sidebar actions** menu while the update control or the update
circle is showing. Widening the sidebar brings their icons back into the footer
row.

Scient never installs an update on its own. Restarting interrupts running agent
turns and terminal commands, so let them finish before choosing **Restart**.
Threads, settings, and project files remain in their existing locations.

If the app restarts on its old version, Scient tells you the update did not
apply. It does not install that version again on its own, even when another
device asks. Use the update control on that machine to retry.

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

## Update other machines and providers

Updates for connected machines and providers have their own control: a small
light-blue circle with an up arrow, beside the update control. It covers
servers and desktop apps on connected machines, provider CLIs Scient can update
in one step, and Scient-managed provider runtimes. Updates Scient can't run
itself are listed in Settings instead. Hover, focus, or click the circle to open
its card; a click keeps the card open.

Each row names the item, its machine when that is not this one, and the version
change. Choose **Update** on a row, or **Update all**. Neither restarts this
app, so they start right away. When a server update would stop threads running
on that machine, the card first shows how many, such as **Stops 2 running
threads**; choose **Update** again to go ahead. While a provider on a machine is
still updating, that machine's server shows **waiting** and **Update all** leaves
it for later; it offers **Update** again once the provider is done. While updates
run, the circle shows a spinning ring and each row shows a download percentage
or its current step. A Scient-managed runtime that waits for running turns shows
**waiting for idle** and switches on its own. A failure turns the circle red;
its row shows the reason and **Retry**, which updates a server again to the
version it tried while it is still eligible for it. Finished rows show **done**
until you next open the card, and the circle shows a brief check before it
disappears. Progress and result notifications appear as for updates started
elsewhere.

An SSH machine that Scient starts from this app's own package is not listed; it
moves to the new version the next time it connects after this app updates.

When this app also has an update to download, choosing **Update** on the update
control includes everything else in one step: outdated providers first, then
servers that are behind, then this desktop app. Servers move to the version this
app is installing, or to your web app's version. A background service stays on
its current release channel, and a remote desktop app installs the latest
release from its own channel. If servers would stop running threads, a small
card above **Update** says how many and waits for you to choose **Update** or
**Cancel**; otherwise the step starts straight away. Progress appears in the
circle. Once each server has started its own
restart, a tooltip above **Restart** counts down to this app's restart: choose
**Restart** to restart now, or **Later** to keep working and restart when you
are ready. A server that is still restarting finishes on its own.

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
A thread that finished its turn to wait on a monitor, subagent, or background task
is woken and told that this work stopped. A background shell, such as a dev server,
does not wake it; the thread learns about it with your next message.
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

| Action                     | What to do                                                                                                                                                                  |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Update server**          | Keep the client open while it installs and reconnects. For a desktop-hosted server, this also closes and relaunches the desktop app on the host.                            |
| **Update the desktop app** | Update the desktop app on the machine running the server, then reopen it if needed.                                                                                         |
| **Copy update command**    | Run the command on the named host to update the detected global npm install, then restart the server with your usual options.                                               |
| **Copy relaunch command**  | Stop the command-line server on its host and relaunch with the copied command, keeping your usual subcommand and options. This does not update a globally installed server. |

A server you run without the desktop app is updated by restarting it from the
newer release; see [Run a Scient server without the desktop app](./background-service.md).

## Troubleshooting

1. Confirm that you are updating the machine named in the warning.
2. Let active work finish, then retry the offered action once.
3. For a manually managed server, copy the command again instead of reusing an
   older version or changing its release URL.
4. If a desktop update cannot be checked or downloaded, install the same or a
   newer official release manually; do not remove the existing data directory.

Only one server can use a Scient data directory at a time. If startup reports
that another server owns it, stop that server before retrying, or use a separate
data directory and pair with the running server.

## Update providers

The sidebar's update circle lists provider updates for every connected
environment beside its server updates. Servers requiring an exact Scient release
artifact are listed only when that artifact is available from Scient's release
repository. Disconnected environments, missing maintenance permissions, and
incompatible release channels are left out. In the desktop app, the circle
replaces the "update available" notices for providers; the web app keeps them.

After **Update all**, or a step that includes this app, one summary lists what
was updated and each failure. When this desktop app installs last, the summary
appears after it restarts. Threads on a server that can resume them after its
update are not counted as stopped. Continuation still requires that server's
supported capability and enabled setting; it does not revive stopped or settled
work. If a server would stop more threads when its restart is due than when you
chose **Update**, it waits in the circle instead.

**Settings → Providers** shows provider updates for the selected environment.
**Update all** updates every outdated provider on every connected environment
at once. Hover it to see which providers it will update. Two kinds are left
out on purpose: providers that only offer a manual update command, and
Scient-managed runtimes, which update from their own actions or the sidebar
circle.

After a successful provider CLI update, Scient refreshes model discovery for
every enabled instance of that provider using its own configuration. Connected
clients receive the refreshed catalogs automatically.

The provider update checks setting also controls whether Scient downloads model
catalog updates. With it off, new models may not appear until you turn it on
and refresh provider status.

Provider updates do not restart running chats. An existing session can keep
using the previous CLI until it ends. If discovery fails, check the provider
status and refresh it again.
