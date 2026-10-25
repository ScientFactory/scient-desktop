// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";

import type {
  ProjectFilePublicationAttention,
  FilesystemEntryMetadata,
  FilesystemGetMetadataInput,
  FilesystemGetMetadataResult,
  ProjectReadFileInput,
  ProjectReadFileResult,
  ProjectWriteFileInput,
  ProjectWriteFileResult,
} from "@t3tools/contracts";
import { PROJECT_MISSING_FILE_REVISION } from "@t3tools/contracts";
import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { isNetworkPath } from "@t3tools/shared/path";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../config.ts";
import * as KnownWorkspaces from "./KnownWorkspaces.ts";
import * as WorkspaceEntries from "./WorkspaceEntries.ts";
import * as WorkspacePaths from "./WorkspacePaths.ts";
// SCIENT-FORK:START — saves, creates, renames and the open-file watch.
import { isInSourceFileStore } from "../scient/sources/sourceFileStore.ts";
import {
  isNodeError,
  WorkspaceFileExistsError,
  WorkspaceFileRevisionConflictError,
  WorkspaceFileTargetChangedError,
  WorkspaceFileRecoveryRequiredError,
  WorkspaceFileMutationUnavailableError,
  WorkspaceFileMutationIntentConflictError,
} from "../scient/workspace/WorkspaceFileErrors.ts";
import {
  makeWorkspaceFileMutations,
  revisionForBytes,
  type WorkspaceFileMutationMethods,
} from "../scient/workspace/WorkspaceFileMutations.ts";
import {
  ensureNativePrivateRetentionDirectory,
  resolveNativeFilePublicationHelperPath,
} from "../scient/workspace/NativeFilePublication.ts";
import { RetainedMutationError } from "../scient/workspace/RetainedFileMutation.ts";
import {
  makeWorkspaceFileWatch,
  type WorkspaceFileWatchMethods,
} from "../scient/workspace/WorkspaceFileWatch.ts";
// SCIENT-FORK:END
import { fileHeaderMimeType } from "./fileHeaderMimeType.ts";

const PROJECT_READ_FILE_MAX_BYTES = 1024 * 1024;

// Windows also reaches `.git` through trailing dots or spaces, a `:` stream
// suffix, or the 8.3 short name `GIT~1`. Names compare upcased, as NTFS does.
const isGitMetadataName = (segment: string) => {
  const name = (segment.split(":")[0] ?? "").replace(/[. ]+$/, "").toUpperCase();
  return name === ".GIT" || name === "GIT~1";
};

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
      "retained-publication",
      "link",
      "unlink",
      "watch",
    ]),
    cause: Schema.Defect(),
    currentMissing: Schema.optional(Schema.Literal(true)),
    publicationOutcome: Schema.optional(Schema.Literals(["unchanged", "retained-attention"])),
    mutationId: Schema.optional(Schema.String),
    recoveryId: Schema.optional(Schema.String),
    retainedPaths: Schema.optional(Schema.Array(Schema.String)),
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
  WorkspaceFileTargetChangedError,
  WorkspaceFileRecoveryRequiredError,
  WorkspaceFileMutationUnavailableError,
  WorkspaceFileMutationIntentConflictError,
  WorkspacePaths.WorkspaceRootNotExistsError,
  WorkspacePaths.WorkspaceRootCreateFailedError,
  WorkspacePaths.WorkspaceRootStatFailedError,
  WorkspacePaths.WorkspaceRootNotDirectoryError,
  // SCIENT-FORK: mutation methods share the known-workspace boundary.
  KnownWorkspaces.UnknownWorkspaceError,
]);
export type WorkspaceFileSystemError = typeof WorkspaceFileSystemError.Type;

export class WorkspaceFileSystem extends Context.Service<
  WorkspaceFileSystem,
  {
    readonly getMetadata: (
      input: FilesystemGetMetadataInput,
    ) => Effect.Effect<FilesystemGetMetadataResult>;

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
    // SCIENT-FORK:START viewer-only reads outside the workspace.
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
    // SCIENT-FORK:END
    /** Writes inside a known workspace only. */
    readonly writeFile: (
      input: ProjectWriteFileInput,
    ) => Effect.Effect<
      ProjectWriteFileResult,
      | WorkspaceFileSystemError
      | WorkspacePaths.WorkspacePathOutsideRootError
      | KnownWorkspaces.UnknownWorkspaceError
    >;
  } &
    // SCIENT-FORK:START — save, create, rename, delete and watch methods.
    WorkspaceFileMutationMethods &
    WorkspaceFileWatchMethods
  // SCIENT-FORK:END
>()("t3/workspace/WorkspaceFileSystem") {}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const workspacePaths = yield* WorkspacePaths.WorkspacePaths;
  const knownWorkspaces = yield* KnownWorkspaces.KnownWorkspaces;
  const workspaceEntries = yield* WorkspaceEntries.WorkspaceEntries;
  const config = yield* ServerConfig.ServerConfig;
  const nativePublicationHelper = yield* Effect.promise(() =>
    resolveNativeFilePublicationHelperPath(config.filePublicationHelperPath),
  );
  const configuredRetentionStorageDirectory =
    config.filePublicationRetentionRoot ??
    path.join(NodeOS.homedir(), ".scient-next", "file-publications");
  // Resolve only ancestors: the final private directory must still reject a symlink.
  // Missing optional storage stays absent until a publication provisions it.
  const canonicalAncestor = async (directory: string): Promise<string> => {
    try {
      return await NodeFSP.realpath(directory);
    } catch (cause) {
      if (!isNodeError(cause, "ENOENT")) throw cause;
      return path.join(await canonicalAncestor(path.dirname(directory)), path.basename(directory));
    }
  };
  let canonicalRetentionStorageDirectory: string | undefined;
  const resolveRetentionStorageDirectory = async () => {
    if (canonicalRetentionStorageDirectory !== undefined) return canonicalRetentionStorageDirectory;
    if (!path.isAbsolute(configuredRetentionStorageDirectory)) {
      throw new RetainedMutationError(
        "unavailable",
        "Retention must be an absolute host-owned path.",
        "storage",
      );
    }
    const directory = path.join(
      await canonicalAncestor(path.dirname(configuredRetentionStorageDirectory)),
      path.basename(configuredRetentionStorageDirectory),
    );
    return (canonicalRetentionStorageDirectory ??= directory);
  };
  const retentionDirectoryFor = async (_canonicalRoot: string, parentPath: string) => {
    const parent = await NodeFSP.lstat(parentPath, { bigint: true });
    if (!parent.isDirectory() || parent.isSymbolicLink()) {
      throw new Error("Publication parent binding changed.");
    }
    if (nativePublicationHelper === undefined) {
      throw new RetainedMutationError(
        "unavailable",
        "Native publication helper is unavailable.",
        "storage",
      );
    }
    const retentionStorageDirectory = await resolveRetentionStorageDirectory();
    const preparedRoot = await ensureNativePrivateRetentionDirectory(
      nativePublicationHelper,
      retentionStorageDirectory,
    );
    const directory = path.join(retentionStorageDirectory, `${parent.dev}-${parent.ino}`);
    const preparedDirectory = await ensureNativePrivateRetentionDirectory(
      nativePublicationHelper,
      directory,
    );
    if (preparedRoot !== retentionStorageDirectory || preparedDirectory !== directory) {
      throw new RetainedMutationError(
        "target",
        "Retained storage authority changed during preparation.",
        "storage",
      );
    }
    const storage = await NodeFSP.lstat(directory, { bigint: true });
    if (storage.dev !== parent.dev) {
      throw new RetainedMutationError(
        "unavailable",
        "Retained publication storage must share the source filesystem. Configure SCIENT_FILE_PUBLICATION_RETENTION_ROOT on that filesystem.",
        "storage-volume",
      );
    }
    return directory;
  };

  const metadataForPath = Effect.fnUntraced(function* (requestedPath: string) {
    const expandedPath = expandHomePath(requestedPath, yield* HostProcess.HomeDirectory);
    // Chips ask as soon as an agent's message renders, and touching a network
    // path makes Windows sign in to its host with the user's NTLM credentials.
    if (!path.isAbsolute(expandedPath) || isNetworkPath(expandedPath)) return null;
    const stat = yield* fileSystem.stat(expandedPath).pipe(Effect.option);
    if (stat._tag === "None") return null;
    if (stat.value.type === "Directory") return { kind: "directory" } as const;
    if (stat.value.type !== "File") return { kind: "other" } as const;
    let mimeType: string | undefined;
    if (path.extname(expandedPath) === "" && stat.value.size > 0) {
      mimeType = yield* Effect.tryPromise({
        try: async () => {
          const handle = await NodeFSP.open(
            expandedPath,
            NodeFS.constants.O_RDONLY | NodeFS.constants.O_NONBLOCK,
          );
          try {
            if (!(await handle.stat()).isFile()) return undefined;
            const buffer = Buffer.alloc(512);
            const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
            return fileHeaderMimeType(buffer.subarray(0, bytesRead));
          } finally {
            await handle.close();
          }
        },
        catch: () => undefined,
      }).pipe(Effect.catch(() => Effect.succeed(undefined)));
    }
    return {
      kind: "file",
      byteLength: Number(stat.value.size),
      ...(mimeType === undefined ? {} : { mimeType }),
    } satisfies FilesystemEntryMetadata;
  });

  const getMetadata: WorkspaceFileSystem["Service"]["getMetadata"] = Effect.fn(
    "WorkspaceFileSystem.getMetadata",
  )(function* (input) {
    const paths = [...new Set(input.paths)];
    const entries = yield* Effect.forEach(paths, metadataForPath, { concurrency: 8 });
    const byPath = new Map(paths.map((value, index) => [value, entries[index] ?? null]));
    return { entries: input.paths.map((value) => byPath.get(value) ?? null) };
  });

  /** Both paths must already be real paths. */
  const isInsideRealRoot = (realWorkspaceRoot: string, realPath: string) => {
    const relative = path.relative(realWorkspaceRoot, realPath);
    return !(
      relative.startsWith(`..${path.sep}`) ||
      relative === ".." ||
      path.isAbsolute(relative)
    );
  };

  /**
   * Git runs config and hooks from its own folders, so a write never lands in one:
   * a `.git` entry, or a repository folder under another name such as `.bare`.
   * Folders are checked upward to a linked worktree's top, which holds a `.git`
   * file, since worktrees can sit inside a bare repository. `absolutePath` must
   * be normalized.
   */
  const isInGitFolder = async (absolutePath: string) => {
    if (absolutePath.split(path.sep).some(isGitMetadataName)) return true;
    for (let folder = path.dirname(absolutePath); ; folder = path.dirname(folder)) {
      const [head, commondir, objects, refs, dotGit] = await Promise.all(
        ["HEAD", "commondir", "objects", "refs", ".git"].map((name) =>
          NodeFSP.lstat(path.join(folder, name)).catch((error: NodeJS.ErrnoException) => {
            // Any other failure leaves the folder unknown, so the write is refused.
            if (error.code === "ENOENT" || error.code === "ENOTDIR") return null;
            throw error;
          }),
        ),
      );
      // What git reads as a repository: HEAD, plus objects and refs here or in
      // the folder a `commondir` file names, as in a linked worktree's git folder.
      if (head && (commondir || (objects && refs))) return true;
      if (dotGit?.isFile() || path.dirname(folder) === folder) return false;
    }
  };

  // SCIENT-FORK:START — host and contained reads share dangling-link/absence semantics.
  const canonicalReadTarget = async (absolutePath: string, allowMissing: boolean | undefined) => {
    let candidate = absolutePath;
    for (;;) {
      try {
        return {
          realTargetPath: path.join(
            await NodeFSP.realpath(candidate),
            path.relative(candidate, absolutePath),
          ),
          exists: candidate === absolutePath,
        };
      } catch (error) {
        if (!allowMissing || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        const exists = await NodeFSP.lstat(candidate).then(
          () => true,
          (cause: NodeJS.ErrnoException) => {
            if (cause.code !== "ENOENT") throw cause;
            return false;
          },
        );
        if (exists || path.dirname(candidate) === candidate) throw error;
        candidate = path.dirname(candidate);
      }
    }
  };
  // SCIENT-FORK:END

  const assertNetworkPathWithinRoot = Effect.fn("WorkspaceFileSystem.assertNetworkPathWithinRoot")(
    function* (input: ProjectReadFileInput, targetPath = input.relativePath) {
      if (
        isNetworkPath(targetPath) &&
        !KnownWorkspaces.isWithinRoot(path, path.resolve(targetPath), path.resolve(input.cwd))
      ) {
        return yield* new WorkspacePaths.WorkspacePathOutsideRootError({
          workspaceRoot: input.cwd,
          relativePath: input.relativePath,
        });
      }
    },
  );

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
    const readHostFile = Effect.fn("WorkspaceFileSystem.readHostFile")(function* (
      hostPath: string,
    ) {
      const absolutePath = isNetworkPath(hostPath) ? path.resolve(hostPath) : hostPath;
      yield* assertNetworkPathWithinRoot({ ...input, relativePath: hostPath });
      return yield* Effect.tryPromise({
        try: async () => {
          const resolved = await canonicalReadTarget(absolutePath, input.allowMissing);
          const realRoot = await NodeFSP.realpath(input.cwd).catch(() => null);
          return {
            relativePath: requestedPath,
            realTargetPath: resolved.exists ? resolved.realTargetPath : null,
            readOnly: true,
            outsideWorkspace: realRoot !== null && isOutside(realRoot, resolved.realTargetPath),
          };
        },
        catch: (cause) =>
          new WorkspaceFileSystemOperationError({
            workspaceRoot: input.cwd,
            relativePath: input.relativePath,
            resolvedPath: absolutePath,
            operationPath: absolutePath,
            operation: "realpath-target",
            cause,
          }),
      });
    });
    const hostPath = requestedPath.startsWith("~/")
      ? expandHomePath(requestedPath, yield* HostProcess.HomeDirectory)
      : requestedPath;
    const resolvedHostPath = path.isAbsolute(hostPath)
      ? isNetworkPath(hostPath)
        ? path.resolve(hostPath)
        : hostPath
      : path.resolve(input.cwd, hostPath);
    if (isNetworkPath(resolvedHostPath)) {
      yield* assertNetworkPathWithinRoot(input, resolvedHostPath);
    }
    if (path.isAbsolute(hostPath)) {
      return yield* readHostFile(resolvedHostPath);
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
      try: () => NodeFSP.realpath(path.resolve(input.cwd)),
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
    const resolved = yield* Effect.tryPromise({
      try: () => canonicalReadTarget(target.absolutePath, input.allowMissing),
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
    if (!isInsideRealRoot(realWorkspaceRoot, resolved.realTargetPath)) {
      if (purpose === "contained") {
        return yield* new WorkspaceFilePathEscapeError({
          workspaceRoot: input.cwd,
          relativePath: input.relativePath,
          resolvedWorkspaceRoot: realWorkspaceRoot,
          resolvedPath: resolved.realTargetPath,
        });
      }
      // A symlink inside the project that leads out of it: show the file it
      // points to, but never edit it through the project.
      return {
        relativePath: target.relativePath,
        realTargetPath: resolved.exists ? resolved.realTargetPath : null,
        readOnly: true,
        outsideWorkspace: true,
      };
    }
    const canonicalRelativePath = path
      .relative(realWorkspaceRoot, resolved.realTargetPath)
      .replaceAll("\\", "/");
    return {
      relativePath: target.relativePath,
      realTargetPath: resolved.exists ? resolved.realTargetPath : null,
      readOnly: canonicalRelativePath !== target.relativePath,
      outsideWorkspace: false,
    };
  });

  const readResolvedFile = Effect.fn("WorkspaceFileSystem.readResolvedFile")(function* (
    input: ProjectReadFileInput,
    purpose: "view" | "contained",
  ) {
    const target = yield* resolveReadTarget(input, purpose);
    const absentResult = {
      relativePath: target.relativePath,
      contents: "",
      byteLength: 0,
      truncated: false,
      exists: false,
      revision: PROJECT_MISSING_FILE_REVISION,
      readOnly: true,
      ...(target.outsideWorkspace ? { outsideWorkspace: true } : {}),
    };
    const realTargetPath = target.realTargetPath;
    if (realTargetPath === null) return absentResult;

    const currentRead = Effect.acquireUseRelease(
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
      }).pipe(
        Effect.catchIf(
          (error) =>
            input.allowMissing === true && (error.cause as NodeJS.ErrnoException).code === "ENOENT",
          () => Effect.succeed(null),
        ),
      ),
      (handle) =>
        Effect.gen(function* () {
          if (handle === null) return absentResult;
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
        handle === null
          ? Effect.void
          : Effect.tryPromise({
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
    return yield* currentRead;
  });
  const settledReadFailure = (
    error: WorkspaceFileSystemError | WorkspacePaths.WorkspacePathOutsideRootError,
    attention: ProjectFilePublicationAttention | null,
    currentMissing: boolean,
  ) => {
    if (error._tag !== "WorkspaceFileSystemOperationError") return error;
    const missing =
      currentMissing && error.operation === "realpath-target" && isNodeError(error.cause, "ENOENT");
    if (!missing && attention === null) return error;
    return new WorkspaceFileSystemOperationError({
      workspaceRoot: error.workspaceRoot,
      relativePath: error.relativePath,
      resolvedPath: error.resolvedPath,
      operationPath: error.operationPath,
      operation: error.operation,
      cause: error.cause,
      ...(missing ? { currentMissing: true as const } : {}),
      ...(attention === null
        ? {}
        : {
            publicationOutcome: "retained-attention" as const,
            mutationId: attention.mutationId,
            recoveryId: attention.recoveryId,
            retainedPaths: attention.retainedPaths,
          }),
    });
  };

  // SCIENT-FORK:START separate contained and viewer read authorities.
  const readFile: WorkspaceFileSystem["Service"]["readFile"] = Effect.fn(
    "WorkspaceFileSystem.readFile",
  )(function* (input) {
    yield* assertNetworkPathWithinRoot(input);
    if (!path.isAbsolute(input.relativePath)) {
      yield* workspacePaths.resolveRelativePathWithinRoot({
        workspaceRoot: input.cwd,
        relativePath: input.relativePath,
      });
    }
    return yield* (
      path.isAbsolute(input.relativePath) ? withSettledWorkspaceRead : withSettledFileRead
    )(input, (attention, settlement) =>
      readResolvedFile(input, "contained").pipe(
        Effect.map((result) =>
          attention === null ? result : { ...result, publicationAttention: attention },
        ),
        Effect.mapError((error) => settledReadFailure(error, attention, settlement.currentMissing)),
      ),
    );
  });
  const viewFile: WorkspaceFileSystem["Service"]["viewFile"] = Effect.fn(
    "WorkspaceFileSystem.viewFile",
  )(function* (input) {
    yield* assertNetworkPathWithinRoot(input);
    const rootExists = yield* fileSystem.exists(input.cwd).pipe(
      Effect.mapError(
        (cause) =>
          new WorkspaceFileSystemOperationError({
            workspaceRoot: input.cwd,
            relativePath: input.relativePath,
            resolvedPath: path.resolve(input.cwd, input.relativePath),
            operationPath: input.cwd,
            operation: "stat",
            cause,
          }),
      ),
    );
    if (!rootExists) return yield* readResolvedFile(input, "view");
    return yield* withSettledWorkspaceRead(input, (attention, settlement) =>
      readResolvedFile(input, "view").pipe(
        Effect.map((result) =>
          attention === null ? result : { ...result, publicationAttention: attention },
        ),
        Effect.mapError((error) => settledReadFailure(error, attention, settlement.currentMissing)),
      ),
    );
  });
  // SCIENT-FORK:END

  /**
   * Resolves the file a write targets. The deepest existing ancestor resolves to
   * its real path before the root check, so neither the file nor the directories
   * created for it can follow a symlink out of the root. A dangling symlink is
   * rejected rather than written through.
   */
  const resolveWriteTarget = Effect.fn("WorkspaceFileSystem.resolveWriteTarget")(function* (
    input: Pick<ProjectWriteFileInput, "cwd" | "relativePath">,
  ) {
    const target = yield* workspacePaths.resolveRelativePathWithinRoot({
      workspaceRoot: input.cwd,
      relativePath: input.relativePath,
    });
    const realWorkspaceRoot = yield* Effect.tryPromise({
      // Resolve `..` in cwd the way the relative path was resolved, before following links.
      try: () => NodeFSP.realpath(path.resolve(input.cwd)),
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

    // Split the host path, not the display relativePath: on POSIX `\` is a file name character.
    const segments = path.relative(input.cwd, target.absolutePath).split(path.sep);
    const realTargetPath = yield* Effect.tryPromise({
      try: async () => {
        for (let depth = segments.length; depth > 0; depth--) {
          const candidate = path.join(realWorkspaceRoot, ...segments.slice(0, depth));
          try {
            return path.join(await NodeFSP.realpath(candidate), ...segments.slice(depth));
          } catch (error) {
            // Only a missing entry is skipped; one that exists but cannot resolve is a dangling link.
            const exists = await NodeFSP.lstat(candidate).then(
              () => true,
              () => false,
            );
            if ((error as NodeJS.ErrnoException).code !== "ENOENT" || exists) throw error;
          }
        }
        return path.join(realWorkspaceRoot, ...segments);
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
    // The path as named is checked too: a `.git/config` symlink resolves away the `.git`.
    const namedTargetPath = path.join(realWorkspaceRoot, ...segments);
    const inGitFolder = Effect.fn("WorkspaceFileSystem.inGitFolder")((checkedPath: string) =>
      Effect.tryPromise({
        try: () => isInGitFolder(checkedPath),
        catch: (cause) =>
          new WorkspaceFileSystemOperationError({
            workspaceRoot: input.cwd,
            relativePath: input.relativePath,
            resolvedPath: realTargetPath,
            operationPath: checkedPath,
            operation: "stat",
            cause,
          }),
      }),
    );
    if (
      !isInsideRealRoot(realWorkspaceRoot, realTargetPath) ||
      (yield* inGitFolder(realTargetPath)) ||
      (yield* inGitFolder(namedTargetPath))
    ) {
      return yield* new WorkspaceFilePathEscapeError({
        workspaceRoot: input.cwd,
        relativePath: input.relativePath,
        resolvedWorkspaceRoot: realWorkspaceRoot,
        resolvedPath: realTargetPath,
      });
    }
    return { relativePath: target.relativePath, realTargetPath };
  });

  // SCIENT-FORK:START — revision-checked saves, exclusive creates, renames and deletes.
  const mutations = yield* makeWorkspaceFileMutations({
    fileSystem,
    path,
    workspacePaths,
    workspaceEntries,
    readFile: (input) => readResolvedFile(input, "contained"),
    ...(nativePublicationHelper === undefined ? {} : { nativePublicationHelper }),
    resolveRetentionStorageDirectory,
    retentionDirectoryFor,
    retentionLimitBytes: config.filePublicationRetentionLimitBytes ?? null,
    // Sources' content-addressed files are shared by every attachment with their bytes.
    isProtectedPath: async (absolutePath) =>
      isInSourceFileStore(absolutePath) || (await isInGitFolder(absolutePath)),
  });
  // SCIENT-FORK:END

  // SCIENT-FORK:START authorize upstream write targets before Scient atomic mutations.
  const assertWritableTarget = Effect.fnUntraced(function* (
    input: Pick<ProjectWriteFileInput, "cwd" | "relativePath">,
  ) {
    const normalized = { ...input, cwd: path.resolve(input.cwd) };
    yield* knownWorkspaces.assertContains(normalized.cwd);
    yield* resolveWriteTarget(normalized);
    return normalized;
  });
  const writeFile: WorkspaceFileSystem["Service"]["writeFile"] = (input) =>
    assertWritableTarget(input).pipe(
      Effect.flatMap((target) => mutations.writeFile({ ...input, ...target })),
    );
  const createBinaryFile: WorkspaceFileSystem["Service"]["createBinaryFile"] = (input) =>
    assertWritableTarget(input).pipe(
      Effect.flatMap((target) => mutations.createBinaryFile({ ...input, ...target })),
    );
  const writeBinaryFile: WorkspaceFileSystem["Service"]["writeBinaryFile"] = (input) =>
    assertWritableTarget(input).pipe(
      Effect.flatMap((target) => mutations.writeBinaryFile({ ...input, ...target })),
    );
  const deleteFile: WorkspaceFileSystem["Service"]["deleteFile"] = (input) =>
    assertWritableTarget(input).pipe(
      Effect.flatMap((target) => mutations.deleteFile({ ...input, ...target })),
    );
  const inspectWriteTarget: WorkspaceFileSystem["Service"]["inspectWriteTarget"] = (input) =>
    assertWritableTarget(input).pipe(Effect.flatMap(mutations.inspectWriteTarget));
  const renameFile: WorkspaceFileSystem["Service"]["renameFile"] = Effect.fn(
    "WorkspaceFileSystem.renameFile",
  )(function* (input) {
    const source = yield* assertWritableTarget(input);
    yield* assertWritableTarget({ ...source, relativePath: input.destinationRelativePath });
    return yield* mutations.renameFile({ ...input, ...source });
  });
  const replaceFileRetained: WorkspaceFileSystem["Service"]["replaceFileRetained"] = (input) =>
    assertWritableTarget(input).pipe(
      Effect.flatMap((target) => mutations.replaceFileRetained({ ...input, ...target })),
    );
  const removeFileRetained: WorkspaceFileSystem["Service"]["removeFileRetained"] = (input) =>
    assertWritableTarget(input).pipe(
      Effect.flatMap((target) => mutations.removeFileRetained({ ...input, ...target })),
    );
  const {
    registerRetainedFileHistory,
    prepareRetainedDirectory,
    listFileVersions,
    discardFileVersion,
    withSettledFileRead,
    getMutationEpoch,
    withWorkspacePublicationFence,
    withSettledWorkspaceRead,
    resolveFileMutation,
  } = mutations;
  // SCIENT-FORK:END

  // SCIENT-FORK:START — open-file watch.
  const { watchFile } = makeWorkspaceFileWatch({
    path,
    workspacePaths,
    waitForSettlement: (input) => withSettledFileRead(input, () => Effect.void),
  });
  // SCIENT-FORK:END

  return WorkspaceFileSystem.of({
    getMetadata,
    replaceFileRetained,
    removeFileRetained,
    registerRetainedFileHistory,
    prepareRetainedDirectory,
    listFileVersions,
    discardFileVersion,
    withSettledFileRead,
    getMutationEpoch,
    withWorkspacePublicationFence,
    withSettledWorkspaceRead,
    resolveFileMutation,
    createBinaryFile,
    writeBinaryFile,
    deleteFile,
    inspectWriteTarget,
    readFile,
    renameFile,
    viewFile,
    watchFile,
    writeFile,
  });
});

export const layer = Layer.effect(WorkspaceFileSystem, make);
