import type { MarkdownPersistenceLease } from "./markdownPersistenceRegistry";

/**
 * Calls back each time a save this document made is acknowledged, with the
 * source and the revision that are now on disk. An outside change that is
 * adopted, a failed save and a conflict do not call back.
 */
export function onDocumentSaved(
  persistence: Pick<MarkdownPersistenceLease, "getSnapshot" | "subscribe">,
  listener: (saved: { readonly source: string; readonly revision: string }) => void,
): () => void {
  let previous = persistence.getSnapshot();
  return persistence.subscribe(() => {
    const next = persistence.getSnapshot();
    const acknowledged =
      previous.inFlight &&
      !next.inFlight &&
      previous.publicationSource !== null &&
      next.baselineSource === previous.publicationSource &&
      next.baselineRevision !== previous.baselineRevision;
    previous = next;
    if (acknowledged) listener({ source: next.baselineSource, revision: next.baselineRevision });
  });
}
