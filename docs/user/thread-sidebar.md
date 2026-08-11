# Organizing threads

Pin a thread from its context menu to keep it in the pinned section above your active work.
Pinned threads are shown independently of their project, including when you connect to more than
one environment.

## General Chat

Choose **General chat** from the new-thread picker to start a conversation without placing it in a
project. General chats use the selected environment's default working directory and appear in the
separate, collapsible **General chat** section above the project filter. The section starts
collapsed so project navigation remains primary. Scient does not yet remember this disclosure
preference between app launches. General chats do not offer project-only branch, worktree,
checkpoint, or source-control controls.

To turn a useful general conversation into project work, open the chat and choose **Move chat to
project** in its header. Scient stops the current provider session before changing the workspace
boundary, then moves the same conversation and history under the selected project. A chat can be
moved from General Chat into one project; moving an existing project chat between projects is not
part of this action.

On web and desktop, drag a pinned thread to change its position. On mobile, open the thread's menu
and choose **Move up** or **Move down**. The order is stored by the server and appears on your
other connected devices.

If reordering is unavailable for one environment, update the T3 Code server running in that
environment. Older servers can still pin and unpin threads, but do not understand synced ordering;
their pinned threads keep the default newest-first order below the ones you have arranged.

## Environment artwork

Dev and Nightly environments can identify themselves with artwork at the top of the sidebar and in
the send button. Choose **Artwork**, **Version pill**, or **None** in Settings under environment
identification. Artwork is recolored to match each built-in theme. Custom themes use the **Version
pill** fallback because their colors are not controlled by T3 Code.
