import {
  ScientDocumentPdfExportError,
  type ScientConversationExportRequest,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { ConversationExportService } from "../conversationExport/ConversationExportService.ts";
import { captureConversationBundle } from "./ConversationPdfCapture.ts";

/**
 * The conversation half of PDF export: the export dialog's options (work log,
 * reasoning, range, time zone) select a snapshot, the conversation package
 * turns it into a document bundle, and the bundle is captured for the
 * document page. The client then prints the capture on its desktop and
 * publishes it with `documents.publishDocumentPdf`.
 */
export const prepareConversationPdf = Effect.fn("ConversationPdfPreparation.prepare")(function* (
  request: ScientConversationExportRequest,
) {
  if (request.format !== "pdf") {
    return yield* new ScientDocumentPdfExportError({
      reason: "invalid-source",
      detail: "Only a PDF export request can prepare a conversation PDF.",
    });
  }
  const exports = yield* ConversationExportService;
  const { bundle } = yield* exports.document(request).pipe(
    Effect.catchTags({
      ConversationSnapshotReadError: () =>
        Effect.fail(
          new ScientDocumentPdfExportError({
            reason: "failed",
            detail: "Scient could not read the conversation for export.",
          }),
        ),
      ConversationExportFileError: () =>
        Effect.fail(
          new ScientDocumentPdfExportError({
            reason: "storage",
            detail: "Scient could not prepare the conversation for export.",
          }),
        ),
    }),
  );
  return yield* captureConversationBundle(bundle);
});
