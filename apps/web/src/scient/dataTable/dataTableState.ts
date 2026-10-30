import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
} from "@t3tools/client-runtime/state/runtime";
import { WS_METHODS } from "@t3tools/contracts";

import { connectionAtomRuntime } from "~/connection/runtime";

/** Pages are cached by the grid that shows them, so the query keeps nothing once read. */
export const dataFileTablePage = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:data:read-file-table",
  tag: WS_METHODS.dataReadFileTable,
  staleTimeMs: 0,
  idleTtlMs: 0,
});

export const computeTablePage = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:compute:read-table",
  tag: WS_METHODS.computeReadTable,
  concurrency: {
    mode: "singleFlight",
    key: ({ environmentId, input }) => JSON.stringify([environmentId, input]),
  },
});
