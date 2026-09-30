import { createEnvironmentRpcQueryAtomFamily } from "@t3tools/client-runtime/state/runtime";
import { WS_METHODS } from "@t3tools/contracts";

import { connectionAtomRuntime } from "~/connection/runtime";

export const environmentFilePreparation = createEnvironmentRpcQueryAtomFamily(
  connectionAtomRuntime,
  {
    label: "environment-data:filesystem:prepare-file-open",
    tag: WS_METHODS.filesystemPrepareFileOpen,
    staleTimeMs: 10_000,
    idleTtlMs: 60 * 60_000,
  },
);

/** Asks the environment what a chat link means; never cached, since files move. */
export const environmentFileLinkResolution = createEnvironmentRpcQueryAtomFamily(
  connectionAtomRuntime,
  {
    label: "environment-data:filesystem:resolve-file-link",
    tag: WS_METHODS.filesystemResolveFileLink,
    staleTimeMs: 0,
    idleTtlMs: 0,
  },
);
