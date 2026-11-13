import {
  PDF_TEXT_PROFILE,
  PdfTarget,
  type PdfSourceDescriptor,
} from "@scientfactory/document-artifacts";
import type { ScientSourcesFullTextSearchResult } from "@t3tools/contracts";
import { useEffect, useSyncExternalStore } from "react";

import { pdfDocumentIdentity, pdfDocumentMaterial } from "../pdf/anchors/pdfTextTarget";
import { pdfRevealDocumentKey, requestPdfReveal } from "../pdf/anchors/pdfRevealRequests";

type FullTextHit = ScientSourcesFullTextSearchResult["hits"][number];

interface SourcePdfKey {
  readonly root: string;
  readonly sourceId: string;
  readonly attachmentId: string;
}

const keyOf = (key: SourcePdfKey) => `${key.root}\0${key.sourceId}\0${key.attachmentId}`;
const pending = new Map<string, FullTextHit>();
const listeners = new Set<() => void>();

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Asks the Sources PDF reader to show a search hit once it knows the PDF it
 * shows: the reader's document identity comes from its authorized preview.
 */
export function requestSourceTextReveal(root: string, hit: FullTextHit): void {
  pending.set(keyOf({ root, sourceId: hit.sourceId, attachmentId: hit.attachmentId }), hit);
  for (const listener of listeners) listener();
}

/** The search hit as a reader quote target; null when the stored page cannot form one. */
export function sourceTextRevealTarget(
  source: PdfSourceDescriptor,
  hit: FullTextHit,
): PdfTarget | null {
  const document = pdfDocumentIdentity(source);
  if (!document) return null;
  const { selector } = hit;
  try {
    return PdfTarget.make({
      version: 1,
      document,
      material: pdfDocumentMaterial(source),
      extractor: { profile: PDF_TEXT_PROFILE, version: selector.extractorVersion },
      selector: {
        type: "text",
        pages: [
          {
            page: hit.page,
            viewBox: selector.viewBox,
            rotation: selector.rotation,
            userUnit: selector.userUnit,
            pageTextHash: selector.pageTextHash,
            start: hit.start,
            end: hit.end,
            quote: selector.quote,
            prefix: selector.prefix,
            suffix: selector.suffix,
          },
        ],
      },
    });
  } catch {
    return null;
  }
}

/** Files a pending search-hit reveal for the PDF this reader shows. */
export function useSourceTextReveal(source: PdfSourceDescriptor | null, key: SourcePdfKey): void {
  const id = keyOf(key);
  const hit = useSyncExternalStore(subscribe, () => pending.get(id) ?? null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- hands a pending search hit to the PDF reveal registry once the reader's document is known
  useEffect(() => {
    if (!source || !hit || pending.get(id) !== hit) return;
    pending.delete(id);
    const target = sourceTextRevealTarget(source, hit);
    if (target) requestPdfReveal(pdfRevealDocumentKey(target.document), target);
  }, [id, hit, source]);
}
