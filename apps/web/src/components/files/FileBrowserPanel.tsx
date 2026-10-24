// SCIENT-FORK:START — refresh moved into the Files menu; its icon import went with it
// SCIENT-FORK:END
import type {
  ContextMenuItem as TreeContextMenuItem,
  ContextMenuOpenContext as TreeContextMenuOpenContext,
} from "@pierre/trees";
import type { EnvironmentId } from "@t3tools/contracts";
import { FileTree, useFileTree, useFileTreeSearch, useFileTreeSelector } from "@pierre/trees/react";
import { settlePromise } from "@t3tools/client-runtime/state/runtime";
import { serializeComposerFileLink } from "@t3tools/shared/composerTrigger";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import * as Cause from "effect/Cause";
// SCIENT-FORK:START — expand and collapse all moved into the Files menu
// SCIENT-FORK:END
import { useEffect, useRef, useState } from "react";

// SCIENT-FORK:START — the Files bar's buttons and their icons come from Scient's toolbar
// SCIENT-FORK:END
import { cn } from "~/lib/utils";
import { toastManager } from "~/components/ui/toast";
// SCIENT-FORK:START — the Files bar's buttons take their tooltips from Scient's toolbar
// SCIENT-FORK:END
import { useComposerHandleContext } from "~/composerHandleContext";
import { writeTextToClipboard } from "~/hooks/useCopyToClipboard";
import { useStableCallback } from "~/hooks/useStableCallback";
import { useTheme } from "~/hooks/useTheme";
import { useWorkspaceMutationRefresh } from "~/hooks/useWorkspaceMutationRefresh";
import { useFileContextMenu, type FileContextMenuAction } from "~/fileContextMenu";
import { readLocalApi } from "~/localApi";
// SCIENT-FORK:START — the tree's icons come from SCIENT_FILE_BROWSER_TREE_ICONS
// SCIENT-FORK:END
import { shouldOpenInBrowserByDefault } from "~/scient/fileOpening/fileOpeningPolicy";
// SCIENT-FORK:START
import {
  FILE_SEARCH_LIMIT,
  FileSearchField,
  ScientFileTreeSurface,
  useScientDirectoryView,
  WorkspaceFilesMenu,
} from "~/scient/files/ScientFileBrowserChrome";
import {
  SCIENT_FILE_BROWSER_TREE_ICONS,
  SCIENT_FILE_BROWSER_TREE_UNSAFE_CSS,
  scientReadOnlyRowDecoration,
  useScientLazyWorkspaceTree,
  useScientLazyWorkspaceTreeLoading,
} from "~/scient/files/useScientLazyWorkspaceTree";
// SCIENT-FORK:END
// SCIENT-FORK:START — the Files bar's New and Connect menus
import { useCreateNewDocument } from "~/scient/documents/useCreateNewDocument";
import type { OpenFileOptions } from "~/rightPanelStore";
import {
  ConnectFolderButton,
  NewDocumentButton,
  type ScientToolbarSlot,
} from "~/scient/files/FileBrowserToolbarActions";
import { TooltipProvider } from "~/components/ui/tooltip";
// SCIENT-FORK:END
// SCIENT-FORK:START — Overleaf: Connect for a folder, and the mark on linked folders
import {
  useOverleafConnectDialog,
  useOverleafTreeMarks,
} from "~/scient/overleaf/useOverleafFolderConnect";
// SCIENT-FORK:END
import { useProjectPathSearch } from "~/state/queries";
import { pierreTreeStyle } from "~/pierre-tree-theme";

import { joinHostPath } from "./filePath";
import { createFileTreeDragMentionController } from "./fileTreeDragMention";
import { resolveFileBrowserSearchValue } from "./fileBrowserSearch";
import { areAllDirectoriesExpanded, setAllDirectoriesExpanded } from "./fileTreeExpansion";
// SCIENT-FORK:START — new documents are listed through useCreateNewDocument
import { refreshProjectEntriesQuery, subscribeProjectFilesRefresh } from "./projectFilesQueryState";
// SCIENT-FORK:END

interface FileBrowserPanelProps {
  environmentId: EnvironmentId;
  cwd: string;
  projectName: string;
  selectedPath: string | null;
  selectedPathRevealId: number;
  onOpenFile: (relativePath: string) => void;
  // SCIENT-FORK:START — New opens a LaTeX document straight in Visual
  onOpenFileSource: (relativePath: string, line?: number, options?: OpenFileOptions) => void;
  // SCIENT-FORK:END
  /**
   * Set when `cwd` is a host folder outside the workspace rather than the
   * workspace root. Entries then open and mention as host paths. A host folder can
   * be a home directory, so nothing walks it whole: there is no expand-all, and
   * search filters the folders already loaded instead of indexing on the server.
   */
  hostFolder?: boolean;
  onRefreshSelectedFile?: () => void;
  // SCIENT-FORK:START — controls placed before the search field, such as a tab's Back
  scientToolbarLeading?: ScientToolbarSlot;
  // SCIENT-FORK:END
  workspaceMutationId: string | null;
}

// SCIENT-FORK:START — refresh moved into the Files menu (WorkspaceFilesMenu)
// SCIENT-FORK:END

function areSamePaths(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  return left.size === right.size && [...left].every((path) => right.has(path));
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
  hostFolder = false,
  // SCIENT-FORK:START
  scientToolbarLeading,
  // SCIENT-FORK:END
}: FileBrowserPanelProps) {
  const panelPath = (relativePath: string) =>
    hostFolder ? joinHostPath(cwd, relativePath) : relativePath;
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
  const { query: searchQuery, normalizedQuery: normalizedSearchValue } =
    resolveFileBrowserSearchValue(searchValue);
  const isSearching = normalizedSearchValue.length > 0;
  const pathSearch = useProjectPathSearch(
    { environmentId, cwd: hostFolder ? null : cwd, query: searchQuery },
    FILE_SEARCH_LIMIT,
  );
  const hasCurrentSearch = pathSearch.searchedQuery === normalizedSearchValue;
  const fileContextMenu = useFileContextMenu(environmentId);
  const syncingSelectionRef = useRef(false);
  const treeSelectionPathRef = useRef<string | null>(null);
  // SCIENT-FORK:START — the folder New acts on: the last selected folder, or
  // the folder of the last selected file.
  const lastSelectionRef = useRef<string | null>(null);
  const createNewDocument = useCreateNewDocument();
  const overleafConnect = useOverleafConnectDialog({ environmentId, cwd });
  const selectionBase = () => {
    const selection = lastSelectionRef.current ?? selectedPath;
    if (!selection) return "";
    if (entryKindsRef.current.get(selection) === "directory") return `${selection}/`;
    const slash = selection.lastIndexOf("/");
    return slash === -1 ? "" : selection.slice(0, slash + 1);
  };
  const startNewDocument = (format: "markdown" | "latex", base: string) =>
    createNewDocument({
      format,
      environmentId,
      cwd,
      base,
      open: (relativePath) =>
        onOpenFileSource(relativePath, undefined, { latexPreviewMode: "visual" }),
    });
  // SCIENT-FORK:END
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

  const showEntryContextMenu = useStableCallback(
    (item: TreeContextMenuItem, context: TreeContextMenuOpenContext) => {
      const api = readLocalApi();
      if (!api) {
        context.close();
        return;
      }
      const relativePath = item.path.replace(/\/$/, "");
      // SCIENT-FORK:START
      const isFolder =
        !hostFolder &&
        (item.path.endsWith("/") || entryKindsRef.current.get(relativePath) === "directory");
      // SCIENT-FORK:END
      const mention = serializeComposerFileLink(panelPath(relativePath));
      const pointer = contextMenuPointerRef.current;
      const pointerIsFresh = pointer !== null && performance.now() - pointer.at < 1000;
      const anchorRect = context.anchorElement.getBoundingClientRect();
      const position = pointerIsFresh
        ? { x: pointer.x, y: pointer.y }
        : { x: anchorRect.left, y: anchorRect.bottom };
      const fileTarget = { environmentId, filePath: relativePath, workspaceRoot: cwd };
      const fileMenuItems = fileContextMenu.buildItems(fileTarget);
      void settlePromise(async () => {
        const clicked = await api.contextMenu.show(
          [
            ...fileMenuItems,
            // SCIENT-FORK:START — files that open rendered by default can open as source
            ...(shouldOpenInBrowserByDefault(relativePath)
              ? ([{ id: "open-source", label: "Open source" }] as const)
              : []),
            // SCIENT-FORK:END
            { id: "copy-mention", label: "Copy mention" },
            { id: "add-to-chat", label: "Add to chat" },
            // SCIENT-FORK:START — start a document in, or connect, this folder
            ...(isFolder
              ? ([
                  {
                    id: "new-document",
                    label: "New document here",
                    separatorBefore: true,
                    children: [
                      { id: "new-document:markdown", label: "Markdown" },
                      { id: "new-document:latex", label: "LaTeX" },
                    ],
                  },
                  {
                    id: "connect",
                    label: "Connect to",
                    children: [{ id: "connect:overleaf", label: "Overleaf…" }],
                  },
                ] as const)
              : []),
            // SCIENT-FORK:END
          ],
          position,
        );
        if (clicked === null) return;
        // SCIENT-FORK:START
        if (clicked === "connect:overleaf") {
          overleafConnect.openConnect(relativePath);
          return;
        }
        if (clicked === "new-document:markdown" || clicked === "new-document:latex") {
          startNewDocument(
            clicked === "new-document:latex" ? "latex" : "markdown",
            `${relativePath}/`,
          );
          return;
        }
        // SCIENT-FORK:END
        // "Open with" submenu selections report the child id ("editor:<id>"),
        // which is not present in the top-level item list.
        const isFileMenuAction =
          fileMenuItems.some((entry) => entry.id === clicked) || clicked.startsWith("editor:");
        if (isFileMenuAction) {
          await fileContextMenu.activate(clicked as FileContextMenuAction, fileTarget);
          return;
        }
        // SCIENT-FORK:START
        if (clicked === "open-source") {
          onOpenFileSource(panelPath(relativePath));
          return;
        }
        // SCIENT-FORK:END
        if (clicked === "copy-mention") {
          try {
            await writeTextToClipboard(mention);
            toastManager.add({
              type: "success",
              title: "Mention copied",
              description: relativePath,
            });
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
      }).then((result) => {
        context.close();
        // Keep surfacing unexpected failures as unhandled rejections.
        if (!AsyncResult.isSuccess(result)) throw Cause.squash(result.cause);
      });
    },
  );

  const loadingDirectoriesRef = useRef(treeSnapshot.loadingDirectories);
  // SCIENT-FORK:START — folders linked to Overleaf, read by the row marks
  const overleafFoldersRef = useRef<ReadonlySet<string>>(new Set());
  // SCIENT-FORK:END
  const dragMention = createFileTreeDragMentionController(
    hostFolder ? { mentionPath: (path: string) => joinHostPath(cwd, path) } : {},
  );
  const { model } = useFileTree({
    composition: {
      contextMenu: {
        triggerMode: "right-click",
        onOpen: (item, context) => {
          showEntryContextMenu(item, context);
        },
      },
    },
    dragAndDrop: { canDrop: () => false },
    density: "compact",
    fileTreeSearchMode: "hide-non-matches",
    flattenEmptyDirectories: false,
    initialExpansion: "closed",
    // SCIENT-FORK:START — the tree's icons include Overleaf's mark for linked folders
    icons: SCIENT_FILE_BROWSER_TREE_ICONS,
    // SCIENT-FORK:END
    onSelectionChange: (selectedPaths) => {
      // The drag controller's selection cache must track every change,
      // including reveal-driven ones, or drags act on a stale selection.
      dragMention.handleSelectionChange(selectedPaths);
      if (syncingSelectionRef.current) return;
      if (dragMention.isDragInProgress()) {
        return;
      }
      const selectedPath = selectedPaths.at(-1)?.replace(/\/$/, "");
      // SCIENT-FORK:START
      if (selectedPath) lastSelectionRef.current = selectedPath;
      // SCIENT-FORK:END
      if (selectedPath && entryKindsRef.current.get(selectedPath) !== "directory") {
        treeSelectionPathRef.current = selectedPath;
        onOpenFile(panelPath(selectedPath));
      }
    },
    paths: [],
    // SCIENT-FORK:START — preserve upstream first-load feedback and read-only locks
    renderRowDecoration: (context) =>
      scientReadOnlyRowDecoration(
        treeEntriesRef,
        loadingDirectoriesRef,
        overleafFoldersRef,
      )(context),
    // SCIENT-FORK:END
    search: false,
    unsafeCSS: SCIENT_FILE_BROWSER_TREE_UNSAFE_CSS,
  });
  useEffect(() => {
    const next = treeSnapshot.loadingDirectories;
    if (areSamePaths(loadingDirectoriesRef.current, next)) return;
    loadingDirectoriesRef.current = next;
    model.setComposition(model.getComposition());
  }, [model, treeSnapshot.loadingDirectories]);
  // SCIENT-FORK:START — Overleaf's mark on linked folders, redrawn when links change
  const redrawRowMarks = useStableCallback(() => model.setComposition(model.getComposition()));
  useOverleafTreeMarks({
    environmentId,
    cwd,
    enabled: !hostFolder,
    foldersRef: overleafFoldersRef,
    onFoldersChanged: redrawRowMarks,
  });
  // SCIENT-FORK:END
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
  const refreshEntries = () => {
    void treeControllerRef.current?.refresh();
    refreshProjectEntriesQuery(environmentId, cwd);
    if (isSearching) pathSearch.refresh();
  };
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

  // The capture phase runs before the tree's own dragstart handler selects
  // the dragged row, so the drag flag is up before that selection emits.
  const panelRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const panel = panelRef.current;
    if (panel === null) {
      return;
    }
    const handleDragStart = (event: DragEvent) => dragMention.handleDragStart(event);
    const handleDragEnd = () =>
      dragMention.handleDragEnd((path) => model.getItem(path)?.deselect());
    panel.addEventListener("dragstart", handleDragStart, true);
    panel.addEventListener("dragend", handleDragEnd);
    return () => {
      panel.removeEventListener("dragstart", handleDragStart, true);
      panel.removeEventListener("dragend", handleDragEnd);
    };
  }, [dragMention, model]);

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
        {/* SCIENT-FORK:START — search first; New acts on the selected folder, Connect lists
            the services on the way; refresh and expand-all live in the Files menu. Host
            folders are read-only.
            Tooltips here open quickly, and at once while moving between buttons. */}
        <TooltipProvider delay={100} closeDelay={0} timeout={400}>
          {scientToolbarLeading}
          <FileSearchField
            name="project-files-search"
            ariaLabel={`Search ${projectName} files`}
            value={searchValue}
            onValueChange={handleSearchValueChange}
            onClose={handleSearchClose}
          />
          {hostFolder ? null : (
            <>
              <NewDocumentButton onChoose={(format) => startNewDocument(format, selectionBase())} />
              <ConnectFolderButton
                onConnectOverleaf={() => {
                  // The selected folder, or the project's top when nothing is selected.
                  const base = selectionBase();
                  overleafConnect.openConnect(base.replace(/\/$/u, ""));
                }}
              />
            </>
          )}
          <WorkspaceFilesMenu
            view={directoryView}
            onViewChange={changeDirectoryView}
            refresh={{
              pending: treeSnapshot.isPending || isSearchPending,
              onRefresh: handleRefresh,
            }}
            folders={
              loadedDirectoryPaths.length > 0 && !hostFolder
                ? { allExpanded: allLoadedDirectoriesExpanded, onToggle: toggleLoadedDirectories }
                : undefined
            }
          />
        </TooltipProvider>
        {/* SCIENT-FORK:END */}
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
      {overleafConnect.dialog}
      {/* SCIENT-FORK:END */}
    </div>
  );
}
