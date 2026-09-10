// @effect-diagnostics nodeBuiltinImport:off -- Packaged entry for the Scient analytics worker.
import * as NodeWorkerThreads from "node:worker_threads";

import { startAnalyticsWorker } from "@scientfactory/analytics/worker";
import type { AnalyticsWorkerInput } from "@scientfactory/analytics";

if (NodeWorkerThreads.parentPort === null) {
  throw new Error("The Scient analytics worker requires a parent message port.");
}

const data = NodeWorkerThreads.workerData as AnalyticsWorkerInput;

startAnalyticsWorker({
  port: NodeWorkerThreads.parentPort,
  ...data,
});
