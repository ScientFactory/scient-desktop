# Overleaf in Scient: agents, the app and the docs (PR C)

Decided with the owner on October 23–24, 2026. This document is the reference for everything after the server coordinator: what step 5 adds, the agent tools (PR C1), the app's screens (PR C2) and the documentation. Where the [implementation plan](implementation-plan.md) or the [coordinator contract](pr-b-coordinator-contract.md) disagree with it, this document wins, and they should be corrected.

Nothing here is built yet. Steps 1–4 of the coordinator are merged and need no rework for these decisions.

## 1. The rule for agents: whatever a person can do

**An agent can do everything with Overleaf that a person can do in Scient, whenever the user asks it to.** An agent on full access has full access. Overleaf adds no permission, approval, confirmation, warning or stop of its own, for agents or for people.

- **The only control is the access setting the user already chose in the composer.** Overleaf tools run under it exactly like every other tool. Do not add an Overleaf permission. Do not change how the composer's access setting works. The tools never read it to decide what to refuse, and never change it.
- **Every capability is available to the agent**, including the ones that remove or overwrite: unlink, start fresh after damaged history, restore a kept copy, undo a sync, choose a side in a conflict, keep a file only on this computer or send it.
- **Tools do what they are asked, then report.** A tool returns a plain account of what happened, using the same lines a person sees (section 4). The engine's review acknowledgements are passed automatically: they identify the exact review being confirmed, and they are never a question to anyone.
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

| Situation                                                                          | What it says                                                                                      |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| First sync of a link                                                               | What came in and what was sent. The connect screen or tool result already showed this beforehand. |
| A file was renamed                                                                 | Overleaf drops comments and tracked changes on renamed files                                      |
| Older versions were sent, for example after switching to an older branch           | "Sent older versions of 2 files · Undo" (section 4.3)                                             |
| An earlier send never got an answer                                                | Scient checked Overleaf for it first and never sends it twice                                     |
| The project is bigger than Overleaf recommends, or a file is too big to edit there | A size note                                                                                       |
| A new file is over 50 MB                                                           | It stays only on this computer, because Overleaf refuses it                                       |
| Another agent is working in this copy of the project                               | A note. The thread running the sync doesn't count.                                                |
| A file still has conflict marks                                                    | That file waits; everything else was sent (section 4.2)                                           |
| The sync history is damaged (rare)                                                 | Scient says so and offers "Start fresh". Nothing is deleted on either side.                       |

### 4.2 Conflicts

A conflict is the same lines changed on both sides, or a change on one side that the other side's change makes impossible (for example an edit to a file the collaborator deleted). Each one offers four choices:

- **Keep mine.**
- **Use Overleaf's.**
- **Merge myself.** Scient writes both versions into the file between conflict marks. The Source view highlights each block, with "Use mine", "Use Overleaf's" and "Keep both" above it.
- **Ask the agent.** Scient writes the marks into the file and posts a message in the chat asking the agent to merge them and explain its choices. If the current thread works in a separate worktree, it starts a new thread on the linked copy instead.

Conflicts that span several files (a rename on both sides, a file replaced by a folder) keep the engine's two whole-group choices: keep mine, or use Overleaf's.

**While a file has conflict marks, only that file waits.** Everything else is sent, and Overleaf's copy of that file stays as it is until the marks are gone. The editor says "This file has 2 Overleaf conflicts to settle" instead of showing a failed LaTeX build. Today's engine holds back the whole send while any marks remain; step 5 changes this (section 7). Your version from before the sync is always kept as a copy.

### 4.3 Undo

Every sync that sent something offers **Undo**: it puts back into the folder the version Overleaf had just before that sync, for each file the sync changed there, keeping the current versions as copies, and syncs again. It covers the one case where this sync differs from GitHub: Git knows when you switch branches, but the sync only sees files that went back in time, so it sends older versions over collaborators' newer text. Undo also covers a deletion sent by mistake. Agents can undo too. Scient's private history already holds what Overleaf had before each send.

### 4.4 What can still stop a sync

These are failures with a reason, not questions:

- Overleaf can't be reached, or the token is missing or rejected;
- an open editor couldn't save (for example unconverted Visual-editor input);
- the folder or Overleaf project is beyond a limit: 5,000 entries walked, 2,000 files, 250 MiB in total, or a synced file over 50 MB;
- a pull, branch switch or checkpoint restore is changing the same checkout at that moment;
- sixteen earlier sends still have no answer;
- the sync history is damaged ("Start fresh", section 4.1).

Each says what to do next. An agent can do whatever a person would.

## 5. What is sent

- **New files in the folder are sent by default.** The review carries the default for each new file, so the app and the agent tools always pick the same files.
- **Skipped automatically, every sync** (a rule, not a remembered list):
  - what the engine already skips or leaves out: LaTeX build leftovers (`.aux`, `.log`, `.synctex.gz`, `.fls`, `.fdb_latexmk`, `.out`, `.toc`, `.bbl`), anything in a hidden folder, system and editor droppings, Git's and Scient's own folders, nested repositories, links and Git LFS pointers;
  - Scient's own project files (`AGENTS.md`, `PROJECT.md`) when the linked folder is the project's top;
  - new files over 50 MB, reported (section 4.1).

  A build leftover, hidden file or Scient file that Overleaf already has (a `.bbl` kept for arXiv, say) is synced like any other file.

- **"Keep only on this computer"** is a list a person or agent edits on purpose, for something like notes to self. Taking a file off the list sends it at the next sync, and so does choosing "Send this file" for a skipped one. Once sent, a file is synced like any other.
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
| Files       | Keep a file only on this computer, or send it.                                                                                                               |
| Kept copies | List, compare and restore them.                                                                                                                              |
| Undo        | Put back Overleaf's previous version of what a sync sent.                                                                                                    |
| Manage      | Relink, unlink, start fresh after damaged history; save the token (through the secure secret request), test it or remove it.                                 |

**Saving editors.** The sync tool asks the app to save the folder's open editors in every open window, then syncs. If no window is open, nothing is unsaved. A window that can't save returns which file failed, and the sync doesn't run over it.

**Worktrees.** A link belongs to one copy of the project, usually the main one. When the calling thread works in another worktree, the tools act on the linked copy and say so: "Synced the main copy. Your edits in this worktree aren't in it until they're merged there."

**Activity.** The sync reports other agents working in the same copy. The thread running the sync, and its own subagents, are not counted.

**How agents learn this:** the tool descriptions, written as instructions; a mention in Scient's description of itself for agents (`ScientAwareness.ts`); and a built-in Overleaf skill covering the folder model, when to make a new folder, and how to merge conflict marks.

## 7. Server work

**Step 5 (the last coordinator step)** adds, beyond the contract's routes, mount, connect, disconnect, relink, token renewal, cancel and status:

1. **An offline status** for the chip and the status tool: compares the folder with the last sync without going online. It reads the folder, so it is cached and refreshed on file changes, not run for every file header.
2. **A "needs a decision" flag** on each review: true only when it has a conflict. The app and the tools confirm everything else straight away.
3. **The other-agents line** (contract section 10): a bounded read of active threads in the same copy, excluding the caller. It is reported, never acknowledged. If activity can't be read, the line says so; it never claims no agent is working.
4. **The new-file rule** of section 5: the review's default selection, the extra skips, and rule-skipped files no longer remembered as local-only. Today every unselected new file is remembered, and after 2,000 the sync refuses.
5. **Holding back only a conflicted file** (section 4.2): the published tree takes the fetched Overleaf version of each file with conflict marks, and verification checks every other file byte for byte. This keeps the base rules as they are, because an apply already gives such a file Overleaf's version as its base. Step 5 proves it with a test: everything else is sent, Overleaf's copy of that file is unchanged, and the user's merge goes out at the next sync.

**PR C1 adds two engine operations**: sending a file that was kept only on this computer (today only a name clash with an Overleaf file brings one back), and Undo (section 4.3). It also adds the link between the server and the app's windows that saves open editors, which PR C2 reuses.

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
2. **PR C1, agent tools**, with the editor-save link and the two engine operations. Its acceptance is the first real end-to-end sync against Overleaf Cloud, driven by an agent from the dev app.
3. **PR C2, the screens and the user guide**, reusing C1's operations. Then the full journey in a packaged, signed macOS build.

Each piece is built, reviewed by Codex until clean, and merged through the queue one PR at a time. Where older text says "PR C", read C1 for the editor-save link and the agent journey, and C2 for anything on screen.

## 11. Still open with the owner

**Four defaults** (contract section 1), recommended as they are: a review expires after 15 minutes; Scient's private copy of each project's history is capped at 5 GiB; files over 50,000,000 bytes are refused; only Overleaf's own site (Overleaf Cloud) is supported.
