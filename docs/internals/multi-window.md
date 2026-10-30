# Multiple app windows

Scient Desktop can show several full app windows at once. Each window is its own
renderer, with its own React tree, router and stores, loaded from the same
origin and session as the others and talking to the same backend. Windows share
no memory. They share state only through the backend (authoritative for
threads, projects and settings), `localStorage`, Web Locks, and change notices
the main process broadcasts. All of these work because every window has the
same origin and session partition; giving a window its own partition would break
them.

User guide: [Multiple windows](../user/multiple-windows.md).

## Main process

`ElectronWindow` keeps the app windows in most-recently-focused order. The head
is the main window, so upstream's "main window" now means the window the user
used last; menu commands, zoom and DevTools act on it. Closing it promotes the
next window. `DesktopWindow.createWindow` builds every window the same way. An
additional window loads the app URL with `#<route>` (the renderer uses hash
history), opens 28px down and right of the window it was opened from (wrapping to
the work area's corner at the edge), and does not open a second detached DevTools
in development.

`openNewWindow(route)` serves both **File > New Window**
(`CmdOrCtrl+Alt+Shift+N`; the renderer already uses Mod+N, Mod+Shift+N and
Mod+Alt+N) and the bridge method behind the thread menu's **Open in new window**.
It accepts only an in-app path (`parseAppWindowRoute`); anything else opens the
default route. It refuses while the app quits, and while the backend is not yet
confirmed (it reveals the splash instead): a window opened before then can be
stranded on a failed auth bootstrap.

IPC handlers that checked for the main window's renderer now accept any app
window (`appWindowForSender`) and act on the sender's own window: window
controls, zoom, full screen, SnapShot, spelling, accounts and the unread badge.
Browser previews and other guest renderers are still refused. Each window's
renderer reports when it is ready (`ReadyRenderers`). App activation requests go
to the most recently focused ready window. Opened links wait for the main window
to be ready, as they did with one window. Development launch control needs any
ready window.

The main process persists client settings and the connection catalog. After a
window writes either, it sends a change notice to every other window, which then
reads the value again. Each window saves its own bounds as it moves, to the same
setting, so a relaunch opens one window at the bounds saved last.

The preview manager accepts browser preview guests from any app window. It
records each tab's host window when its guest registers. Closing a window ends
picture-in-picture and recordings only for the tabs it hosted; closing the last
window keeps upstream's shutdown behavior.

## Persisted renderer state

A zustand store that persists its whole state lets the last window to save erase
other windows' changes. The stores that matter merge instead
(`scient/multiWindow/crossWindowMerge.ts`):

- Each window remembers the stored value its memory last matched. Whatever
  differs from it is this window's unsaved change.
- A save keeps this window's changes and the stored value for everything else.
- On a `storage` event, the window adopts the stored value except where it has
  an unsaved change, which goes out with its next save.
- Records merge per entry, so two windows editing different threads never
  collide. When two windows change the same entry, the later save wins.

This applies to composer drafts (per draft), the prompt stash (adopted from
`storage` events), UI state (`uiStateSync.ts`; a thread visit keeps the later
timestamp of the two windows, unless this window marked the thread unread),
compute context bindings, and the side panel's per-thread state
(`rightPanelSync.ts`), so a thread's tabs match in every window. With one window,
the stored value always equals the window's own, so each store writes exactly
what it wrote before. Other persisted preferences already follow `storage`
events or hold state where the last save is harmless. Check a new persisted
store against this before several windows rely on it.

Settings writes hold a Web Lock and re-read on the change notice. Connection
catalog edits run under an exclusive Web Lock and invalidate the cached catalog
on the notice. A saved environment added in one window connects in the others
after they reload.

## Notifications

Windows elect one presenter with a Web Lock (`notificationPresenter.ts`).
Focusing a window makes it the presenter; when the presenter closes, a waiting
window takes over. Only the presenter plays sounds, shows system notifications
and sets the app icon badge. On Windows, each window paints the badge on its own
taskbar button. In-app toasts still appear in every visible window. A presenter
that has not had a user gesture may be unable to play sound until it gets one.

## Browser preview tabs

An Electron guest webview can be attached to only one window. Web Locks keyed by
the tab's runtime id decide which window mounts it
(`scient/multiWindow/previewHostOwnership.ts`, `PreviewWindowHost.tsx`):

- The holder of an exclusive host lock mounts the webview.
- Windows that display the tab also hold a shared "shown" lock. A window that
  displays the tab takes over from a host that does not.
- Other windows that display the tab show **This browser tab is open in another
  window** with **Show here**, which steals the host lock.
- A shared presence lock (`previewTabPresence.ts`) keeps one window's release
  from closing a tab that another window still uses, and orders creation after
  a pending close.

Moving the page between windows remounts the webview, so the page reloads and
loses its scroll position and form input. Windows that do not host the tab keep
its toolbar current and send commands to the tab, which acts on the host's guest;
element picking and annotations appear in the host window.

## Known limits

- Every window's title is the app name, because upstream pins the title.
- A relaunch restores one window.
- A `storage` write that lands between a window loading a store and attaching
  its listener is adopted only at the next write.

## Verification

Node tests cover the window registry and its focus order, routes, cascading,
opening a window and its refusals, ready renderers, preview hosting per window,
each store's merge (with negative controls for merge-on-save and adoption),
settings and catalog notices, the notification election, and preview host
ownership. A live check with two and three windows covered drafts in different
threads, settings and side panel tabs updating in the other window, the browser
tab placeholder, **Show here**, a host window closing, and quitting with two
windows open. The native **New Window** menu item, window close button and the
context menu's appearance need manual review.
