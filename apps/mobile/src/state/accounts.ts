import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "@t3tools/client-runtime/state/runtime";
import { type EnvironmentId, WS_METHODS } from "@t3tools/contracts";

import { connectionAtomRuntime } from "../connection/runtime";

const changes = createEnvironmentRpcSubscriptionAtomFamily(connectionAtomRuntime, {
  label: "accounts:changes",
  tag: WS_METHODS.accountsSubscribeChanges,
});

/** Sign-ins waiting for the user, so the phone can answer what the desktop is waiting on. */
export const accountsEnvironment = {
  snapshot: createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
    label: "accounts:snapshot",
    tag: WS_METHODS.accountsSnapshot,
    staleTimeMs: 30_000,
    idleTtlMs: 60_000,
    refreshTrigger: ({ environmentId }: { readonly environmentId: EnvironmentId }) =>
      changes({ environmentId, input: {} }),
  }),
  respondApproval: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "accounts:respondApproval",
    tag: WS_METHODS.accountsApprovalRespond,
  }),
  cancelHandoff: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "accounts:cancelHandoff",
    tag: WS_METHODS.accountsHandoffCancel,
  }),
};
