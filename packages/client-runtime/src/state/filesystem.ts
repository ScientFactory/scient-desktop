import { type FilesystemBrowseEntry, WS_METHODS } from "@t3tools/contracts";
import { Atom } from "effect/unstable/reactivity";

import type { EnvironmentConnectionPhase } from "../connection/presentation.ts";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  canNavigateUp,
  ensureBrowseDirectoryPath,
  getBrowseDirectoryPath,
  getBrowseLeafPathSegment,
  getBrowseParentPath,
  hasTrailingPathSeparator,
  isFilesystemBrowseQuery,
  isUnsupportedWindowsProjectPath,
} from "./projects.ts";
import { createEnvironmentRpcQueryAtomFamily } from "./runtime.ts";

export interface FilesystemBrowseScope {
  readonly baseDirectoryPath: string;
  readonly alias?: {
    readonly path: string;
    readonly resolvedPath: string;
  };
}

export function canonicalizeUneditedBrowseQuery(
  currentQuery: string,
  initialQuery: string,
  resolvedInitialPath: string,
): string {
  return currentQuery === initialQuery
    ? ensureBrowseDirectoryPath(resolvedInitialPath)
    : currentQuery;
}

function resolveScopedBrowseQuery(
  query: string,
  platform: string,
  scope: FilesystemBrowseScope | null,
): string {
  const alias = scope?.alias;
  if (alias && query.startsWith(alias.path)) {
    return `${ensureBrowseDirectoryPath(alias.resolvedPath)}${query.slice(alias.path.length)}`;
  }
  if (isFilesystemBrowseQuery(query, platform) || scope === null) {
    return query;
  }
  // Keep an absolute Windows path intact on non-Windows environments. The
  // picker stays in filesystem mode and its existing validation can explain
  // the platform mismatch instead of interpreting the drive as a folder name.
  if (isUnsupportedWindowsProjectPath(query, platform)) {
    return query;
  }
  const scopedBaseDirectory =
    alias && ensureBrowseDirectoryPath(scope.baseDirectoryPath) === alias.path
      ? alias.resolvedPath
      : scope.baseDirectoryPath;
  return `${ensureBrowseDirectoryPath(scopedBaseDirectory)}${query}`;
}

export function getFilesystemBrowsePath(
  query: string,
  platform = "",
  enabled = true,
  scope: FilesystemBrowseScope | null = null,
) {
  const resolvedQuery = resolveScopedBrowseQuery(query, platform, scope);
  const isUnsupportedPath =
    scope !== null && isUnsupportedWindowsProjectPath(resolvedQuery, platform);
  const isBrowsing =
    enabled &&
    (scope !== null || isFilesystemBrowseQuery(resolvedQuery, platform) || isUnsupportedPath);
  const directoryPath =
    isBrowsing && !isUnsupportedPath ? getBrowseDirectoryPath(resolvedQuery) : "";
  const filterQuery =
    isBrowsing && !isUnsupportedPath && !hasTrailingPathSeparator(resolvedQuery)
      ? getBrowseLeafPathSegment(resolvedQuery)
      : "";
  const parentPath = isBrowsing ? getBrowseParentPath(directoryPath) : null;

  return {
    isBrowsing,
    resolvedQuery,
    directoryPath,
    filterQuery,
    parentPath,
    canBrowseUp: isBrowsing && canNavigateUp(directoryPath),
  };
}

export function filterFilesystemBrowseEntries(
  entries: ReadonlyArray<FilesystemBrowseEntry>,
  query: string,
) {
  const lowerQuery = query.toLowerCase();
  const showHidden = query.startsWith(".");
  const visibleEntries = entries.filter(
    (entry) =>
      entry.name.toLowerCase().startsWith(lowerQuery) &&
      (showHidden || !entry.name.startsWith(".")),
  );
  const exactEntry =
    query.length > 0 ? (visibleEntries.find((entry) => entry.name === query) ?? null) : null;

  return { visibleEntries, exactEntry };
}

export function createBrowseNavigationCoordinator() {
  let generation = 0;

  return {
    invalidate: () => {
      generation += 1;
    },
    run: async (load: () => Promise<void>, commit: () => void) => {
      const navigationGeneration = ++generation;
      await load();
      if (navigationGeneration !== generation) {
        return false;
      }
      commit();
      return true;
    },
  };
}

export function canPreloadBrowsePath(
  connectionPhase: EnvironmentConnectionPhase | null | undefined,
): boolean {
  return connectionPhase === "connected";
}

export function createFilesystemEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    browse: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:filesystem:browse",
      tag: WS_METHODS.filesystemBrowse,
    }),
  };
}
