# Multiple windows

Scient Desktop can show several full app windows at once, for example two
conversations side by side. Every window is a complete Scient window with its
own sidebar, conversation, composer and side panel. All windows share the same
projects, threads, settings and connections, because they talk to the same
Scient server.

## Open a window

- **File > New Window** (`Cmd+Option+Shift+N` on macOS, `Ctrl+Alt+Shift+N`
  on Windows and Linux) opens a new window beside the current one.
- On macOS, right-click Scient's icon in the Dock and choose **New Window**.
  This works even when no Scient window is open.
- **Open in new window** in a thread's menu (right-click the thread in the
  sidebar, or use the menu in the conversation header) opens that conversation
  in its own window. Right-click a draft in the sidebar for the same command.
- **Open in new window** in a side panel tab's menu (right-click the tab) opens
  a window that shows the conversation with that tab filling the window. Pages
  with a menu of their own list it there too: the device, Files, PDF and LaTeX
  **⋯** menus, the Markdown editor's **Document** menu, a pull request's actions
  menu, and Compute's session menu while a session runs. A browser tab's **⋯**
  menu calls it **Open in new Scient window**, to tell it apart from **Open
  separate preview window**, which shows only the page.
- Drag a side panel tab out of the window and let go outside it. A window
  opens where you dropped the tab, showing that tab the same way.

A new window opens slightly offset from the window you were using, or under the
pointer when you drag a tab out. Move or resize it like any other window. Close
it with its window controls; the other windows stay open.

## What windows share

- **Threads and conversations.** A message sent in one window appears in every
  window that shows that thread.
- **Drafts.** A draft you type in one window is saved for the others. If you
  edit the same draft in two windows at once, the one you typed in last wins.
- **Side panel tabs.** Tabs you open, close or reorder in a conversation's side
  panel change in every window that shows that conversation. Each window keeps
  its own view of them: which tab is selected, whether the panel is open, and
  whether it fills the window. If another window closes the tab you are
  looking at, the tab next to it takes its place.
- **Settings and connections.** Changing a setting in one window applies it in
  the others. A newly added saved environment appears in other windows after
  they reload.
- **Notifications.** Sounds, system notifications and the app icon badge come
  from the window you used most recently, so each plays once, not once per
  window.

## Browser tabs

A browser tab in the side panel shows its page in one window at a time. If you
open the same thread's browser tab in a second window, that window shows
**This browser tab is open in another window** with a **Show here** button.
Choosing **Show here** moves the page to this window. Opening a browser tab in
a new window, from its menu or by dragging it out, moves the page to the new
window, and the window you came from shows that message. The page reloads when
it moves, so scroll position and typed form input are not kept.

## Limits

- When you quit and reopen Scient, one window opens, where you last moved or
  resized a window.
- Each window's title in the Window menu is the app name.
- The Windows taskbar and Linux launcher menus do not offer **New Window**.
- A window that opens a conversation already open in another window, or
  reloads, starts with the side panel as the last window to change it left it.
