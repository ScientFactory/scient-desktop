// FILE: useDockWorkspaceExplorer.ts
// Purpose: Shared directory-expansion and search state for dock-hosted explorers.
// Layer: Chat right-dock UI state

import { useCallback, useEffect, useState } from "react";

export interface DockWorkspaceExplorerController {
  readonly expandedDirectories: ReadonlySet<string>;
  readonly searchQuery: string;
  readonly setSearchQuery: (query: string) => void;
  readonly toggleDirectory: (path: string) => void;
}

interface DockWorkspaceExplorerState {
  readonly scopeKey: string;
  readonly expandedDirectories: ReadonlySet<string>;
  readonly searchQuery: string;
}

function emptyExplorerState(scopeKey: string): DockWorkspaceExplorerState {
  return {
    scopeKey,
    expandedDirectories: new Set<string>(),
    searchQuery: "",
  };
}

export function useDockWorkspaceExplorer(scopeKey: string): DockWorkspaceExplorerController {
  const [state, setState] = useState<DockWorkspaceExplorerState>(() =>
    emptyExplorerState(scopeKey),
  );
  // Derive an empty state synchronously so the first render for a new thread or
  // workspace can never display the previous scope's query or expanded paths.
  const scopedState = state.scopeKey === scopeKey ? state : emptyExplorerState(scopeKey);

  useEffect(() => {
    setState((current) => (current.scopeKey === scopeKey ? current : emptyExplorerState(scopeKey)));
  }, [scopeKey]);

  const setSearchQuery = useCallback(
    (query: string) => {
      setState((current) => {
        const scopedCurrent =
          current.scopeKey === scopeKey ? current : emptyExplorerState(scopeKey);
        return scopedCurrent.searchQuery === query
          ? scopedCurrent
          : { ...scopedCurrent, searchQuery: query };
      });
    },
    [scopeKey],
  );

  const toggleDirectory = useCallback(
    (path: string) => {
      setState((current) => {
        const scopedCurrent =
          current.scopeKey === scopeKey ? current : emptyExplorerState(scopeKey);
        const next = new Set(scopedCurrent.expandedDirectories);
        if (next.has(path)) {
          next.delete(path);
        } else {
          next.add(path);
        }
        return { ...scopedCurrent, expandedDirectories: next };
      });
    },
    [scopeKey],
  );

  return {
    expandedDirectories: scopedState.expandedDirectories,
    searchQuery: scopedState.searchQuery,
    setSearchQuery,
    toggleDirectory,
  };
}
