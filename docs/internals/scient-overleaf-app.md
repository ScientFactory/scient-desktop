# Overleaf in the app

The screens over the Overleaf engine ([scient-overleaf-engine.md](scient-overleaf-engine.md)).
The person-facing guide is [docs/user/overleaf.md](../user/overleaf.md). Everything here is
Scient-owned: `apps/web/src/scient/overleaf/`, with small marked hooks in upstream files.

## The rule the screens follow

**Only a conflict stops a sync.** Clicking Sync is the confirmation. The app sends a sync request
and shows its result; it never shows a review to accept. The server confirms every review without
a conflict itself (`OverleafSync.sync`), and answers `needs-decision` only for a conflict. There is
no Overleaf-specific permission, confirmation or warning dialog anywhere, Unlink included (nothing
is deleted on either side).

## Layers

| File                                         | What it holds                                                                                                                                                                                                                                                               |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `client-runtime/state/scientOverleafHttp.ts` | One Effect function per route of the `scientOverleaf` group, like `scientWordExportHttp.ts`.                                                                                                                                                                                |
| `overleaf/client.ts`                         | Promises over those functions for the web (`runtime.runPromise`). Tests mock this module.                                                                                                                                                                                   |
| `overleaf/overleafModel.ts`                  | Pure: project links, folder paths, chip states, the result lines of design section 4.1, reason texts, choices.                                                                                                                                                              |
| `overleaf/overleafStore.ts`                  | Per workspace view (`environmentId` + root): links and offline statuses. Per link (`environmentId` + connection ID), shared by every view: running syncs, last results, the shown review, reads of the changes, pending and carried decisions. Token state per environment. |
| `overleaf/overleafActions.ts`                | Sync and report; read changes for the review tab; open the project on Overleaf.                                                                                                                                                                                             |
| `overleaf/ConnectOverleafDialog.tsx`         | The one Connect dialog.                                                                                                                                                                                                                                                     |
| `overleaf/OverleafFileChip.tsx`              | The chip next to "Saved".                                                                                                                                                                                                                                                   |
| `overleaf/OverleafReviewPanel.tsx`           | The side-panel tab (`scient:overleaf-review:<cwd>:<connection>`).                                                                                                                                                                                                           |
| `overleaf/OverleafSettings.tsx`              | Source Control ▸ Overleaf, Project Settings ▸ Overleaf.                                                                                                                                                                                                                     |
| `overleaf/OverleafKeptCopies.tsx`            | Kept copies inside "Retained file versions".                                                                                                                                                                                                                                |
| `overleaf/OverleafUndoDialog.tsx`            | Undo of one send, from the chip and the review tab.                                                                                                                                                                                                                         |
| `overleaf/overleafPaletteItems.tsx`          | "Sync with Overleaf" in the command palette.                                                                                                                                                                                                                                |
| `overleaf/OverleafNewProject.tsx`            | Add project ▸ Overleaf project: the palette entry and the dialog host mounted in `__root.tsx`.                                                                                                                                                                              |
| `overleaf/createProjectForOverleaf.ts`       | Makes the Scient project as Add project does: register, then Scient setup.                                                                                                                                                                                                  |
| `overleaf/useOverleafFolderConnect.tsx`      | The Files panel's Connect dialog and the tree's marks.                                                                                                                                                                                                                      |

Hooks in upstream files, each between `SCIENT-FORK` markers: `FileBrowserPanel.tsx` (Connect
button, right-click **Connect to ▸ Overleaf…**, row marks, icon sprite), `FilePreviewPanel.tsx`
(the chip), `CommandPalette.tsx` (palette items, Add project ▸ Overleaf project), `SourceControlSettings.tsx` and
`ProjectSettingsPanel.tsx` (settings), `__root.tsx` (the new-project dialog's host). Scient-owned files changed in place: the right-panel
surface list, content and icon, `ScientFileVersionHistory.tsx`, `ScientLatexSurface.tsx`
(conflict notice), `FileBrowserToolbarActions.tsx` and `useScientLazyWorkspaceTree.ts`.

## Status and the chip

`useOverleafWorkspace(environmentId, root)` lists the project's links (`list`, which returns every
link of the host project with `linkedHere`) and reads each one's offline status. The status reads
the folder, so it is never read per file header: once per workspace, again after any sync,
connect or unlink, on window focus when older than 10 s, and for one link 400 ms after a save in
its folder settles (several saves read once). Saves are watched once for the app's lifetime
(`overleafSaveWatch`, started by the first chip), not by each chip, so a save that finishes after
the last linked file's editor closed still counts. It hears both kinds of editor: a document
session's save is done when it stops being pending or its session closes, and plain text editors
announce each confirmed save through `scient/fileSurfaces/workspaceFileSaves.ts` (a marked line in
`useFileSaveCoordinator.ts`). A save also marks the link's status stale; a chip that appears reads
a stale status, or one older than 5 s, again. Every list and
status read is numbered when it starts, and a response is used only if no read of the same thing
started after it; a forced load (after an operation) starts afresh rather than joining one already
running, and so does the load of a view marked stale by another view's operation. So a read from during a sync can't answer after the sync's own refresh and leave the chip
on "Syncing…".

`overleafChipView` maps the status:

| Chip             | From                                                                                   |
| ---------------- | -------------------------------------------------------------------------------------- |
| Syncing…         | a sync started in this window, or `busy`                                               |
| Overleaf problem | `unavailable` or `disconnected`; reasons `folder-changed` or `staging`; local `unread` |
| Needs a decision | reasons `conflict-marks` or `interrupted-files`                                        |
| Edits to send    | local changes, or `recovery-required` (the next sync finishes it)                      |
| Up to date       | otherwise                                                                              |

A file belongs to the link whose folder holds it (`connectionForPath`), whatever copy the link
is in. In a worktree (`linkedHere` false) the chip says the link belongs to the main copy and
offers **Sync the main copy**: the request names the worktree, and the server syncs the linked
checkout and reports `linkedElsewhere`.

"Last synced" is this window's last sync time, else the link's `updatedAt` once
`completedSyncCount` is above zero. The summary has no dedicated last-sync time, and `updatedAt`
records any change to the link, so it can read later than the real last sync.

## Saving editors before a sync

The screens don't save editors themselves. Every server operation that may write the folder
(sync, reading the changes, restoring a kept copy, undo) first asks every open window to save the
folder's editors, this window included: `scient/editorFlush/EditorFlushHosts.tsx` answers for each
window, with every kind of editor (documents, plain text editors, LaTeX Visual input,
composition). One that can't save, or a window that doesn't answer, refuses the operation with
reason `editor-unsaved` and the files in `paths`; the screens say "_file_ couldn't be saved, so
nothing was changed."

## Sync and its result

`runOverleafSync` is the only sync path: it refuses a second sync of the same link from this
window, posts `sync` with a fresh request ID and any conflict choices, records the
result, refreshes the file tree and the statuses, and reports. Choices always travel with
`reviewedRemote`, the `remoteTree` of the review they answer; when Overleaf has moved since, the
server answers `needs-decision` with a fresh review, and the tab says "Overleaf changed since you
chose. Choose again." Choices are kept with the identity of the review they were made on (its
`reviewId` and `remoteTree`) and shown only while that review is: any sync or read that brings
another review leaves it with no choices, so an old choice is never sent against a newer review.
**Cancel sync** (chip) and **Cancel** (tab) post `cancel`; the sync stops at a stage boundary and returns
`cancelled`, reported as "Sync cancelled. Nothing was changed." A failure shows only fixed
words: the server's `ScientOverleafOperationError` reaches the app as itself (the HTTP adapter
passes it through) and its reason is mapped; anything else is "The Overleaf request didn't go
through. Try again.", never an address or a serialized error. The server already retries once
when Overleaf moved during the send. `overleafResultView` turns the result into a title ("3 files
came in, 2 were sent"), the lines of design section 4.1 and a tone; the toast carries **See
changes** when there were changes, and a conflict opens the review tab instead. The Connect
dialog runs the same function with `quiet` and shows the result itself.

Headline counts: incoming is the review's incoming changes; "sent" counts outgoing changes only
when the publication is `accepted`.

## The review tab

A side-panel surface, `scient:overleaf-review:<encoded cwd>:<connection>`, persisted with the
other tabs. The review it shows is the store's `reviews` entry, its own state apart from the
latest result: set by a sync that applied or stopped at a conflict, or by a read of the changes,
and left as it is by an operation that brings none (cancelled, refused, failed), so its conflicts
and their choices survive a retry that didn't run. "Last synced" comes from `syncedAt`, set only
when a sync applied. Reads of the changes (`preview`) are ordered with syncs: each change to the
shown review is numbered, and a read's answer is used only if no sync replaced the review after
the read started, so a late read never brings obsolete conflicts back over a sync that applied.
A read replaces the shown review only when it succeeds. With no review the tab offers **Read
changes**; with one it offers **Check again**, so after a sync the next sync's new files can be
decided before they are sent. The chip's **See changes** reads again unless the shown review is
still to run (a read, or a conflict waiting); the toast's **See changes** shows what that sync did.
It lists what came in and what is or was sent; a file opens in its editor (for a link in another
copy of the project, the linked copy's file in its normal editor, in a new thread on that copy
started the way Ask the agent starts one, so its conflict marks can be settled and saved; never
this checkout's file of the same name), and **Show in Diff**
opens the thread's Diff tab. The engine exposes paths, not contents, so the tab doesn't draw a
per-file Overleaf diff itself.

Per-file decisions (`OverleafNewFiles`): for a review still to run (a preview, or one waiting on a
conflict), the tab lists the review's `additions`. A selected one offers **Keep only on this
computer**; a skipped one shows its `skippedBecause` in a few words and offers **Send this file**,
except `too-large` (Overleaf refuses it). `localOnly` is listed as **Kept only here**, each with
**Send this file**. Files held back for their conflict marks (`unresolvedMarkers`, plus those a
review still to run already sends as they are, `released`) are listed as **Waiting for
conflicts**, each with **Send it anyway** (decision `release`), after a sync too. A decision is a
pending toggle, not a sync of its own: the tab's next **Sync** or **Sync again** sends them as
`files: { keepOnlyHere, send, release }`, and a sync that applies clears them. A release the
engine can't honour (another held file keeps that path on Overleaf) is the refusal
`release-held`: "_file_ can't be sent anyway: another file waiting for its conflicts keeps its
place on Overleaf. Settle that file first." Before they are shown or sent, the decisions are reconciled with the review shown
(`actionableDecisions`): a "keep" only for a new file the rule would send, a "send" only for one
the rule skips (and Overleaf would take) or one kept only here. Rows and rules follow the rule
(`skippedBecause`), not the review's `selected`, because a review from a sync that carried
decisions already encodes them: a kept file unselected, a sent one selected, and a sent local-only
file read like a new one, in neither list. The store is the single owner of decisions: they,
and the ones a sync carried with the review it returned at a conflict, live there by connection
(`fileDecisions`, `submittedDecisions`), so opening a file, which replaces the tab, keeps them.
`runOverleafSync`, the one path every Sync takes (chip, palette, settings, the tab), attaches
the connection's reconciled decisions (`pendingOverleafDecisions`) and records what it carried;
only a sync that applies clears them. When a fresh review is accepted (a read, or a sync that
stops at a conflict), decisions it no longer lists or allows are pruned for good, so a file
recreated later doesn't bring an old decision back. Disconnecting (Unlink) and connecting
(including an archive reconnected with its old ID) forget the connection's review, decisions and
carried record in every workspace view (`forgetOverleafConnection`). The count of files to send takes a file without a decision by the rule, not by the
review's `selected`. The tab shows such a local-only file under **Kept only here**, and
keeps sending all of them until a sync applies, so the server never falls back to its defaults. One for a file a fresh read no longer lists or
allows is dropped, never sent; the rest survive a cancel or a refusal. While a sync runs the
buttons are disabled: a decision made then wouldn't be in it, yet
would be cleared by it. One sync then carries every decision together with any conflict choices, and a decision
taken while a conflict waits isn't lost to a sync that stops at that conflict. After a sync the
tab shows "N new files were sent" and only the kept-only list.

Conflicts: each offers the engine's allowed choices. A file conflict (`markers` allowed) shows
**Keep mine**, **Use Overleaf's**, **Merge myself** and **Ask the agent**; a group shows the first
two. **Ask the agent** is sent as `markers`; after the sync applies, the app writes a message
naming the files to the thread the request came from (it does not send it): into its composer
when the window still shows that thread, else appended to that thread's draft by identity, never
into whichever composer is on screen. When the
link is in another copy (`linkedHere` false, or the result's `linkedElsewhere`), this thread's
agent can't see the marks, so `askAgentOnLinkedCopy` starts a new thread there through the app's
own new-thread handler, as "New thread on this branch" does: the project whose folder is the
linked checkout (`envMode: "local"`), or this thread's project with the checkout as its worktree
(`envMode: "worktree"`). The message is placed in that draft's composer, not sent. **Sync
again** is enabled once every conflict has a choice and sends them with the sync.

## Connect

The dialog takes a link (`overleaf.com/project/<id>`, `git.overleaf.com/<id>`) or an ID, parsed
client-side to the ID the server accepts. **Bring it in as a new folder** is the default: a name
(default `paper`) inside the selected folder, or at the project's top. Overleaf's Git access does
not expose the project's title, so the folder can't be named from it. **Link** uses the selected
folder, or a typed one from Project Settings. Connect waits until the token's status is known. With
no token saved the dialog asks for it, saves it first (a token the server didn't save stops there),
then connects and runs the first sync with `quiet`.

**Add project ▸ Overleaf project** opens the same dialog with `newProject`: a project name, a
location (Add project's starting folder, plus the system folder chooser on this computer) and the
paper's folder name (default `paper`); no Link choice. Connect saves the token, makes the project
(`createProjectForOverleaf`: the server resolves the root, the project is registered with
`createWorkspaceRootIfMissing` as Add project does, Scient setup runs for an ordinary folder, and a
folder that already is a project is used as it is), then connects with `create: true` into the
subfolder and syncs. The paper never goes at the project's top. A refusal after the project is made
says so and keeps the project; the project fields lock, and Connect again only links. Closing the
dialog opens a new thread in the project; if the project hadn't reached the sidebar when it was
made, closing waits for it again, and says where the project is if it still isn't there. Overleaf's title isn't available, so the project is named
from the typed name.

## Kept copies

The "Retained file versions" popover lists the link's kept copies of the open file (`keptCopies`,
filtered by path) with **Restore** (`restoreKept` with the revisions the list read), only when the
file belongs to the linked copy (`linkedHere`). In another worktree the copies, and a restore,
would be the other checkout's, so it says "Kept copies are in the main copy." with **Open there**,
which opens that file on the linked copy the way the Overleaf tab does. A restore says what its
apply did (`restored` carries `outcome`): "Restored" only when it completed; a `replan` wrote
nothing ("The file changed while restoring, so nothing was written. Try again."), and `attention`
may have stopped partway. Compare and
**Show in Finder** need the copy's location or bytes, which the routes don't return yet.

## Undo

`OverleafUndoDialog` undoes one accepted send (design section 4.3). The chip's **Undo last
send…** (shown once the link has synced, not while a sync runs) opens it for the newest send; the
review tab's **Undo send** icon button (shown when the review it displays is from a sync whose send
Overleaf accepted) opens it for that send's number. It reads `undoableSends` (the newest ten
accepted sends with their changes) and lists each file with what Undo does to it: **Earlier
version**, **Removed**, **Back**, **Old name back**. **Undo** posts `undo` through
`runOverleafUndo`; the server saves the folder's editors, puts the earlier versions back and syncs.
The dialog then shows `overleafUndoView`: "Put back N files", the files left as they are with why
(edited since, already back, name in use, too large), and the sync's own title and lines. The
sync is recorded like any other; one that stops at a conflict opens the review tab. A replanned
undo says "Nothing was put back"; one needing attention says so.

## Conflict marks in the editor

`overleafConflictBlocks` reads `<<<<<<< Scient` … `=======` … `>>>>>>> Overleaf` blocks, the labels
`OverleafRepository` gives its merge sides (Git adds `:<path>` to a label after a rename; a
`|||||||` base section, if the user's Git config asks for one, is dropped from both sides). The
LaTeX surface shows "This file has N Overleaf conflicts to settle" in place of the build status
while any remain.

In Source, `OverleafConflictActions` sits in the file editor's surface (a marked hook in
`FilePreviewPanel`'s `EditableFileEditor`, so Markdown and BibTeX get it too). It measures the
rendered rows (`[data-content] > [data-line]`, in the editor's shadow roots) after scrolling,
resizing and row changes, draws a light highlight over each block's visible rows and puts **Use
mine**, **Use Overleaf's** and **Keep both** on the block's first row. A choice finds the block
again in the editor's current text and replaces it with `editor.applyEdits`, the editor's own
edit path: it joins the undo history and reaches the document session like typing. The actions
are disabled while editing is.

## Not built here

- Settings ▸ Overleaf "Test" of the token: no route.
