import { createEnvironmentRpcSubscriptionAtomFamily } from "@t3tools/client-runtime/state/runtime";
import { WS_METHODS } from "@t3tools/contracts";

import { connectionAtomRuntime } from "../connection/runtime";

/** Live MCP server health of one thread; never part of its history. */
export const threadMcpStatus = createEnvironmentRpcSubscriptionAtomFamily(connectionAtomRuntime, {
  label: "thread:mcp-status",
  tag: WS_METHODS.threadMcpStatusSubscribe,
});
