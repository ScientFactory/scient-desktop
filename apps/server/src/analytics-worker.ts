// @effect-diagnostics nodeBuiltinImport:off -- Packaged entry for the Scient analytics worker.
import { parentPort, workerData } from "node:worker_threads";

import { startAnalyticsWorker } from "@scientfactory/analytics/worker";

if (parentPort === null) {
  throw new Error("The Scient analytics worker requires a parent message port.");
}

const data = workerData as {
  readonly outboxPath: string;
  readonly endpoint: string;
};

startAnalyticsWorker({
  port: parentPort,
  outboxPath: data.outboxPath,
  endpoint: data.endpoint,
});
