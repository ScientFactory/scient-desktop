import { createEnvironmentRpcSubscriptionAtomFamily } from "@t3tools/client-runtime/state/runtime";
import { WS_METHODS } from "@t3tools/contracts";

import { connectionAtomRuntime } from "~/connection/runtime";

/**
 * One shared exact-host-file subscription per environment and normalized path
 * (canonical once inspection succeeds). File previews and derived-document
 * lifecycles consume the same atom family, so mounting both surfaces does not
 * create parallel native watchers.
 */
export const environmentFileChanges = createEnvironmentRpcSubscriptionAtomFamily(
  connectionAtomRuntime,
  {
    label: "environment-data:filesystem:exact-file-changes",
    tag: WS_METHODS.filesystemSubscribeFileChanges,
    idleTtlMs: 0,
  },
);
