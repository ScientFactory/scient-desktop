# Saving workspace files

Every save, create, rename and delete goes through `publish` in
`apps/server/src/scient/workspace/WorkspaceFileMutations.ts`. A save takes one of
two paths, chosen by what the native helper (`native/file-exchange`) reports for
the file's root and parent folder.

**Native publication.** Used when the helper has strict current-root authority,
publication leases, exclusive move and link, and one-step replacement
(`atomicExchange`) or, for a new file, one-step complete creation
(`atomicCreateMetadata`). It keeps the previous version and a durable record, so
an interrupted save can be recovered and reviewed. macOS on APFS qualifies.

**Plain publication.** Used for saves and new files when the helper only provides
leases: Windows (no one-step replacement or creation), Linux (no strict
current-root authority), and new files on macOS volumes without clone support. It runs under
the same root and parent leases, after the same pending-record settlement,
attention, epoch and revision checks. It then writes a temporary file next to
the target, flushes it, and renames it over the target, or hard-links it for an
exclusive create (copy-exclusive on volumes without hard links). Permissions of
an existing file are kept. On Windows, a rename refused because another program
briefly holds the file is retried with short back-off. No earlier version is
kept, as on `main` before native publication existed.

Plain publication keeps these guarantees:

- A stale revision is refused and the file is untouched (`revision_conflict`).
- A lost reply converges: if the requested bytes are already on disk, the save
  succeeds without writing. A retry with the same mutation id in the same server
  run replays its receipt; reusing the id for different bytes is refused.
- Each plain save advances the workspace mutation epoch (an in-memory count with
  a per-run nonce), so build fences and PDF exports captured before it refuse.
  Exports also re-check source contents, which covers a server restart.
- A failure before the final rename or link reports an `"unchanged"`
  publication outcome with the operating system's error code.

Overleaf retention (an explicit retention directory), renames and deletes still
require native publication authority. Windows qualifies for them; Linux does not
yet (no strict current-root authority), so renames and deletes are refused there.
Without any helper, reads fail as well, so a missing helper is an installation
fault rather than a save fallback case.

## What the user sees

Routine saves are silent. A transient failure retries after 0.25, 1 and 3
seconds; meanwhile the LaTeX file status reads "Retrying…". Only then does the
document show a one-line notice (`ScientMarkdownPersistenceNotice`, shared by
Markdown and LaTeX): a plain title with the reason in words when the system gave
one ("Couldn't save: the disk is full."), one short sentence, the actions, and
**Details** with the raw error, code and references for bug reports. A failure
the server proved unchanged reads "Couldn't save … Nothing was written." rather
than an unknown outcome.
