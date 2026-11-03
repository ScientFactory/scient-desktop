import { WS_METHODS, WsWorkspaceRpcGroup } from "@t3tools/contracts";

import type { WorkspaceFileSystem } from "../../workspace/WorkspaceFileSystem.ts";
import type { ScientRpcHandlerSubset, ScientRpcObservers } from "../ScientRpcObservers.ts";
import { changeWorkspaceEntries } from "./WorkspaceEntryChanges.ts";
import { listOpenWithApps, openWith } from "./WorkspaceOpenWith.ts";

/** The Files panel's moves, copies, new folders, Trash and Open With. */
export const makeWorkspaceEntryRpcHandlers = ({
  observeRpcEffect,
  workspaceFileSystem,
}: Pick<ScientRpcObservers, "observeRpcEffect"> & {
  readonly workspaceFileSystem: WorkspaceFileSystem["Service"];
}) =>
  ({
    [WS_METHODS.projectsChangeEntries]: (input) =>
      observeRpcEffect(
        WS_METHODS.projectsChangeEntries,
        changeWorkspaceEntries(workspaceFileSystem.resolveEntryPath, input),
        { "rpc.aggregate": "workspace" },
      ),
    [WS_METHODS.projectsOpenWithApps]: (input) =>
      observeRpcEffect(
        WS_METHODS.projectsOpenWithApps,
        listOpenWithApps(workspaceFileSystem.resolveEntryPath, input),
        { "rpc.aggregate": "workspace" },
      ),
    [WS_METHODS.projectsOpenWith]: (input) =>
      observeRpcEffect(
        WS_METHODS.projectsOpenWith,
        openWith(workspaceFileSystem.resolveEntryPath, input),
        { "rpc.aggregate": "workspace" },
      ),
  }) satisfies ScientRpcHandlerSubset<
    typeof WsWorkspaceRpcGroup,
    | typeof WS_METHODS.projectsChangeEntries
    | typeof WS_METHODS.projectsOpenWithApps
    | typeof WS_METHODS.projectsOpenWith
  >;
