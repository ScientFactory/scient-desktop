# Overleaf in Scient: agents, the app and the docs (PRs C1 and C2)

Decided with the owner on October 23–24, 2026. This document is the reference for everything after the server coordinator: what step 5 adds, the agent tools (PR C1), the app's screens (PR C2) and the documentation. Where the [implementation plan](implementation-plan.md) or the [coordinator contract](pr-b-coordinator-contract.md) disagree with it, this document wins, and they should be corrected.

Nothing here is built yet. Steps 1–4 of the coordinator are merged. Most of these decisions sit on top of them; the engine changes they need are listed in section 7.

## 1. The rule for agents: whatever a person can do

**An agent can do everything with Overleaf that a person can do in Scient, whenever the user asks it to.** An agent on full access has full access. Overleaf adds no permission, approval, confirmation, warning or stop of its own, for agents or for people.

- **The only control is the access setting the user already chose in the composer.** Overleaf tools run under it exactly like every other tool. Do not add an Overleaf permission. Do not change how the composer's access setting works. The tools never read it to decide what to refuse, and never change it.
- **Every capability is available to the agent**, including the ones that remove or overwrite: unlink, start fresh after damaged history, restore a kept copy, undo a sync, choose a side in a conflict, keep a file only on this computer or send it.
- **Tools do what they are asked, then report.** A tool returns a plain account of what happened, using the same lines a person sees (section 4). The engine's review acknowledgements are passed automatically: they identify the exact review being confirmed, and they are never a question to anyone.
- **A review the engine rebuilds is confirmed the same way.** When the folder changes during a sync, or Overleaf moves, the engine builds a new review; the app or tool confirms it itself unless it now has a conflict. Asking for an operation, such as Start fresh, Undo or a restore, is its confirmation.
- **Conflicts don't stop the agent.** It decides, the way it handles Git merge conflicts today.

Three things look like steps but are not permission checks:

- **The token.** Overleaf issues a Git token only to a signed-in person, and the token is the user's password for Git access. If none is saved, the tool says so and the agent asks for it with the existing secure secret request (the "Save securely" card, `request_secret`). The token goes from the user straight to Scient's secret storage, never into the conversation, transcripts or provider logs. This happens once per Overleaf site.
- **Unsaved editor text.** Before a sync, the app saves the folder's open editors (section 6). The user never sees this.
- **Real failures.** Overleaf unreachable, a rejected token, a full disk or a file that cannot be saved are errors with a reason, not questions (section 4.4).

## 2. The model: one Overleaf project, one folder

- An Overleaf project is one document (a paper, thesis, slide deck or grant), made of files that only work together: the main `.tex` file, chapters, a `.bib` file and figures.
- **Each Overleaf project lives in its own folder inside a Scient project.** Everything in that folder syncs. Nothing outside it ever does.
- **A Scient project can hold several Overleaf folders**, side by side and at any depth, for example `paper/`, `slides/` and `grant/`. A folder links to one Overleaf project, and a linked folder is never inside another. Step 5's connect enforces both (contract rule 1, acceptance case A02).
- **Code, data and analysis stay outside Overleaf folders.** Analysis writes its figures into the paper's folder, for example `paper/figures/`, and the next sync sends them.
- **A new Scient project made from Overleaf puts the paper in a subfolder** named after it, never at the project's top. This leaves room for more papers and for analysis, and keeps Scient's own files (`AGENTS.md`, `PROJECT.md`, `.scient/`) out of Overleaf.
- **Exception:** a folder that is already just the paper, opened as its own Scient project, can be linked as it is.

## 3. Ways to connect

Every way ends in the same connect operation (step 5). People see one Connect to Overleaf dialog; agents get the same result from the connect tool.

| Way                                      | Where                                                                                                                                                                                        |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. The Connect button in the Files panel | The Files toolbar: a folder icon with arrows, next to "New document". Its menu lists Overleaf; Google Drive, OneDrive and Dropbox say "Coming soon" (they belong to the cloud-storage plan). |
| 2. Right-click a folder                  | File tree ▸ Connect to ▸ Overleaf…                                                                                                                                                           |
| 3. Add project                           | Add project ▸ Overleaf project. Creates a Scient project with the paper in a subfolder.                                                                                                      |
| 4. Project Settings ▸ Overleaf           | "Link a folder…" and "Bring in an Overleaf project…"                                                                                                                                         |
| 5. Ask the agent                         | For example: "Bring my Overleaf project 'Main paper' into this project."                                                                                                                     |

Ways 1 and 2 are being designed in their own thread (worktree `scient-desktop-connectui-20261023`, branch `claude/connect-ui-20261023`). Its draft dialog links the selected folder, or the project's top when nothing is selected; with nothing selected, the default must be a new folder instead.

**The dialog, and the connect tool, take:**

- the Overleaf project, as its link or ID;
- one of two choices:
  - **bring it in as a new folder** (the default): named after the Overleaf project, inside the selected folder, or at the project's top when nothing is selected;
  - **link this folder**, for a folder that already holds just the paper.

**They show what the first sync will bring in and send.** If the folder looks like more than a paper (many code or data files, or the top of a code repository), they suggest a new folder instead. This is information, not an extra step: an agent's connect tool returns it in its result, and the agent decides.

## 4. How sync behaves

**Sync is manual and two-way:** Overleaf's changes come into the folder, then the folder's changes go to Overleaf, like `git pull` followed by `git push`. Automatic live sync is a separate, later plan.

**Like GitHub sync, only a conflict stops it.** Clicking Sync, or an agent's sync call, is the confirmation. New files, deletions, renames and older versions are all synced, then reported.

### 4.1 What the result says

A short message, for example "3 files came in, 2 were sent · See changes". The agent gets the same lines. It can add:

| Situation                                                                          | What it says                                                                                                                                                                            |
| ---------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| First sync of a link                                                               | What came in and what was sent. The connect screen or tool result already showed this beforehand.                                                                                       |
| A file was renamed                                                                 | Overleaf drops comments and tracked changes on renamed files                                                                                                                            |
| Older versions were sent, for example after switching to an older branch           | "Sent older versions of 2 files · Undo" (section 4.3)                                                                                                                                   |
| An earlier send never got an answer                                                | Scient checked Overleaf for it and never retries it. The line says whether it arrived; if that still can't be told, it says so, and this sync may carry some of the same changes again. |
| Overleaf changed while this sync was sending                                       | The app or tool starts one new sync by itself. If Overleaf changes again, the line says to sync again.                                                                                  |
| The project is bigger than Overleaf recommends, or a file is too big to edit there | A size note                                                                                                                                                                             |
| A new file is over 50 MB                                                           | It stays only on this computer, because Overleaf refuses it                                                                                                                             |
| Another agent is working in this copy of the project                               | A note. The thread running the sync doesn't count.                                                                                                                                      |
| A file still has conflict marks                                                    | That file waits; everything else was sent (section 4.2)                                                                                                                                 |
| The sync history is damaged (rare)                                                 | Scient says so and offers "Start fresh". Nothing is deleted on either side.                                                                                                             |

### 4.2 Conflicts

A conflict is the same lines changed on both sides, or a change on one side that the other side's change makes impossible (for example an edit to a file the collaborator deleted). Each one offers four choices:

- **Keep mine.**
- **Use Overleaf's.**
- **Merge myself.** Scient writes both versions into the file between conflict marks. The Source view highlights each block, with "Use mine", "Use Overleaf's" and "Keep both" above it.
- **Ask the agent.** Scient writes the marks into the file and posts a message in the chat asking the agent to merge them and explain its choices. If the current thread works in a separate worktree, it starts a new thread on the linked copy instead.

Conflicts that span several files (a rename on both sides, a file replaced by a folder) keep the engine's two whole-group choices: keep mine, or use Overleaf's.

**While a file has conflict marks, only that file waits.** Everything else is sent, and Overleaf's copy of that file stays as it is until the marks are gone. The editor says "This file has 2 Overleaf conflicts to settle" instead of showing a failed LaTeX build. Your version from before the sync is always kept as a copy. Today's engine holds back the whole send while any marks remain; the change is an engine addition specified in section 7.

### 4.3 Undo

**Undo puts back what Overleaf had before a send.** It covers the one case where this sync differs from GitHub: Git knows when you switch branches, but the sync only sees files that went back in time, so it sends older versions over collaborators' newer text. It also covers a deletion sent by mistake. People and agents can both undo.

- **Which sends.** One send that Overleaf accepted, named by its attempt number. It is offered in that sync's result and in the status, for as long as the connection still records that attempt (the last 64). A send whose outcome is unknown, refused or out of date has nothing known to undo.
- **What it does.** For every path that send changed on Overleaf (its parent commit's tree against the tree it sent: additions, deletions and both sides of a rename), it puts the parent's version back in the folder. That restores a changed file, removes a file the send added and recreates one it deleted. A file edited since that send is left alone and reported. Current bytes are kept as copies.
- **Then it syncs.** The restored files go out as ordinary local changes. If collaborators changed the same files since, they merge like any other edit, and only a conflict stops.
- **Safety.** It runs as a recorded local operation with its own receipt, like a kept-copy restore, so a retry or a restart never applies it twice.

### 4.4 What can still stop a sync

These are failures with a reason, never questions or approvals. Each says what happened and what to do next, and an agent can do whatever a person would.

- **Overleaf:** it can't be reached, the token is missing or rejected, or this account has no Git access to the project.
- **Editors:** an open editor couldn't save, for example unconverted Visual-editor input.
- **Limits:** more than 5,000 entries in the folder, more than 2,000 files or 250 MiB to sync, a synced or incoming file over 50,000,000 bytes, or Scient's private copy of the project over its storage cap. Keeping some files only on this computer, or choosing a narrower folder, fixes the first ones.
- **Paths and content:** names this Mac or Overleaf can't hold apart (differing only by letter case or Unicode spelling, a file and a folder with one name), or content Overleaf sends that Scient refuses to write (links, Git LFS pointers, repositories).
- **The folder moved under the sync:** a file changed while it was being read (the sync reads it again), or the folder no longer matches what was applied when it is time to send (nothing is sent; the edit goes with the next sync).
- **An interrupted earlier sync:** Scient finishes it first by itself. Files it can't settle become a conflict.
- **A kept copy changed during this sync** (a program wrote into the old file): this sync sends nothing; the next one checks again.
- **The checkout is busy:** a pull, branch switch or checkpoint restore is changing it at that moment.
- **The folder can't be verified:** its disk is unplugged, it moved, or the project's link to this checkout changed. Relink fixes the last two.
- **Scient's own state:** another Scient process holds the Overleaf state, or the disk is full.
- **Sixteen earlier sends** still have no answer.
- **The sync history is damaged:** Start fresh (section 4.1).

## 5. What is sent

- **New files in the folder are sent by default.** The review carries the default for each new file, so the app and the agent tools always pick the same files.
- **Skipped by default, every sync** (a rule, not a remembered list). "Send this file" sends one anyway:
  - LaTeX build leftovers (`.aux`, `.log`, `.synctex.gz`, `.fls`, `.fdb_latexmk`, `.out`, `.toc`, `.bbl`);
  - hidden files and anything in a hidden folder, for example `.env` or `.latexmkrc`;
  - Scient's own project files (`AGENTS.md`, `PROJECT.md`) when the linked folder is the project's top.
- **Never sent**, because Overleaf or the file layer can't take them; "Send this file" doesn't apply:
  - Git's and Scient's own folders, nested repositories, links, Git LFS pointers, and system and editor droppings (`.DS_Store`, swap files);
  - new files over 50,000,000 bytes, reported each sync (section 4.1). A file that shrinks under the limit is sent like any other.
- **A file Overleaf already has is synced like any other**, even if its name is on the skip rule (a `.bbl` kept for arXiv, a `.latexmkrc`).
- **"Keep only on this computer"** is a list a person or agent edits on purpose, for files not yet on Overleaf, such as notes to self. Taking a file off the list sends it at the next sync. Stopping the sync of a file already on Overleaf is not in this delivery.
- **Too much to send** (over 2,000 files or 250 MiB) stops the sync with that reason (section 4.4).
- A `.gitignore` in the folder is not read.

## 6. Agents' tools (PR C1)

The tools are server tools, like the existing "build this LaTeX document" tool. Their exact names and inputs are fixed in PR C1. Together they cover:

| Capability  | What the agent can do                                                                                                                                        |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Status      | Which folders are linked, to what, when they last synced, edits to send, conflicts, kept copies, and which copy of the project the link belongs to. Offline. |
| Preview     | What a sync would bring in and send, and any conflicts, without changing Overleaf. Like `git status` and `git diff` before a push.                           |
| Connect     | Link a folder, or bring an Overleaf project in as a new folder or a new Scient project.                                                                      |
| Sync        | The same sync a person runs, returning the result lines of section 4.1.                                                                                      |
| Decide      | For each conflict: keep mine, use Overleaf's or merge in the file. The agent then edits the file and syncs again.                                            |
| Files       | Keep a file only on this computer, or send a skipped or kept-only-here file.                                                                                 |
| Kept copies | List, compare and restore them.                                                                                                                              |
| Undo        | Put back Overleaf's previous version of what a sync sent.                                                                                                    |
| Manage      | Relink, unlink, start fresh after damaged history; save the token (through the secure secret request), test it or remove it.                                 |

**Saving editors.** The sync tool asks the app to save the folder's open editors in every open window, then syncs. If no window is open, nothing is unsaved. A window that can't save returns which file failed, and the sync doesn't run over it.

**Worktrees.** A link belongs to one copy of the project, usually the main one. When the calling thread works in another worktree, the tools act on the linked copy and say so: "Synced the main copy. Your edits in this worktree aren't in it until they're merged there."

**Activity.** The sync reports other agents working in the same copy. The thread running the sync, and its own subagents, are not counted.

**How agents learn this:** the tool descriptions, written as instructions; a mention in Scient's description of itself for agents (`ScientAwareness.ts`); and a built-in Overleaf skill covering the folder model, when to make a new folder, and how to merge conflict marks.

## 7. Server work

### Step 5, the last coordinator step

Beyond the contract's routes, mount, connect, disconnect, relink, token renewal, cancel and status, step 5 adds:

1. **An offline status** for the chip and the status tool: compares the folder with the last sync without going online. It reads the folder, so it is cached and refreshed on file changes, not run for every file header.
2. **A "needs a decision" flag** on each review: true only when it has a conflict. The app and the tools confirm everything else straight away.
3. **The other-agents line** (contract section 10): a bounded read of active threads in the same copy, excluding the caller and its subagents. It is reported, never acknowledged. If activity can't be read, the line says so; it never claims no agent is working.
4. **The new-file rule** of section 5:
   - the review's default selection, which the app and tools confirm as it is;
   - hidden files skipped by default, not only files in hidden folders (today a top-level `.env` is selected by default);
   - Scient's own project files and new files over 50,000,000 bytes skipped;
   - rule-skipped files no longer remembered as local-only. Today every unselected new file is remembered, and after 2,000 the sync refuses.

### Engine additions, before the agent tools

Each is its own PR after step 5, reviewed and merged before the C1 tools that use it.

**1. Holding back only a file with conflict marks** (section 4.2). Today one candidate tree is the apply target, the verification expectation, the attempt and the next base, and the applier reports any remaining marks as needing attention, which blocks the whole send. The addition:

1. **Two trees in the review.** The local target (what the folder will hold, marks included) and the publication tree: the local target with each held path set to the fetched Overleaf entry, or absent where Overleaf has none. Both trees and the set of held paths are bound into the review's digest. Outgoing changes are the difference between Overleaf's tree and the publication tree, so a held file never appears among them. The publication tree is validated like any other tree (file-and-folder and case or Unicode collisions).
2. **Which paths are held.** Every path that gets new marks in this apply, plus every recorded marker path whose file still has marks. A marker record follows its file through renames on either side, so a marked file renamed locally is held at its new path. Today the review checks recorded marks only at their recorded paths.
3. **The gate.** An apply whose only reason for attention is marks on held paths may publish: every unit done, the folder matches the local target, no interrupted groups, no staging, and no changed or ambiguous kept copies. Anything else blocks the send as today.
4. **Verification** captures the whole publication domain and compares every path that isn't held with the publication tree, absences included. Held files are the user's work in progress and are not compared.
5. **The attempt and the base.** The attempt records the publication tree, and acceptance makes it the base. A held file's base is then Overleaf's version, as an apply already sets it (`advanceBase`), so the user's merge goes out at the next sync. Marker records stay until the marks are gone, across acceptance, restart and recovery.
6. **Tests:** new and carried-over marks; a marked file renamed locally and on Overleaf; Overleaf deleting a marked file; a restart between apply and send; resolving the marks and syncing; Markdown `=======` lines hold nothing back.

**2. Sending a file kept only on this computer.** Removes it from the local-only list and selects it in the next review. Today only a name clash with an Overleaf file brings one back.

**3. Undo** (section 4.3): a recorded local operation with its own receipt, built from the accepted attempt's parent and sent trees.

PR C1 also adds the request from the server that saves open editors in every window, which PR C2 reuses.

## 8. The app's screens (PR C2)

- **An Overleaf chip in the header of every file in a linked folder**, next to "Saved". It shows up to date, edits to send, needs a decision, or a problem. Clicking it shows Sync, the last sync time, Open in Overleaf and Overleaf settings…. In another worktree it says the link belongs to the main copy and offers to sync that copy.
- **A "Sync with Overleaf" command** in the command palette.
- **An Overleaf mark on linked folders** in the file tree.
- **A review tab in the right panel**, opened only for a conflict or by "See changes". It reuses the existing Diff view.
- **Kept copies** in each file's existing "Retained file versions" menu, with "Show in Finder", because the folder that holds them is hidden.
- **Settings ▸ Source Control ▸ Overleaf**, beside GitHub and the other providers:
  - the token: "Create a token on Overleaf ↗", Save, Test, Remove and its status;
  - every linked folder on this computer, grouped by project, each with its status, last sync, Sync now, Open in Overleaf, kept copies, files kept only here, and Unlink.
- **Project Settings ▸ Overleaf** shows only this project's links, plus "Link a folder…" and "Bring in an Overleaf project…".
- **Deliberately left out:** a "review every sync" switch, a sync schedule, commit messages, and any Overleaf-specific agent permission.

The UI of PR #121 (closed October 19) is a reference for these screens.

## 9. Documentation

| For        | What                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Ships with |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| Agents     | Tool descriptions written as instructions; the mention in `ScientAwareness.ts`; the built-in Overleaf skill                                                                                                                                                                                                                                                                                                                                                                                                                         | C1         |
| Users      | A new `docs/user/overleaf.md`: what it does; what you need (Git access on a paid Overleaf plan, yours or the project owner's; macOS; an APFS disk; Git 2.39 or newer); getting a token; the five ways to connect and the folder model; what Sync does and what is and isn't sent; conflicts, Undo, kept copies and worktrees; Overleaf's side effects (renames drop comments, edits show as "via Git"); limits; unlinking; where the token is stored; and a closing table of every message the app can show and what to do about it | C2         |
| Users      | Updates to `source-control.md`, `project-settings.md`, `projects.md`, `latex.md` and `permission-modes.md`                                                                                                                                                                                                                                                                                                                                                                                                                          | C2         |
| Developers | An internals document for the app side: chip states, the "only conflicts stop" rule, the review tab, saving editors before a sync, settings, and an agent-tools reference. The engine document is kept current with each step.                                                                                                                                                                                                                                                                                                      | C1 and C2  |

**Acceptance test for the docs.** Before C1 merges, a fresh agent with only the tool descriptions and the skill links a folder to a disposable Overleaf project, syncs both ways, settles a conflict and undoes a sync. Before C2 merges, a fresh agent follows the user guide end to end. Anything either one gets stuck on is a documentation bug.

## 10. Delivery

1. **Step 5**, as stacked PRs if large (service operations, then routes and mount).
2. **The three engine additions** of section 7, one PR each.
3. **PR C1, agent tools**, with the editor-save request, the skill and the agent documentation. Its acceptance is the first real end-to-end sync against Overleaf Cloud, driven by an agent from the dev app.
4. **PR C2, the screens and the user guide**, reusing C1's operations. Then the full journey in a packaged, signed macOS build.

Each piece is built, reviewed by Codex until clean, and merged through the queue one PR at a time. Where older text says "PR C", read C1 for the editor-save request and the agent journey, and C2 for anything on screen.

## 11. Still open with the owner

**Four defaults** (contract section 1), recommended as they are:

- a review expires after 15 minutes (it matters only while a conflict waits);
- Scient's private copy of each project's history is capped at 5 GiB;
- Overleaf's 50 MB file limit is read as 50,000,000 bytes: a new file over it stays only on this computer, and a synced or incoming one stops the sync;
- only Overleaf's own site (Overleaf Cloud) is supported.
