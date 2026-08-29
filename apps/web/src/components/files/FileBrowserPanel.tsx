import type {
  ContextMenuItem as TreeContextMenuItem,
  ContextMenuOpenContext as TreeContextMenuOpenContext,
} from "@pierre/trees";
import type { EnvironmentId, ProjectDirectoryEntry } from "@t3tools/contracts";
import { FileTree, useFileTree } from "@pierre/trees/react";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { serializeComposerFileLink } from "@t3tools/shared/composerTrigger";
import { MoreHorizontal, RotateCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Button } from "~/components/ui/button";
import { InputGroup, InputGroupInput } from "~/components/ui/input-group";
import { Menu, MenuCheckboxItem, MenuPopup, MenuTrigger } from "~/components/ui/menu";
import { toastManager } from "~/components/ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { useComposerHandleContext } from "~/composerHandleContext";
import { writeTextToClipboard } from "~/hooks/useCopyToClipboard";
import { useTheme } from "~/hooks/useTheme";
import { cn } from "~/lib/utils";
import { readLocalApi } from "~/localApi";
import { T3_PIERRE_ICONS } from "~/pierre-icons";
import { shouldOpenInBrowserByDefault } from "~/scient/fileOpening/fileOpeningPolicy";
import {
  LazyWorkspaceTreeController,
  type LazyWorkspaceTreeSnapshot,
} from "~/scient/files/LazyWorkspaceTreeController";
import { projectEnvironment } from "~/state/projects";
import { useProjectPathSearch } from "~/state/queries";
import { useAtomCommand } from "~/state/use-atom-command";

import { createFileTreeDragMentionController } from "./fileTreeDragMention";

interface FileBrowserPanelProps {
  environmentId: EnvironmentId;
  cwd: string;
  projectName: string;
  /** File currently open in the preview pane; revealed and selected in the tree. */
  selectedPath: string | null;
  /** Bumped when the same path should be revealed again (e.g. re-opened from search). */
  selectedPathRevealId: number;
  onOpenFile: (relativePath: string) => void;
  onOpenFileSource: (relativePath: string) => void;
  onRefreshSelectedFile?: () => void;
}

const TREE_UNSAFE_CSS = `
  :host {
    --trees-bg-override: transparent;
    --trees-selected-bg-override: color-mix(in srgb, currentColor 12%, transparent);
    --trees-hover-bg-override: color-mix(in srgb, currentColor 7%, transparent);
    --trees-border-color-override: color-mix(in srgb, currentColor 14%, transparent);
    --trees-font-family-override: var(--font-sans);
    --trees-font-size-override: var(--scient-font-size-file-tree, 14px);
  }
  button[data-type='item'] { border-radius: 5px; }
`;

const INITIAL_TREE_SNAPSHOT: LazyWorkspaceTreeSnapshot = {
  entries: new Map(),
  failures: [],
  isPending: true,
  rootError: null,
};

const FILE_SEARCH_LIMIT = 200;
const INTERNAL_VIEW_BY_WORKSPACE = new Map<string, boolean>();

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
        <RotateCw className={cn(props.isPending && "animate-spin")} />
      </TooltipTrigger>
      <TooltipPopup>{props.isPending ? "Refreshing…" : "Refresh files"}</TooltipPopup>
    </Tooltip>
  );
}

function WorkspaceFilesMenu(props: {
  showInternals: boolean;
  onShowInternalsChange: (showInternals: boolean) => void;
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
      <MenuPopup align="end" sideOffset={6} className="min-w-52">
        <MenuCheckboxItem
          checked={props.showInternals}
          onCheckedChange={props.onShowInternalsChange}
        >
          Show workspace internals
        </MenuCheckboxItem>
      </MenuPopup>
    </Menu>
  );
}

function FileSearchField(props: {
  ariaLabel: string;
  name: string;
  onClose: () => void;
  onValueChange: (value: string) => void;
  value: string;
}) {
  return (
    <InputGroup
      variant="ghost"
      className="h-7 min-w-0 flex-1 has-[input:focus-visible,textarea:focus-visible]:border-transparent has-[input:focus-visible,textarea:focus-visible]:ring-2 has-[input:focus-visible,textarea:focus-visible]:ring-inset has-[input:focus-visible,textarea:focus-visible]:ring-ring"
    >
      <InputGroupInput
        type="search"
        name={props.name}
        size="sm"
        value={props.value}
        aria-label={props.ariaLabel}
        placeholder="Search files"
        spellCheck={false}
        onChange={(event) => props.onValueChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== "Escape") return;
          props.onClose();
          event.currentTarget.blur();
        }}
      />
    </InputGroup>
  );
}

function FileSearchResults(props: {
  entries: readonly { readonly path: string }[];
  error: string | null;
  isPending: boolean;
  onOpenFile: (relativePath: string) => void;
  query: string;
  truncated: boolean;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col" aria-busy={props.isPending}>
      <div className="min-h-0 flex-1 overflow-y-auto px-1 py-1" aria-label="Indexed file results">
        {props.error ? (
          <div className="px-3 py-2 text-xs leading-relaxed text-destructive">{props.error}</div>
        ) : props.entries.length > 0 ? (
          props.entries.map((entry) => (
            <Tooltip key={entry.path}>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    className="block w-full truncate rounded-md px-2 py-1.5 text-left text-sm outline-none transition-colors hover:bg-accent focus-visible:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
                    onClick={() => props.onOpenFile(entry.path)}
                  >
                    {entry.path}
                  </button>
                }
              />
              <TooltipPopup side="right">{entry.path}</TooltipPopup>
            </Tooltip>
          ))
        ) : props.isPending ? (
          <div className="px-3 py-2 text-xs text-muted-foreground">Searching…</div>
        ) : (
          <div className="px-3 py-2 text-xs text-muted-foreground">
            No indexed files match “{props.query}”.
          </div>
        )}
      </div>
      <div className="shrink-0 border-t border-border/50 px-3 py-1.5 text-[11px] leading-4 text-muted-foreground">
        {props.truncated
          ? `Showing the first ${FILE_SEARCH_LIMIT} indexed results. Ignored files may not appear.`
          : "Indexed results only; ignored files may not appear."}
      </div>
    </div>
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
}: FileBrowserPanelProps) {
  const { resolvedTheme } = useTheme();
  const composerRef = useComposerHandleContext();
  const runListDirectory = useAtomCommand(projectEnvironment.listDirectory, {
    reportDefect: false,
    reportFailure: false,
  });
  const [treeSnapshot, setTreeSnapshot] =
    useState<LazyWorkspaceTreeSnapshot>(INITIAL_TREE_SNAPSHOT);
  const workspaceSessionKey = JSON.stringify([environmentId, cwd]);
  const [showInternals, setShowInternals] = useState(
    () => INTERNAL_VIEW_BY_WORKSPACE.get(workspaceSessionKey) ?? false,
  );
  const showInternalsRef = useRef(showInternals);
  showInternalsRef.current = showInternals;
  const [searchValue, setSearchValue] = useState("");
  const normalizedSearchValue = searchValue.trim();
  const isSearching = normalizedSearchValue.length > 0;
  const fileSearch = useProjectPathSearch(
    { environmentId, cwd, query: searchValue, kind: "file" },
    FILE_SEARCH_LIMIT,
  );
  const hasCurrentSearch = fileSearch.searchedQuery === normalizedSearchValue;
  const entryKinds = useMemo(
    () =>
      new Map(
        [...treeSnapshot.entries.values()].map(
          (entry) => [entry.relativePath, entry.kind] as const,
        ),
      ),
    [treeSnapshot.entries],
  );
  const entryKindsRef = useRef<ReadonlyMap<string, ProjectDirectoryEntry["kind"]>>(entryKinds);
  entryKindsRef.current = entryKinds;
  const treeEntriesRef = useRef(treeSnapshot.entries);
  treeEntriesRef.current = treeSnapshot.entries;
  const treeControllerRef = useRef<LazyWorkspaceTreeController | null>(null);
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
    try {
      const clicked = await api.contextMenu.show(
        [
          ...(shouldOpenInBrowserByDefault(relativePath)
            ? ([{ id: "open-source", label: "Open source" }] as const)
            : []),
          { id: "copy-mention", label: "Copy mention" },
          { id: "add-to-chat", label: "Add to chat" },
        ],
        position,
      );
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
    renderRowDecoration: ({ item }) => {
      const relativePath = item.path.replace(/\/$/, "");
      return treeEntriesRef.current.get(relativePath)?.readOnly
        ? { icon: "file-tree-icon-lock", title: "Read-only in Files" }
        : null;
    },
    search: false,
    unsafeCSS: TREE_UNSAFE_CSS,
  });
  const loadDirectory = useCallback(
    async (relativeDirectory: string, view: "ordinary" | "with-internals") => {
      const result = await runListDirectory({
        environmentId,
        input: { cwd, relativeDirectory, view },
      });
      if (result._tag === "Success") return result.value;
      throw squashAtomCommandFailure(result);
    },
    [cwd, environmentId, runListDirectory],
  );

  useEffect(() => {
    setTreeSnapshot(INITIAL_TREE_SNAPSHOT);
    const controller = new LazyWorkspaceTreeController({
      model,
      loadDirectory,
      initialView: showInternalsRef.current ? "with-internals" : "ordinary",
      onSnapshot: (snapshot) => {
        treeEntriesRef.current = snapshot.entries;
        setTreeSnapshot(snapshot);
      },
    });
    treeControllerRef.current = controller;
    void controller.start();
    return () => {
      controller.destroy();
      if (treeControllerRef.current === controller) treeControllerRef.current = null;
    };
  }, [loadDirectory, model]);

  useEffect(() => {
    void treeControllerRef.current?.setView(showInternals ? "with-internals" : "ordinary");
  }, [showInternals]);

  const handleSearchValueChange = (value: string) => {
    if (value.trim().length === 0) {
      if (searchSelectionPathRef.current === selectedPath) handledRevealRef.current = null;
      searchSelectionPathRef.current = null;
    }
    setSearchValue(value);
  };
  const handleSearchClose = () => {
    if (searchSelectionPathRef.current === selectedPath) handledRevealRef.current = null;
    searchSelectionPathRef.current = null;
    setSearchValue("");
  };
  const handleRefresh = () => {
    void treeControllerRef.current?.refresh();
    if (isSearching) fileSearch.refresh();
    onRefreshSelectedFile?.();
  };

  useEffect(() => {
    if (!selectedPath) {
      handledRevealRef.current = null;
      return;
    }
    const revealRequest = { path: selectedPath, revealId: selectedPathRevealId };
    if (isSearching) {
      if (searchSelectionPathRef.current === selectedPath) {
        handledRevealRef.current = revealRequest;
      } else {
        searchSelectionPathRef.current = null;
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
      const selectedItem = model.getItem(selectedPath);
      if (!selectedItem || entryKindsRef.current.get(selectedPath) === "directory") return;

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
      selectedItem.select();
      model.scrollToPath(selectedPath, { focus: true, offset: "center" });
      queueMicrotask(() => {
        syncingSelectionRef.current = false;
      });
    });
    return () => {
      cancelled = true;
    };
  }, [isSearching, model, selectedPath, selectedPathRevealId]);

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

  return (
    <div
      ref={panelRef}
      className="flex min-h-0 flex-1 flex-col bg-background"
      data-file-browser-panel={`${environmentId}:${cwd}`}
    >
      <div
        className="flex h-10 min-h-10 shrink-0 items-center gap-1 border-b border-border/60 bg-background px-2 in-data-[preview-panel-mode=inline]:mb-3 in-data-[preview-panel-mode=inline]:h-7 in-data-[preview-panel-mode=inline]:min-h-7 in-data-[preview-panel-mode=inline]:border-b-transparent"
        data-surface-subheader
      >
        <RefreshFilesButton
          isPending={treeSnapshot.isPending || (isSearching && fileSearch.isPending)}
          onRefresh={handleRefresh}
        />
        <FileSearchField
          name="project-files-search"
          ariaLabel={`Search ${projectName} files`}
          value={searchValue}
          onValueChange={handleSearchValueChange}
          onClose={handleSearchClose}
        />
        <WorkspaceFilesMenu
          showInternals={showInternals}
          onShowInternalsChange={(nextShowInternals) => {
            if (nextShowInternals) {
              INTERNAL_VIEW_BY_WORKSPACE.set(workspaceSessionKey, true);
            } else {
              INTERNAL_VIEW_BY_WORKSPACE.delete(workspaceSessionKey);
            }
            setShowInternals(nextShowInternals);
          }}
        />
      </div>
      <div className="sr-only" aria-live="polite">
        {treeSnapshot.isPending
          ? "Loading workspace files."
          : treeSnapshot.failures.length > 0
            ? "Some workspace files could not be loaded."
            : "Workspace files loaded."}
      </div>
      {isSearching ? (
        <FileSearchResults
          entries={hasCurrentSearch ? fileSearch.entries : []}
          error={hasCurrentSearch ? fileSearch.error : null}
          isPending={fileSearch.isPending}
          query={hasCurrentSearch ? fileSearch.searchedQuery : normalizedSearchValue}
          truncated={hasCurrentSearch && fileSearch.truncated}
          onOpenFile={(relativePath) => {
            searchSelectionPathRef.current = relativePath;
            onOpenFile(relativePath);
          }}
        />
      ) : treeSnapshot.rootError && treeSnapshot.entries.size === 0 ? (
        <div className="flex flex-col items-start gap-2 p-4 text-xs leading-relaxed text-destructive">
          <span>{treeSnapshot.rootError}</span>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-foreground"
            onClick={() => void treeControllerRef.current?.retry("")}
          >
            Retry
          </Button>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col">
          {treeSnapshot.failures[0] ? (
            <button
              type="button"
              className="shrink-0 border-b border-destructive/15 px-3 py-1.5 text-left text-[11px] leading-4 text-destructive transition-colors hover:bg-destructive/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
              onClick={() =>
                void treeControllerRef.current?.retry(
                  treeSnapshot.failures[0]?.relativeDirectory ?? "",
                )
              }
            >
              Couldn’t load {treeSnapshot.failures[0].relativeDirectory || "the workspace"}. Retry
            </button>
          ) : treeSnapshot.entries.size === 0 && treeSnapshot.isPending ? (
            <div className="px-3 py-2 text-xs text-muted-foreground">Loading files…</div>
          ) : null}
          <FileTree
            model={model}
            aria-label={`${projectName} files`}
            className="min-h-0 flex-1 overflow-hidden"
            style={{
              colorScheme: resolvedTheme,
              ["--trees-fg-override" as string]: "var(--contrast-foreground)",
            }}
          />
        </div>
      )}
    </div>
  );
}
