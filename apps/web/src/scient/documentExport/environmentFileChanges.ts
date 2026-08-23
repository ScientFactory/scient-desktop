import { createEnvironmentRpcSubscriptionAtomFamily } from "@t3tools/client-runtime/state/runtime";
import { WS_METHODS } from "@t3tools/contracts";

import { connectionAtomRuntime } from "~/connection/runtime";

export const environmentFileChanges = createEnvironmentRpcSubscriptionAtomFamily(
  connectionAtomRuntime,
  {
    label: "environment-data:filesystem:exact-file-changes",
    tag: WS_METHODS.filesystemSubscribeFileChanges,
    idleTtlMs: 0,
  },
);
