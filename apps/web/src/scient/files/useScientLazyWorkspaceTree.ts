import { useLayoutEffect } from "react";
import type { FileTree, FileTreeRowDecorationRenderer } from "@pierre/trees";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  ProjectDirectoryEntry,
  ProjectDirectoryView,
} from "@t3tools/contracts";
import { useEffect, useRef, useState, type RefObject } from "react";

import { T3_PIERRE_ICONS } from "~/pierre-icons";
import { PIERRE_TREE_UNSAFE_CSS } from "~/pierre-tree-theme";
import { projectEnvironment } from "~/state/projects";
import type { useProjectPathSearch } from "~/state/queries";
import { useAtomCommand } from "~/state/use-atom-command";

import {
  LazyWorkspaceTreeController,
  type LazyWorkspaceTreeSnapshot,
} from "./LazyWorkspaceTreeController";

/** The sprite symbol of Overleaf's mark on a linked folder's row. */
const OVERLEAF_TREE_ICON = "scient-tree-icon-overleaf";

/**
 * The tree's icons plus Overleaf's leaf (Simple Icons, CC0), in the green of
 * Overleaf's own logo, for the mark on linked folders.
 */
export const SCIENT_FILE_BROWSER_TREE_ICONS = {
  ...T3_PIERRE_ICONS,
  spriteSheet: `${T3_PIERRE_ICONS.spriteSheet}<svg xmlns="http://www.w3.org/2000/svg" width="0" height="0" aria-hidden="true"><symbol id="${OVERLEAF_TREE_ICON}" viewBox="0 0 24 24"><path fill="#138A07" d="M22.3515.7484C19.1109-.5101 7.365-.982 7.3452 6.0266c-3.4272 2.194-5.6967 5.768-5.6967 9.598a8.373 8.373 0 0 0 13.1225 6.898 8.373 8.373 0 0 0-1.7668-14.7194c-.6062-.2339-1.9234-.6481-2.9753-.559-1.5007.9544-3.3308 2.9155-4.1949 4.8693 2.5894-3.082 7.5046-2.425 9.1937 1.2287 1.6892 3.6538-.9944 7.8237-5.0198 7.7998a5.4995 5.4995 0 0 1-4.1949-1.9328c-1.485-1.7483-1.8678-3.6444-1.5615-5.4975 1.057-6.4947 8.759-10.1894 14.486-11.6094-1.8677.989-5.2373 2.6134-7.5948 4.3837C18.015 9.1382 19.1308 3.345 22.3515.7484z"/></symbol></svg>`,
};

export const SCIENT_FILE_BROWSER_TREE_UNSAFE_CSS = `${PIERRE_TREE_UNSAFE_CSS}
  :host {
    --trees-font-size-override: var(--scient-font-size-file-tree, 14px);
  }
`;

const INITIAL_TREE_SNAPSHOT: LazyWorkspaceTreeSnapshot = {
  entries: new Map(),
  failures: [],
  loadingDirectories: new Set(),
  isPending: true,
  rootError: null,
};

/** Marks rows of files that are read-only in Files with a lock. */
export function scientReadOnlyRowDecoration(
  treeEntriesRef: RefObject<ReadonlyMap<string, ProjectDirectoryEntry>>,
  loadingDirectoriesRef: RefObject<ReadonlySet<string>>,
  /** Folders linked to Overleaf: they carry its mark. */
  overleafFoldersRef?: RefObject<ReadonlySet<string>>,
): FileTreeRowDecorationRenderer {
  return ({ item, row }) => {
    const relativePath = item.path.replace(/\/$/, "");
    if (
      row.kind === "directory" &&
      row.isExpanded &&
      loadingDirectoriesRef.current.has(relativePath)
    ) {
      return { icon: "t3-tree-icon-loading", title: "Loading…" };
    }
    if (row.kind === "directory" && overleafFoldersRef?.current.has(relativePath)) {
      return { icon: OVERLEAF_TREE_ICON, title: "Linked to Overleaf" };
    }
    return treeEntriesRef.current.get(relativePath)?.readOnly
      ? { icon: "file-tree-icon-lock", title: "Read-only in Files" }
      : null;
  };
}

/**
 * The workspace tree's state when it loads one directory at a time: the
 * latest snapshot, the folders loaded so far, and the refs the tree reads.
 */
export function useScientLazyWorkspaceTree(directoryView: ProjectDirectoryView) {
  const runListDirectory = useAtomCommand(projectEnvironment.listDirectory, {
    reportDefect: false,
    reportFailure: false,
  });
  const [treeSnapshot, setTreeSnapshot] =
    useState<LazyWorkspaceTreeSnapshot>(INITIAL_TREE_SNAPSHOT);
  const directoryViewRef = useRef(directoryView);
  useLayoutEffect(() => {
    directoryViewRef.current = directoryView;
  });
  const entryKinds = new Map(
    [...treeSnapshot.entries.values()].map((entry) => [entry.relativePath, entry.kind] as const),
  );
  const loadedDirectoryPaths = [...treeSnapshot.entries.values()]
    .filter((entry) => entry.kind === "directory")
    .map((entry) => `${entry.relativePath}/`);
  const entryKindsRef = useRef<ReadonlyMap<string, ProjectDirectoryEntry["kind"]>>(entryKinds);
  useLayoutEffect(() => {
    entryKindsRef.current = entryKinds;
  });
  const treeEntriesRef = useRef(treeSnapshot.entries);
  useLayoutEffect(() => {
    treeEntriesRef.current = treeSnapshot.entries;
  });
  const treeControllerRef = useRef<LazyWorkspaceTreeController | null>(null);
  return {
    runListDirectory,
    treeSnapshot,
    setTreeSnapshot,
    directoryViewRef,
    loadedDirectoryPaths,
    entryKindsRef,
    treeEntriesRef,
    treeControllerRef,
  };
}

/**
 * Loads the tree through a lazy controller for the current workspace and
 * view, and loads the folders of search results before the tree filters to
 * them.
 */
export function useScientLazyWorkspaceTreeLoading({
  model,
  environmentId,
  cwd,
  directoryView,
  isSearching,
  normalizedSearchValue,
  hasCurrentSearch,
  pathSearch,
  tree,
}: {
  model: FileTree;
  environmentId: EnvironmentId;
  cwd: string;
  directoryView: ProjectDirectoryView;
  isSearching: boolean;
  normalizedSearchValue: string;
  hasCurrentSearch: boolean;
  pathSearch: ReturnType<typeof useProjectPathSearch>;
  tree: Pick<
    ReturnType<typeof useScientLazyWorkspaceTree>,
    | "runListDirectory"
    | "setTreeSnapshot"
    | "directoryViewRef"
    | "treeEntriesRef"
    | "treeControllerRef"
  >;
}) {
  const { runListDirectory, setTreeSnapshot, directoryViewRef, treeEntriesRef, treeControllerRef } =
    tree;
  const [primedSearchKey, setPrimedSearchKey] = useState<string | null>(null);
  const searchResultKey =
    hasCurrentSearch && !pathSearch.isPending
      ? JSON.stringify([directoryView, normalizedSearchValue, pathSearch.entries])
      : null;
  const loadDirectory = async (relativeDirectory: string, view: ProjectDirectoryView) => {
    const result = await runListDirectory({
      environmentId,
      input: { cwd, relativeDirectory, view },
    });
    if (result._tag === "Success") return result.value;
    throw squashAtomCommandFailure(result);
  };

  useEffect(() => {
    setTreeSnapshot(INITIAL_TREE_SNAPSHOT);
    const controller = new LazyWorkspaceTreeController({
      model,
      loadDirectory,
      initialView: directoryViewRef.current,
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
  }, [directoryViewRef, loadDirectory, model, setTreeSnapshot, treeControllerRef, treeEntriesRef]);

  useEffect(() => {
    void treeControllerRef.current?.setView(directoryView);
  }, [directoryView, treeControllerRef]);

  useEffect(() => {
    if (!isSearching || searchResultKey === null) return;
    if (pathSearch.entries.length === 0) return;

    const controller = treeControllerRef.current;
    if (!controller) return;
    let cancelled = false;
    void controller.primePaths(pathSearch.entries.map((entry) => entry.path)).finally(() => {
      if (cancelled || treeControllerRef.current !== controller) return;
      setPrimedSearchKey(searchResultKey);
    });
    return () => {
      cancelled = true;
    };
  }, [isSearching, pathSearch.entries, searchResultKey, treeControllerRef]);

  const isSearchPending =
    isSearching &&
    (!hasCurrentSearch ||
      pathSearch.isPending ||
      (pathSearch.entries.length > 0 && searchResultKey !== primedSearchKey));
  return { isSearchPending };
}
