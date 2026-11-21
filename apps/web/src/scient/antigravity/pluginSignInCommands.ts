import { createEnvironmentRpcCommand } from "@t3tools/client-runtime/state/runtime";
import { WS_METHODS } from "@t3tools/contracts";

import { connectionAtomRuntime } from "../../connection/runtime.ts";

/** Outside the thread's queue: opening a sign-in must not wait on the agent's turn. */
export const pluginSignInOpenCommand = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "web:plugin-sign-in:open",
  tag: WS_METHODS.pluginSignInOpen,
});
