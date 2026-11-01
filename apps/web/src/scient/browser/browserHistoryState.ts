import { createEnvironmentRpcCommand } from "@t3tools/client-runtime/state/runtime";
import { WS_METHODS } from "@t3tools/contracts";

import { connectionAtomRuntime } from "~/connection/runtime";

export const browserHistoryState = {
  list: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "browser-history:list",
    tag: WS_METHODS.browserHistoryList,
  }),
  remove: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "browser-history:remove",
    tag: WS_METHODS.browserHistoryRemove,
  }),
  clear: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "browser-history:clear",
    tag: WS_METHODS.browserHistoryClear,
  }),
};
