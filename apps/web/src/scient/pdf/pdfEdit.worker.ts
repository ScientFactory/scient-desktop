/* oxlint-disable unicorn/require-post-message-target-origin -- Dedicated workers do not accept Window target origins. */
import type { PdfEditWorkerRequest, PdfEditWorkerResponse } from "./pdfPageEdits";
import { createPdfEditor } from "./pdfEditor";

const execute = createPdfEditor();
self.addEventListener("message", (event: MessageEvent<PdfEditWorkerRequest>) => {
  void execute(event.data).then(
    (result) => self.postMessage(result),
    (error: unknown) =>
      self.postMessage({
        id: event.data.id,
        kind: "error",
        message: error instanceof Error ? error.message : "The PDF operation failed.",
      } satisfies PdfEditWorkerResponse),
  );
});
