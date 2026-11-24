import { composerCitationsToPlainText } from "@t3tools/shared/composerCitations";
import { replaceComposerContextReferences } from "@t3tools/shared/composerContextReferences";
import { composerFileLinksToPlainText } from "@t3tools/shared/composerInlineTokens";

/**
 * A queued row's readable text. Scient file and PDF quotes decode to their
 * quoted text and comment; inline references, images too, keep their labels in place,
 * and `@`-file links show by file name.
 */
export const queuePreviewText = (text: string): string =>
  composerCitationsToPlainText(
    composerFileLinksToPlainText(
      replaceComposerContextReferences(text, (reference) => reference.label),
    ),
  ).trim();
