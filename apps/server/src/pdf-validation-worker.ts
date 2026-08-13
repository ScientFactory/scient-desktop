// @effect-diagnostics nodeBuiltinImport:off -- Packaged entry for the Scient PDF validation worker.
import * as NodeWorkerThreads from "node:worker_threads";

import { startPdfValidationWorker } from "@scientfactory/pdf-validation/worker";

if (NodeWorkerThreads.parentPort === null) {
  throw new Error("The Scient PDF validation worker requires a parent message port.");
}

startPdfValidationWorker({
  port: NodeWorkerThreads.parentPort,
  request: NodeWorkerThreads.workerData,
});
