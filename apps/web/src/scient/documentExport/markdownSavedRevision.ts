import type { MarkdownPersistenceLease } from "../markdownEditor/persistence/markdownPersistenceRegistry";

const REVISION_PATTERN = /^sha256:[0-9a-f]{64}$/u;

/** Flushes editor changes and returns only a confirmed saved document revision. */
export async function savedMarkdownRevision(
  persistence: Pick<MarkdownPersistenceLease, "flushNow" | "getSnapshot">,
): Promise<string | null> {
  if (!(await persistence.flushNow())) return null;
  const snapshot = persistence.getSnapshot();
  if (
    snapshot.pending ||
    snapshot.draftSource !== snapshot.baselineSource ||
    snapshot.conflict !== null ||
    snapshot.error !== null ||
    !REVISION_PATTERN.test(snapshot.baselineRevision)
  ) {
    return null;
  }
  return snapshot.baselineRevision;
}
