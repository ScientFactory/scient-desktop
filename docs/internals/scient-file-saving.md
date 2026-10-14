# Saving workspace files

Workspace mutations live in
`apps/server/src/scient/workspace/WorkspaceFileMutations.ts`. When the service
is created it asks the native helper (`native/file-exchange`) what it can do and
chooses one of two modes for the host.

**Native publication.** Requires strict current-root authority, publication
leases including shared ancestor leases, and exclusive move and link. macOS
qualifies. Saves, creates, renames and deletes keep the previous version and a
durable record, so an interrupted operation can be recovered and reviewed. A
save also needs one-step replacement (`atomicExchange`) and a new file one-step
complete creation (`atomicCreateMetadata`); where a volume lacks these (creating
on a macOS volume without clone support), that one operation is published
plainly under the same leases and checks.

**Plain host.** Used when any of those primitives is missing: Windows (no shared
leases, no one-step replace or create), Linux (no strict current-root
authority), or no helper at all. Mutations, settled reads, epoch reads and
publication fences own their workspace root in this process, like native root
leases (`main` locked per file): work on overlapping roots runs one at a time in
arrival order, unrelated roots run independently, and a held callback must not
wait for its own root. A request cancelled while it waits never runs. After the
wait each mutation resolves its path again and refuses one that now resolves
elsewhere (`target_changed`). No earlier versions are kept; version history is
empty and Overleaf retention reports that it needs native publication.

Plain publication, in either mode:

- Writes a temporary file next to the target and flushes it, then checks the
  folder and the guarded revision again and renames the file over the target
  (Windows retries a rename refused because another program briefly holds the
  file). A new file is hard-linked into place, never replacing one. On volumes
  without hard links (including Windows exFAT, which reports `EISDIR`) the name
  is created exclusively and written in place: it can never replace another
  file, but a reader may briefly see it incomplete, and an interrupted write can
  leave it incomplete. Permissions of an existing file are kept.
- Refuses a stale revision and leaves the file untouched (`revision_conflict`).
- Converges a lost reply: if the requested bytes are already on disk the save
  succeeds without writing. A retry with the same mutation id in the same server
  run replays its receipt; reusing the id for different bytes is refused, also
  across the plain and native paths.
- Reports a failure that left the target exactly as before, including a refused
  read of the current file during admission, as an `"unchanged"` publication
  outcome with the operating system's error code. If the rename or
  link call fails it re-reads the target: the requested bytes count as done, the
  previous bytes as unchanged, anything else stays unknown.
- Advances the workspace mutation epoch before its rename, so build fences and
  PDF exports captured earlier refuse. One count covers every root, including
  nested ones. The count is kept in memory: until a run publishes plainly the
  epoch is what it was before a restart; afterwards the run's own nonce keeps it
  from matching any earlier run's epoch, so a LaTeX PDF built in an earlier run
  after a plain save is rebuilt once. Builds and exports also re-check source
  contents.

Plain moves link the file to its new name (never replacing one), confirm the new
name holds the same file with the inspected bytes, then remove the old name; if
that fails the new name is removed again, but only while it is still the link
this move created. Plain moves need hard links, as on `main`. A mutation id a
plain publication has started or answered cannot be reused by a later native
move or delete. Plain deletes check the current revision first. Both can remove folders
they leave empty.

Plain publication cannot stop another program from changing the file between
the final check and the rename, and cannot pin folders against being swapped
while it works. These are the guarantees `main` had; native publication is what
removes them.

## What the user sees

Routine saves are silent. A failure the server proved left the file unchanged
retries after 0.25, 1 and 3 seconds (the LaTeX file status reads "Retrying…"),
then the document shows a one-line notice (`ScientMarkdownPersistenceNotice`,
shared by Markdown and LaTeX): "Couldn't save: the disk is full. Your changes are
still here." with **Try again** and **Details** (raw error, code and references,
with **Copy details**). Outcomes that need checking keep their review actions
with plain labels: **Show file on disk**, **Continue from this version**, **Open
earlier version**.
