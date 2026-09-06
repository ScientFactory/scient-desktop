// @effect-diagnostics nodeBuiltinImport:off -- Dedicated Scient analytics worker entry.
import * as NodeWorkerThreads from "node:worker_threads";

import { startAnalyticsWorker } from "./workerRuntime.ts";
import type { AnalyticsWorkerInput } from "./workerProtocol.ts";

if (NodeWorkerThreads.parentPort === null) {
  throw new Error("The Scient analytics worker requires a parent message port.");
}

const data = NodeWorkerThreads.workerData as AnalyticsWorkerInput;

startAnalyticsWorker({
  port: NodeWorkerThreads.parentPort,
  ...data,
});
