# Unread answers and the app icon badge

The desktop app icon shows how many threads the sidebar marks unread: threads
with a successful answer completed after their last visit. It is a projection of
current state, never an increment/decrement event counter.

## Completion and read ownership

The server derives `latestCompletedAnswer` from existing durable turn and message
projections. It selects the newest successfully completed turn whose final
assistant message still exists and is no longer streaming. Current running,
interrupted, and failed turns do not erase it. Reverting the message removes the
marker through the same query. No provider events, queue transitions, or database
schema are added. The query uses existing per-thread turn and message indexes.

Shell and detail snapshots expose the same optional contract. The shell's marker
wins when merging independently delivered detail. An omitted field supports old
servers by falling back to the latest successful turn; an explicit null means no
answer. Old servers cannot preserve an answer across subsequent queued turns.

Read state is the sidebar's visit watermark. When a server tracks visits, its
`lastVisitedAt` is authoritative, including Mark unread and reads on other
clients; the persisted `threadLastVisitedAtById` only serves servers without
visit tracking. The chat acknowledges the exact completion time only when its
final assistant message is loaded and the document is visible and focused.
Selecting a background conversation does not acknowledge it. Merely opening
Settings does not acknowledge any conversation. Reading here means viewing the
conversation, without requiring scrolling to a particular message.

## What the badge counts

`countUnreadConversations` reuses the sidebar's own predicates rather than
restating them: its roster filter (no archived, unfiled, or subagent threads),
its visit resolution, `hasUnseenCompletion`, and its shelf rule (snoozed and
settled threads are left out where their environment supports parking; pinned
threads count). Every project and environment counts, whatever project scope the
sidebar shows. A thread never visited has no unread dot and is not counted, so
the badge needs no adoption baseline of its own. Sections placement reads unread
answers through the same shared `hasUnreadCompletedAnswer`.

## Desktop delivery

A coordinator above routes runs only in the desktop app. It waits until the
catalog lists every environment (this machine's once discovery adds it, unless
the local environment is off) and each one has a cached or live snapshot or has
settled offline, so loading never erases the native badge. It then sends each
changed count; window focus reapplies the current one in case OS permissions
changed. Snooze ends are compared in UTC at minute precision. **Settings → General → App icon badge** (per device,
on by default) sends zero instead.

The app icon has one owner. `installUnreadAnswerBadge` replaces upstream's
`installNotificationBadge` in `DesktopIpcHandlers.ts`. Upstream's
`ThreadNotificationCoordinator` is unchanged and still reports its pending
notifications on upstream's channel; the Scient owner answers that channel
without writing the app icon, and keeps the rest of upstream's handler: when a
window gains focus, when a notification arrives while a window has focus, and on
quit, renderers are told to dismiss their pending notifications
(`onNotificationBadgeClear`). On the web, upstream's count still badges the
favicon. The unread-badge IPC accepts only app window renderers, not browser
previews, and validates the count and image. With several app windows, only the
notification presenter window sends the count
([Multiple app windows](./multi-window.md#notifications)).

- **macOS:** `app.setBadgeCount` on the Dock. macOS hides the Dock badge of an
  app without notification permission (electron/electron#22715), and Electron
  requests that permission (alerts, sounds, badges) only when it first creates its
  notification presenter. The handler calls `Notification.isSupported()`, which
  creates it, once there is a count to show, so the system asks once.
- **Windows:** there is no badge API. The renderer paints the count ("9+" above
  nine) as a PNG, and each app window shows it as an overlay on its own taskbar
  button, with an accessible description.
- **Linux:** `app.setBadgeCount`, on docks that support the LauncherEntry API.

Neither Electron nor the OS reports whether the badge is displayed, so the
Settings row says where each OS allows it. The badge is cleared on quit and when
the desktop shuts down by signal or relaunches. The coordinator runs while a
window is open, hidden, or minimized. Closing the last window on macOS destroys
its renderer: the last count remains, and new answers are counted when a window
reopens.

## Integration and verification

Scient-owned behavior lives in `scient/answerAttention` modules in server, web,
and desktop, plus `packages/contracts/src/scient/desktopBridge.ts`. Upstream
files carry marked seams only: the handler install in `DesktopIpcHandlers.ts`,
the bridge method in `preload.ts` and `channels.ts`, the root mount, and the
Settings row and search entry. When upstream changes `installNotificationBadge`
or its channel's payload, carry the change into the Scient owner, except writes
to the app icon.

Tests cover the count against the sidebar's unread rows (server and local
visits, Mark unread, hidden and parked threads, environments), catalog
completeness, the coordinator's loading, deduplication, focus, time zones,
setting, and Windows overlay, and the IPC's platforms, permission request,
payload and sender validation, notification dismissal, quit, and shutdown.
Native appearance and OS permission prompts need manual review on each platform.
