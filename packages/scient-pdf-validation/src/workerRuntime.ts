// @effect-diagnostics nodeBuiltinImport:off -- Dedicated PDF validation worker boundary.
import type * as NodeWorkerThreads from "node:worker_threads";

import { validatePdfBytes } from "./validate.ts";
import type { PdfValidationWorkerInput, PdfValidationWorkerOutput } from "./workerProtocol.ts";

export function startPdfValidationWorker(input: {
  readonly port: NodeWorkerThreads.MessagePort;
  readonly request: PdfValidationWorkerInput;
}): void {
  void validatePdfBytes(input.request.bytes, input.request.profile)
    .then((result) => {
      const output: PdfValidationWorkerOutput = { _tag: "Success", result };
      // oxlint-disable-next-line unicorn/require-post-message-target-origin -- Node MessagePort postMessage has no targetOrigin parameter.
      input.port.postMessage(output);
    })
    .catch(() => {
      const output: PdfValidationWorkerOutput = { _tag: "Failure" };
      // oxlint-disable-next-line unicorn/require-post-message-target-origin -- Node MessagePort postMessage has no targetOrigin parameter.
      input.port.postMessage(output);
    })
    .finally(() => input.port.close());
}
