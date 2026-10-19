import { createEnvironmentRpcCommand } from "@t3tools/client-runtime/state/runtime";
import { WS_METHODS } from "@t3tools/contracts";

import { connectionAtomRuntime } from "../../connection/runtime";

/** Asks the server for the one opening of a sign-in operation's page. */
export const claimProviderSignInPage = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-command:providers:claim-sign-in-page",
  tag: WS_METHODS.serverClaimProviderSignInPage,
});
