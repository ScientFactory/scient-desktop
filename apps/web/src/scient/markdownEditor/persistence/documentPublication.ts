import type { MarkdownPersistenceLease } from "./markdownPersistenceRegistry";

type DocumentSnapshot = ReturnType<MarkdownPersistenceLease["getSnapshot"]>;

/**
 * Whether the step from one snapshot to the next confirms a save this
 * document made: by its acknowledgement, or by an ordered read that finds it
 * on disk after the acknowledgement was lost. An outside change that is
 * adopted, a failed save and a conflict do not.
 */
export function documentWasSaved(previous: DocumentSnapshot, next: DocumentSnapshot): boolean {
  return (
    previous.publicationSource !== null &&
    next.publicationSource !== previous.publicationSource &&
    next.baselineSource === previous.publicationSource &&
    next.baselineRevision !== previous.baselineRevision
  );
}

/**
 * Calls back each time a save this document made is confirmed (see
 * `documentWasSaved`), with the source and the revision that are now on disk.
 */
export function onDocumentSaved(
  persistence: Pick<MarkdownPersistenceLease, "getSnapshot" | "subscribe">,
  listener: (saved: { readonly source: string; readonly revision: string }) => void,
): () => void {
  let previous = persistence.getSnapshot();
  return persistence.subscribe(() => {
    const next = persistence.getSnapshot();
    const confirmed = documentWasSaved(previous, next);
    previous = next;
    if (confirmed) listener({ source: next.baselineSource, revision: next.baselineRevision });
  });
}
