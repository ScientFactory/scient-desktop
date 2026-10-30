# Multiple windows

Scient Desktop can show several full app windows at once, for example two
conversations side by side. Every window is a complete Scient window with its
own sidebar, conversation, composer and side panel. All windows share the same
projects, threads, settings and connections, because they talk to the same
Scient server.

## Open a window

- **File > New Window** (`Cmd+Option+Shift+N` on macOS, `Ctrl+Alt+Shift+N`
  on Windows and Linux) opens a new window beside the current one.
- **Open in new window** in a thread's menu (right-click the thread in the
  sidebar, or use the menu in the conversation header) opens that conversation
  in its own window.

A new window opens slightly offset from the window you were using. Move or
resize it like any other window. Close it with its window controls; the other
windows stay open.

## What windows share

- **Threads and conversations.** A message sent in one window appears in every
  window that shows that thread.
- **Drafts.** A draft you type in one window is saved for the others. If you
  edit the same draft in two windows at once, the one you typed in last wins.
- **Side panel tabs.** Tabs you open or close in a conversation's side panel
  appear in every window that shows that conversation.
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
Choosing **Show here** moves the page to this window. The page reloads when it
moves, so scroll position and typed form input are not kept.

## Limits

- When you quit and reopen Scient, one window opens, where you last moved or
  resized a window.
- Each window's title in the Window menu is the app name.
