/** A Library source that has this PDF attached, as the server lists it for a document. */
export interface QuoteCitationSource {
  readonly sourceId: string;
  readonly title: string | null;
  readonly citationKey?: string;
}

/** A source "Quote in my document" can cite, offered when several share the PDF. */
export interface QuoteCitationChoice {
  readonly sourceId: string;
  readonly citationKey: string;
  readonly title: string | null;
}

/** Whom a quote from a PDF cites. */
export type QuoteCitation =
  | { readonly kind: "cite"; readonly citationKey: string }
  /** Several sources with keys share the PDF and none was named: the writer picks one. */
  | { readonly kind: "choose"; readonly choices: ReadonlyArray<QuoteCitationChoice> }
  /** No key to cite: the quote names the file and page. */
  | { readonly kind: "none" };

export const NO_QUOTE_CITATION: QuoteCitation = { kind: "none" };

/**
 * Resolves the citation for a quote from a PDF that `sources` have attached.
 * Opened from a source, the quote cites exactly that source, or nothing when it
 * has no key, never another source sharing the file. Opened elsewhere, one keyed
 * source is cited, and several are left for the writer to choose between.
 */
export function resolveQuoteCitation(
  sources: ReadonlyArray<QuoteCitationSource>,
  originSourceId: string | null,
): QuoteCitation {
  if (originSourceId !== null) {
    const citationKey = sources.find((entry) => entry.sourceId === originSourceId)?.citationKey;
    return citationKey ? { kind: "cite", citationKey } : NO_QUOTE_CITATION;
  }
  const choices: QuoteCitationChoice[] = [];
  for (const entry of sources) {
    if (entry.citationKey) {
      choices.push({
        sourceId: entry.sourceId,
        citationKey: entry.citationKey,
        title: entry.title,
      });
    }
  }
  const only = choices.length === 1 ? choices[0] : undefined;
  if (only) return { kind: "cite", citationKey: only.citationKey };
  return choices.length === 0 ? NO_QUOTE_CITATION : { kind: "choose", choices };
}
