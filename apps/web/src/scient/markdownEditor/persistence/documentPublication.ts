import type { MarkdownPersistenceLease } from "./markdownPersistenceRegistry";

/**
 * Calls back each time a save this document made is confirmed, with the
 * source and the revision that are now on disk. A save is confirmed by its
 * acknowledgement, or by an ordered read that finds it on disk after the
 * acknowledgement was lost. An outside change that is adopted, a failed save
 * and a conflict do not call back.
 */
export function onDocumentSaved(
  persistence: Pick<MarkdownPersistenceLease, "getSnapshot" | "subscribe">,
  listener: (saved: { readonly source: string; readonly revision: string }) => void,
): () => void {
  let previous = persistence.getSnapshot();
  return persistence.subscribe(() => {
    const next = persistence.getSnapshot();
    const confirmed =
      previous.publicationSource !== null &&
      next.publicationSource !== previous.publicationSource &&
      next.baselineSource === previous.publicationSource &&
      next.baselineRevision !== previous.baselineRevision;
    previous = next;
    if (confirmed) listener({ source: next.baselineSource, revision: next.baselineRevision });
  });
}
