// @effect-diagnostics nodeBuiltinImport:off
/**
 * WorkspaceFileSystem - Effect service contract for workspace file mutations.
 *
 * Owns workspace-root-relative file read/write operations and their associated
 * safety checks and cache invalidation hooks. Reads also accept absolute host
 * paths so clients can show files an agent left outside the workspace; writes
 * never leave the root.
 *
 * @module WorkspaceFileSystem
 */
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";

import type {
  ProjectReadFileInput,
  ProjectReadFileResult,
  ProjectWriteFileInput,
  ProjectWriteFileResult,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as WorkspaceEntries from "./WorkspaceEntries.ts";
import * as WorkspacePaths from "./WorkspacePaths.ts";
// SCIENT-FORK:START — saves, creates, renames and the open-file watch.
import {
  WorkspaceFileExistsError,
  WorkspaceFileRevisionConflictError,
} from "../scient/workspace/WorkspaceFileErrors.ts";
import {
  makeWorkspaceFileMutations,
  revisionForBytes,
  type WorkspaceFileMutationMethods,
} from "../scient/workspace/WorkspaceFileMutations.ts";
import {
  makeWorkspaceFileWatch,
  type WorkspaceFileWatchMethods,
} from "../scient/workspace/WorkspaceFileWatch.ts";
// SCIENT-FORK:END

const PROJECT_READ_FILE_MAX_BYTES = 1024 * 1024;

export class WorkspaceFileSystemOperationError extends Schema.TaggedError<WorkspaceFileSystemOperationError>()(
  "WorkspaceFileSystemOperationError",
  {
    workspaceRoot: Schema.String,
    relativePath: Schema.String,
    resolvedPath: Schema.String,
    operationPath: Schema.String,
    operation: Schema.Literals([
      "realpath-workspace-root",
      "realpath-target",
      "realpath-watch-directory",
      "open",
      "stat",
      "read",
      "close",
      "make-directory",
      "write-file",
      "atomic-write-file",
      "link",
      "unlink",
      "watch",
    ]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Workspace file operation '${this.operation}' failed at '${this.operationPath}' for resolved path '${this.resolvedPath}' (requested as '${this.relativePath}' in '${this.workspaceRoot}').`;
  }
}

export class WorkspaceFilePathEscapeError extends Schema.TaggedError<WorkspaceFilePathEscapeError>()(
  "WorkspaceFilePathEscapeError",
  {
    workspaceRoot: Schema.String,
    relativePath: Schema.String,
    resolvedWorkspaceRoot: Schema.String,
    resolvedPath: Schema.String,
  },
) {
  override get message(): string {
    return `Workspace file '${this.relativePath}' resolves outside workspace root '${this.workspaceRoot}': ${this.resolvedPath}`;
  }
}

export class WorkspacePathNotFileError extends Schema.TaggedError<WorkspacePathNotFileError>()(
  "WorkspacePathNotFileError",
  {
    workspaceRoot: Schema.String,
    relativePath: Schema.String,
    resolvedPath: Schema.String,
  },
) {
  override get message(): string {
    return `Workspace path '${this.relativePath}' in '${this.workspaceRoot}' is not a file: ${this.resolvedPath}`;
  }
}

export class WorkspaceBinaryFileError extends Schema.TaggedError<WorkspaceBinaryFileError>()(
  "WorkspaceBinaryFileError",
  {
    workspaceRoot: Schema.String,
    relativePath: Schema.String,
    resolvedPath: Schema.String,
  },
) {
  override get message(): string {
    return `Workspace file '${this.relativePath}' in '${this.workspaceRoot}' is binary and cannot be previewed as text.`;
  }
}

// SCIENT-FORK:START — mutation errors and types, kept importable from here.
export { WorkspaceFileExistsError, WorkspaceFileRevisionConflictError };
export type {
  WorkspaceCreateBinaryFileInput,
  WorkspaceWriteTargetInspection,
} from "../scient/workspace/WorkspaceFileMutations.ts";
// SCIENT-FORK:END

export const WorkspaceFileSystemError = Schema.Union([
  WorkspaceFileSystemOperationError,
  WorkspaceFilePathEscapeError,
  WorkspacePathNotFileError,
  WorkspaceBinaryFileError,
  WorkspaceFileRevisionConflictError,
  WorkspaceFileExistsError,
]);
export type WorkspaceFileSystemError = typeof WorkspaceFileSystemError.Type;

/** Service tag for workspace file operations. */
export class WorkspaceFileSystem extends Context.Service<
  WorkspaceFileSystem,
  {
    /**
     * Read a UTF-8 text file relative to the workspace root, or any host file by
     * absolute path. A relative path stays inside the root, symlinks included:
     * this is the read every feature that works on project files uses, and the
     * one saves and renames confirm their target with.
     */
    readonly readFile: (
      input: ProjectReadFileInput,
    ) => Effect.Effect<
      ProjectReadFileResult,
      WorkspaceFileSystemError | WorkspacePaths.WorkspacePathOutsideRootError
    >;
    /**
     * Read a file to show it. Viewing never depends on the project boundary: a
     * relative path that climbs out of the root and a symlink that leads out of
     * it are read in place, read-only, like an absolute host path. Only the
     * file viewer uses this; nothing that changes or processes project files
     * should.
     */
    readonly viewFile: (
      input: ProjectReadFileInput,
    ) => Effect.Effect<
      ProjectReadFileResult,
      WorkspaceFileSystemError | WorkspacePaths.WorkspacePathOutsideRootError
    >;
    /**
     * Write a file relative to the workspace root.
     *
     * Creates parent directories as needed and rejects paths that escape the
     * workspace root.
     */
    readonly writeFile: (
      input: ProjectWriteFileInput,
    ) => Effect.Effect<
      ProjectWriteFileResult,
      WorkspaceFileSystemError | WorkspacePaths.WorkspacePathOutsideRootError
    >;
  } &
    // SCIENT-FORK:START — save, create, rename and watch methods.
    WorkspaceFileMutationMethods &
    WorkspaceFileWatchMethods
  // SCIENT-FORK:END
>()("t3/workspace/WorkspaceFileSystem") {}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const workspacePaths = yield* WorkspacePaths.WorkspacePaths;
  const workspaceEntries = yield* WorkspaceEntries.WorkspaceEntries;

  /**
   * Resolves the file a read targets, for one of two purposes.
   *
   * - `view`: viewing never depends on the project boundary. An absolute path,
   *   a relative path that climbs out of the root and a symlink that leads out
   *   of it all read the host file in place, read-only.
   * - `contained`: the read for anything that works on project files, and the
   *   one a save or rename relies on to confirm what it is about to change. A
   *   relative path stays inside the root, symlinks included, and fails
   *   otherwise, exactly as writes do.
   */
  const resolveReadTarget = Effect.fn("WorkspaceFileSystem.resolveReadTarget")(function* (
    input: ProjectReadFileInput,
    purpose: "view" | "contained",
  ) {
    // A path names one exact file, whitespace included, so it is used as given.
    const requestedPath = input.relativePath;
    const isOutside = (realRoot: string, realTarget: string) => {
      const relative = path.relative(realRoot, realTarget);
      return relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
    };
    // A host path is always read-only here. It is reported as outside the
    // workspace only when it is: an absolute spelling of a workspace file is
    // read-only for being addressed that way, not for where it lives.
    const readHostFile = (hostPath: string) =>
      Effect.tryPromise({
        try: async () => {
          const realTargetPath = await NodeFSP.realpath(hostPath);
          const realRoot = await NodeFSP.realpath(input.cwd).catch(() => null);
          return {
            relativePath: requestedPath,
            realTargetPath,
            readOnly: true,
            outsideWorkspace: realRoot !== null && isOutside(realRoot, realTargetPath),
          };
        },
        catch: (cause) =>
          new WorkspaceFileSystemOperationError({
            workspaceRoot: input.cwd,
            relativePath: input.relativePath,
            resolvedPath: hostPath,
            operationPath: hostPath,
            operation: "realpath-target",
            cause,
          }),
      });
    if (path.isAbsolute(requestedPath)) {
      return yield* readHostFile(requestedPath);
    }

    const resolveWithinRoot = workspacePaths.resolveRelativePathWithinRoot({
      workspaceRoot: input.cwd,
      relativePath: input.relativePath,
    });
    if (purpose === "view") {
      const containedTarget = yield* resolveWithinRoot.pipe(Effect.option);
      if (containedTarget._tag === "None") {
        return yield* readHostFile(path.resolve(input.cwd, requestedPath));
      }
    }
    const target = yield* resolveWithinRoot;
    const realWorkspaceRoot = yield* Effect.tryPromise({
      try: () => NodeFSP.realpath(input.cwd),
      catch: (cause) =>
        new WorkspaceFileSystemOperationError({
          workspaceRoot: input.cwd,
          relativePath: input.relativePath,
          resolvedPath: target.absolutePath,
          operationPath: input.cwd,
          operation: "realpath-workspace-root",
          cause,
        }),
    });
    const realTargetPath = yield* Effect.tryPromise({
      try: () => NodeFSP.realpath(target.absolutePath),
      catch: (cause) =>
        new WorkspaceFileSystemOperationError({
          workspaceRoot: input.cwd,
          relativePath: input.relativePath,
          resolvedPath: target.absolutePath,
          operationPath: target.absolutePath,
          operation: "realpath-target",
          cause,
        }),
    });
    if (isOutside(realWorkspaceRoot, realTargetPath)) {
      if (purpose === "contained") {
        return yield* new WorkspaceFilePathEscapeError({
          workspaceRoot: input.cwd,
          relativePath: input.relativePath,
          resolvedWorkspaceRoot: realWorkspaceRoot,
          resolvedPath: realTargetPath,
        });
      }
      // A symlink inside the project that leads out of it: show the file it
      // points to, but never edit it through the project.
      return {
        relativePath: target.relativePath,
        realTargetPath,
        readOnly: true,
        outsideWorkspace: true,
      };
    }
    const canonicalRelativePath = path
      .relative(realWorkspaceRoot, realTargetPath)
      .replaceAll("\\", "/");
    return {
      relativePath: target.relativePath,
      realTargetPath,
      readOnly: canonicalRelativePath !== target.relativePath,
      outsideWorkspace: false,
    };
  });

  const readResolvedFile = Effect.fn("WorkspaceFileSystem.readResolvedFile")(function* (
    input: ProjectReadFileInput,
    purpose: "view" | "contained",
  ) {
    const target = yield* resolveReadTarget(input, purpose);
    const realTargetPath = target.realTargetPath;

    return yield* Effect.acquireUseRelease(
      Effect.tryPromise({
        // Non-blocking so a FIFO cannot hang the open; the stat below rejects
        // it. Regular files ignore the flag. The target was already resolved,
        // so its last component is not a link: refusing to follow one means a
        // file swapped for a symlink after that check fails here instead of
        // being read under the flags decided for the original. Windows lacks
        // both flags.
        try: () =>
          NodeFSP.open(
            realTargetPath,
            NodeFS.constants.O_RDONLY |
              (NodeFS.constants.O_NONBLOCK ?? 0) |
              (NodeFS.constants.O_NOFOLLOW ?? 0),
          ),
        catch: (cause) =>
          new WorkspaceFileSystemOperationError({
            workspaceRoot: input.cwd,
            relativePath: input.relativePath,
            resolvedPath: realTargetPath,
            operationPath: realTargetPath,
            operation: "open",
            cause,
          }),
      }),
      (handle) =>
        Effect.gen(function* () {
          const stat = yield* Effect.tryPromise({
            try: () => handle.stat(),
            catch: (cause) =>
              new WorkspaceFileSystemOperationError({
                workspaceRoot: input.cwd,
                relativePath: input.relativePath,
                resolvedPath: realTargetPath,
                operationPath: realTargetPath,
                operation: "stat",
                cause,
              }),
          });
          if (!stat.isFile()) {
            return yield* new WorkspacePathNotFileError({
              workspaceRoot: input.cwd,
              relativePath: input.relativePath,
              resolvedPath: realTargetPath,
            });
          }

          const bytesToRead = Math.min(stat.size, PROJECT_READ_FILE_MAX_BYTES);
          const buffer = Buffer.alloc(bytesToRead);
          const { bytesRead } = yield* Effect.tryPromise({
            try: () => handle.read(buffer, 0, bytesToRead, 0),
            catch: (cause) =>
              new WorkspaceFileSystemOperationError({
                workspaceRoot: input.cwd,
                relativePath: input.relativePath,
                resolvedPath: realTargetPath,
                operationPath: realTargetPath,
                operation: "read",
                cause,
              }),
          });
          const fileBytes = buffer.subarray(0, bytesRead);
          if (fileBytes.includes(0)) {
            return yield* new WorkspaceBinaryFileError({
              workspaceRoot: input.cwd,
              relativePath: input.relativePath,
              resolvedPath: realTargetPath,
            });
          }

          return {
            relativePath: target.relativePath,
            contents: new TextDecoder("utf-8").decode(fileBytes),
            byteLength: stat.size,
            truncated: stat.size > PROJECT_READ_FILE_MAX_BYTES,
            revision: revisionForBytes(fileBytes),
            ...(target.readOnly ? { readOnly: true } : {}),
            ...(target.outsideWorkspace ? { outsideWorkspace: true } : {}),
          };
        }),
      (handle) =>
        Effect.tryPromise({
          try: () => handle.close(),
          catch: (cause) =>
            new WorkspaceFileSystemOperationError({
              workspaceRoot: input.cwd,
              relativePath: input.relativePath,
              resolvedPath: realTargetPath,
              operationPath: realTargetPath,
              operation: "close",
              cause,
            }),
        }),
    );
  });

  const readFile: WorkspaceFileSystem["Service"]["readFile"] = (input) =>
    readResolvedFile(input, "contained");
  const viewFile: WorkspaceFileSystem["Service"]["viewFile"] = (input) =>
    readResolvedFile(input, "view");
  // SCIENT-FORK:START — revision-checked saves, exclusive creates and renames.
  const { createBinaryFile, inspectWriteTarget, renameFile, writeFile } =
    yield* makeWorkspaceFileMutations({
      fileSystem,
      path,
      workspacePaths,
      workspaceEntries,
      readFile,
    });
  // SCIENT-FORK:END

  // SCIENT-FORK:START — open-file watch.
  const { watchFile } = makeWorkspaceFileWatch({ path, workspacePaths });
  // SCIENT-FORK:END

  return WorkspaceFileSystem.of({
    createBinaryFile,
    inspectWriteTarget,
    readFile,
    renameFile,
    viewFile,
    watchFile,
    writeFile,
  });
});

export const layer = Layer.effect(WorkspaceFileSystem, make);
