# Organizing threads

A thread is one conversation and its continuing work history inside a project.
Use separate threads for separate questions or outcomes so their instructions,
results, and follow-up work remain easy to find. You can run several threads in
parallel; use an isolated worktree when simultaneous tasks should not edit the
same project files.

Pin a thread from its context menu to keep it in the pinned section above your active work.
Pinned threads are shown independently of their project, including when you connect to more than
one environment.

Pinned threads still move to **Settled** when they become inactive. They also move when their pull
request merges if **Auto-settle merged threads** is enabled.

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
