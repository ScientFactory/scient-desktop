import { createEnvironmentRpcSubscriptionAtomFamily } from "@t3tools/client-runtime/state/runtime";
import { WS_METHODS } from "@t3tools/contracts";

import { connectionAtomRuntime } from "~/connection/runtime";

/**
 * Scient-owned mount of the producer-neutral document-binding stream. Keeping
 * the atom beside its only current consumer avoids another edit to inherited
 * project state while leaving the wire contract reusable by future producers.
 */
export const documentBindingChanges = createEnvironmentRpcSubscriptionAtomFamily(
  connectionAtomRuntime,
  {
    label: "environment-data:documents:binding-changes",
    tag: WS_METHODS.subscribeDocumentBindingChanges,
    idleTtlMs: 0,
  },
);
