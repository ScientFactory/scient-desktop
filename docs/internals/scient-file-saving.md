# Saving workspace files

A save lands or goes again. Nothing about a failed save stops the next one, and
the editor never locks.

Workspace mutations live in
`apps/server/src/scient/workspace/WorkspaceFileMutations.ts`. Saves, creates,
renames, deletes and Overleaf's file writes are plain on every host. The native
helper (`native/file-exchange`) only finishes what an older build left unfinished,
and is removed after one release.

## A save

1. **Keep a copy.** What the save replaces goes to the file history
   (`scient/workspace/FileHistory.ts`, under the server's `file-history` folder,
   shown in the file's version menu). Each copy is named for the bytes it holds.
   Scient's own autosaves are kept five minutes apart. Text Scient didn't write is
   only replaced once its copy is safe; if that copy fails, or the file is over the
   history's 1 GiB limit, the save reports failure and the file stays as it is.
2. **Write.** A temporary file next to the target is flushed, then renamed over it.
   The revision is checked right before every rename attempt, and Windows retries a
   rename another program briefly holds. A new file is hard-linked into place, never
   replacing one. On volumes without hard links the name is created exclusively and
   written in place.
3. **If it can't be replaced**, because a program holds it, the folder refuses new
   files, or it has other hard links: the bytes go through the file's own handle.
   That needs a copy in the history first, and the handle must still be the admitted
   file. A failed write puts the earlier bytes back.
4. **Read back.** If the bytes are already on disk the save counts as done, which also
   settles a save whose answer was lost.

A stale revision is refused and leaves the file untouched (`revision_conflict`). Any
failure that left the target as before is reported as `"unchanged"`, with the system's
error code. Every mutation advances the workspace mutation epoch, so build fences and
PDF exports captured earlier refuse.

Mutations, settled reads, epoch reads and publication fences own their workspace root
in this process: work on overlapping roots runs one at a time, and a request cancelled
while it waits never runs. A read refuses to answer for a folder replaced while it ran.

A rename takes the file's history along. A delete keeps a copy.

## In the editor

`packages/scient-document/src/persistenceCoordinator.ts` owns this. There is no
"unknown" or "review" state.

- A failed save goes again after 0.25, 1, 3, 10, then every 30 seconds, for as long
  as it takes. Saving by hand doesn't wait out the delay. Before going again over
  newer typing or an undo it reads what landed, so undone text is never sent.
- Brief holds stay out of sight. A failure that lasts, or isn't transient, shows one
  notice (`ScientMarkdownPersistenceNotice`, shared by Markdown and LaTeX) with the
  real reason and **Save a copy**.
- A change elsewhere merges if it can. If it can't, the person's text is saved, the
  other version goes to the history, and a small line offers **Use the other
  version**.
- A draft restored from an earlier session that conflicts with the file writes
  nothing. A small line offers **Keep my draft** and **Use the file**, and typing on
  counts as keeping it. This is the one question left: only the person knows which
  text they want.

Plain text and code files still use the older `fileSaveCoordinator`, with its own
Try again and conflict question.

## Overleaf

An apply writes each file with `applyStep`: it takes the same ownership as a save,
checks the file and its group, keeps the earlier bytes in the step's folder and the
history, and publishes like a save. Its record has the format sync already reads.
Running a step again looks at the file and finishes it, so a crash needs no recovery
of its own. A delete moves the original into the kept copy, so a program still holding
it writes there.

Sync is not a person, so it never overwrites edits: Overleaf conflicts stop and ask.

## Older builds

The first touch of a root looks for unfinished records, without the native helper.
Nearly every root has none. If there are some, writes wait for them to finish rather
than race them, and are refused and retried meanwhile. Stalled work holds saves for at
most two minutes. Nothing a record says blocks a read or a save.

## Limits

- An edit from another program in the last moment before a rename can be lost.
- A program holding a file open while it is replaced writes into the old file, as with
  `git pull`.
- A file removed in the instant between a crash and a sync step's record is added again
  when sync resumes: a step goes by the file alone.
- Custom Windows ACLs and alternate data streams aren't carried across a rename.
- A lost answer followed by a backend restart can show an error for a create, rename or
  delete that did succeed.
