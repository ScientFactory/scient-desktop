// FILE: DockExplorerPane.tsx
// Purpose: Standalone workspace explorer used before a file is selected. Opening
//          a file promotes this surface into the richer file + explorer pane.
// Layer: Chat right-dock UI
// Exports: DockExplorerPane

import { memo } from "react";

import type { ChatFileReference } from "~/lib/chatReferences";
import { WorkspaceExplorerSidebar } from "./workspaceExplorer";
import type { DockWorkspaceExplorerController } from "./useDockWorkspaceExplorer";

const DOCK_EXPLORER_SIDEBAR_CLASS =
  "flex h-full min-h-0 w-full min-w-0 flex-col bg-[var(--color-background-surface)]";

export const DockExplorerPane = memo(function DockExplorerPane(props: {
  workspaceRoot: string | null;
  explorer: DockWorkspaceExplorerController;
  onOpenFile: (path: string) => void;
  onReferenceInChat?: ((reference: ChatFileReference) => void) | undefined;
}) {
  return (
    <WorkspaceExplorerSidebar
      workspaceRoot={props.workspaceRoot}
      selectedFilePath={null}
      expandedDirectories={props.explorer.expandedDirectories}
      query={props.explorer.searchQuery}
      onQueryChange={props.explorer.setSearchQuery}
      containerClassName={DOCK_EXPLORER_SIDEBAR_CLASS}
      onSelectFile={props.onOpenFile}
      onToggleDirectory={props.explorer.toggleDirectory}
      onReferenceInChat={props.onReferenceInChat}
    />
  );
});
