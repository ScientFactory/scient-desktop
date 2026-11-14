// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";

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
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../config.ts";
import { makeIsServerInternalPath } from "../auth/serverInternalPaths.ts";
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
  acceptedNativeFilePublicationHelper,
  nativeFilePublicationHelper,
} from "../scient/workspace/NativeFilePublication.ts";
import { RetainedMutationError } from "../scient/workspace/RetainedFileMutation.ts";
import {
  makeWorkspaceFileWatch,
  type WorkspaceFileWatchMethods,
} from "../scient/workspace/WorkspaceFileWatch.ts";
// SCIENT-FORK:END
import { fileHeaderMimeType } from "./fileHeaderMimeType.ts";
import { toWslDrivePath } from "./wslDrivePath.ts";

const PROJECT_READ_FILE_MAX_BYTES = 1024 * 1024;

// NTFS reaches .git through trailing dots/spaces, stream suffixes and GIT~1; compare uppercased names.
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
    /** Viewer-only reads may follow absolute paths, escaping relatives and symlinks read-only.
     * Project processing and mutations must use contained reads. */
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
    // SCIENT-FORK:START — the Files panel's moves, copies, new folders and Trash.
    /**
     * A project entry as named, for changing it as a whole: inside the root
     * through real folders only, never in Git's files or Sources' store. A
     * symlink names itself, not its target. The root itself is refused.
     */
    readonly resolveEntryPath: (input: {
      readonly cwd: string;
      readonly relativePath: string;
    }) => Effect.Effect<
      { readonly relativePath: string; readonly absolutePath: string },
      WorkspaceFileSystemError | WorkspacePaths.WorkspacePathOutsideRootError
    >;
    // SCIENT-FORK:END
  } &
    // SCIENT-FORK:START — save, create, rename, delete and watch methods.
    WorkspaceFileMutationMethods &
    WorkspaceFileWatchMethods
  // SCIENT-FORK:END
>()("t3/workspace/WorkspaceFileSystem") {}

const UTF8_BOM = "\uFEFF";

async function startsWithUtf8Bom(filePath: string): Promise<boolean> {
  const handle = await NodeFSP.open(
    filePath,
    // O_NONBLOCK keeps a FIFO with no writer from hanging the save.
    NodeFS.constants.O_RDONLY |
      (NodeFS.constants.O_NOFOLLOW ?? 0) |
      (NodeFS.constants.O_NONBLOCK ?? 0),
  ).catch(() => null);
  if (!handle) return false;
  try {
    const { bytesRead, buffer } = await handle.read(Buffer.alloc(3), 0, 3, 0);
    return bytesRead === 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf;
  } catch {
    return false;
  } finally {
    await handle.close();
  }
}

/** @public */
export const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const workspacePaths = yield* WorkspacePaths.WorkspacePaths;
  const knownWorkspaces = yield* KnownWorkspaces.KnownWorkspaces;
  const workspaceEntries = yield* WorkspaceEntries.WorkspaceEntries;
  const config = yield* ServerConfig.ServerConfig;
  const helperPath = config.filePublicationHelperPath;
  // Checked before saves start, so they begin on the path they keep; a refusal is checked again.
  yield* Effect.promise(() => nativeFilePublicationHelper(helperPath));
  const configuredRetentionStorageDirectory =
    config.filePublicationRetentionRoot ?? path.join(config.baseDir, "file-publications");
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
    const nativePublicationHelper = await nativeFilePublicationHelper(helperPath);
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
  const isServerInternalPath = yield* makeIsServerInternalPath;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  const toHostPath = (requestedPath: string) =>
    toWslDrivePath(requestedPath).pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    );

  const metadataForPath = Effect.fnUntraced(function* (requestedPath: string) {
    const expandedPath = expandHomePath(
      yield* toHostPath(requestedPath),
      yield* HostProcess.HomeDirectory,
    );
    // Chips ask as soon as an agent's message renders, and touching a network
    // path makes Windows sign in to its host with the user's NTLM credentials.
    if (!path.isAbsolute(expandedPath) || isNetworkPath(expandedPath)) return null;
    const stat = yield* fileSystem.stat(expandedPath).pipe(Effect.option);
    // Server state files answer like missing paths, as readFile refuses them.
    if (stat._tag === "None" || (yield* isServerInternalPath(expandedPath))) return null;
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
      }).pipe(Effect.orElseSucceed(() => undefined));
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

  // Reject Git folders, including renamed bare repos whose config/hooks can execute; paths must be normalized.
  // Stop at linked worktrees' .git files since worktrees can sit inside bare repos.
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
      // Git recognizes HEAD with commondir or objects/refs as a repository.
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

  // SCIENT-FORK:START — contained and viewer reads keep their host-path authority.
  /** Viewer reads may leave the project root, read-only.
   * Processing, save and rename require contained paths, including symlink targets. */
  const resolveReadTarget = Effect.fn("WorkspaceFileSystem.resolveReadTarget")(function* (
    input: ProjectReadFileInput,
    purpose: "view" | "contained",
    mappedPath?: string,
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
    const hostPath =
      requestedPath.startsWith("~/") || requestedPath.startsWith("~\\")
        ? expandHomePath(requestedPath, yield* HostProcess.HomeDirectory)
        : (mappedPath ?? (yield* toHostPath(requestedPath)));
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
  // SCIENT-FORK:END

  const readResolvedFile = Effect.fn("WorkspaceFileSystem.readResolvedFile")(function* (
    input: ProjectReadFileInput,
    purpose: "view" | "contained",
    mappedPath?: string,
  ) {
    const target = yield* resolveReadTarget(input, purpose, mappedPath);
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
    if (yield* isServerInternalPath(realTargetPath)) {
      return yield* new WorkspacePaths.WorkspacePathOutsideRootError({
        workspaceRoot: input.cwd,
        relativePath: input.relativePath,
      });
    }

    const currentRead = Effect.acquireUseRelease(
      Effect.tryPromise({
        // Non-blocking opens prevent FIFO hangs before stat rejects them; Windows lacks the flag.
        // O_NOFOLLOW rejects symlink swaps after resolution; Windows lacks both flags.
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
          let offset = 0;
          while (offset < bytesToRead) {
            const { bytesRead } = yield* Effect.tryPromise({
              try: () => handle.read(buffer, offset, bytesToRead - offset, offset),
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
            if (bytesRead <= 0) break;
            offset += bytesRead;
          }
          const fileBytes = buffer.subarray(0, offset);
          const truncated = stat.size > PROJECT_READ_FILE_MAX_BYTES;
          const binaryFileError = () =>
            new WorkspaceBinaryFileError({
              workspaceRoot: input.cwd,
              relativePath: input.relativePath,
              resolvedPath: realTargetPath,
            });
          if (fileBytes.includes(0)) return yield* binaryFileError();
          // Fatal decoding rejects invalid UTF-8, since U+FFFD contents would corrupt the file on save.
          // Streaming decode drops a character the byte limit split, instead of rejecting it.
          const contents = yield* Effect.try({
            try: () =>
              new TextDecoder("utf-8", { fatal: true }).decode(fileBytes, { stream: truncated }),
            catch: binaryFileError,
          });
          return {
            relativePath: target.relativePath,
            contents,
            byteLength: stat.size,
            truncated,
            // SCIENT-FORK:START — raw-byte revisions and viewer authority.
            revision: revisionForBytes(fileBytes),
            ...(target.readOnly ? { readOnly: true } : {}),
            ...(target.outsideWorkspace ? { outsideWorkspace: true } : {}),
            // SCIENT-FORK:END
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
    const hostPath = yield* toHostPath(input.relativePath);
    if (!path.isAbsolute(hostPath)) {
      yield* workspacePaths.resolveRelativePathWithinRoot({
        workspaceRoot: input.cwd,
        relativePath: input.relativePath,
      });
    }
    return yield* (path.isAbsolute(hostPath) ? withSettledWorkspaceRead : withSettledFileRead)(
      { ...input, relativePath: hostPath },
      (attention, settlement) =>
        readResolvedFile(input, "contained", hostPath).pipe(
          Effect.map((result) =>
            attention === null ? result : { ...result, publicationAttention: attention },
          ),
          Effect.mapError((error) =>
            settledReadFailure(error, attention, settlement.currentMissing),
          ),
        ),
    );
  });
  const viewFile: WorkspaceFileSystem["Service"]["viewFile"] = Effect.fn(
    "WorkspaceFileSystem.viewFile",
  )(function* (input) {
    yield* assertNetworkPathWithinRoot(input);
    const hostPath = yield* toHostPath(input.relativePath);
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
    if (!rootExists) return yield* readResolvedFile(input, "view", hostPath);
    return yield* withSettledWorkspaceRead(
      { ...input, relativePath: hostPath },
      (attention, settlement) =>
        readResolvedFile(input, "view", hostPath).pipe(
          Effect.map((result) =>
            attention === null ? result : { ...result, publicationAttention: attention },
          ),
          Effect.mapError((error) =>
            settledReadFailure(error, attention, settlement.currentMissing),
          ),
        ),
    );
  });
  // SCIENT-FORK:END

  // Resolve existing ancestors and reject dangling links so creation cannot follow symlinks outside root.
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

  // SCIENT-FORK:START — the Files panel's moves, copies, new folders and Trash.
  const resolveEntryPath: WorkspaceFileSystem["Service"]["resolveEntryPath"] = Effect.fn(
    "WorkspaceFileSystem.resolveEntryPath",
  )(function* (input) {
    const cwd = path.resolve(input.cwd);
    yield* knownWorkspaces.assertContains(cwd);
    const target = yield* workspacePaths.resolveRelativePathWithinRoot({
      workspaceRoot: cwd,
      relativePath: input.relativePath,
    });
    const segments = path.relative(cwd, target.absolutePath).split(path.sep);
    const resolved = yield* Effect.tryPromise({
      try: async () => {
        const realRoot = await NodeFSP.realpath(cwd);
        // The parent must resolve to itself: no symlinked folder on the way.
        const parent = path.join(realRoot, ...segments.slice(0, -1));
        const realParent = await NodeFSP.realpath(parent);
        const absolutePath = path.join(realParent, segments.at(-1) ?? "");
        const allowed =
          segments[0] !== "" &&
          realParent === parent &&
          isInsideRealRoot(realRoot, absolutePath) &&
          !isInSourceFileStore(absolutePath) &&
          !(await isInGitFolder(absolutePath));
        return { realRoot, absolutePath, allowed };
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
    if (!resolved.allowed) {
      return yield* new WorkspaceFilePathEscapeError({
        workspaceRoot: input.cwd,
        relativePath: input.relativePath,
        resolvedWorkspaceRoot: resolved.realRoot,
        resolvedPath: resolved.absolutePath,
      });
    }
    return { relativePath: target.relativePath, absolutePath: resolved.absolutePath };
  });
  // SCIENT-FORK:END

  // SCIENT-FORK:START — revision-checked saves, exclusive creates, renames and deletes.
  const mutations = yield* makeWorkspaceFileMutations({
    fileSystem,
    path,
    workspacePaths,
    workspaceEntries,
    readFile: (input) => readResolvedFile(input, "contained"),
    get nativePublicationHelper() {
      return acceptedNativeFilePublicationHelper(helperPath);
    },
    resolveRetentionStorageDirectory,
    retentionDirectoryFor,
    retentionLimitBytes: config.filePublicationRetentionLimitBytes ?? null,
    fileHistoryDirectory: path.join(config.baseDir, "file-history"),
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
  // A retried save keeps its first BOM decision, so it replays the same bytes even after
  // another program changed the file; mutation receipts are matched by those bytes.
  const bomDecisions = new Map<string, boolean>();
  const writeFile: WorkspaceFileSystem["Service"]["writeFile"] = Effect.fn(
    "WorkspaceFileSystem.writeFile",
  )(function* (input) {
    const target = yield* assertWritableTarget(input);
    const { realTargetPath } = yield* resolveWriteTarget(target);
    const decided = input.mutationId === undefined ? undefined : bomDecisions.get(input.mutationId);
    const replacesFile =
      decided === undefined &&
      (yield* fileSystem.exists(realTargetPath).pipe(Effect.orElseSucceed(() => false)));
    // readFile decodes the BOM away, so an editor save would otherwise drop it from the file.
    const keepsBom =
      decided ??
      (replacesFile &&
        !input.contents.startsWith(UTF8_BOM) &&
        (yield* Effect.promise(() => startsWithUtf8Bom(realTargetPath))));
    if (input.mutationId !== undefined && decided === undefined) {
      bomDecisions.set(input.mutationId, keepsBom);
      if (bomDecisions.size > 512) bomDecisions.delete(bomDecisions.keys().next().value!);
    }
    const contents = keepsBom ? UTF8_BOM + input.contents : input.contents;
    return yield* mutations.writeFile({ ...input, ...target, contents });
  });
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
    retainedWriteFolders,
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
    // SCIENT-FORK:START — Overleaf preflights the folders each retained write needs.
    retainedWriteFolders,
    // SCIENT-FORK:END
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
    // SCIENT-FORK:START — the Files panel's entry changes.
    resolveEntryPath,
    // SCIENT-FORK:END
    viewFile,
    watchFile,
    writeFile,
  });
});

export const layer = Layer.effect(WorkspaceFileSystem, make);
