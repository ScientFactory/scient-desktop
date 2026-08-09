// @effect-diagnostics nodeBuiltinImport:off -- Dedicated Scient analytics worker entry.
import * as NodeWorkerThreads from "node:worker_threads";

import { startAnalyticsWorker } from "./workerRuntime.ts";

if (NodeWorkerThreads.parentPort === null) {
  throw new Error("The Scient analytics worker requires a parent message port.");
}

const data = NodeWorkerThreads.workerData as {
  readonly outboxPath: string;
  readonly endpoint: string;
};

startAnalyticsWorker({
  port: NodeWorkerThreads.parentPort,
  outboxPath: data.outboxPath,
  endpoint: data.endpoint,
});
