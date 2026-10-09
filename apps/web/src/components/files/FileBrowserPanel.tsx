import { RefreshIcon } from "~/components/ui/refresh-icon";
import type {
  ContextMenuItem as TreeContextMenuItem,
  ContextMenuOpenContext as TreeContextMenuOpenContext,
} from "@pierre/trees";
import type { EnvironmentId } from "@t3tools/contracts";
import { FileTree, useFileTree, useFileTreeSearch, useFileTreeSelector } from "@pierre/trees/react";
import { serializeComposerFileLink } from "@t3tools/shared/composerTrigger";
import { ChevronsDownUp, ChevronsUpDown } from "lucide";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Button } from "~/components/ui/button";

import { MorphIcon } from "~/components/MorphIcon";
import { cn } from "~/lib/utils";
import { toastManager } from "~/components/ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { useComposerHandleContext } from "~/composerHandleContext";
import { writeTextToClipboard } from "~/hooks/useCopyToClipboard";
import { useTheme } from "~/hooks/useTheme";
import { useWorkspaceMutationRefresh } from "~/hooks/useWorkspaceMutationRefresh";
import { useFileContextMenu, type FileContextMenuAction } from "~/fileContextMenu";
import { readLocalApi } from "~/localApi";
import { T3_PIERRE_ICONS } from "~/pierre-icons";
import { shouldOpenInBrowserByDefault } from "~/scient/fileOpening/fileOpeningPolicy";
import { ScientMarkdownCreateButton } from "~/scient/markdownEditor/ui/ScientMarkdownCreateButton";
// SCIENT-FORK:START
import {
  FILE_SEARCH_LIMIT,
  FileSearchField,
  ScientFileTreeSurface,
  useScientDirectoryView,
  WorkspaceFilesMenu,
} from "~/scient/files/ScientFileBrowserChrome";
import {
  SCIENT_FILE_BROWSER_TREE_UNSAFE_CSS,
  scientReadOnlyRowDecoration,
  useScientLazyWorkspaceTree,
  useScientLazyWorkspaceTreeLoading,
} from "~/scient/files/useScientLazyWorkspaceTree";
// SCIENT-FORK:END
import { useProjectPathSearch } from "~/state/queries";
import { pierreTreeStyle } from "~/pierre-tree-theme";

import { createFileTreeDragMentionController } from "./fileTreeDragMention";
import { areAllDirectoriesExpanded, setAllDirectoriesExpanded } from "./fileTreeExpansion";
import {
  refreshProjectEntriesQuery,
  setProjectFileQueryData,
  subscribeProjectFilesRefresh,
} from "./projectFilesQueryState";

interface FileBrowserPanelProps {
  environmentId: EnvironmentId;
  cwd: string;
  projectName: string;
  /** Entry currently open in the surface; revealed and selected in the tree. A directory is expanded. */
  selectedPath: string | null;
  /** Bumped when the same path should be revealed again (e.g. re-opened from search). */
  selectedPathRevealId: number;
  onOpenFile: (relativePath: string) => void;
  onOpenFileSource: (relativePath: string) => void;
  onRefreshSelectedFile?: () => void;
  workspaceMutationId: string | null;
}

function RefreshFilesButton(props: { isPending: boolean; onRefresh: () => void }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label="Refresh workspace files"
            onClick={props.onRefresh}
          />
        }
      >
        <RefreshIcon refreshing={props.isPending} />
      </TooltipTrigger>
      <TooltipPopup>{props.isPending ? "Refreshing…" : "Refresh files"}</TooltipPopup>
    </Tooltip>
  );
}

export default function FileBrowserPanel({
  environmentId,
  cwd,
  projectName,
  selectedPath,
  selectedPathRevealId,
  onOpenFile,
  onOpenFileSource,
  onRefreshSelectedFile,
  workspaceMutationId,
}: FileBrowserPanelProps) {
  const { resolvedTheme } = useTheme();
  const composerRef = useComposerHandleContext();
  // SCIENT-FORK:START — file visibility view and the lazily loaded tree
  const { directoryView, changeDirectoryView } = useScientDirectoryView(environmentId, cwd);
  const {
    treeSnapshot,
    loadedDirectoryPaths,
    entryKindsRef,
    treeEntriesRef,
    treeControllerRef,
    ...lazyTree
  } = useScientLazyWorkspaceTree(directoryView);
  // SCIENT-FORK:END
  const [searchValue, setSearchValue] = useState("");
  const normalizedSearchValue = searchValue.trim();
  const isSearching = normalizedSearchValue.length > 0;
  const pathSearch = useProjectPathSearch(
    { environmentId, cwd, query: searchValue },
    FILE_SEARCH_LIMIT,
  );
  const hasCurrentSearch = pathSearch.searchedQuery === normalizedSearchValue;
  const fileContextMenu = useFileContextMenu(environmentId);
  const syncingSelectionRef = useRef(false);
  const treeSelectionPathRef = useRef<string | null>(null);
  const searchSelectionPathRef = useRef<string | null>(null);
  const handledRevealRef = useRef<{ path: string; revealId: number } | null>(null);

  // The tree renders rows in shadow DOM and its anchor rect is unreliable, so
  // capture the right-click position ourselves; contextmenu is a composed
  // event, so a capture-phase listener sees it with viewport coordinates.
  const contextMenuPointerRef = useRef<{ x: number; y: number; at: number } | null>(null);
  useEffect(() => {
    const capturePointer = (event: MouseEvent) => {
      contextMenuPointerRef.current = { x: event.clientX, y: event.clientY, at: event.timeStamp };
    };
    document.addEventListener("contextmenu", capturePointer, true);
    return () => document.removeEventListener("contextmenu", capturePointer, true);
  }, []);

  /** Combines the file actions (open/reveal/open with) with the panel's own mention actions. */
  const showEntryContextMenu = async (
    item: TreeContextMenuItem,
    context: TreeContextMenuOpenContext,
  ) => {
    const api = readLocalApi();
    if (!api) {
      context.close();
      return;
    }
    const relativePath = item.path.replace(/\/$/, "");
    const mention = serializeComposerFileLink(relativePath);
    const pointer = contextMenuPointerRef.current;
    const pointerIsFresh = pointer !== null && performance.now() - pointer.at < 1000;
    const anchorRect = context.anchorElement.getBoundingClientRect();
    const position = pointerIsFresh
      ? { x: pointer.x, y: pointer.y }
      : { x: anchorRect.left, y: anchorRect.bottom };
    const fileTarget = { environmentId, filePath: relativePath, workspaceRoot: cwd };
    const fileMenuItems = fileContextMenu.buildItems(fileTarget);
    try {
      const clicked = await api.contextMenu.show(
        [
          ...fileMenuItems,
          ...(shouldOpenInBrowserByDefault(relativePath)
            ? ([{ id: "open-source", label: "Open source" }] as const)
            : []),
          { id: "copy-mention", label: "Copy mention" },
          { id: "add-to-chat", label: "Add to chat" },
        ],
        position,
      );
      if (clicked === null) return;
      // "Open with" submenu selections report the child id ("editor:<id>"),
      // which is not present in the top-level item list.
      const isFileMenuAction =
        fileMenuItems.some((entry) => entry.id === clicked) || clicked.startsWith("editor:");
      if (isFileMenuAction) {
        await fileContextMenu.activate(clicked as FileContextMenuAction, fileTarget);
        return;
      }
      if (clicked === "open-source") {
        onOpenFileSource(relativePath);
        return;
      }
      if (clicked === "copy-mention") {
        try {
          await writeTextToClipboard(mention);
          toastManager.add({ type: "success", title: "Mention copied", description: relativePath });
        } catch (error) {
          toastManager.add({
            type: "error",
            title: "Failed to copy mention",
            description: error instanceof Error ? error.message : "An error occurred.",
          });
        }
        return;
      }
      if (clicked === "add-to-chat") {
        const composer = composerRef?.current;
        if (!composer) {
          toastManager.add({
            type: "error",
            title: "Unable to add to chat",
            description: "Open a chat for this project and try again.",
          });
          return;
        }
        const inserted = composer.insertTextAtEnd(`${mention} `, { ensureLeadingBoundary: true });
        if (!inserted) {
          toastManager.add({
            type: "error",
            title: "Unable to add to chat",
            description: "The chat isn't ready to accept input right now.",
          });
        }
      }
    } finally {
      context.close();
    }
  };
  const showEntryContextMenuRef = useRef(showEntryContextMenu);
  useEffect(() => {
    showEntryContextMenuRef.current = showEntryContextMenu;
  });

  const treeModelRef = useRef<ReturnType<typeof useFileTree>["model"] | null>(null);
  const dragMention = useMemo(
    () =>
      createFileTreeDragMentionController({
        deselect: (path) => treeModelRef.current?.getItem(path)?.deselect(),
      }),
    [],
  );
  const { model } = useFileTree({
    composition: {
      contextMenu: {
        triggerMode: "right-click",
        onOpen: (item, context) => {
          void showEntryContextMenuRef.current(item, context);
        },
      },
    },
    // Rows only need to be draggable so entries can be dropped into the chat
    // composer; rearranging files inside the tree stays off.
    dragAndDrop: { canDrop: () => false },
    density: "compact",
    fileTreeSearchMode: "hide-non-matches",
    flattenEmptyDirectories: false,
    initialExpansion: "closed",
    icons: T3_PIERRE_ICONS,
    onSelectionChange: (selectedPaths) => {
      // The drag controller's selection cache must track every change,
      // including reveal-driven ones, or drags act on a stale selection.
      dragMention.handleSelectionChange(selectedPaths);
      // Selection changes driven by the reveal sync below are echoes of an
      // already-open file, not a request to open it again.
      if (syncingSelectionRef.current) return;
      // Starting a drag selects the dragged row; that selection is a side
      // effect of the gesture, not a request to open the file.
      if (dragMention.isDragInProgress()) {
        return;
      }
      const selectedPath = selectedPaths.at(-1)?.replace(/\/$/, "");
      if (selectedPath && entryKindsRef.current.get(selectedPath) !== "directory") {
        treeSelectionPathRef.current = selectedPath;
        onOpenFile(selectedPath);
      }
    },
    paths: [],
    // SCIENT-FORK:START — read-only rows carry a lock
    renderRowDecoration: scientReadOnlyRowDecoration(treeEntriesRef),
    // SCIENT-FORK:END
    search: false,
    unsafeCSS: SCIENT_FILE_BROWSER_TREE_UNSAFE_CSS,
  });
  const treeSearch = useFileTreeSearch(model);
  const allLoadedDirectoriesExpanded = useFileTreeSelector(model, (currentModel) =>
    areAllDirectoriesExpanded(currentModel, loadedDirectoryPaths),
  );
  const toggleLoadedDirectories = () => {
    setAllDirectoriesExpanded(model, loadedDirectoryPaths, !allLoadedDirectoriesExpanded);
  };
  // SCIENT-FORK:START — load the tree lazily and prime it for search results
  const { isSearchPending } = useScientLazyWorkspaceTreeLoading({
    model,
    environmentId,
    cwd,
    directoryView,
    isSearching,
    normalizedSearchValue,
    hasCurrentSearch,
    pathSearch,
    tree: { treeControllerRef, treeEntriesRef, ...lazyTree },
  });
  // SCIENT-FORK:END

  const handleSearchValueChange = (value: string) => {
    if (!isSearching && value.trim().length > 0) {
      // Starting a search must not look like an external file selection.
      // Keep the file that was already open as this search session's anchor.
      searchSelectionPathRef.current = selectedPath;
    }
    if (value.trim().length === 0) {
      if (searchSelectionPathRef.current === selectedPath) handledRevealRef.current = null;
      searchSelectionPathRef.current = null;
      model.closeSearch();
    } else {
      model.setSearch(value);
    }
    setSearchValue(value);
  };
  const handleSearchClose = () => {
    if (searchSelectionPathRef.current === selectedPath) handledRevealRef.current = null;
    searchSelectionPathRef.current = null;
    model.closeSearch();
    setSearchValue("");
  };
  const refreshEntries = useCallback(() => {
    void treeControllerRef.current?.refresh();
    refreshProjectEntriesQuery(environmentId, cwd);
    if (isSearching) pathSearch.refresh();
  }, [cwd, environmentId, isSearching, pathSearch.refresh]);
  useWorkspaceMutationRefresh({
    mutationId: workspaceMutationId,
    refresh: refreshEntries,
    resourceKey: `files:${environmentId}:${cwd}`,
  });
  const handleRefresh = () => {
    refreshEntries();
    onRefreshSelectedFile?.();
  };

  useEffect(
    () => subscribeProjectFilesRefresh(environmentId, cwd, refreshEntries),
    [environmentId, cwd, refreshEntries],
  );

  useEffect(() => {
    if (!selectedPath) {
      handledRevealRef.current = null;
      return;
    }
    const revealRequest = { path: selectedPath, revealId: selectedPathRevealId };
    if (isSearching) {
      const selectedInTree = model
        .getSelectedPaths()
        .some((path) => path.replace(/\/$/, "") === selectedPath);
      if (selectedInTree && treeSelectionPathRef.current === selectedPath) {
        treeSelectionPathRef.current = null;
        searchSelectionPathRef.current = selectedPath;
        handledRevealRef.current = revealRequest;
      } else if (searchSelectionPathRef.current === selectedPath) {
        handledRevealRef.current = revealRequest;
      } else {
        searchSelectionPathRef.current = null;
        model.closeSearch();
        setSearchValue("");
      }
      return;
    }
    const handledReveal = handledRevealRef.current;
    // Branch refreshes update entry metadata while the same preview stays open.
    // Replaying a handled reveal would steal focus from the user's current work.
    if (
      handledReveal?.path === revealRequest.path &&
      handledReveal.revealId === revealRequest.revealId
    ) {
      return;
    }
    let cancelled = false;
    void treeControllerRef.current?.ensurePath(selectedPath).then((found) => {
      if (cancelled || !found) return;
      const selectedKind = entryKindsRef.current.get(selectedPath);
      if (selectedKind === undefined) return;
      const selectedTreePath = selectedKind === "directory" ? `${selectedPath}/` : selectedPath;
      const selectedItem = model.getItem(selectedTreePath);
      if (!selectedItem) return;

      // A selection that originated inside the tree is already visible. Only
      // external opens (search, chat links, or another picker) need revealing.
      const selectedInTree = model
        .getSelectedPaths()
        .some((path) => path.replace(/\/$/, "") === selectedPath);
      if (selectedInTree && treeSelectionPathRef.current === selectedPath) {
        treeSelectionPathRef.current = null;
        handledRevealRef.current = revealRequest;
        return;
      }
      treeSelectionPathRef.current = null;
      handledRevealRef.current = revealRequest;

      syncingSelectionRef.current = true;
      for (const path of model.getSelectedPaths()) {
        model.getItem(path)?.deselect();
      }
      if ("expand" in selectedItem) selectedItem.expand();
      selectedItem.select();
      model.scrollToPath(selectedTreePath, { focus: true, offset: "center" });
      queueMicrotask(() => {
        syncingSelectionRef.current = false;
      });
    });
    return () => {
      cancelled = true;
    };
  }, [entryKindsRef, isSearching, model, selectedPath, selectedPathRevealId, treeControllerRef]);

  // Tag tree drags with the composer mention payload. The row is read from
  // the composed event path (the tree's shadow root is open), so this does
  // not depend on running after the tree's own dragstart handler; the drag
  // data store is writable for every dragstart listener in the dispatch.
  // The capture phase runs before the tree's own dragstart handler selects
  // the dragged row, so the drag flag is up before that selection emits.
  const panelRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    treeModelRef.current = model;
  }, [model]);
  useEffect(() => {
    const panel = panelRef.current;
    if (panel === null) {
      return;
    }
    const handleDragStart = (event: DragEvent) => dragMention.handleDragStart(event);
    const handleDragEnd = () => dragMention.handleDragEnd();
    panel.addEventListener("dragstart", handleDragStart, true);
    panel.addEventListener("dragend", handleDragEnd);
    return () => {
      panel.removeEventListener("dragstart", handleDragStart, true);
      panel.removeEventListener("dragend", handleDragEnd);
    };
  }, [dragMention]);

  const currentSearchError = hasCurrentSearch ? pathSearch.error : null;
  const hideTreeForSearch = isSearching && treeSearch.matchingPaths.length === 0;

  return (
    <div
      ref={panelRef}
      className="scient-reading-ui flex min-h-0 flex-1 flex-col bg-background"
      data-file-browser-panel={`${environmentId}:${cwd}`}
    >
      <div
        className="@container/file-browser-header flex h-10 min-h-10 shrink-0 items-center gap-1 border-b border-border/60 bg-background px-2 in-data-[preview-panel-mode=inline]:mb-2 in-data-[preview-panel-mode=inline]:h-8 in-data-[preview-panel-mode=inline]:min-h-8 in-data-[preview-panel-mode=inline]:border-b-transparent in-data-[preview-panel-mode=inline]:pt-1"
        data-surface-subheader
      >
        <RefreshFilesButton
          isPending={treeSnapshot.isPending || isSearchPending}
          onRefresh={handleRefresh}
        />
        <ScientMarkdownCreateButton
          environmentId={environmentId}
          cwd={cwd}
          selectedPath={selectedPath}
          onCreated={(relativePath, contents, revision) => {
            setProjectFileQueryData(environmentId, cwd, relativePath, contents, revision);
            handleRefresh();
            onOpenFile(relativePath);
          }}
        />
        <FileSearchField
          name="project-files-search"
          ariaLabel={`Search ${projectName} files`}
          value={searchValue}
          onValueChange={handleSearchValueChange}
          onClose={handleSearchClose}
        />
        <div className="ms-auto flex shrink-0 items-center gap-1">
          {loadedDirectoryPaths.length > 0 ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    type="button"
                    size="icon-xs"
                    variant="ghost"
                    aria-label={
                      allLoadedDirectoriesExpanded ? "Collapse all folders" : "Expand all folders"
                    }
                    onClick={toggleLoadedDirectories}
                  />
                }
              >
                <MorphIcon
                  className="size-3.5"
                  icon={allLoadedDirectoriesExpanded ? ChevronsDownUp : ChevronsUpDown}
                />
              </TooltipTrigger>
              <TooltipPopup>
                {allLoadedDirectoriesExpanded ? "Collapse all folders" : "Expand all folders"}
              </TooltipPopup>
            </Tooltip>
          ) : null}
          <WorkspaceFilesMenu view={directoryView} onViewChange={changeDirectoryView} />
        </div>
      </div>
      {/* SCIENT-FORK:START — lazy tree load and search status around the tree */}
      <ScientFileTreeSurface
        treeSnapshot={treeSnapshot}
        onRetryDirectory={(relativeDirectory) =>
          void treeControllerRef.current?.retry(relativeDirectory)
        }
        isSearching={isSearching}
        isSearchPending={isSearchPending}
        currentSearchError={currentSearchError}
        hasCurrentSearch={hasCurrentSearch}
        searchTruncated={pathSearch.truncated}
        matchingPathCount={treeSearch.matchingPaths.length}
        hideTreeForSearch={hideTreeForSearch}
        normalizedSearchValue={normalizedSearchValue}
      >
        {/* SCIENT-FORK:END */}
        <FileTree
          model={model}
          aria-label={`${projectName} files`}
          className={cn("min-h-0 flex-1 overflow-hidden", hideTreeForSearch && "invisible")}
          style={pierreTreeStyle(resolvedTheme)}
        />
        {/* SCIENT-FORK:START */}
      </ScientFileTreeSurface>
      {/* SCIENT-FORK:END */}
    </div>
  );
}
