import type { EnvironmentId, ProjectDirectoryView } from "@t3tools/contracts";
import { FolderXIcon, MoreHorizontal } from "lucide-react";
import { useState, type ReactNode } from "react";

import { FileSurfaceFailure } from "~/components/files/fileSurfaceChrome";
import { Button } from "~/components/ui/button";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuTrigger,
} from "~/components/ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";

import type { LazyWorkspaceTreeSnapshot } from "./LazyWorkspaceTreeController";

export const FILE_SEARCH_LIMIT = 200;
const DIRECTORY_VIEW_BY_WORKSPACE = new Map<string, ProjectDirectoryView>();
const FILE_VISIBILITY_OPTIONS = [
  { value: "ordinary", label: "Project files" },
  { value: "with-internals", label: "All workspace internals" },
] as const satisfies ReadonlyArray<{ value: ProjectDirectoryView; label: string }>;

/**
 * Which workspace files the tree lists. A choice other than the default is
 * remembered per workspace for the rest of the session.
 */
export function useScientDirectoryView(environmentId: EnvironmentId, cwd: string) {
  const workspaceSessionKey = JSON.stringify([environmentId, cwd]);
  const [directoryView, setDirectoryView] = useState<ProjectDirectoryView>(
    () => DIRECTORY_VIEW_BY_WORKSPACE.get(workspaceSessionKey) ?? "ordinary",
  );
  const changeDirectoryView = (nextView: ProjectDirectoryView) => {
    if (nextView === "ordinary") {
      DIRECTORY_VIEW_BY_WORKSPACE.delete(workspaceSessionKey);
    } else {
      DIRECTORY_VIEW_BY_WORKSPACE.set(workspaceSessionKey, nextView);
    }
    setDirectoryView(nextView);
  };
  return { directoryView, changeDirectoryView };
}

export function WorkspaceFilesMenu(props: {
  view: ProjectDirectoryView;
  onViewChange: (view: ProjectDirectoryView) => void;
}) {
  return (
    <Menu>
      <Tooltip>
        <TooltipTrigger
          render={
            <MenuTrigger
              render={
                <Button type="button" variant="ghost" size="icon-xs" aria-label="Files menu" />
              }
            />
          }
        >
          <MoreHorizontal />
        </TooltipTrigger>
        <TooltipPopup>Files menu</TooltipPopup>
      </Tooltip>
      <MenuPopup align="end" sideOffset={6} className="min-w-56">
        <MenuGroup>
          <MenuGroupLabel>File visibility</MenuGroupLabel>
          <MenuRadioGroup
            value={props.view}
            onValueChange={(value) => props.onViewChange(value as ProjectDirectoryView)}
          >
            {FILE_VISIBILITY_OPTIONS.map((option) => (
              <MenuRadioItem key={option.value} value={option.value}>
                {option.label}
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
        </MenuGroup>
      </MenuPopup>
    </Menu>
  );
}

/**
 * The lazily loaded workspace tree's surroundings: load and search status for
 * screen readers, load failures with retry, and the search state around the
 * tree, which is passed in as `children`.
 */
export function ScientFileTreeSurface(props: {
  readonly treeSnapshot: LazyWorkspaceTreeSnapshot;
  readonly onRetryDirectory: (relativeDirectory: string) => void;
  readonly isSearching: boolean;
  readonly isSearchPending: boolean;
  readonly currentSearchError: string | null;
  readonly hasCurrentSearch: boolean;
  readonly searchTruncated: boolean;
  readonly matchingPathCount: number;
  readonly hideTreeForSearch: boolean;
  readonly normalizedSearchValue: string;
  readonly children: ReactNode;
}) {
  const {
    treeSnapshot,
    isSearching,
    isSearchPending,
    currentSearchError,
    hasCurrentSearch,
    hideTreeForSearch,
    normalizedSearchValue,
  } = props;
  const searchEmptyMessage = isSearchPending
    ? "Searching…"
    : currentSearchError
      ? "Couldn’t search unopened folders."
      : `No files or folders match “${normalizedSearchValue}”.`;

  return (
    <>
      <div className="sr-only" aria-live="polite">
        {isSearching
          ? isSearchPending
            ? "Searching workspace files."
            : currentSearchError
              ? "Some workspace files could not be searched."
              : `${props.matchingPathCount} matching workspace paths.`
          : treeSnapshot.isPending
            ? "Loading workspace files."
            : treeSnapshot.failures.length > 0
              ? "Some workspace files could not be loaded."
              : "Workspace files loaded."}
      </div>
      {treeSnapshot.rootError && treeSnapshot.entries.size === 0 ? (
        <FileSurfaceFailure
          icon={FolderXIcon}
          title="Couldn't load project files"
          description="Scient couldn't list the files in this project."
          details={treeSnapshot.rootError}
          retrying={treeSnapshot.isPending}
          onRetry={() => props.onRetryDirectory("")}
        />
      ) : (
        <div
          className="flex min-h-0 flex-1 flex-col"
          aria-busy={treeSnapshot.isPending || isSearchPending}
        >
          {treeSnapshot.failures[0] ? (
            <button
              type="button"
              className="shrink-0 border-b border-warning/20 bg-warning-surface px-3 py-1.5 text-left scient-reading-micro leading-4 text-warning-foreground transition-colors hover:bg-warning/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
              onClick={() =>
                props.onRetryDirectory(treeSnapshot.failures[0]?.relativeDirectory ?? "")
              }
            >
              Couldn’t load {treeSnapshot.failures[0].relativeDirectory || "the workspace"}. Retry
            </button>
          ) : treeSnapshot.entries.size === 0 && treeSnapshot.isPending ? (
            <div className="px-3 py-2 text-xs text-muted-foreground">Loading files…</div>
          ) : null}
          <div className="relative flex min-h-0 flex-1">
            {props.children}
            {hideTreeForSearch ? (
              <div className="absolute inset-x-0 top-0 px-3 py-2 text-xs text-muted-foreground">
                {searchEmptyMessage}
              </div>
            ) : null}
          </div>
          {isSearching ? (
            <div className="shrink-0 border-t border-border/50 px-3 py-1.5 scient-reading-micro leading-4 text-muted-foreground">
              {isSearchPending
                ? "Searching unopened folders…"
                : currentSearchError
                  ? "Couldn’t search unopened folders. Loaded folders are still filtered."
                  : hasCurrentSearch && props.searchTruncated
                    ? `First ${FILE_SEARCH_LIMIT} indexed matches loaded; ignored paths may not appear.`
                    : "Unopened folders use indexed search; ignored paths may not appear."}
            </div>
          ) : null}
        </div>
      )}
    </>
  );
}
