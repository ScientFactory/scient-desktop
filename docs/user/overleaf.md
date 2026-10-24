# Overleaf

Scient keeps a folder of your project in step with an Overleaf project. You
write in Scient, your collaborators write on Overleaf, and **Sync** brings their
changes in and sends yours, like `git pull` followed by `git push`. Nothing
syncs on its own: a sync runs when you, or an agent you asked, start it.

## What you need

- **Git access to the Overleaf project.** Overleaf offers Git on its paid plans.
  Your plan or the project owner's plan must include it.
- **An Overleaf Git token** (next section).
- **macOS**, with the project on an **APFS** disk (the Mac's own disk is APFS).
- **Git 2.39 or newer** on this computer. The one in Apple's command line tools
  is recent enough.

Only Overleaf's own site (overleaf.com) is supported.

## The token

Overleaf gives Git access through a token instead of your password.

1. On Overleaf, open **Account settings ▸ Git integration** and generate a token.
   **Create a token on Overleaf ↗** in Scient opens that page.
2. Paste it in Scient: the Connect dialog asks for it the first time, or save it
   in **Settings ▸ Source Control ▸ Overleaf**.

Scient saves one token for Overleaf. It is kept in the server's secret store, a
folder inside Scient's own data that only your user account can read. It is not
in the project, in settings, in chats or in agents' tools. **Remove** in the
same place deletes it. When an agent needs the token, it asks you with a
**Save securely** card, and the token goes straight to the secret store.

## The folder model

- An Overleaf project is one document: a paper, a thesis, a talk or a grant, with
  its main `.tex` file, chapters, bibliography and figures.
- **Each Overleaf project lives in its own folder** inside a Scient project.
  Everything in that folder syncs; nothing outside it ever does.
- A Scient project can hold **several Overleaf folders**, for example `paper/`,
  `slides/` and `grant/`. A linked folder is never inside another.
- Keep code, data and analysis **outside** the Overleaf folder. Have your analysis
  write its figures into the paper's folder, such as `paper/figures/`, and the
  next sync sends them.
- A folder that is already just the paper, opened as its own Scient project, can
  be linked as it is.

Linked folders carry Overleaf's leaf in the file tree.

## Connect a folder

Every way opens the same **Connect to Overleaf** dialog:

| Where            | How                                                                |
| ---------------- | ------------------------------------------------------------------ |
| The Files bar    | The Connect button (a folder with arrows) ▸ **Overleaf…**          |
| The file tree    | Right-click a folder ▸ **Connect to ▸ Overleaf…**                  |
| Add project      | **Overleaf project**, for a new Scient project (see below)         |
| Project Settings | **Overleaf ▸ Link a folder…** or **Bring in an Overleaf project…** |
| Ask the agent    | For example: "Bring my Overleaf project into a `paper` folder."    |

In the dialog:

1. Paste the project's **link** (the address of the project on Overleaf) or its
   **ID**.
2. Choose where it goes:
   - **Bring it in as a new folder** (the default). Name the folder; it is made
     inside the selected folder, or at the project's top when nothing is
     selected. The folder must not exist yet, or must be empty.
   - **Link** the selected folder, for a folder that already holds just the paper.
3. If no token is saved yet, paste it.
4. **Connect.** Scient links the folder and runs the first sync straight away,
   then shows what came in and what was sent.

Google Drive, OneDrive and Dropbox are listed in the Connect menu as **Coming
soon**.

### Start a new project from Overleaf

**Add project ▸ Overleaf project** makes a Scient project with the paper in a
subfolder of it, never at its top. That leaves room for more papers and for
your analysis, and keeps Scient's own files (`AGENTS.md`, `PROJECT.md`,
`.scient/`) out of Overleaf. The dialog asks for:

1. the Overleaf project's **link** or **ID**;
2. the **project name** and its **location** (where Add project browses from;
   the folder button opens your computer's folder chooser). The project's folder
   is made there, named after the project; a folder that already is a project is
   used as it is;
3. the **paper folder**, `paper` until you rename it;
4. your token, if none is saved yet.

**Connect** makes the project, links the paper folder and runs the first sync,
then shows its result. If Overleaf refuses the link after the project is made,
the dialog says so and keeps the project: fix the link and **Connect** again,
or close the dialog and connect later from the Files bar. Closing the dialog
opens the new project.

## Sync

Start a sync from:

- the **Overleaf chip** in the header of any file in a linked folder: **Sync now**;
- the command palette: **Sync with Overleaf** (one entry per linked folder);
- **Settings ▸ Source Control ▸ Overleaf** or **Project Settings ▸ Overleaf**:
  **Sync now** beside each link.

Before it syncs, Scient saves the folder's open editors in every open window.
The same happens before anything else that may write the folder: reading the
changes, restoring a kept copy and Undo. If an editor can't save (for example,
Visual editor input that isn't converted yet), or a window doesn't answer,
nothing is changed and the message names the file.

Clicking Sync is the confirmation. Overleaf's changes come into the folder, then
the folder's changes go to Overleaf. New files, deletions, renames and older
versions are all synced, then reported. **Only a conflict stops a sync.**

While a sync runs, **Cancel sync** in the chip's menu, or **Cancel** in the
Overleaf tab, stops it at its next step. A sync never stops halfway through
writing your files or sending to Overleaf; a cancelled sync says nothing was
changed.

The result is a short message, such as "3 files came in, 2 were sent · See
changes". **See changes** opens the Overleaf tab in the side panel with the files
that came in and the files that were sent; click a file to open it, or **Show in
Diff** for the project's Diff tab. **Check again** there (or **See changes** in the
chip's menu) reads what the next sync would bring in and send.

### The chip

The chip next to **Saved** shows the link's state without going online:

| Chip                 | Meaning                                                                       |
| -------------------- | ----------------------------------------------------------------------------- |
| **Up to date**       | The folder matches the last sync.                                             |
| **Edits to send**    | The folder has changes since the last sync, or an earlier sync didn't finish. |
| **Needs a decision** | A file still has Overleaf conflict marks, or was left half done.              |
| **Overleaf problem** | The folder moved, its disk isn't connected, or it couldn't be read.           |
| **Syncing…**         | A sync is running.                                                            |

Its menu has **Sync now** (**Cancel sync** while one runs), **See changes**, when
the folder last synced, **Open in Overleaf** and **Overleaf settings…**.

## What is sent

- **New files in the folder are sent.** Skipped, every sync:
  - LaTeX build leftovers (`.aux`, `.log`, `.synctex.gz`, `.fls`,
    `.fdb_latexmk`, `.out`, `.toc`, `.bbl`);
  - hidden files and anything in a hidden folder, such as `.env`;
  - Scient's own project files (`AGENTS.md`, `PROJECT.md`) when the linked
    folder is the project's top.
- **Never sent:** Git's and Scient's own folders, nested repositories, links, Git
  LFS pointers, system and editor droppings (`.DS_Store`, swap files), and new
  files over 50,000,000 bytes (they stay only on this computer, and each sync
  says so).
- A file Overleaf already has is synced like any other, even if its name is on
  the skip list.
- A `.gitignore` in the folder is not read.

### Decide file by file

The Overleaf tab (**See changes**) lists the new files the next sync finds,
and how many it will send:

- a file that will be sent has **Keep only on this computer**. Scient remembers
  it and leaves it out of every sync until you send it;
- a skipped file says why ("Build output", "Hidden file", "Scient project
  file") and has **Send this file**. A file over Overleaf's 50 MB limit can't
  be sent;
- **Kept only here** lists the files you kept back, each with **Send this
  file**.

A choice waits for the tab's next **Sync** (or **Sync again** after a
conflict), which carries it; press it again to take it back. While a sync runs,
the choices wait. Once a file is on
Overleaf it syncs like any other: keeping it only here is no longer offered.

## Conflicts

A conflict is the same lines changed on both sides, or a change on one side that
the other side makes impossible, such as an edit to a file a collaborator
deleted. A conflict stops the sync before anything changes, and the Overleaf tab
opens with each conflict and its choices:

- **Keep mine**
- **Use Overleaf's**
- **Merge myself:** Scient writes both versions into the file between conflict
  marks (`<<<<<<< Scient`, `=======`, `>>>>>>> Overleaf`).
- **Ask the agent:** Scient writes the marks, then puts a message in the chat
  asking the agent to merge them and explain its choices. Send it as it is or
  add to it. When your thread works in another worktree than the linked copy,
  Scient opens a new thread on the linked copy with the message instead, since
  that is where the marks are.

A conflict across several files (a rename on both sides, a file replaced by a
folder) offers **Keep mine** or **Use Overleaf's** for the whole group.

Choose for every conflict, then **Sync again**. If Overleaf changed while you
were choosing, Scient doesn't apply your choices to text you haven't seen: the
tab says **Overleaf changed since you chose. Choose again.** and shows the
conflicts as they are now.

While a file has conflict marks, the LaTeX editor says **This file has N
Overleaf conflicts to settle** instead of a failed build. In the Source view
each block is highlighted, with **Use mine**, **Use Overleaf's** and **Keep
both** above it; each is an ordinary edit, so Undo takes it back. Or edit the
block yourself and remove the marks. Then sync. Until the marks are gone, Scient sends nothing to
Overleaf; your version from before the sync is always kept.

## Kept copies

Whenever a sync replaces or removes your file, Scient keeps the version it
replaced. Open the file's **Retained file versions** menu (the clock in its
header): **Kept by Overleaf sync** lists them, each with **Restore**. A restored
file is an ordinary change that the next sync sends. If the file changes while
it is being restored, nothing is written and the menu says so: restore again. In another worktree the
copies are the main copy's: **Open there** opens the file on the main copy.

## Worktrees

A link belongs to one copy of the project, usually the main one. In a thread
that works in another worktree, the chip says **This link belongs to the main
copy** and offers **Sync the main copy**. The result says so too: your edits in
the worktree aren't in the main copy until they're merged there.

## Agents

An agent can do everything with Overleaf that you can, whenever you ask it to,
under the access setting you chose in the composer. Overleaf adds no permission
or approval of its own. A sync reports other agents working in the same copy of
the project.

## On Overleaf's side

- Overleaf shows synced edits as made "via Git".
- Overleaf treats a rename as a new file: comments and tracked changes on a
  renamed file are dropped.
- Overleaf recommends against very large projects, and won't take a file over
  50 MB.

## Limits

A sync stops with a reason, never a question, when:

- the folder has more than 5,000 entries, or more than 2,000 files or 250 MiB to
  sync: choose a narrower folder;
- a synced or incoming file is over 50,000,000 bytes;
- two names differ only by letter case or accents, or a file and a folder share a
  name;
- Overleaf sends something Scient won't write: a link, a repository or a Git LFS
  pointer.

## Unlink

**Unlink** in **Settings ▸ Source Control ▸ Overleaf** or **Project Settings ▸
Overleaf** ends the link. Nothing is deleted, in the folder or on Overleaf.
Linking the same folder to the same project again picks up where it left off.

## Messages

| Message                                                              | What to do                                                                 |
| -------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| No Overleaf token is saved.                                          | Save one in Settings ▸ Source Control ▸ Overleaf.                          |
| Overleaf refused the token, or this account has no Git access.       | Make a new token, or ask the project's owner for Git access.               |
| Overleaf has no such project.                                        | Check the link or ID.                                                      |
| That isn't an Overleaf project link or ID.                           | Paste the address of the project on Overleaf.                              |
| Overleaf couldn't be reached.                                        | Check the connection and sync again.                                       |
| Overleaf sync needs Git 2.39 or newer.                               | Install the command line tools (`xcode-select --install`) or a newer Git.  |
| The Overleaf project has no single main branch.                      | Ask Overleaf support; the project's Git history is unusual.                |
| A folder with that name already has files.                           | Pick another name, or link that folder instead.                            |
| This folder, or one inside or around it, is linked already.          | Use the existing link, or unlink it first.                                 |
| This Overleaf project is linked to another folder of this project.   | Sync that folder instead.                                                  |
| The project wasn't made: _reason_                                    | Fix what the reason says (often the location), then **Connect** again.     |
| The project is made, but Overleaf isn't linked yet.                  | Fix what follows it, then **Connect** again; the project stays.            |
| The token wasn't saved. Try again.                                   | Paste the token again and **Connect**; nothing was made.                   |
| The project is made but not in the sidebar yet.                      | Wait for it to appear, or open its folder with Add project ▸ Local folder. |
| _file_ couldn't be saved, so nothing was changed.                    | Save the file (finish Visual editor input), then try again.                |
| Another Overleaf operation is running on this folder.                | Wait for it to finish.                                                     |
| A pull, branch switch or checkpoint restore is changing the project. | Sync again after it.                                                       |
| An earlier sync didn't finish.                                       | Sync again: Scient finishes it first.                                      |
| More than 2,000 files, or 250 MiB, to sync.                          | Choose a narrower folder.                                                  |
| The folder has more than 5,000 entries.                              | Choose a narrower folder.                                                  |
| A file is over Overleaf's 50 MB limit.                               | Make it smaller, or move it out of the folder.                             |
| A file changed while Scient read it.                                 | Sync again.                                                                |
| The folder kept changing during the sync.                            | Sync again when edits pause.                                               |
| Two names differ only by letter case or accents.                     | Rename one and sync again.                                                 |
| Overleaf sent something Scient won't write.                          | Remove the link, repository or LFS file on Overleaf.                       |
| The folder isn't there, or its disk isn't connected.                 | Connect the disk, or relink the folder.                                    |
| This project's folder changed since it was linked.                   | Relink it.                                                                 |
| Another Scient process holds the Overleaf state.                     | Quit the other Scient and sync again.                                      |
| An earlier attempt stopped before it finished.                       | Try again; Scient never repeats an attempt that may have half run.         |
| Scient can't read its Overleaf link records.                         | Nothing was linked or changed. Report it; the records need repair.         |
| Overleaf kept changing while the conflicts were shown.               | Sync again.                                                                |
| The project changed while this ran.                                  | Try again.                                                                 |
| Overleaf changed since you chose. Choose again.                      | Choose for each conflict as it is now, then Sync again.                    |
| Sync cancelled. Nothing was changed.                                 | Sync again when you're ready.                                              |
| No sync is running.                                                  | Nothing to cancel; the sync had already finished.                          |
| Nothing was sent: N files still have conflict marks.                 | Settle the marks, then sync again.                                         |
| Nothing was sent: the folder changed during the sync.                | Nothing to do; the edit goes with the next sync.                           |
| Nothing was sent: a kept copy changed during this sync.              | Sync again; the next sync checks again.                                    |
| Nothing was sent: the Overleaf token changed during the sync.        | Sync again.                                                                |
| Overleaf changed again while this sync was sending.                  | Sync again.                                                                |
| Scient couldn't tell whether Overleaf received this send.            | Nothing to do: it is never sent twice, and the next sync checks.           |
| An earlier send never got an answer.                                 | Nothing to do; this sync may carry some of the same changes again.         |
| Renamed _a_ to _b_. Overleaf drops comments and tracked changes.     | Nothing to do; re-add comments on Overleaf if you need them.               |
| Sent older versions of N files.                                      | Expected after switching to an older branch or restoring a checkpoint.     |
| The project is bigger than Overleaf recommends.                      | Consider moving large files out of the folder.                             |
| Another agent is working in this copy.                               | Nothing to do; its edits go with a later sync.                             |
| Scient couldn't check whether other agents are working in this copy. | Nothing to do.                                                             |
| Synced the main copy. Your edits in this worktree aren't in it.      | Merge the worktree's branch, then sync again.                              |
| N conflicts with Overleaf                                            | Choose for each one in the Overleaf tab, then Sync again.                  |
