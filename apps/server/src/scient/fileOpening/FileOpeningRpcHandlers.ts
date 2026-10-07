/**
 * Scient's file opening RPCs: preparing any environment file for the
 * viewer, resolving a file link, and watching an opened file for changes.
 *
 * @module FileOpeningRpcHandlers
 */
import { WS_METHODS, WsWorkspaceRpcGroup } from "@t3tools/contracts";

import type { ScientRpcHandlerSubset, ScientRpcObservers } from "../ScientRpcObservers.ts";
import { resolveEnvironmentFileLink } from "./EnvironmentFileLinkResolve.ts";
import { prepareEnvironmentFileOpen, watchEnvironmentFile } from "./EnvironmentFileOpen.ts";

export const makeFileOpeningRpcHandlers = ({
  observeRpcEffect,
  observeRpcStream,
}: Pick<ScientRpcObservers, "observeRpcEffect" | "observeRpcStream">) =>
  ({
    [WS_METHODS.filesystemPrepareFileOpen]: (input) =>
      observeRpcEffect(WS_METHODS.filesystemPrepareFileOpen, prepareEnvironmentFileOpen(input), {
        "rpc.aggregate": "workspace",
      }),
    [WS_METHODS.filesystemResolveFileLink]: (input) =>
      observeRpcEffect(WS_METHODS.filesystemResolveFileLink, resolveEnvironmentFileLink(input), {
        "rpc.aggregate": "workspace",
      }),
    [WS_METHODS.filesystemSubscribeFileChanges]: (input) =>
      observeRpcStream(WS_METHODS.filesystemSubscribeFileChanges, watchEnvironmentFile(input), {
        "rpc.aggregate": "workspace",
      }),
  }) satisfies ScientRpcHandlerSubset<
    typeof WsWorkspaceRpcGroup,
    | typeof WS_METHODS.filesystemPrepareFileOpen
    | typeof WS_METHODS.filesystemResolveFileLink
    | typeof WS_METHODS.filesystemSubscribeFileChanges
  >;
