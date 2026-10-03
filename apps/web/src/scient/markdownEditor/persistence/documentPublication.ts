import type { MarkdownPersistenceLease } from "./markdownPersistenceRegistry";

type DocumentSnapshot = ReturnType<MarkdownPersistenceLease["getSnapshot"]>;

/**
 * Whether the step from one snapshot to the next is the acknowledgement of a
 * save this document made. An outside change that is adopted, a failed save
 * and a conflict are not.
 */
export function documentWasSaved(previous: DocumentSnapshot, next: DocumentSnapshot): boolean {
  return (
    previous.inFlight &&
    !next.inFlight &&
    previous.publicationSource !== null &&
    next.baselineSource === previous.publicationSource &&
    next.baselineRevision !== previous.baselineRevision
  );
}

/**
 * Calls back each time a save this document made is acknowledged, with the
 * source and the revision that are now on disk.
 */
export function onDocumentSaved(
  persistence: Pick<MarkdownPersistenceLease, "getSnapshot" | "subscribe">,
  listener: (saved: { readonly source: string; readonly revision: string }) => void,
): () => void {
  let previous = persistence.getSnapshot();
  return persistence.subscribe(() => {
    const next = persistence.getSnapshot();
    const acknowledged = documentWasSaved(previous, next);
    previous = next;
    if (acknowledged) listener({ source: next.baselineSource, revision: next.baselineRevision });
  });
}
