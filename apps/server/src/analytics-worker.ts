// @effect-diagnostics nodeBuiltinImport:off -- Packaged entry for the Scient analytics worker.
import * as NodeWorkerThreads from "node:worker_threads";

import { startAnalyticsWorker } from "@scientfactory/analytics/worker";
import type { AnalyticsWorkerInput } from "@scientfactory/analytics";

import { prepareOutboundNetworking } from "./outboundHttp.ts";

if (NodeWorkerThreads.parentPort === null) {
  throw new Error("The Scient analytics worker requires a parent message port.");
}

try {
  prepareOutboundNetworking();
} catch {
  // Delivery still works on Node's defaults; analytics must never fail to start over this.
}

const data = NodeWorkerThreads.workerData as AnalyticsWorkerInput;

startAnalyticsWorker({
  port: NodeWorkerThreads.parentPort,
  ...data,
});
