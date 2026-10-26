import { composerCitationsToPlainText } from "@t3tools/shared/composerCitations";
import { replaceComposerContextReferences } from "@t3tools/shared/composerContextReferences";

/**
 * A queued row's readable text. Scient file and PDF quotes decode to their
 * quoted text and comment; an image reference with a thumbnail shows nothing.
 */
export const queuePreviewText = (text: string, hasThumbnails: boolean): string =>
  composerCitationsToPlainText(
    replaceComposerContextReferences(text, (reference) =>
      reference.kind === "image" && hasThumbnails ? "" : reference.label,
    ),
  ).trim();
