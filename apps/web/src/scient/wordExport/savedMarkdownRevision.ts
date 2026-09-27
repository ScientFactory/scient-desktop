import type { MarkdownPersistenceSnapshot } from "@scientfactory/scient-markdown";

/**
 * The saved revision of an open Markdown file, after flushing its pending
 * edits, or `null` when what the editor shows is not yet on disk. Word export
 * converts the saved file, never a draft the server has not seen.
 */
export async function savedMarkdownRevision(lease: {
  readonly flushNow: () => Promise<boolean>;
  readonly getSnapshot: () => Pick<
    MarkdownPersistenceSnapshot,
    "pending" | "draftSource" | "baselineSource" | "baselineRevision" | "conflict"
  >;
}): Promise<string | null> {
  await lease.flushNow();
  const snapshot = lease.getSnapshot();
  if (snapshot.pending || snapshot.conflict !== null) return null;
  return snapshot.draftSource === snapshot.baselineSource ? snapshot.baselineRevision : null;
}
