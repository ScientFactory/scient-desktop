import { composerCitationsToPlainText } from "@t3tools/shared/composerCitations";
import { replaceComposerContextReferences } from "@t3tools/shared/composerContextReferences";

/**
 * A queued row's readable text. Scient file and PDF quotes decode to their
 * quoted text and comment; inline references, images too, keep their labels in place.
 */
export const queuePreviewText = (text: string): string =>
  composerCitationsToPlainText(
    replaceComposerContextReferences(text, (reference) => reference.label),
  ).trim();
