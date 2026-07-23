// FILE: DockFilePane.tsx
// Purpose: Right-dock file surface with the shared preview and a persistent,
//          collapsible workspace explorer beside it.
// Layer: Chat right-dock UI
// Exports: DockFilePane

import { isWorkspaceRelativePathSafe } from "@synara/shared/path";
import { memo } from "react";

import type { ChatFileReference } from "~/lib/chatReferences";
import type { FileCommentSelection } from "~/lib/fileComments";
import { disclosureWidthClassName } from "~/lib/disclosureMotion";
import { cn } from "~/lib/utils";
import { WorkspaceFilePreview } from "../WorkspaceFilePreview";
import { PanelStateMessage } from "./PanelStateMessage";
import { WorkspaceExplorerSidebar } from "./workspaceExplorer";
import type { DockWorkspaceExplorerController } from "./useDockWorkspaceExplorer";

const DOCK_FILE_EXPLORER_WIDTH_CLASS = "w-[min(22rem,46%)]";
const DOCK_FILE_EXPLORER_CONTENT_CLASS =
  "flex h-full min-h-0 w-full min-w-64 flex-col bg-[var(--color-background-surface)]";

export const DockFilePane = memo(function DockFilePane(props: {
  workspaceRoot: string | null;
  filePath: string | null;
  explorerOpen: boolean;
  explorer: DockWorkspaceExplorerController;
  onOpenFile: (path: string) => void;
  onReferenceInChat?: ((reference: ChatFileReference) => void) | undefined;
  onAskWhyInChat?: ((reference: ChatFileReference) => void) | undefined;
  onCommentInChat?: ((comment: FileCommentSelection) => void) | undefined;
}) {
  const hasFile = props.filePath !== null;
  const selectedWorkspaceFilePath =
    props.filePath !== null && isWorkspaceRelativePathSafe(props.filePath) ? props.filePath : null;

  return (
    <div className="flex h-full min-h-0 w-full overflow-hidden">
      <div className={cn("min-h-0 min-w-0 flex-1", hasFile ? "flex" : "hidden")}>
        <WorkspaceFilePreview
          workspaceRoot={props.workspaceRoot}
          filePath={props.filePath}
          markdownPreviewDefault
          emptyState={
            <PanelStateMessage density="compact" fill="flex">
              <p>Select a file from the explorer to preview it here.</p>
            </PanelStateMessage>
          }
          onReferenceInChat={props.onReferenceInChat}
          onAskWhyInChat={props.onAskWhyInChat}
          onCommentInChat={props.onCommentInChat}
        />
      </div>
      <div
        data-dock-file-explorer-region
        className={cn(
          "flex min-h-0 shrink-0 bg-[var(--color-background-surface)]",
          hasFile
            ? disclosureWidthClassName(props.explorerOpen, DOCK_FILE_EXPLORER_WIDTH_CLASS)
            : "min-w-0 flex-1",
          hasFile && props.explorerOpen && "min-w-64 border-l border-border/60",
        )}
        aria-hidden={hasFile && !props.explorerOpen ? true : undefined}
        inert={hasFile && !props.explorerOpen ? true : undefined}
      >
        <WorkspaceExplorerSidebar
          workspaceRoot={props.workspaceRoot}
          selectedFilePath={selectedWorkspaceFilePath}
          expandedDirectories={props.explorer.expandedDirectories}
          query={props.explorer.searchQuery}
          onQueryChange={props.explorer.setSearchQuery}
          containerClassName={DOCK_FILE_EXPLORER_CONTENT_CLASS}
          onSelectFile={props.onOpenFile}
          onToggleDirectory={props.explorer.toggleDirectory}
          onReferenceInChat={props.onReferenceInChat}
        />
      </div>
    </div>
  );
});
