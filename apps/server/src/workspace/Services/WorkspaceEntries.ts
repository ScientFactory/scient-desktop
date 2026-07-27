import { Data, Effect, ServiceMap } from "effect";

import type {
  FilesystemBrowseInput,
  FilesystemBrowseResult,
  ProjectDiscoverScriptsInput,
  ProjectDiscoverScriptsResult,
  ProjectListDirectoriesInput,
  ProjectListDirectoriesResult,
  ProjectSearchEntriesInput,
  ProjectSearchEntriesResult,
  ProjectSearchLocalEntriesInput,
  ProjectSearchLocalEntriesResult,
} from "@synara/contracts";

import type { WorkspaceFileSuffixResolution } from "../../workspaceEntries";

export interface WorkspaceEntriesShape {
  readonly browse: (
    input: FilesystemBrowseInput,
  ) => Effect.Effect<FilesystemBrowseResult, WorkspaceEntriesError>;
  readonly search: (
    input: ProjectSearchEntriesInput,
  ) => Effect.Effect<ProjectSearchEntriesResult, WorkspaceEntriesError>;
  readonly discoverScripts: (
    input: ProjectDiscoverScriptsInput,
  ) => Effect.Effect<ProjectDiscoverScriptsResult, WorkspaceEntriesError>;
  readonly listDirectories: (
    input: ProjectListDirectoriesInput,
  ) => Effect.Effect<ProjectListDirectoriesResult, WorkspaceEntriesError>;
  readonly searchLocal: (
    input: ProjectSearchLocalEntriesInput,
  ) => Effect.Effect<ProjectSearchLocalEntriesResult, WorkspaceEntriesError>;
  // Resolve a bare/partial workspace-relative reference (basename or tail path)
  // against the tracked workspace, reporting whether it resolved to a unique
  // file, is ambiguous (with the competing matches), or matched nothing.
  readonly resolveFileBySuffix: (input: {
    readonly cwd: string;
    readonly relativePath: string;
  }) => Effect.Effect<WorkspaceFileSuffixResolution, WorkspaceEntriesError>;
  readonly invalidate: (cwd: string) => Effect.Effect<void, never>;
}

export class WorkspaceEntries extends ServiceMap.Service<WorkspaceEntries, WorkspaceEntriesShape>()(
  "synara/workspace/Services/WorkspaceEntries",
) {}

export class WorkspaceEntriesError extends Data.TaggedError("WorkspaceEntriesError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export function toWorkspaceEntriesError(operation: string, cause: unknown): WorkspaceEntriesError {
  return new WorkspaceEntriesError({
    message: cause instanceof Error ? cause.message : `Failed to ${operation}: ${String(cause)}`,
    cause,
  });
}
