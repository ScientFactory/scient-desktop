// FILE: useDockWorkspaceExplorer.ts
// Purpose: Shared directory-expansion and search state for dock-hosted explorers.
// Layer: Chat right-dock UI state

import { useCallback, useState } from "react";

export function useDockWorkspaceExplorer() {
  const [expandedDirectories, setExpandedDirectories] = useState<ReadonlySet<string>>(
    () => new Set<string>(),
  );
  const [searchQuery, setSearchQuery] = useState("");

  const toggleDirectory = useCallback((path: string) => {
    setExpandedDirectories((current) => {
      const next = new Set(current);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  }, []);

  return {
    expandedDirectories,
    searchQuery,
    setSearchQuery,
    toggleDirectory,
  };
}
