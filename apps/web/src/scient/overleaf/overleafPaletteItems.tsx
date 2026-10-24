// SCIENT-OWNED: "Sync with Overleaf" in the command palette, one entry per
// linked folder of the current thread's project.
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";

import { ITEM_ICON_CLASS, type CommandPaletteActionItem } from "~/components/CommandPalette.logic";
import { OverleafMark } from "~/scient/files/ExternalFolderMarks";

import { runOverleafSync } from "./overleafActions";
import { openOverleafReview } from "./openOverleafReview";
import { useOverleafWorkspace } from "./overleafStore";

export function useOverleafPaletteItems(input: {
  readonly thread: {
    readonly environmentId: EnvironmentId;
    readonly id: ThreadId;
    readonly projectId: ProjectId;
    readonly worktreePath: string | null;
  } | null;
  readonly projects: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly id: ProjectId;
    readonly workspaceRoot: string;
  }>;
}): ReadonlyArray<CommandPaletteActionItem> {
  const thread = input.thread;
  const project = thread
    ? input.projects.find(
        (entry) => entry.environmentId === thread.environmentId && entry.id === thread.projectId,
      )
    : undefined;
  const workspaceRoot = thread?.worktreePath ?? project?.workspaceRoot ?? null;
  const workspace = useOverleafWorkspace(thread?.environmentId ?? null, workspaceRoot);
  if (!thread || workspaceRoot === null) return [];
  const threadRef = scopeThreadRef(thread.environmentId, thread.id);
  const several = workspace.connections.length > 1;
  return workspace.connections.map((connection) => ({
    kind: "action",
    value: `action:overleaf-sync:${connection.connectionId}`,
    searchTerms: ["overleaf", "sync", "latex", "paper", connection.folder],
    title: "Sync with Overleaf",
    ...(several || connection.folder !== ""
      ? { description: connection.folder === "" ? "This project" : connection.folder }
      : {}),
    icon: <OverleafMark aria-hidden className={ITEM_ICON_CLASS} />,
    disabled: workspace.syncing.has(connection.connectionId),
    // The palette closes at once; the sync reports with its own message.
    run: async () => {
      void runOverleafSync({
        environmentId: thread.environmentId,
        workspaceRoot,
        connection,
        openReview: () =>
          openOverleafReview(threadRef, {
            cwd: workspaceRoot,
            connectionId: connection.connectionId,
            folder: connection.folder,
          }),
      });
    },
  }));
}
