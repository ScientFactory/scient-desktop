---
name: overleaf-sync
description: Overleaf transfer. Bring in or link an Overleaf project; sync, push or pull my paper; resolve Overleaf conflicts or conflict marks, recover an interrupted sync or undo a send. Use latex-authoring for editing or compiling .tex without transferring files.
---

# Overleaf sync

The goal is to keep a paper in a Scient project and its Overleaf project in step, losing nobody's text, and to report plainly what moved each way. Link, preview or sync only when the user asked to transfer files; resolving conflict marks in a local file is a local merge.

## The folder

One Overleaf project is one document, in its own folder inside the Scient project, and everything in that folder syncs: new files, deletions and renames included. Keep code, data and private notes outside it, and write the paper's figures into it. Bring a project in as a new folder (`scient_overleaf_connect`, mode `new-folder`) unless an existing folder holds just the paper; when the connect result says a folder looks like more than a paper, tell the user and prefer a new folder.

In a separate worktree, the tools act on the copy the link belongs to and say so; worktree edits reach Overleaf only once merged into that copy.

When a tool says the Overleaf Git token is missing or refused, ask for it with `request_secret` and save it with `scient_overleaf_token`; the token never goes through chat.

## Syncing

1. `scient_overleaf_status` lists each link and its state offline. A check-only question ends here: `scient_overleaf_preview` saves open editors and can finish an interrupted sync, so it changes things.
2. `scient_overleaf_preview` shows what would come in and go out, and any conflicts (`diff: true` for text differences).
3. `scient_overleaf_sync` brings Overleaf's changes in, then sends the folder's. "Push" and "pull" both sync both ways; tell the user so rather than promising a one-way transfer.
4. Report from the result: what came in, what was sent, what was held or skipped (counted apart from sent), renames (Overleaf drops comments and tracked changes on renamed files) and any recovery the sync did first.

## Conflicts and merges

Decide as you would for a Git merge: follow the user's instructions and use only the choices each conflict allows. When both sides hold real work and `markers` is allowed, use it and merge them; when it isn't (binary files, renames, deletions), keep both versions and settle the choice with the user. Pass the review's `remoteTree` back as `reviewedRemote`; if Overleaf moved meanwhile, decide again for the new review. A file still holding conflict marks is held back; `files.release` sends it as it is only when the marks are its real content, and `files.send` sends a file that was held. Explain your choices to the user.

As soon as merged text exists locally, and before a sync that would send it, check the merge: citations, captions, figures and numbers keep both sides' content, and no conflict marks remain. Then build with `scient_latex_build` from the real root, fix undefined citations, references and missing files, and look at the rendered pages: `pdftoppm` if installed, otherwise `pdf-authoring`'s `scripts/render_pdf.py` (read it with `scient_skill_read_resource`). Look at the changed pages, or every page of a short paper. If you couldn't build or look, say so and why.

## Recovery

The version a sync replaced is kept: `scient_overleaf_kept_copies` lists and restores copies. `scient_overleaf_undo` puts back what Overleaf had before one send, then syncs; list the sends first. `scient_overleaf_manage` relinks, recovers an interrupted sync or cancels a running one. Restoring and undoing change files, so use them only for the recovery the user asked for. When a tool stops with an error, do what it says, or tell the user when only they can fix it.

Reply with links to the changed sources and any built PDF, what moved each way, the build and visual check, and anything unresolved. For a local-only merge, say that nothing was synced.
