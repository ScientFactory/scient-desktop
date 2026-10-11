import type { FileTree, FileTreeRowDecorationRenderer } from "@pierre/trees";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  ProjectDirectoryEntry,
  ProjectDirectoryView,
} from "@t3tools/contracts";
import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";

import { PIERRE_TREE_UNSAFE_CSS } from "~/pierre-tree-theme";
import { projectEnvironment } from "~/state/projects";
import type { useProjectPathSearch } from "~/state/queries";
import { useAtomCommand } from "~/state/use-atom-command";

import {
  LazyWorkspaceTreeController,
  type LazyWorkspaceTreeSnapshot,
} from "./LazyWorkspaceTreeController";

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
  directoryViewRef.current = directoryView;
  const entryKinds = useMemo(
    () =>
      new Map(
        [...treeSnapshot.entries.values()].map(
          (entry) => [entry.relativePath, entry.kind] as const,
        ),
      ),
    [treeSnapshot.entries],
  );
  const loadedDirectoryPaths = useMemo(
    () =>
      [...treeSnapshot.entries.values()]
        .filter((entry) => entry.kind === "directory")
        .map((entry) => `${entry.relativePath}/`),
    [treeSnapshot.entries],
  );
  const entryKindsRef = useRef<ReadonlyMap<string, ProjectDirectoryEntry["kind"]>>(entryKinds);
  entryKindsRef.current = entryKinds;
  const treeEntriesRef = useRef(treeSnapshot.entries);
  treeEntriesRef.current = treeSnapshot.entries;
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
  const loadDirectory = useCallback(
    async (relativeDirectory: string, view: ProjectDirectoryView) => {
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
    if (pathSearch.entries.length === 0) {
      setPrimedSearchKey(searchResultKey);
      return;
    }

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
    (!hasCurrentSearch || pathSearch.isPending || searchResultKey !== primedSearchKey);
  return { isSearchPending };
}
