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
authority), or no helper at all. Every mutation, settled read, epoch read and
publication fence runs behind one in-process lock, as on `main` before native
publication existed. No earlier versions are kept; version history is empty and
Overleaf retention reports that it needs native publication.

Plain publication, in either mode:

- Writes a temporary file next to the target and flushes it, then checks the
  folder and the guarded revision again and renames the file over the target
  (Windows retries a rename refused because another program briefly holds the
  file). A new file is hard-linked into place, never replacing one; on volumes
  without hard links the name is reserved exclusively and the complete file
  renamed over that empty reservation. Permissions of an existing file are kept.
- Refuses a stale revision and leaves the file untouched (`revision_conflict`).
- Converges a lost reply: if the requested bytes are already on disk the save
  succeeds without writing. A retry with the same mutation id in the same server
  run replays its receipt; reusing the id for different bytes is refused, also
  across the plain and native paths.
- Reports a failure that left the target exactly as before as an `"unchanged"`
  publication outcome with the operating system's error code. If the rename or
  link call fails it re-reads the target: the requested bytes count as done, the
  previous bytes as unchanged, anything else stays unknown.
- Advances the workspace mutation epoch before its rename, so build fences and
  PDF exports captured earlier refuse. One count covers every root, including
  nested ones. Until a run publishes plainly the epoch stays what it was before a
  restart; builds and exports also re-check source contents.

Plain moves link the file to its new name (never replacing one), confirm it is
the same file, then remove the old name; if that fails the new name is removed
again. Plain deletes check the current revision first. Both can remove folders
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
