import {
  ScientDocumentPdfExportError,
  type DocumentBundle,
  type ScientDocumentPdfPrepared,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { documentLogicalKey, writeDocumentCapture } from "./DocumentCapture.ts";

/**
 * Captures a conversation's document bundle for PDF export. The conversation
 * snapshot was taken and released before the bundle was built, and its content
 * digest identifies it, so publication needs no further source check. Every
 * PDF of one thread is a revision of the same generated document.
 */
export const captureConversationBundle = Effect.fn("ConversationPdfCapture.capture")(function* (
  bundle: DocumentBundle,
) {
  const source = bundle.metadata.source;
  if (source._tag !== "conversation") {
    return yield* new ScientDocumentPdfExportError({
      reason: "invalid-source",
      detail: "Only a conversation document bundle can be exported as a conversation PDF.",
    });
  }
  const { record, inputRelativeUrl } = yield* writeDocumentCapture({
    bundle,
    logicalDocumentKey: documentLogicalKey("conversation-pdf", source.threadId),
    source: { _tag: "conversation" },
  });
  return {
    inputRelativeUrl,
    expected: record.expected,
    title: record.title || "Conversation",
    warnings: record.warnings,
  } satisfies ScientDocumentPdfPrepared;
});
