# Organizing threads

A thread is one conversation and its continuing work history inside a project.
Use separate threads for separate questions or outcomes so their instructions,
results, and follow-up work remain easy to find. You can run several threads in
parallel; use an isolated worktree when simultaneous tasks should not edit the
same project files.

Pin a thread from its context menu to keep it in the pinned section above your active work.
`mod+shift+p` pins or unpins the thread you have open. Pinned threads are shown independently of
their project, including when you connect to more than one environment.

To require confirmation before unpinning, enable **Settings → General → Unpin confirmation**. The
confirmation applies to the sidebar controls, thread menus, and the `mod+shift+p` shortcut.

Pinned threads still move to **Settled** when they become inactive. They also move when their pull
request merges if **Auto-settle merged threads** is enabled.

Each environment owns its automatic settlement settings. The server checks them even when no web,
desktop, or mobile client is connected. By default, Scient settles threads after seven days without
activity; settling when a pull request merges is available but off by default. An eligible idle
thread also settles when its pull request closes. An open pull request blocks inactivity settlement.
Active work, pending input, and live background work keep the thread active. Scient settles from a
closed or merged pull request only when its timestamp is not older than the user's latest activity.
If that timestamp is not available, the inactivity rule still applies. A manual un-settle also keeps
the thread active.
Change these rules in **Settings > General** for the environment. A settings change affects future
settlement and does not reopen a settled thread. Settings saved by older clients on one device no
longer control this behavior.

When you un-settle a thread, it returns to the top of the active list so you can find it right
away. Its timestamps do not change. Other threads keep their positions.

Right-click a pull request link in a thread and choose **Link to thread** to show that pull request
in the sidebar. The thread settles when the linked pull request merges if **Auto-settle merged
threads** is enabled. Right-click the same link and choose **Unlink from thread** to remove it.

Drag a pinned thread to change its position. The order is stored by the selected
environment and appears on other compatible connected clients.

If reordering is unavailable for one environment, update the Scient server
running there using the version guidance shown in the app.

To generate a fresh title from the conversation, open a thread's context menu and choose
**Regenerate title**. While Scient is generating it, the action reads **Regenerating…** and cannot
be selected again. The option is hidden when the connected environment needs a server update.
