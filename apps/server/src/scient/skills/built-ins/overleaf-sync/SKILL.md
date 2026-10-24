---
name: overleaf-sync
description: Link project folders to Overleaf projects and sync them in Scient. Use when the user mentions Overleaf, asks to bring in, link, sync, push to or pull from an Overleaf project, or when a file has Overleaf conflict marks.
---

# Overleaf Sync

The goal is to keep a paper in a Scient project and its Overleaf project in step, losing nobody's text, and to report plainly what moved each way.

You can do with Overleaf whatever the user can do in Scient. The tools ask no one for approval: do what the user asked, then report the result lines. This skill grants no tools or authority.

## The Folder Model

- One Overleaf project is one document (a paper, thesis, slide deck or grant). It lives in its own folder inside the Scient project, and everything in that folder syncs. Nothing outside it ever does.
- A project can hold several Overleaf folders side by side, for example `paper/` and `slides/`. A linked folder is never inside another.
- Keep code, data and analysis outside Overleaf folders. Write figures for the paper into its folder, for example `paper/figures/`; the next sync sends them.
- Bring a project in as a new folder by default (`scient_overleaf_connect` with mode `new-folder`), named after the paper. Link an existing folder (mode `link-folder`) only when it already holds just the paper. Link the project's top folder only when the whole project is the paper. If the connect result says the folder looks like more than a paper, tell the user and prefer a new folder.

## The Token

Syncing needs the user's Overleaf Git token (Git access needs a paid Overleaf plan, the user's or the project owner's). When a tool says no token is saved, or that Overleaf refused it:

1. Call `request_secret` with the label "Overleaf Git token", explaining that the user creates it in Overleaf under Account settings, Git integration.
2. Call `scient_overleaf_token` with action `save` and the returned `secretRef`.

Never ask for the token in chat, never write it anywhere, and never repeat it.

## Syncing

1. Find the link with `scient_overleaf_status`; it lists each linked folder's `connectionId` and status without going online.
2. Optionally preview with `scient_overleaf_preview`: what would come in and be sent, and any conflicts.
3. Sync with `scient_overleaf_sync`. It saves the folder's open editors, brings Overleaf's changes in, then sends the folder's changes. New files, deletions, renames and older versions all sync, then get reported.
4. New files are sent by default, except build output, hidden files and Scient's own project files. Send one of those with `files.send`. Keep a new file only on this computer (notes to self, for example) with `files.keepOnlyHere`; it stays out until you send it the same way.
5. Report the result lines to the user: what came in, what was sent, renames (Overleaf drops comments and tracked changes on renamed files), older versions sent, and any other agents working in the same copy.

If the thread works in a separate worktree, the tools act on the copy the link belongs to and say so. Your edits in the worktree reach Overleaf only after they are merged into that copy.

## Conflicts

Only a conflict stops a sync. None of the stopped review's changes are applied; the result first says if the sync finished an interrupted sync or applied an earlier attempt before it stopped. Each conflict has a key and allowed choices:

- `mine` keeps this computer's version; `theirs` takes Overleaf's.
- `markers` writes both versions into the file between conflict marks (`<<<<<<<`, `=======`, `>>>>>>>`).

Decide the way you would for a Git merge conflict: follow the user's instructions, and when both sides hold real work, choose `markers` and merge. Call `scient_overleaf_sync` again with one choice per key and the `reviewedRemote` the result gave. If Overleaf changed meanwhile, the result shows a new review whose conflicts your choices don't answer; decide again for them. For `markers`, edit each marked file so it keeps the intended text from both sides, remove every mark, check the document still builds, then sync again. A file with marks is not sent until its marks are gone; everything else is. If the marks are the file's real content (a guide that quotes them), send it as it is with `files.release`. Explain your merge choices to the user.

The version a sync replaced is kept as a copy. `scient_overleaf_kept_copies` lists them and restores one.

## Undo

Undo puts back what Overleaf had before one send: for example after an older branch's files were sent over a collaborator's newer text, or a deletion was sent by mistake. `scient_overleaf_undo` without `attemptNumber` lists the sends you can undo, with what each changed. With the send's number (`send #N` in a sync result) it saves the open editors, puts back the earlier version of every file that send changed, keeps the replaced files as copies, then syncs. A file edited since that send is left as it is and reported. Tell the user what was put back and what was left.

## When Something Stops

Errors name what happened and what to do next: Overleaf unreachable, a missing or refused token, an editor that could not save, a link to relink (`scient_overleaf_manage` with action `relink`), or an interrupted sync to recover (action `recover`). Action `cancel` asks a running sync to stop before its next step. Do what the message says, or tell the user when only they can fix it.
