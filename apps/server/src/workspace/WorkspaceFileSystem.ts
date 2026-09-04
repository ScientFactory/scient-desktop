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
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";

import type {
  ProjectFileWatchEvent,
  ProjectReadFileInput,
  ProjectReadFileResult,
  ProjectRenameFileInput,
  ProjectRenameFileResult,
  ProjectWriteFileInput,
  ProjectWriteFileResult,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SynchronizedRef from "effect/SynchronizedRef";
import * as Stream from "effect/Stream";

import { writeFileStringAtomically } from "../atomicWrite.ts";
import * as WorkspaceEntries from "./WorkspaceEntries.ts";
import * as WorkspacePaths from "./WorkspacePaths.ts";

const PROJECT_READ_FILE_MAX_BYTES = 1024 * 1024;

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}

export class WorkspaceFileSystemOperationError extends Schema.TaggedErrorClass<WorkspaceFileSystemOperationError>()(
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

export class WorkspaceFilePathEscapeError extends Schema.TaggedErrorClass<WorkspaceFilePathEscapeError>()(
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

export class WorkspacePathNotFileError extends Schema.TaggedErrorClass<WorkspacePathNotFileError>()(
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

export class WorkspaceBinaryFileError extends Schema.TaggedErrorClass<WorkspaceBinaryFileError>()(
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

export class WorkspaceFileRevisionConflictError extends Schema.TaggedErrorClass<WorkspaceFileRevisionConflictError>()(
  "WorkspaceFileRevisionConflictError",
  {
    workspaceRoot: Schema.String,
    relativePath: Schema.String,
    resolvedPath: Schema.String,
    currentRevision: Schema.String,
  },
) {
  override get message(): string {
    return `Workspace file '${this.relativePath}' changed after it was opened. Reload it before saving.`;
  }
}

export class WorkspaceFileExistsError extends Schema.TaggedErrorClass<WorkspaceFileExistsError>()(
  "WorkspaceFileExistsError",
  {
    workspaceRoot: Schema.String,
    relativePath: Schema.String,
    resolvedPath: Schema.String,
  },
) {
  override get message(): string {
    return `Workspace file '${this.relativePath}' already exists in '${this.workspaceRoot}'.`;
  }
}

export const WorkspaceFileSystemError = Schema.Union([
  WorkspaceFileSystemOperationError,
  WorkspaceFilePathEscapeError,
  WorkspacePathNotFileError,
  WorkspaceBinaryFileError,
  WorkspaceFileRevisionConflictError,
  WorkspaceFileExistsError,
]);
export type WorkspaceFileSystemError = typeof WorkspaceFileSystemError.Type;

export interface WorkspaceWriteTargetInspection {
  readonly relativePath: string;
  readonly canonicalRelativePath: string;
  readonly traversesSymlink: boolean;
}

export interface WorkspaceCreateBinaryFileInput {
  readonly cwd: string;
  readonly relativePath: string;
  readonly bytes: Uint8Array;
}

/** Service tag for workspace file operations. */
export class WorkspaceFileSystem extends Context.Service<
  WorkspaceFileSystem,
  {
    /**
     * Read a UTF-8 text file relative to the workspace root, or any host file by
     * absolute path.
     */
    readonly readFile: (
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
    /** Resolve the canonical destination used by a workspace write. */
    readonly inspectWriteTarget: (
      input: Pick<ProjectWriteFileInput, "cwd" | "relativePath">,
    ) => Effect.Effect<
      WorkspaceWriteTargetInspection,
      WorkspaceFileSystemError | WorkspacePaths.WorkspacePathOutsideRootError
    >;
    /** Rename a regular file without ever replacing the destination. */
    readonly renameFile: (
      input: ProjectRenameFileInput,
    ) => Effect.Effect<
      ProjectRenameFileResult,
      WorkspaceFileSystemError | WorkspacePaths.WorkspacePathOutsideRootError
    >;
    /** Atomically create a binary file and fail if the destination exists. */
    readonly createBinaryFile: (
      input: WorkspaceCreateBinaryFileInput,
    ) => Effect.Effect<
      ProjectWriteFileResult,
      WorkspaceFileSystemError | WorkspacePaths.WorkspacePathOutsideRootError
    >;
    /** Observe native filesystem hints for one currently open file. */
    readonly watchFile: (
      input: ProjectReadFileInput,
    ) => Stream.Stream<
      ProjectFileWatchEvent,
      WorkspaceFileSystemError | WorkspacePaths.WorkspacePathOutsideRootError
    >;
  }
>()("t3/workspace/WorkspaceFileSystem") {}

export const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const workspacePaths = yield* WorkspacePaths.WorkspacePaths;
  const workspaceEntries = yield* WorkspaceEntries.WorkspaceEntries;
  const writeSemaphoresRef = yield* SynchronizedRef.make(new Map<string, Semaphore.Semaphore>());

  const writeSemaphoreFor = (absolutePath: string) =>
    SynchronizedRef.modifyEffect(writeSemaphoresRef, (semaphores) => {
      const existing = semaphores.get(absolutePath);
      if (existing) return Effect.succeed([existing, semaphores] as const);
      return Semaphore.make(1).pipe(
        Effect.map((semaphore) => {
          const next = new Map(semaphores);
          next.set(absolutePath, semaphore);
          return [semaphore, next] as const;
        }),
      );
    });

  const revisionForBytes = (bytes: Uint8Array): string =>
    `sha256:${NodeCrypto.createHash("sha256").update(bytes).digest("hex")}`;

  const revisionForContents = (contents: string): string =>
    revisionForBytes(new TextEncoder().encode(contents));

  /**
   * Resolves the file a read targets. Workspace-relative paths must stay inside the
   * root, symlinks included. An absolute path reads a host file in place, such as a
   * report an agent wrote to a temp directory; it gets no root check.
   */
  const resolveReadTarget = Effect.fn("WorkspaceFileSystem.resolveReadTarget")(function* (
    input: ProjectReadFileInput,
  ) {
    const requestedPath = input.relativePath.trim();
    if (path.isAbsolute(requestedPath)) {
      const realTargetPath = yield* Effect.tryPromise({
        try: () => NodeFSP.realpath(requestedPath),
        catch: (cause) =>
          new WorkspaceFileSystemOperationError({
            workspaceRoot: input.cwd,
            relativePath: input.relativePath,
            resolvedPath: requestedPath,
            operationPath: requestedPath,
            operation: "realpath-target",
            cause,
          }),
      });
      return { relativePath: requestedPath, realTargetPath, readOnly: true };
    }

    const target = yield* workspacePaths.resolveRelativePathWithinRoot({
      workspaceRoot: input.cwd,
      relativePath: input.relativePath,
    });
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
    const relativeRealPath = path.relative(realWorkspaceRoot, realTargetPath);
    if (
      relativeRealPath.startsWith(`..${path.sep}`) ||
      relativeRealPath === ".." ||
      path.isAbsolute(relativeRealPath)
    ) {
      return yield* new WorkspaceFilePathEscapeError({
        workspaceRoot: input.cwd,
        relativePath: input.relativePath,
        resolvedWorkspaceRoot: realWorkspaceRoot,
        resolvedPath: realTargetPath,
      });
    }
    const canonicalRelativePath = path
      .relative(realWorkspaceRoot, realTargetPath)
      .replaceAll("\\", "/");
    return {
      relativePath: target.relativePath,
      realTargetPath,
      readOnly: canonicalRelativePath !== target.relativePath,
    };
  });

  const readFile: WorkspaceFileSystem["Service"]["readFile"] = Effect.fn(
    "WorkspaceFileSystem.readFile",
  )(function* (input) {
    const target = yield* resolveReadTarget(input);
    const realTargetPath = target.realTargetPath;

    return yield* Effect.acquireUseRelease(
      Effect.tryPromise({
        // Non-blocking so a FIFO cannot hang the open; the stat below rejects
        // it. Regular files ignore the flag. Windows lacks it.
        try: () =>
          NodeFSP.open(
            realTargetPath,
            NodeFS.constants.O_RDONLY | (NodeFS.constants.O_NONBLOCK ?? 0),
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

  const resolveRealFileWatchTarget = Effect.fn("WorkspaceFileSystem.resolveRealFileWatchTarget")(
    function* (input: ProjectReadFileInput) {
      const target = yield* workspacePaths.resolveRelativePathWithinRoot({
        workspaceRoot: input.cwd,
        relativePath: input.relativePath,
      });
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
      const resolvedParentDirectory = yield* Effect.tryPromise({
        try: () => NodeFSP.realpath(path.dirname(target.absolutePath)),
        catch: (cause) =>
          new WorkspaceFileSystemOperationError({
            workspaceRoot: input.cwd,
            relativePath: input.relativePath,
            resolvedPath: target.absolutePath,
            operationPath: path.dirname(target.absolutePath),
            operation: "realpath-watch-directory",
            cause,
          }),
      });
      const relativeWatchDirectory = path.relative(realWorkspaceRoot, resolvedParentDirectory);
      if (
        relativeWatchDirectory.startsWith(`..${path.sep}`) ||
        relativeWatchDirectory === ".." ||
        path.isAbsolute(relativeWatchDirectory)
      ) {
        return yield* new WorkspaceFilePathEscapeError({
          workspaceRoot: input.cwd,
          relativePath: input.relativePath,
          resolvedWorkspaceRoot: realWorkspaceRoot,
          resolvedPath: resolvedParentDirectory,
        });
      }
      const realTargetPath = yield* Effect.tryPromise({
        try: async () => {
          try {
            return await NodeFSP.realpath(target.absolutePath);
          } catch (error) {
            if (isNodeError(error, "ENOENT")) {
              return path.join(resolvedParentDirectory, path.basename(target.absolutePath));
            }
            throw error;
          }
        },
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
      const relativeRealPath = path.relative(realWorkspaceRoot, realTargetPath);
      if (
        relativeRealPath.startsWith(`..${path.sep}`) ||
        relativeRealPath === ".." ||
        path.isAbsolute(relativeRealPath)
      ) {
        return yield* new WorkspaceFilePathEscapeError({
          workspaceRoot: input.cwd,
          relativePath: input.relativePath,
          resolvedWorkspaceRoot: realWorkspaceRoot,
          resolvedPath: realTargetPath,
        });
      }
      // Existing file symlinks need to watch the resolved target's directory,
      // not merely the directory containing the link. Missing files already
      // resolve through their canonical parent above.
      const watchDirectory = path.dirname(realTargetPath);
      return { realTargetPath, target, watchDirectory };
    },
  );

  // Resolve the nearest existing ancestor before creating missing segments.
  // This keeps revision-less creates from escaping through a directory symlink.
  const resolveRealWriteTarget = Effect.fn("WorkspaceFileSystem.resolveRealWriteTarget")(function* (
    input: Pick<ProjectWriteFileInput, "cwd" | "relativePath">,
  ) {
    const target = yield* workspacePaths.resolveRelativePathWithinRoot({
      workspaceRoot: input.cwd,
      relativePath: input.relativePath,
    });
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
      try: async () => {
        let unresolvedSymlink = false;
        const recordSymlink = async (candidate: string) => {
          try {
            if ((await NodeFSP.lstat(candidate)).isSymbolicLink()) unresolvedSymlink = true;
          } catch (error) {
            if (!isNodeError(error, "ENOENT")) throw error;
          }
        };
        try {
          return {
            path: await NodeFSP.realpath(target.absolutePath),
            unresolvedSymlink,
            exists: true,
          };
        } catch (error) {
          if (!isNodeError(error, "ENOENT")) throw error;
          await recordSymlink(target.absolutePath);
        }

        const missingSegments = [path.basename(target.absolutePath)];
        let ancestor = path.dirname(target.absolutePath);
        for (;;) {
          try {
            const realAncestor = await NodeFSP.realpath(ancestor);
            return {
              path: path.join(realAncestor, ...missingSegments),
              unresolvedSymlink,
              exists: false,
            };
          } catch (error) {
            if (!isNodeError(error, "ENOENT")) throw error;
            await recordSymlink(ancestor);
            const parent = path.dirname(ancestor);
            if (parent === ancestor) throw error;
            missingSegments.unshift(path.basename(ancestor));
            ancestor = parent;
          }
        }
      },
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
    const relativeRealPath = path.relative(realWorkspaceRoot, realTargetPath.path);
    if (
      relativeRealPath.startsWith(`..${path.sep}`) ||
      relativeRealPath === ".." ||
      path.isAbsolute(relativeRealPath)
    ) {
      return yield* new WorkspaceFilePathEscapeError({
        workspaceRoot: input.cwd,
        relativePath: input.relativePath,
        resolvedWorkspaceRoot: realWorkspaceRoot,
        resolvedPath: realTargetPath.path,
      });
    }
    const canonicalRelativePath = relativeRealPath.replaceAll("\\", "/");
    return {
      target,
      realTargetPath: realTargetPath.path,
      canonicalRelativePath,
      traversesSymlink:
        realTargetPath.unresolvedSymlink || canonicalRelativePath !== target.relativePath,
      exists: realTargetPath.exists,
    };
  });

  const inspectWriteTarget: WorkspaceFileSystem["Service"]["inspectWriteTarget"] = Effect.fn(
    "WorkspaceFileSystem.inspectWriteTarget",
  )(function* (input) {
    const resolved = yield* resolveRealWriteTarget(input);
    return {
      relativePath: resolved.target.relativePath,
      canonicalRelativePath: resolved.canonicalRelativePath,
      traversesSymlink: resolved.traversesSymlink,
    };
  });

  // Waiting for another mutation must not let a retargeted alias move this
  // operation to a file whose lock it never acquired.
  const revalidateWriteTarget = Effect.fn("WorkspaceFileSystem.revalidateWriteTarget")(function* (
    input: Pick<ProjectWriteFileInput, "cwd" | "relativePath">,
    lockedPath: string,
  ) {
    const resolved = yield* resolveRealWriteTarget(input);
    if (resolved.realTargetPath !== lockedPath) {
      return yield* new WorkspaceFileSystemOperationError({
        workspaceRoot: input.cwd,
        relativePath: input.relativePath,
        resolvedPath: resolved.realTargetPath,
        operationPath: resolved.target.absolutePath,
        operation: "realpath-target",
        cause: new Error(
          "Workspace file target changed while waiting for its mutation lock. Retry the operation.",
        ),
      });
    }
    return resolved;
  });

  const writeFileBytesExclusively = Effect.fn("WorkspaceFileSystem.writeFileBytesExclusively")(
    function* (input: {
      readonly cwd: string;
      readonly relativePath: string;
      readonly filePath: string;
      readonly bytes: Uint8Array;
    }) {
      return yield* Effect.scoped(
        Effect.gen(function* () {
          const targetDirectory = path.dirname(input.filePath);
          const tempDirectory = yield* fileSystem
            .makeTempDirectoryScoped({
              directory: targetDirectory,
              prefix: `${path.basename(input.filePath)}.`,
            })
            .pipe(
              Effect.mapError(
                (cause) =>
                  new WorkspaceFileSystemOperationError({
                    workspaceRoot: input.cwd,
                    relativePath: input.relativePath,
                    resolvedPath: input.filePath,
                    operationPath: targetDirectory,
                    operation: "write-file",
                    cause,
                  }),
              ),
            );
          const tempPath = path.join(tempDirectory, "contents.tmp");
          yield* fileSystem.writeFile(tempPath, input.bytes).pipe(
            Effect.mapError(
              (cause) =>
                new WorkspaceFileSystemOperationError({
                  workspaceRoot: input.cwd,
                  relativePath: input.relativePath,
                  resolvedPath: input.filePath,
                  operationPath: tempPath,
                  operation: "write-file",
                  cause,
                }),
            ),
          );
          yield* Effect.tryPromise({
            try: async () => {
              const handle = await NodeFSP.open(tempPath, "r");
              try {
                await handle.sync();
              } finally {
                await handle.close();
              }
            },
            catch: (cause) =>
              new WorkspaceFileSystemOperationError({
                workspaceRoot: input.cwd,
                relativePath: input.relativePath,
                resolvedPath: input.filePath,
                operationPath: tempPath,
                operation: "write-file",
                cause,
              }),
          });
          yield* Effect.tryPromise({
            try: () => NodeFSP.link(tempPath, input.filePath),
            catch: (cause) =>
              isNodeError(cause, "EEXIST")
                ? new WorkspaceFileExistsError({
                    workspaceRoot: input.cwd,
                    relativePath: input.relativePath,
                    resolvedPath: input.filePath,
                  })
                : new WorkspaceFileSystemOperationError({
                    workspaceRoot: input.cwd,
                    relativePath: input.relativePath,
                    resolvedPath: input.filePath,
                    operationPath: input.filePath,
                    operation: "link",
                    cause,
                  }),
          });
          yield* Effect.tryPromise({
            try: async () => {
              try {
                const directoryHandle = await NodeFSP.open(targetDirectory, "r");
                try {
                  await directoryHandle.sync();
                } finally {
                  await directoryHandle.close();
                }
              } catch (cause) {
                if (
                  isNodeError(cause, "EINVAL") ||
                  isNodeError(cause, "ENOTSUP") ||
                  isNodeError(cause, "EISDIR") ||
                  isNodeError(cause, "EPERM")
                ) {
                  return;
                }
                throw cause;
              }
            },
            catch: (cause) =>
              new WorkspaceFileSystemOperationError({
                workspaceRoot: input.cwd,
                relativePath: input.relativePath,
                resolvedPath: input.filePath,
                operationPath: targetDirectory,
                operation: "link",
                cause,
              }),
          });
        }),
      );
    },
  );

  const writeFile: WorkspaceFileSystem["Service"]["writeFile"] = Effect.fn(
    "WorkspaceFileSystem.writeFile",
  )(function* (input) {
    const { realTargetPath: writeTargetPath } = yield* resolveRealWriteTarget(input);
    const writeSemaphore = yield* writeSemaphoreFor(writeTargetPath);
    return yield* writeSemaphore.withPermits(1)(
      Effect.gen(function* () {
        const { exists, target } = yield* revalidateWriteTarget(input, writeTargetPath);
        if (input.createOnly && exists) {
          return yield* new WorkspaceFileExistsError({
            workspaceRoot: input.cwd,
            relativePath: input.relativePath,
            resolvedPath: writeTargetPath,
          });
        }
        if (input.expectedRevision !== undefined) {
          const current = yield* readFile({ cwd: input.cwd, relativePath: input.relativePath });
          if (current.truncated || current.revision !== input.expectedRevision) {
            return yield* new WorkspaceFileRevisionConflictError({
              workspaceRoot: input.cwd,
              relativePath: input.relativePath,
              resolvedPath: target.absolutePath,
              currentRevision: current.revision,
            });
          }
        }

        yield* fileSystem.makeDirectory(path.dirname(writeTargetPath), { recursive: true }).pipe(
          Effect.mapError(
            (cause) =>
              new WorkspaceFileSystemOperationError({
                workspaceRoot: input.cwd,
                relativePath: input.relativePath,
                resolvedPath: writeTargetPath,
                operationPath: path.dirname(writeTargetPath),
                operation: "make-directory",
                cause,
              }),
          ),
        );
        if (input.createOnly) {
          yield* writeFileBytesExclusively({
            cwd: input.cwd,
            relativePath: input.relativePath,
            filePath: writeTargetPath,
            bytes: new TextEncoder().encode(input.contents),
          });
          yield* workspaceEntries.refresh(input.cwd);
          return {
            relativePath: target.relativePath,
            revision: revisionForContents(input.contents),
          };
        }
        const existingMode = yield* Effect.tryPromise({
          try: async () => {
            try {
              return (await NodeFSP.stat(writeTargetPath)).mode & 0o7777;
            } catch (error) {
              if (isNodeError(error, "ENOENT")) return undefined;
              throw error;
            }
          },
          catch: (cause) =>
            new WorkspaceFileSystemOperationError({
              workspaceRoot: input.cwd,
              relativePath: input.relativePath,
              resolvedPath: writeTargetPath,
              operationPath: writeTargetPath,
              operation: "stat",
              cause,
            }),
        });
        yield* writeFileStringAtomically({
          filePath: writeTargetPath,
          contents: input.contents,
          mode: existingMode,
        }).pipe(
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.provideService(Path.Path, path),
          Effect.mapError(
            (cause) =>
              new WorkspaceFileSystemOperationError({
                workspaceRoot: input.cwd,
                relativePath: input.relativePath,
                resolvedPath: writeTargetPath,
                operationPath: writeTargetPath,
                operation: "atomic-write-file",
                cause,
              }),
          ),
        );
        yield* workspaceEntries.refresh(input.cwd);
        return {
          relativePath: target.relativePath,
          revision: revisionForContents(input.contents),
        };
      }),
    );
  });

  const createBinaryFile: WorkspaceFileSystem["Service"]["createBinaryFile"] = Effect.fn(
    "WorkspaceFileSystem.createBinaryFile",
  )(function* (input) {
    const { realTargetPath } = yield* resolveRealWriteTarget(input);
    const writeSemaphore = yield* writeSemaphoreFor(realTargetPath);
    return yield* writeSemaphore.withPermits(1)(
      Effect.gen(function* () {
        const { exists, target } = yield* revalidateWriteTarget(input, realTargetPath);
        if (exists) {
          return yield* new WorkspaceFileExistsError({
            workspaceRoot: input.cwd,
            relativePath: input.relativePath,
            resolvedPath: realTargetPath,
          });
        }
        yield* fileSystem.makeDirectory(path.dirname(realTargetPath), { recursive: true }).pipe(
          Effect.mapError(
            (cause) =>
              new WorkspaceFileSystemOperationError({
                workspaceRoot: input.cwd,
                relativePath: input.relativePath,
                resolvedPath: realTargetPath,
                operationPath: path.dirname(realTargetPath),
                operation: "make-directory",
                cause,
              }),
          ),
        );
        yield* writeFileBytesExclusively({
          cwd: input.cwd,
          relativePath: input.relativePath,
          filePath: realTargetPath,
          bytes: input.bytes,
        });
        yield* workspaceEntries.refresh(input.cwd);
        return {
          relativePath: target.relativePath,
          revision: revisionForBytes(input.bytes),
        };
      }),
    );
  });

  const renameFile: WorkspaceFileSystem["Service"]["renameFile"] = Effect.fn(
    "WorkspaceFileSystem.renameFile",
  )(function* (input) {
    const source = yield* resolveRealWriteTarget(input);
    const destinationInput = {
      cwd: input.cwd,
      relativePath: input.destinationRelativePath,
    };
    const initialDestination = yield* resolveRealWriteTarget(destinationInput);
    const sourceTarget = source.target;
    if (source.realTargetPath === initialDestination.realTargetPath) {
      return yield* new WorkspaceFileExistsError({
        workspaceRoot: input.cwd,
        relativePath: input.destinationRelativePath,
        resolvedPath: initialDestination.realTargetPath,
      });
    }
    // All mutation methods lock the same canonical identities, even when a
    // client reaches the file through a workspace-root or parent alias.
    const [firstPath, secondPath] = [
      source.realTargetPath,
      initialDestination.realTargetPath,
    ].sort();
    const firstSemaphore = yield* writeSemaphoreFor(firstPath!);
    const secondSemaphore = yield* writeSemaphoreFor(secondPath!);

    return yield* firstSemaphore.withPermits(1)(
      secondSemaphore.withPermits(1)(
        Effect.gen(function* () {
          yield* revalidateWriteTarget(input, source.realTargetPath);
          const destination = yield* revalidateWriteTarget(
            destinationInput,
            initialDestination.realTargetPath,
          );
          const current = yield* readFile({ cwd: input.cwd, relativePath: input.relativePath });
          if (current.truncated || current.revision !== input.expectedRevision) {
            return yield* new WorkspaceFileRevisionConflictError({
              workspaceRoot: input.cwd,
              relativePath: input.relativePath,
              resolvedPath: sourceTarget.absolutePath,
              currentRevision: current.revision,
            });
          }
          const sourceStat = yield* Effect.tryPromise({
            try: () => NodeFSP.lstat(sourceTarget.absolutePath),
            catch: (cause) =>
              new WorkspaceFileSystemOperationError({
                workspaceRoot: input.cwd,
                relativePath: input.relativePath,
                resolvedPath: sourceTarget.absolutePath,
                operationPath: sourceTarget.absolutePath,
                operation: "stat",
                cause,
              }),
          });
          if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) {
            return yield* new WorkspacePathNotFileError({
              workspaceRoot: input.cwd,
              relativePath: input.relativePath,
              resolvedPath: sourceTarget.absolutePath,
            });
          }

          if (destination.exists) {
            return yield* new WorkspaceFileExistsError({
              workspaceRoot: input.cwd,
              relativePath: input.destinationRelativePath,
              resolvedPath: destination.realTargetPath,
            });
          }
          yield* fileSystem
            .makeDirectory(path.dirname(destination.realTargetPath), { recursive: true })
            .pipe(
              Effect.mapError(
                (cause) =>
                  new WorkspaceFileSystemOperationError({
                    workspaceRoot: input.cwd,
                    relativePath: input.destinationRelativePath,
                    resolvedPath: destination.realTargetPath,
                    operationPath: path.dirname(destination.realTargetPath),
                    operation: "make-directory",
                    cause,
                  }),
              ),
            );
          yield* Effect.tryPromise({
            try: () => NodeFSP.link(source.realTargetPath, destination.realTargetPath),
            catch: (cause) =>
              isNodeError(cause, "EEXIST")
                ? new WorkspaceFileExistsError({
                    workspaceRoot: input.cwd,
                    relativePath: input.destinationRelativePath,
                    resolvedPath: destination.realTargetPath,
                  })
                : new WorkspaceFileSystemOperationError({
                    workspaceRoot: input.cwd,
                    relativePath: input.destinationRelativePath,
                    resolvedPath: destination.realTargetPath,
                    operationPath: destination.realTargetPath,
                    operation: "link",
                    cause,
                  }),
          });
          const linked = yield* readFile({
            cwd: input.cwd,
            relativePath: input.destinationRelativePath,
          });
          if (linked.truncated || linked.revision !== input.expectedRevision) {
            yield* Effect.tryPromise(() => NodeFSP.unlink(destination.realTargetPath)).pipe(
              Effect.ignore,
            );
            return yield* new WorkspaceFileRevisionConflictError({
              workspaceRoot: input.cwd,
              relativePath: input.relativePath,
              resolvedPath: sourceTarget.absolutePath,
              currentRevision: linked.revision,
            });
          }
          yield* Effect.tryPromise({
            try: async () => {
              try {
                await NodeFSP.unlink(source.realTargetPath);
              } catch (cause) {
                await NodeFSP.unlink(destination.realTargetPath).catch(() => undefined);
                throw cause;
              }
            },
            catch: (cause) =>
              new WorkspaceFileSystemOperationError({
                workspaceRoot: input.cwd,
                relativePath: input.relativePath,
                resolvedPath: sourceTarget.absolutePath,
                operationPath: sourceTarget.absolutePath,
                operation: "unlink",
                cause,
              }),
          });
          yield* workspaceEntries.refresh(input.cwd);
          return {
            relativePath: sourceTarget.relativePath,
            destinationRelativePath: destination.target.relativePath,
            revision: linked.revision,
          };
        }),
      ),
    );
  });

  const watchFile: WorkspaceFileSystem["Service"]["watchFile"] = (input) =>
    Stream.unwrap(
      resolveRealFileWatchTarget(input).pipe(
        Effect.map(({ realTargetPath, target, watchDirectory }) => {
          return Stream.callback<ProjectFileWatchEvent, WorkspaceFileSystemOperationError>(
            (queue) =>
              Effect.acquireRelease(
                Effect.try({
                  try: () => {
                    const watcher = NodeFS.watch(watchDirectory, (_event, reportedPath) => {
                      // Node documents that filename may be absent on some
                      // platforms. Since this watcher is scoped to one parent,
                      // a conservative reread is cheaper than missing a save.
                      if (reportedPath !== null) {
                        const absoluteReportedPath = path.isAbsolute(reportedPath)
                          ? path.resolve(reportedPath)
                          : path.resolve(watchDirectory, reportedPath);
                        if (absoluteReportedPath !== realTargetPath) return;
                      }
                      Queue.offerUnsafe(queue, {
                        _tag: "file-changed",
                        relativePath: target.relativePath,
                      });
                    });
                    watcher.on("error", (cause) => {
                      Queue.failCauseUnsafe(
                        queue,
                        Cause.fail(
                          new WorkspaceFileSystemOperationError({
                            workspaceRoot: input.cwd,
                            relativePath: input.relativePath,
                            resolvedPath: realTargetPath,
                            operationPath: watchDirectory,
                            operation: "watch",
                            cause,
                          }),
                        ),
                      );
                    });
                    watcher.on("close", () => Queue.endUnsafe(queue));
                    Queue.offerUnsafe(queue, {
                      _tag: "watch-ready",
                      relativePath: target.relativePath,
                    });
                    return watcher;
                  },
                  catch: (cause) =>
                    new WorkspaceFileSystemOperationError({
                      workspaceRoot: input.cwd,
                      relativePath: input.relativePath,
                      resolvedPath: realTargetPath,
                      operationPath: watchDirectory,
                      operation: "watch",
                      cause,
                    }),
                }),
                (watcher) => Effect.sync(() => watcher.close()),
              ),
          ).pipe(
            // Editors and atomic writers commonly produce several events for
            // one save. Batch them after the write settles, but preserve the
            // explicit readiness signal used by clients and deterministic tests.
            Stream.groupedWithin(256, "100 millis"),
            Stream.flatMap((events) => {
              const coalesced: ProjectFileWatchEvent[] = [];
              if (events.some((event) => event._tag === "watch-ready")) {
                coalesced.push({ _tag: "watch-ready", relativePath: target.relativePath });
              }
              if (events.some((event) => event._tag === "file-changed")) {
                coalesced.push({ _tag: "file-changed", relativePath: target.relativePath });
              }
              return Stream.fromIterable(coalesced);
            }),
          );
        }),
      ),
    );

  return WorkspaceFileSystem.of({
    createBinaryFile,
    inspectWriteTarget,
    readFile,
    renameFile,
    watchFile,
    writeFile,
  });
});

export const layer = Layer.effect(WorkspaceFileSystem, make);
