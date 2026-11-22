import type { EnvironmentId, ProjectDirectoryView } from "@t3tools/contracts";
import {
  ChevronsDownUpIcon,
  ChevronsUpDownIcon,
  FolderXIcon,
  MoreHorizontal,
  RefreshCwIcon,
  SearchIcon,
} from "lucide-react";
import { msg, T, useGT, useMessages } from "gt-react";
import { type ReactNode, type Ref, useState } from "react";

import { FileSurfaceFailure } from "~/components/files/fileSurfaceChrome";
import { Button } from "~/components/ui/button";
import { InputGroup, InputGroupAddon, InputGroupInput } from "~/components/ui/input-group";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
} from "~/components/ui/menu";
import { Popover, PopoverPopup, PopoverTrigger } from "~/components/ui/popover";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";

import { PanelTabNewWindowItem } from "../multiWindow/PanelTabNewWindowItem";

import type { LazyWorkspaceTreeSnapshot } from "./LazyWorkspaceTreeController";

export const FILE_SEARCH_LIMIT = 200;
const DIRECTORY_VIEW_BY_WORKSPACE = new Map<string, ProjectDirectoryView>();
const FILE_VISIBILITY_OPTIONS = [
  { value: "ordinary", label: msg("Project files") },
  { value: "with-internals", label: msg("All workspace internals") },
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
  /** Reloads the listed files; the tree does not watch the disk. */
  refresh?: { readonly pending: boolean; readonly onRefresh: () => void } | undefined;
  /** Opens or closes every loaded folder; absent where that would walk too much. */
  folders?: { readonly allExpanded: boolean; readonly onToggle: () => void } | undefined;
}) {
  const gt = useGT();
  const messages = useMessages();
  return (
    <Menu>
      <Tooltip>
        <TooltipTrigger
          render={
            <MenuTrigger
              render={
                <Button
                  type="button"
                  variant="ghost-muted"
                  size="icon-xs"
                  aria-label={gt("Files menu")}
                />
              }
            />
          }
        >
          <MoreHorizontal className="scient-quiet-icon size-4" />
        </TooltipTrigger>
        <TooltipPopup>
          <T>Files menu</T>
        </TooltipPopup>
      </Tooltip>
      <MenuPopup align="end" sideOffset={6} className="min-w-56">
        {props.refresh ? (
          <MenuItem onClick={props.refresh.onRefresh}>
            <RefreshCwIcon aria-hidden className="size-4 text-muted-foreground" />
            {props.refresh.pending ? gt("Refreshing…") : gt("Refresh files")}
          </MenuItem>
        ) : null}
        {props.folders ? (
          <MenuItem onClick={props.folders.onToggle}>
            {props.folders.allExpanded ? (
              <ChevronsDownUpIcon aria-hidden className="size-4 text-muted-foreground" />
            ) : (
              <ChevronsUpDownIcon aria-hidden className="size-4 text-muted-foreground" />
            )}
            {props.folders.allExpanded ? gt("Collapse all folders") : gt("Expand all folders")}
          </MenuItem>
        ) : null}
        {props.refresh || props.folders ? <MenuSeparator /> : null}
        <MenuGroup>
          <MenuGroupLabel>
            <T>File visibility</T>
          </MenuGroupLabel>
          <MenuRadioGroup
            value={props.view}
            onValueChange={(value) => props.onViewChange(value as ProjectDirectoryView)}
          >
            {FILE_VISIBILITY_OPTIONS.map((option) => (
              <MenuRadioItem key={option.value} value={option.value}>
                {messages(option.label)}
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
        </MenuGroup>
        <PanelTabNewWindowItem separated />
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
  const gt = useGT();
  const searchEmptyMessage = isSearchPending
    ? gt("Searching…")
    : currentSearchError
      ? gt("Couldn’t search unopened folders.")
      : gt("No files or folders match “{query}”.", { query: normalizedSearchValue });

  return (
    <>
      <div className="sr-only" aria-live="polite">
        {isSearching
          ? isSearchPending
            ? gt("Searching workspace files.")
            : currentSearchError
              ? gt("Some workspace files could not be searched.")
              : gt("{count} matching workspace paths.", { count: props.matchingPathCount })
          : treeSnapshot.isPending
            ? gt("Loading workspace files.")
            : treeSnapshot.failures.length > 0
              ? gt("Some workspace files could not be loaded.")
              : gt("Workspace files loaded.")}
      </div>
      {treeSnapshot.rootError && treeSnapshot.entries.size === 0 ? (
        <FileSurfaceFailure
          icon={FolderXIcon}
          title={gt("Couldn't load project files")}
          description={gt("Scient couldn't list the files in this project.")}
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
              {treeSnapshot.failures[0].relativeDirectory
                ? gt("Couldn’t load {folder}. Retry", {
                    folder: treeSnapshot.failures[0].relativeDirectory,
                  })
                : gt("Couldn’t load the workspace. Retry")}
            </button>
          ) : treeSnapshot.entries.size === 0 && treeSnapshot.isPending ? (
            <div className="px-3 py-2 text-xs text-muted-foreground">
              <T>Loading files…</T>
            </div>
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
                ? gt("Searching unopened folders…")
                : currentSearchError
                  ? gt("Couldn’t search unopened folders. Loaded folders are still filtered.")
                  : hasCurrentSearch && props.searchTruncated
                    ? gt("First {limit} indexed matches loaded; ignored paths may not appear.", {
                        limit: FILE_SEARCH_LIMIT,
                      })
                    : gt("Unopened folders use indexed search; ignored paths may not appear.")}
            </div>
          ) : null}
        </div>
      )}
    </>
  );
}

/**
 * The file search field. In a narrow header it folds into a search button
 * that opens the same field in a popover.
 */
export function FileSearchField({
  ref,
  ...props
}: {
  ariaLabel: string;
  name: string;
  onClose: () => void;
  onValueChange: (value: string) => void;
  /** The inline field, which the Files panel's find shortcut focuses. */
  ref?: Ref<HTMLInputElement>;
  value: string;
}) {
  const gt = useGT();
  const renderSearchInput = (autoFocus = false) => (
    <InputGroupInput
      {...(autoFocus || !ref ? {} : { ref })}
      type="search"
      name={props.name}
      size="sm"
      value={props.value}
      aria-label={props.ariaLabel}
      placeholder={gt("Search files")}
      data-workspace-focus-default
      spellCheck={false}
      autoFocus={autoFocus}
      onChange={(event) => props.onValueChange(event.target.value)}
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        props.onClose();
        event.currentTarget.blur();
      }}
    />
  );

  return (
    <>
      <InputGroup
        variant="ghost"
        className="h-7 min-w-0 flex-1 @max-[14rem]/file-browser-header:hidden"
      >
        <InputGroupAddon>
          <SearchIcon aria-hidden className="scient-quiet-icon size-3.5" />
        </InputGroupAddon>
        {renderSearchInput()}
      </InputGroup>
      <Popover>
        <PopoverTrigger
          render={
            <Button
              type="button"
              size="icon-xs"
              variant="ghost-muted"
              className="hidden shrink-0 @max-[14rem]/file-browser-header:inline-flex"
              aria-label={props.ariaLabel}
              title={props.ariaLabel}
            />
          }
        >
          <SearchIcon aria-hidden className="scient-quiet-icon size-4" />
        </PopoverTrigger>
        <PopoverPopup
          side="top"
          align="end"
          alignOffset={8}
          sideOffset={6}
          padding="none"
          className="w-48 max-w-[calc(100vw-2rem)]"
        >
          <InputGroup variant="ghost" className="h-7 min-w-0">
            <InputGroupAddon>
              <SearchIcon aria-hidden className="scient-quiet-icon size-3.5" />
            </InputGroupAddon>
            {renderSearchInput(true)}
          </InputGroup>
        </PopoverPopup>
      </Popover>
    </>
  );
}
