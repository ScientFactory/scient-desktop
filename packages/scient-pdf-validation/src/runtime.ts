// @effect-diagnostics nodeBuiltinImport:off globalTimers:off -- Owns the bounded Node worker lifecycle.
import * as NodeWorkerThreads from "node:worker_threads";

import {
  PDF_VALIDATION_MAX_BYTES,
  PDF_VALIDATION_TIMEOUT_MS,
  type PdfValidationProfile,
  type PdfValidationResult,
  rejectedPdf,
} from "./contract.ts";
import type { PdfValidationWorkerInput, PdfValidationWorkerOutput } from "./workerProtocol.ts";

export interface PdfValidationRuntime {
  readonly validate: (
    bytes: Uint8Array,
    profile: PdfValidationProfile,
  ) => Promise<PdfValidationResult>;
  readonly close: () => Promise<void>;
}

export function createPdfValidationRuntime(input: {
  readonly workerUrl: URL;
  readonly timeoutMs?: number;
}): PdfValidationRuntime {
  let queue = Promise.resolve();
  let closed = false;
  let activeWorker: NodeWorkerThreads.Worker | null = null;

  const run = (bytes: Uint8Array, profile: PdfValidationProfile) =>
    new Promise<PdfValidationResult>((resolve) => {
      if (closed) {
        resolve(rejectedPdf(profile, "worker-failed", "The PDF validator is closed."));
        return;
      }
      if (bytes.byteLength === 0) {
        resolve(rejectedPdf(profile, "empty", "The PDF output is empty."));
        return;
      }
      if (bytes.byteLength > PDF_VALIDATION_MAX_BYTES) {
        resolve(
          rejectedPdf(
            profile,
            "too-large",
            `The PDF exceeds the ${PDF_VALIDATION_MAX_BYTES} byte validation limit.`,
          ),
        );
        return;
      }
      const transferable = new ArrayBuffer(bytes.byteLength);
      const workerBytes = new Uint8Array(transferable);
      workerBytes.set(bytes);
      const workerInput: PdfValidationWorkerInput = { bytes: workerBytes, profile };
      let worker: NodeWorkerThreads.Worker;
      try {
        worker = new NodeWorkerThreads.Worker(input.workerUrl, {
          workerData: workerInput,
          transferList: [transferable],
        });
      } catch {
        resolve(rejectedPdf(profile, "worker-failed", "The PDF validation worker failed."));
        return;
      }
      activeWorker = worker;
      let settled = false;
      const finish = (result: PdfValidationResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (activeWorker === worker) activeWorker = null;
        resolve(result);
        void worker.terminate();
      };
      const timeout = setTimeout(
        () =>
          finish(
            rejectedPdf(
              profile,
              "timed-out",
              `PDF validation exceeded ${input.timeoutMs ?? PDF_VALIDATION_TIMEOUT_MS} ms.`,
            ),
          ),
        input.timeoutMs ?? PDF_VALIDATION_TIMEOUT_MS,
      );
      timeout.unref();
      worker.once("message", (message: PdfValidationWorkerOutput) => {
        finish(
          message._tag === "Success"
            ? message.result
            : rejectedPdf(profile, "worker-failed", "The PDF validation worker failed."),
        );
      });
      worker.once("error", () =>
        finish(rejectedPdf(profile, "worker-failed", "The PDF validation worker failed.")),
      );
      worker.once("exit", (code) => {
        if (code !== 0) {
          finish(rejectedPdf(profile, "worker-failed", "The PDF validation worker stopped."));
        }
      });
    });

  return {
    validate: (bytes, profile) => {
      const result = queue.then(() => run(bytes, profile));
      queue = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    },
    close: async () => {
      closed = true;
      await activeWorker?.terminate();
      activeWorker = null;
      await queue;
    },
  };
}
