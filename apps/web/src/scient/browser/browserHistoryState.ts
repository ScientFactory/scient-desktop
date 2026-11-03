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
  suggestPages: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "browser-history:suggest",
    tag: WS_METHODS.browserHistorySuggest,
  }),
  suggestSearches: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "browser-search:suggest",
    tag: WS_METHODS.browserSearchSuggest,
  }),
};
