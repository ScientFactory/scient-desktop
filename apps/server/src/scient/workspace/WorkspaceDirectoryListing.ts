// @effect-diagnostics nodeBuiltinImport:off
/**
 * Scient's one-level workspace directory listing for the Files view. It lists
 * a directory canonically inside the workspace root, hides internal entries
 * for the selected view, and marks owner-only entries read-only.
 */
import * as NodeFSP from "node:fs/promises";

import {
  ProjectDirectoryFailure,
  ProjectDirectoryOperation,
  type ProjectListDirectoryInput,
  type ProjectListDirectoryResult,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as WorkspacePaths from "../../workspace/WorkspacePaths.ts";
import { workspaceEntryDisposition, workspaceEntryVisibleInView } from "./WorkspaceEntryPolicy.ts";

export type WorkspaceRootNormalizationError =
  | WorkspacePaths.WorkspaceRootNotExistsError
  | WorkspacePaths.WorkspaceRootCreateFailedError
  | WorkspacePaths.WorkspaceRootStatFailedError
  | WorkspacePaths.WorkspaceRootNotDirectoryError;

export class WorkspaceDirectoryError extends Schema.TaggedError<WorkspaceDirectoryError>()(
  "WorkspaceDirectoryError",
  {
    cwd: Schema.String,
    relativeDirectory: Schema.String,
    failure: ProjectDirectoryFailure,
    resolvedPath: Schema.optional(Schema.String),
    resolvedWorkspaceRoot: Schema.optional(Schema.String),
    operation: Schema.optional(ProjectDirectoryOperation),
    operationPath: Schema.optional(Schema.String),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    switch (this.failure) {
      case "path_not_directory":
        return `Workspace path '${this.relativeDirectory}' in '${this.cwd}' is not a directory.`;
      case "path_not_visible":
        return `Workspace directory '${this.relativeDirectory}' is not available in the selected Files view.`;
      case "resolved_path_outside_root":
        return `Workspace directory '${this.relativeDirectory}' resolves outside '${this.cwd}'.`;
      default:
        return `Failed to list workspace directory '${this.relativeDirectory}' in '${this.cwd}'.`;
    }
  }
}

export const WorkspaceEntriesListDirectoryError = Schema.Union([
  WorkspacePaths.WorkspaceRootNotExistsError,
  WorkspacePaths.WorkspaceRootCreateFailedError,
  WorkspacePaths.WorkspaceRootStatFailedError,
  WorkspacePaths.WorkspaceRootNotDirectoryError,
  WorkspacePaths.WorkspacePathOutsideRootError,
  WorkspaceDirectoryError,
]);
export type WorkspaceEntriesListDirectoryError = typeof WorkspaceEntriesListDirectoryError.Type;

export const makeListDirectory = (deps: {
  readonly path: Path.Path;
  readonly workspacePaths: WorkspacePaths.WorkspacePaths["Service"];
  readonly normalizeWorkspaceRoot: (
    cwd: string,
  ) => Effect.Effect<string, WorkspaceRootNormalizationError>;
}) => {
  const { path, workspacePaths, normalizeWorkspaceRoot } = deps;
  return Effect.fn("WorkspaceEntries.listDirectory")(function* (
    input: ProjectListDirectoryInput,
  ): Effect.fn.Return<ProjectListDirectoryResult, WorkspaceEntriesListDirectoryError> {
    const normalizedCwd = yield* normalizeWorkspaceRoot(input.cwd);
    const requestedDirectory = input.relativeDirectory;
    const target =
      requestedDirectory.length === 0
        ? { absolutePath: normalizedCwd, relativePath: "" }
        : yield* workspacePaths.resolveRelativePathWithinRoot({
            workspaceRoot: normalizedCwd,
            relativePath: requestedDirectory,
          });

    const requestedDisposition = workspaceEntryDisposition(target.relativePath);
    if (!workspaceEntryVisibleInView(requestedDisposition.visibility, input.view)) {
      return yield* new WorkspaceDirectoryError({
        cwd: normalizedCwd,
        relativeDirectory: target.relativePath,
        failure: "path_not_visible",
        resolvedPath: target.absolutePath,
      });
    }

    const targetStat = yield* Effect.tryPromise({
      try: () => NodeFSP.lstat(target.absolutePath),
      catch: (cause) =>
        new WorkspaceDirectoryError({
          cwd: normalizedCwd,
          relativeDirectory: target.relativePath,
          failure: "operation_failed",
          resolvedPath: target.absolutePath,
          operation: "lstat-directory",
          operationPath: target.absolutePath,
          cause,
        }),
    });
    if (targetStat.isSymbolicLink() || !targetStat.isDirectory()) {
      return yield* new WorkspaceDirectoryError({
        cwd: normalizedCwd,
        relativeDirectory: target.relativePath,
        failure: "path_not_directory",
        resolvedPath: target.absolutePath,
      });
    }

    const realWorkspaceRoot = yield* Effect.tryPromise({
      try: () => NodeFSP.realpath(normalizedCwd),
      catch: (cause) =>
        new WorkspaceDirectoryError({
          cwd: normalizedCwd,
          relativeDirectory: target.relativePath,
          failure: "operation_failed",
          resolvedPath: target.absolutePath,
          operation: "realpath-workspace-root",
          operationPath: normalizedCwd,
          cause,
        }),
    });
    const realTargetPath = yield* Effect.tryPromise({
      try: () => NodeFSP.realpath(target.absolutePath),
      catch: (cause) =>
        new WorkspaceDirectoryError({
          cwd: normalizedCwd,
          relativeDirectory: target.relativePath,
          failure: "operation_failed",
          resolvedPath: target.absolutePath,
          operation: "realpath-directory",
          operationPath: target.absolutePath,
          cause,
        }),
    });
    const relativeRealDirectory = path.relative(realWorkspaceRoot, realTargetPath);
    if (
      relativeRealDirectory.startsWith(`..${path.sep}`) ||
      relativeRealDirectory === ".." ||
      path.isAbsolute(relativeRealDirectory)
    ) {
      return yield* new WorkspaceDirectoryError({
        cwd: normalizedCwd,
        relativeDirectory: target.relativePath,
        failure: "resolved_path_outside_root",
        resolvedWorkspaceRoot: realWorkspaceRoot,
        resolvedPath: realTargetPath,
      });
    }
    const canonicalDirectory = relativeRealDirectory.replaceAll("\\", "/");
    const canonicalDisposition = workspaceEntryDisposition(canonicalDirectory);
    if (!workspaceEntryVisibleInView(canonicalDisposition.visibility, input.view)) {
      return yield* new WorkspaceDirectoryError({
        cwd: normalizedCwd,
        relativeDirectory: target.relativePath,
        failure: "path_not_visible",
        resolvedWorkspaceRoot: realWorkspaceRoot,
        resolvedPath: realTargetPath,
      });
    }

    const dirents = yield* Effect.tryPromise({
      try: () => NodeFSP.readdir(realTargetPath, { withFileTypes: true }),
      catch: (cause) =>
        new WorkspaceDirectoryError({
          cwd: normalizedCwd,
          relativeDirectory: target.relativePath,
          failure: "operation_failed",
          resolvedPath: realTargetPath,
          operation: "read-directory",
          operationPath: realTargetPath,
          cause,
        }),
    });

    const entries: ProjectListDirectoryResult["entries"][number][] = [];
    for (const dirent of dirents) {
      const kind = dirent.isDirectory()
        ? ("directory" as const)
        : dirent.isFile()
          ? ("file" as const)
          : dirent.isSymbolicLink()
            ? ("symlink" as const)
            : null;
      if (kind === null) continue;

      const relativePath =
        target.relativePath.length === 0 ? dirent.name : `${target.relativePath}/${dirent.name}`;
      const canonicalRelativePath =
        canonicalDirectory.length === 0 ? dirent.name : `${canonicalDirectory}/${dirent.name}`;
      const disposition = workspaceEntryDisposition(relativePath);
      const canonicalChildDisposition = workspaceEntryDisposition(canonicalRelativePath);
      if (
        !workspaceEntryVisibleInView(disposition.visibility, input.view) ||
        !workspaceEntryVisibleInView(canonicalChildDisposition.visibility, input.view)
      ) {
        continue;
      }

      entries.push({
        name: dirent.name,
        relativePath,
        kind,
        readOnly:
          kind === "symlink" ||
          disposition.mutation === "owner" ||
          canonicalChildDisposition.mutation === "owner",
      });
    }

    const kindRank = { directory: 0, file: 1, symlink: 2 } as const;
    return {
      entries: entries.toSorted(
        (left, right) =>
          kindRank[left.kind] - kindRank[right.kind] || left.name.localeCompare(right.name),
      ),
      complete: true,
    };
  });
};
