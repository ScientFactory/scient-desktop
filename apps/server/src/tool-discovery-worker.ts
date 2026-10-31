// @effect-diagnostics nodeBuiltinImport:off -- Packaged entry for the Compute tool scan.
import * as NodeWorkerThreads from "node:worker_threads";

import { makeNodeRuntimeDiscoveryHost } from "./scient/compute/RuntimeDiscovery.ts";
import type { ToolScanMessage, ToolScanWorkerData } from "./scient/compute/ToolDiscovery.ts";
import { toolScanSteps } from "./scient/compute/ToolScan.ts";

const port = NodeWorkerThreads.parentPort;
if (port === null) throw new Error("The Compute tool scan requires a parent message port.");

const data = NodeWorkerThreads.workerData as ToolScanWorkerData;
const send = (message: ToolScanMessage) => port.postMessage(message);
const context = {
  platform: data.platform,
  environment: data.environment,
  homeDirectory: data.homeDirectory,
  host: makeNodeRuntimeDiscoveryHost(data.platform, data.environment),
};
for (const step of toolScanSteps(context)) {
  if (data.skip.includes(step.source)) continue;
  send({ kind: "start", source: step.source });
  send({ kind: "found", source: step.source, tools: step.run() });
}
send({ kind: "done" });
