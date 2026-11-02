import { WS_METHODS, WsWorkspaceRpcGroup } from "@t3tools/contracts";

import type { WorkspaceFileSystem } from "../../workspace/WorkspaceFileSystem.ts";
import type { ScientRpcHandlerSubset, ScientRpcObservers } from "../ScientRpcObservers.ts";
import { changeWorkspaceEntries } from "./WorkspaceEntryChanges.ts";

/** The Files panel's moves, copies, new folders and Trash. */
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
  }) satisfies ScientRpcHandlerSubset<
    typeof WsWorkspaceRpcGroup,
    typeof WS_METHODS.projectsChangeEntries
  >;
