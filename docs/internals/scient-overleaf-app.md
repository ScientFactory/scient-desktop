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

| File                                         | What it holds                                                                                                                            |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `client-runtime/state/scientOverleafHttp.ts` | One Effect function per route of the `scientOverleaf` group, like `scientWordExportHttp.ts`.                                             |
| `overleaf/client.ts`                         | Promises over those functions for the web (`runtime.runPromise`). Tests mock this module.                                                |
| `overleaf/overleafModel.ts`                  | Pure: project links, folder paths, chip states, the result lines of design section 4.1, reason texts, choices.                           |
| `overleaf/overleafStore.ts`                  | Per workspace (`environmentId` + root): links, offline statuses, running syncs, last results, read changes. Token state per environment. |
| `overleaf/overleafActions.ts`                | Save editors, sync, report; read changes for the review tab; open the project on Overleaf.                                               |
| `overleaf/ConnectOverleafDialog.tsx`         | The one Connect dialog.                                                                                                                  |
| `overleaf/OverleafFileChip.tsx`              | The chip next to "Saved".                                                                                                                |
| `overleaf/OverleafReviewPanel.tsx`           | The side-panel tab (`scient:overleaf-review:<cwd>:<connection>`).                                                                        |
| `overleaf/OverleafSettings.tsx`              | Source Control ▸ Overleaf, Project Settings ▸ Overleaf.                                                                                  |
| `overleaf/OverleafKeptCopies.tsx`            | Kept copies inside "Retained file versions".                                                                                             |
| `overleaf/overleafPaletteItems.tsx`          | "Sync with Overleaf" in the command palette.                                                                                             |
| `overleaf/useOverleafFolderConnect.tsx`      | The Files panel's Connect dialog and the tree's marks.                                                                                   |

Hooks in upstream files, each between `SCIENT-FORK` markers: `FileBrowserPanel.tsx` (Connect
button, right-click **Connect to ▸ Overleaf…**, row marks, icon sprite), `FilePreviewPanel.tsx`
(the chip), `CommandPalette.tsx` (palette items), `SourceControlSettings.tsx` and
`ProjectSettingsPanel.tsx` (settings). Scient-owned files changed in place: the right-panel
surface list, content and icon, `ScientFileVersionHistory.tsx`, `ScientLatexSurface.tsx`
(conflict notice), `FileBrowserToolbarActions.tsx` and `useScientLazyWorkspaceTree.ts`.

## Status and the chip

`useOverleafWorkspace(environmentId, root)` lists the project's links (`list`, which returns every
link of the host project with `linkedHere`) and reads each one's offline status. The status reads
the folder, so it is never read per file header: once per workspace, again after any sync,
connect or unlink, on window focus when older than 10 s, and for one link when an open editor of
one of its files finishes a save (the chip subscribes to the document registry).

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

`saveOverleafFolderEditors` flushes every document session (Markdown, LaTeX, BibTeX) in the
document registry whose workspace is the caller's root or the link's checkout and whose path is
inside the folder. A session holding unconverted input, or a failed flush, names its file and the
sync doesn't run. This is this window only; the server-side request that saves editors in every
window is PR C1's, and the sync should switch to it then. Plain code editors (generic save
coordinator) have no shared registry and are not flushed; their 500 ms debounced save usually
lands first.

## Sync and its result

`runOverleafSync` is the only sync path: it refuses a second sync of the same link from this
window, saves editors, posts `sync` with a fresh request ID and any conflict choices, records the
result, refreshes the file tree and the statuses, and reports. Choices always travel with
`reviewedRemote`, the `remoteTree` of the review they answer; when Overleaf has moved since, the
server answers `needs-decision` with a fresh review, and the tab clears the choices and says
"Overleaf changed since you chose. Choose again." **Cancel sync** (chip) and **Cancel** (tab)
post `cancel`; the sync stops at a stage boundary and returns `cancelled`, reported as "Sync
cancelled. Nothing was changed." The server already retries once
when Overleaf moved during the send. `overleafResultView` turns the result into a title ("3 files
came in, 2 were sent"), the lines of design section 4.1 and a tone; the toast carries **See
changes** when there were changes, and a conflict opens the review tab instead. The Connect
dialog runs the same function with `quiet` and shows the result itself.

Headline counts: incoming is the review's incoming changes; "sent" counts outgoing changes only
when the publication is `accepted`.

## The review tab

A side-panel surface, `scient:overleaf-review:<encoded cwd>:<connection>`, persisted with the
other tabs. It shows the last sync's review from this window, else a review read by `preview`
(**See changes** reads one when none is held; after a restart the tab offers **Read changes**).
It lists what came in and what is or was sent; a file opens in its editor, and **Show in Diff**
opens the thread's Diff tab. The engine exposes paths, not contents, so the tab doesn't draw a
per-file Overleaf diff itself.

Per-file decisions (`OverleafNewFiles`): for a review still to run (a preview, or one waiting on a
conflict), the tab lists the review's `additions`. A selected one offers **Keep only on this
computer**; a skipped one shows its `skippedBecause` in a few words and offers **Send this file**,
except `too-large` (Overleaf refuses it). `localOnly` is listed as **Kept only here**, each with
**Send this file**. A decision is a pending toggle, not a sync of its own: the tab's next **Sync**
or **Sync again** sends them as `files: { keepOnlyHere, send }`, and a sync that applies clears
them. One sync then carries every decision together with any conflict choices, and a decision
taken while a conflict waits isn't lost to a sync that stops at that conflict. After a sync the
tab shows "N new files were sent" and only the kept-only list.

Conflicts: each offers the engine's allowed choices. A file conflict (`markers` allowed) shows
**Keep mine**, **Use Overleaf's**, **Merge myself** and **Ask the agent**; a group shows the first
two. **Ask the agent** is sent as `markers`; after the sync applies, the app inserts a message
naming the files into the current chat's composer and focuses it (it does not send it). When the
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
folder, or a typed one from Project Settings. With no token saved the dialog asks for it, saves it
first, then connects and runs the first sync with `quiet`.

## Kept copies

The "Retained file versions" popover lists the link's kept copies of the open file (`keptCopies`,
filtered by path) with **Restore** (`restoreKept` with the revisions the list read). Compare and
**Show in Finder** need the copy's location or bytes, which the routes don't return yet.

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

- Undo of a send: engine addition first.
- Settings ▸ Overleaf "Test" of the token: no route.
- Add project ▸ Overleaf project (a new Scient project with the paper in a subfolder).
