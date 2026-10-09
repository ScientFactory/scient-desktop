// @effect-diagnostics nodeBuiltinImport:off
/**
 * Scient's workspace file mutations: revision-checked saves, exclusive creates,
 * renames that never replace their destination and deletes that never take a
 * changed file. Each mutation resolves its
 * canonical target, locks it, and revalidates it after waiting for the lock.
 * WorkspaceFileSystem builds these once and serves them as its write methods.
 */
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";

import type {
  ProjectDeleteFileInput,
  ProjectDeleteFileResult,
  ProjectRenameFileInput,
  ProjectRenameFileResult,
  ProjectWriteFileInput,
  ProjectWriteFileResult,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Semaphore from "effect/Semaphore";
import * as SynchronizedRef from "effect/SynchronizedRef";

import {
  mutateRetainedFile,
  assertRootBinding,
  type RetainedMutationInput,
  type RetainedMutationResult,
  type RetainedMutationHooks,
} from "./RetainedFileMutation.ts";
import { writeFileStringAtomically } from "../../atomicWrite.ts";
import type * as WorkspaceEntries from "../../workspace/WorkspaceEntries.ts";
import {
  WorkspaceFilePathEscapeError,
  WorkspaceFileSystemOperationError,
  WorkspacePathNotFileError,
  type WorkspaceFileSystem,
  type WorkspaceFileSystemError,
} from "../../workspace/WorkspaceFileSystem.ts";
import type * as WorkspacePaths from "../../workspace/WorkspacePaths.ts";
import {
  isNodeError,
  WorkspaceFileExistsError,
  WorkspaceFileRevisionConflictError,
} from "./WorkspaceFileErrors.ts";

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

export interface WorkspaceRetainedFileMethods {
  /** Durably retain the displaced file, never overwrite or delete it in place. Reuse id to recover. */
  readonly replaceFileRetained: (
    input: RetainedMutationInput,
  ) => Effect.Effect<
    RetainedMutationResult,
    WorkspaceFileSystemError | WorkspacePaths.WorkspacePathOutsideRootError
  >;
  readonly removeFileRetained: (
    input: Omit<RetainedMutationInput, "bytes">,
  ) => Effect.Effect<
    RetainedMutationResult,
    WorkspaceFileSystemError | WorkspacePaths.WorkspacePathOutsideRootError
  >;
}

/** The Scient mutation methods WorkspaceFileSystem serves beside its reads. */
export interface WorkspaceFileMutationMethods extends WorkspaceRetainedFileMethods {
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
  /**
   * Delete a regular file only while it is the revision the client last read,
   * and optionally the folders it leaves empty below the workspace root.
   */
  readonly deleteFile: (
    input: ProjectDeleteFileInput,
  ) => Effect.Effect<
    ProjectDeleteFileResult,
    WorkspaceFileSystemError | WorkspacePaths.WorkspacePathOutsideRootError
  >;
  /** Atomically create a binary file and fail if the destination exists. */
  readonly createBinaryFile: (
    input: WorkspaceCreateBinaryFileInput,
  ) => Effect.Effect<
    ProjectWriteFileResult,
    WorkspaceFileSystemError | WorkspacePaths.WorkspacePathOutsideRootError
  >;
}

export const revisionForBytes = (bytes: Uint8Array): string =>
  `sha256:${NodeCrypto.createHash("sha256").update(bytes).digest("hex")}`;

const PROJECT_READ_FILE_MAX_BYTES = 1024 * 1024;

const revisionForContents = (contents: string): string =>
  revisionForBytes(new TextEncoder().encode(contents));

export const makeWorkspaceFileMutations = Effect.fnUntraced(function* (deps: {
  readonly fileSystem: FileSystem.FileSystem;
  readonly path: Path.Path;
  readonly workspacePaths: WorkspacePaths.WorkspacePaths["Service"];
  readonly workspaceEntries: WorkspaceEntries.WorkspaceEntries["Service"];
  readonly readFile: WorkspaceFileSystem["Service"]["readFile"];
  readonly retainedHooks?: RetainedMutationHooks;
}) {
  const { fileSystem, path, workspacePaths, workspaceEntries, readFile } = deps;
  /**
   * The revision a read would report for a file's first bytes, for any file,
   * binary included. A renamed file that is not read whole reports this.
   */
  const leadingBytesRevision = (
    input: { readonly cwd: string; readonly relativePath: string },
    absolutePath: string,
  ) =>
    Effect.tryPromise({
      try: async () => {
        const handle = await NodeFSP.open(absolutePath, "r");
        try {
          const buffer = Buffer.alloc(PROJECT_READ_FILE_MAX_BYTES);
          const { bytesRead } = await handle.read(buffer, 0, PROJECT_READ_FILE_MAX_BYTES, 0);
          return revisionForBytes(buffer.subarray(0, bytesRead));
        } finally {
          await handle.close();
        }
      },
      catch: (cause) =>
        new WorkspaceFileSystemOperationError({
          workspaceRoot: input.cwd,
          relativePath: input.relativePath,
          resolvedPath: absolutePath,
          operationPath: absolutePath,
          operation: "read",
          cause,
        }),
    });

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

  // `rmdir` removes only an empty folder, so a folder anything else still holds
  // stays; the walk stops there and never reaches the workspace root. Each
  // folder must still be itself, reached without a link: one replaced by a link
  // since would lead the walk outside, so the walk stops there.
  const removeEmptyFoldersAbove = (realWorkspaceRoot: string, filePath: string) =>
    Effect.promise(async () => {
      for (let folder = path.dirname(filePath); ; folder = path.dirname(folder)) {
        const relative = path.relative(realWorkspaceRoot, folder);
        if (
          !relative ||
          relative === ".." ||
          relative.startsWith(`..${path.sep}`) ||
          path.isAbsolute(relative)
        )
          return;
        try {
          const stat = await NodeFSP.lstat(folder);
          if (!stat.isDirectory() || (await NodeFSP.realpath(folder)) !== folder) return;
          await NodeFSP.rmdir(folder);
        } catch {
          return;
        }
      }
    });

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
      realWorkspaceRoot,
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
              const handle = await NodeFSP.open(tempPath, "r+");
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
          const current = yield* readFile({
            cwd: input.cwd,
            relativePath: input.relativePath,
          });
          // A lost response can leave the requested bytes on disk with a newer
          // revision. Converge without replacing that already-published file.
          // Truncated reads cannot establish equality with the entire file.
          if (!current.truncated && current.revision === revisionForContents(input.contents)) {
            yield* workspaceEntries.refresh(input.cwd);
            return {
              relativePath: target.relativePath,
              revision: current.revision,
            };
          }
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
          durable: true,
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
          // A file the client edits carries the revision it last saw, so a
          // newer version on disk is never renamed under its open editor. A
          // file it cannot read whole (binary, or larger than a read) has no
          // such revision and nothing open to lose: renaming moves its bytes
          // unchanged, so it is renamed without the content check.
          if (input.expectedRevision !== undefined) {
            const current = yield* readFile({
              cwd: input.cwd,
              relativePath: input.relativePath,
            });
            if (current.truncated || current.revision !== input.expectedRevision) {
              return yield* new WorkspaceFileRevisionConflictError({
                workspaceRoot: input.cwd,
                relativePath: input.relativePath,
                resolvedPath: sourceTarget.absolutePath,
                currentRevision: current.revision,
              });
            }
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
          // The identity (device and inode, as bigints: 64-bit ids exceed a
          // double) of the file being moved, taken before the new name exists.
          const sourceIdentity = yield* Effect.promise(() =>
            NodeFSP.lstat(source.realTargetPath, { bigint: true }).then(
              (stat) => ({ dev: stat.dev, ino: stat.ino }),
              () => null,
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
          // The new name is known to hold the moved file only when it shows
          // the identity taken before linking. Otherwise (the source replaced
          // just before the link, or the new name replaced just after) nothing
          // is removed: every ownership check below fails, and the rename
          // reports a conflict with both names left in place. Cleanup removes
          // the new name only while it holds the moved file; the old name is
          // removed only while it still is that file.
          const destinationPath = destination.realTargetPath;
          const sourcePath = source.realTargetPath;
          const linkedIdentity = yield* Effect.promise(() =>
            NodeFSP.lstat(destinationPath, { bigint: true }).then(
              (stat) =>
                sourceIdentity !== null &&
                stat.dev === sourceIdentity.dev &&
                stat.ino === sourceIdentity.ino
                  ? sourceIdentity
                  : null,
              () => null,
            ),
          );
          const holdsLinkedFile = async (filePath: string) => {
            if (linkedIdentity === null) return false;
            try {
              const stat = await NodeFSP.lstat(filePath, { bigint: true });
              return stat.dev === linkedIdentity.dev && stat.ino === linkedIdentity.ino;
            } catch {
              return false;
            }
          };
          // One rule for both removals: a name is removed only while the other
          // name still holds the same file, so no removal can take a file's
          // last name, whatever another program did to either name meanwhile.
          const removeOwnLink = async () => {
            const [destinationHolds, sourceHolds] = await Promise.all([
              holdsLinkedFile(destinationPath),
              holdsLinkedFile(sourcePath),
            ]);
            if (destinationHolds && sourceHolds) {
              await NodeFSP.unlink(destinationPath).catch(() => undefined);
            }
          };
          const conflict = (currentRevision: string) =>
            new WorkspaceFileRevisionConflictError({
              workspaceRoot: input.cwd,
              relativePath: input.relativePath,
              resolvedPath: sourceTarget.absolutePath,
              currentRevision,
            });
          let revision: string;
          if (input.expectedRevision !== undefined) {
            const linked = yield* readFile({
              cwd: input.cwd,
              relativePath: input.destinationRelativePath,
            }).pipe(Effect.tapError(() => Effect.promise(removeOwnLink)));
            if (linked.truncated || linked.revision !== input.expectedRevision) {
              yield* Effect.promise(removeOwnLink);
              return yield* conflict(linked.revision);
            }
            revision = linked.revision;
          } else {
            // A failed read must not leave the new name behind: a retry would
            // then find it taken.
            revision = yield* leadingBytesRevision(input, destinationPath).pipe(
              Effect.tapError(() => Effect.promise(removeOwnLink)),
            );
          }
          // The locks order this service's own writes, not another program's.
          // One that replaced the source after it was linked (an editor or a
          // compiler writing atomically) keeps its file: the check and the
          // unlink run back to back, and a replaced source is left alone.
          const moved = yield* Effect.tryPromise({
            try: async () => {
              // The old name may go only while the new name still holds the
              // same file: otherwise removing it could delete that file's last
              // name (the new one replaced by another program meanwhile).
              const [sourceHolds, destinationHolds] = await Promise.all([
                holdsLinkedFile(sourcePath),
                holdsLinkedFile(destinationPath),
              ]);
              if (!sourceHolds || !destinationHolds) {
                await removeOwnLink();
                return false;
              }
              try {
                await NodeFSP.unlink(sourcePath);
              } catch (cause) {
                await removeOwnLink();
                throw cause;
              }
              return true;
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
          if (!moved) return yield* conflict(revision);
          if (input.removeEmptyFolders) {
            yield* removeEmptyFoldersAbove(source.realWorkspaceRoot, source.realTargetPath);
          }
          yield* workspaceEntries.refresh(input.cwd);
          return {
            relativePath: sourceTarget.relativePath,
            destinationRelativePath: destination.target.relativePath,
            revision,
          };
        }),
      ),
    );
  });

  const deleteFile: WorkspaceFileSystem["Service"]["deleteFile"] = Effect.fn(
    "WorkspaceFileSystem.deleteFile",
  )(function* (input) {
    const initial = yield* resolveRealWriteTarget(input);
    const semaphore = yield* writeSemaphoreFor(initial.realTargetPath);
    return yield* semaphore.withPermits(1)(
      Effect.gen(function* () {
        const resolved = yield* revalidateWriteTarget(input, initial.realTargetPath);
        const targetPath = resolved.realTargetPath;
        // The name itself must be a file: a link is never followed to delete
        // what it points to (folders on the way may still be aliases).
        const named = yield* Effect.tryPromise({
          try: () => NodeFSP.lstat(resolved.target.absolutePath),
          catch: (cause) =>
            new WorkspaceFileSystemOperationError({
              workspaceRoot: input.cwd,
              relativePath: input.relativePath,
              resolvedPath: resolved.target.absolutePath,
              operationPath: resolved.target.absolutePath,
              operation: "stat",
              cause,
            }),
        });
        if (!named.isFile() || named.isSymbolicLink()) {
          return yield* new WorkspacePathNotFileError({
            workspaceRoot: input.cwd,
            relativePath: input.relativePath,
            resolvedPath: resolved.target.absolutePath,
          });
        }
        const identity = () =>
          Effect.tryPromise({
            try: async () => {
              const stat = await NodeFSP.lstat(targetPath, { bigint: true });
              return stat.isFile() && !stat.isSymbolicLink()
                ? { dev: stat.dev, ino: stat.ino }
                : null;
            },
            catch: (cause) =>
              new WorkspaceFileSystemOperationError({
                workspaceRoot: input.cwd,
                relativePath: input.relativePath,
                resolvedPath: targetPath,
                operationPath: targetPath,
                operation: "stat",
                cause,
              }),
          });
        const before = yield* identity();
        if (before === null) {
          return yield* new WorkspacePathNotFileError({
            workspaceRoot: input.cwd,
            relativePath: input.relativePath,
            resolvedPath: targetPath,
          });
        }
        // Only the revision the client saw is deleted, and only while the name
        // still holds the file that was read: one replaced by another program
        // since (an editor or a compiler writing atomically) is left alone.
        const current = yield* readFile({ cwd: input.cwd, relativePath: input.relativePath });
        const after = yield* identity();
        if (
          current.truncated ||
          current.revision !== input.expectedRevision ||
          after === null ||
          after.dev !== before.dev ||
          after.ino !== before.ino
        ) {
          return yield* new WorkspaceFileRevisionConflictError({
            workspaceRoot: input.cwd,
            relativePath: input.relativePath,
            resolvedPath: targetPath,
            currentRevision: current.revision,
          });
        }
        // Another program can still replace the file between that check and its
        // removal. So the name is first moved aside, which takes whatever it
        // holds at that instant; only a file at the expected revision is then
        // removed, and anything else goes back under its name (or, if that name
        // was written again meanwhile, beside it as a recovered copy).
        const aside = path.join(
          path.dirname(targetPath),
          `.${path.basename(targetPath)}.scient-delete-${NodeCrypto.randomBytes(6).toString("hex")}`,
        );
        const outcome = yield* Effect.tryPromise({
          try: async (): Promise<{ readonly deleted: true } | { readonly revision: string }> => {
            await NodeFSP.rename(targetPath, aside);
            const stat = await NodeFSP.lstat(aside);
            let revision = "unreadable";
            if (stat.isFile() && stat.size <= PROJECT_READ_FILE_MAX_BYTES) {
              revision = revisionForBytes(await NodeFSP.readFile(aside));
              if (revision === input.expectedRevision) {
                await NodeFSP.unlink(aside);
                return { deleted: true };
              }
            }
            const extension = path.extname(targetPath);
            const stem = targetPath.slice(0, targetPath.length - extension.length);
            const names = [
              targetPath,
              ...Array.from(
                { length: 20 },
                (_, index) => `${stem} (recovered${index ? ` ${index + 1}` : ""})${extension}`,
              ),
            ];
            for (const name of names) {
              try {
                await NodeFSP.link(aside, name);
                await NodeFSP.unlink(aside);
                break;
              } catch (cause) {
                if (!isNodeError(cause, "EEXIST")) throw cause;
              }
            }
            return { revision };
          },
          catch: (cause) =>
            new WorkspaceFileSystemOperationError({
              workspaceRoot: input.cwd,
              relativePath: input.relativePath,
              resolvedPath: targetPath,
              operationPath: aside,
              operation: "unlink",
              cause,
            }),
        });
        if (!("deleted" in outcome)) {
          return yield* new WorkspaceFileRevisionConflictError({
            workspaceRoot: input.cwd,
            relativePath: input.relativePath,
            resolvedPath: targetPath,
            currentRevision: outcome.revision,
          });
        }
        if (input.removeEmptyFolders) {
          yield* removeEmptyFoldersAbove(resolved.realWorkspaceRoot, targetPath);
        }
        yield* workspaceEntries.refresh(input.cwd);
        return { relativePath: resolved.target.relativePath };
      }),
    );
  });

  const replaceFileRetained: WorkspaceRetainedFileMethods["replaceFileRetained"] = Effect.fn(
    "WorkspaceFileSystem.replaceFileRetained",
  )(function* (input) {
    const checkRoot = () =>
      Effect.tryPromise({
        try: () => assertRootBinding(input.cwd, input.expectedRootIdentity),
        catch: (cause) =>
          new WorkspaceFileSystemOperationError({
            workspaceRoot: input.cwd,
            relativePath: input.relativePath,
            resolvedPath: input.cwd,
            operationPath: input.cwd,
            operation: "realpath-workspace-root",
            cause,
          }),
      });
    yield* checkRoot();
    const initial = yield* resolveRealWriteTarget(input);
    const semaphore = yield* writeSemaphoreFor(initial.realTargetPath);
    return yield* semaphore
      .withPermits(1)(
        Effect.gen(function* () {
          yield* checkRoot();
          const current = yield* revalidateWriteTarget(input, initial.realTargetPath);
          if (current.traversesSymlink)
            return yield* new WorkspaceFileSystemOperationError({
              workspaceRoot: input.cwd,
              relativePath: input.relativePath,
              resolvedPath: current.realTargetPath,
              operationPath: current.realTargetPath,
              operation: "realpath-target",
              cause: new Error("Retained mutations refuse symlink paths."),
            });
          const result = yield* Effect.tryPromise({
            try: () => mutateRetainedFile(input, current.realTargetPath, deps.retainedHooks),
            catch: (cause) =>
              new WorkspaceFileSystemOperationError({
                workspaceRoot: input.cwd,
                relativePath: input.relativePath,
                resolvedPath: current.realTargetPath,
                operationPath: current.realTargetPath,
                operation: "write-file",
                cause,
              }),
          });
          yield* workspaceEntries.refresh(input.cwd);
          return result;
        }),
      )
      .pipe(Effect.uninterruptible);
  });
  const removeFileRetained: WorkspaceRetainedFileMethods["removeFileRetained"] = (input) =>
    replaceFileRetained({ ...input, bytes: null });
  return {
    createBinaryFile,
    deleteFile,
    inspectWriteTarget,
    renameFile,
    writeFile,
    replaceFileRetained,
    removeFileRetained,
  };
});
