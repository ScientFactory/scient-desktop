// @effect-diagnostics nodeBuiltinImport:off
/** All manuscript namespace changes share durable native ownership and original intent receipts. */
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import type {
  ProjectDeleteFileInput,
  ProjectDeleteFileResult,
  ProjectRenameFileInput,
  ProjectRenameFileResult,
  ProjectWriteFileInput,
  ProjectWriteFileResult,
  ProjectListFileVersionsInput,
  ProjectListFileVersionsResult,
  ProjectDiscardFileVersionInput,
  ProjectDiscardFileVersionResult,
  ProjectFilePublicationAttention,
  ProjectResolveFileMutationInput,
  ProjectResolveFileMutationResult,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import type * as FileSystem from "effect/FileSystem";
import type * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import type * as WorkspaceEntries from "../../workspace/WorkspaceEntries.ts";
import {
  WorkspaceFilePathEscapeError,
  WorkspaceFileSystemOperationError,
  type WorkspaceFileSystemError,
  type WorkspaceFileSystem,
} from "../../workspace/WorkspaceFileSystem.ts";
import type * as WorkspacePaths from "../../workspace/WorkspacePaths.ts";
import {
  bindNativeFilePublication,
  bindNativeFilePublicationParent,
  ensureNativePrivateRetentionDirectory,
  nativeFilePublicationCapabilities,
  withNativeFilePublicationLease,
  type NativeFileBinding,
  type NativeFilePublicationLease,
  type NativeFileLeaseBinding,
} from "./NativeFilePublication.ts";
import {
  assertPrivateRetention,
  assertRootBinding,
  bytesRevision,
  directoryIdentity,
  durableJson,
  fileIdentity,
  fileRevision,
  inspectGuardedFile,
  mutateRetainedFile,
  prepareRetainedDirectory,
  publicationLeaseBindings,
  readRetainedRecord,
  retainedFileNames,
  retainedMutationReceipt,
  retainedPaths,
  retainedViewPath,
  sameIdentity,
  syncDirectory,
  RetainedMutationError,
  type RetainedMutationInput,
  type RetainedMutationResult,
  type RetainedMutationHooks,
} from "./RetainedFileMutation.ts";
import {
  isNodeError,
  WorkspaceFileExistsError,
  WorkspaceFileRevisionConflictError,
  WorkspaceFileTargetChangedError,
  WorkspaceFileRecoveryRequiredError,
  WorkspaceFileMutationUnavailableError,
  WorkspaceFileMutationIntentConflictError,
} from "./WorkspaceFileErrors.ts";

export interface WorkspaceWriteTargetInspection {
  readonly relativePath: string;
  readonly canonicalRelativePath: string;
  readonly traversesSymlink: boolean;
}
export interface WorkspaceFileReadSettlement {
  readonly currentMissing: boolean;
}
export interface WorkspaceCreateBinaryFileInput {
  readonly cwd: string;
  readonly relativePath: string;
  readonly bytes: Uint8Array;
  readonly mutationId?: string;
}
export interface WorkspaceWriteBinaryFileInput extends WorkspaceCreateBinaryFileInput {
  readonly createOnly?: true;
  readonly expectedRevision?: string;
  readonly expectedMutationEpoch?: string;
}
export type WorkspaceMutationError =
  | WorkspaceFileSystemError
  | WorkspaceFileTargetChangedError
  | WorkspaceFileRecoveryRequiredError
  | WorkspaceFileMutationUnavailableError
  | WorkspaceFileMutationIntentConflictError;
type MutationError = WorkspaceMutationError | WorkspacePaths.WorkspacePathsError;
export interface WorkspaceRetainedFileMethods {
  readonly prepareRetainedDirectory: (input: {
    readonly cwd: string;
    readonly retentionDirectory: string;
  }) => Effect.Effect<string, MutationError>;
  readonly replaceFileRetained: (
    input: RetainedMutationInput,
  ) => Effect.Effect<RetainedMutationResult, MutationError>;
  readonly removeFileRetained: (
    input: Omit<RetainedMutationInput, "bytes">,
  ) => Effect.Effect<RetainedMutationResult, MutationError>;
  readonly registerRetainedFileHistory: (input: {
    readonly cwd: string;
    readonly retentionDirectory: string;
  }) => Effect.Effect<void, MutationError>;
}
export interface WorkspaceFileMutationMethods extends WorkspaceRetainedFileMethods {
  readonly inspectWriteTarget: (
    input: Pick<ProjectWriteFileInput, "cwd" | "relativePath">,
  ) => Effect.Effect<WorkspaceWriteTargetInspection, MutationError>;
  readonly writeFile: (
    input: ProjectWriteFileInput,
  ) => Effect.Effect<ProjectWriteFileResult, MutationError>;
  readonly renameFile: (
    input: ProjectRenameFileInput,
  ) => Effect.Effect<ProjectRenameFileResult, MutationError>;
  readonly deleteFile: (
    input: ProjectDeleteFileInput,
  ) => Effect.Effect<ProjectDeleteFileResult, MutationError>;
  readonly createBinaryFile: (
    input: WorkspaceCreateBinaryFileInput,
  ) => Effect.Effect<ProjectWriteFileResult, MutationError>;
  readonly writeBinaryFile: (
    input: WorkspaceWriteBinaryFileInput,
  ) => Effect.Effect<
    ProjectWriteFileResult & { readonly publicationEpoch?: string },
    MutationError
  >;
  readonly listFileVersions: (
    input: ProjectListFileVersionsInput,
  ) => Effect.Effect<ProjectListFileVersionsResult, MutationError>;
  readonly discardFileVersion: (
    input: ProjectDiscardFileVersionInput,
  ) => Effect.Effect<ProjectDiscardFileVersionResult, MutationError>;
  readonly withSettledFileRead: <A, E, R>(
    input: { readonly cwd: string; readonly relativePath: string },
    read: (
      attention: ProjectFilePublicationAttention | null,
      settlement: WorkspaceFileReadSettlement,
    ) => Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | MutationError, R>;
  readonly withSettledWorkspaceRead: <A, E, R>(
    input: { readonly cwd: string; readonly relativePath?: string },
    read: (
      attention: ProjectFilePublicationAttention | null,
      settlement: WorkspaceFileReadSettlement,
    ) => Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | MutationError, R>;
  readonly getMutationEpoch: (input: {
    readonly cwd: string;
    readonly relativePaths?: ReadonlyArray<string>;
  }) => Effect.Effect<string, MutationError>;
  readonly withWorkspacePublicationFence: <A, E, R>(
    input: { readonly cwd: string; readonly expectedEpoch: string },
    commit: () => Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | MutationError, R>;
  readonly resolveFileMutation: (
    input: ProjectResolveFileMutationInput,
  ) => Effect.Effect<ProjectResolveFileMutationResult, MutationError>;
}
export const revisionForBytes = bytesRevision;
const Identity = Schema.Struct({ dev: Schema.String, ino: Schema.String });
const Reference = Schema.Struct({
  version: Schema.Literal(1),
  recordDirectory: Schema.String,
  target: Schema.optionalKey(Schema.String),
  requestedPath: Schema.optionalKey(Schema.String),
  mutationId: Schema.optionalKey(Schema.String),
  intent: Schema.optionalKey(Schema.String),
});
const Review = Schema.Struct({
  version: Schema.Literal(1),
  rootPath: Schema.String,
  target: Schema.String,
  rootIdentity: Identity,
  parentIdentity: Identity,
  revision: Schema.NullOr(Schema.String),
});
const JournalHeader = Schema.Struct({
  target: Schema.optionalKey(Schema.String),
  mutationId: Schema.optionalKey(Schema.String),
  requestedPath: Schema.optionalKey(Schema.String),
});
const decodeReference = Schema.decodeUnknownSync(Schema.fromJsonString(Reference));
const decodeReview = Schema.decodeUnknownSync(Schema.fromJsonString(Review));
const decodeHeader = Schema.decodeUnknownSync(Schema.fromJsonString(JournalHeader));
type Stored = {
  directory: string;
  record: Awaited<ReturnType<typeof readRetainedRecord>> | null;
  target: string | null;
  requestedPath: string | null;
  mutationId: string;
};
const within = (root: string, target: string) => {
  const relative = NodePath.relative(root, target);
  return (
    relative !== ".." && !relative.startsWith(`..${NodePath.sep}`) && !NodePath.isAbsolute(relative)
  );
};
const keyFor = (id: string) =>
  `mutation-${NodeCrypto.createHash("sha256").update(id).digest("hex")}`;

export const makeWorkspaceFileMutations = Effect.fnUntraced(function* (deps: {
  readonly fileSystem: FileSystem.FileSystem;
  readonly path: Path.Path;
  readonly workspacePaths: WorkspacePaths.WorkspacePaths["Service"];
  readonly workspaceEntries: WorkspaceEntries.WorkspaceEntries["Service"];
  readonly readFile: WorkspaceFileSystem["Service"]["readFile"];
  readonly nativePublicationHelper?: string;
  readonly retentionStorageDirectory: string;
  readonly retentionDirectoryFor: (canonicalRoot: string, parentPath: string) => Promise<string>;
  readonly retentionLimitBytes?: number | null;
  readonly retainedHooks?: RetainedMutationHooks;
}) {
  const { workspacePaths, workspaceEntries } = deps;
  const errorFor = (
    input: { cwd: string; relativePath: string },
    target: string,
    cause: unknown,
  ): WorkspaceMutationError => {
    const fields = {
      workspaceRoot: input.cwd,
      relativePath: input.relativePath,
      resolvedPath: target,
    };
    if (
      Schema.is(WorkspaceFileRevisionConflictError)(cause) ||
      Schema.is(WorkspaceFileExistsError)(cause)
    )
      return cause;
    if (cause instanceof RetainedMutationError) {
      if (cause.reason === "intent")
        return new WorkspaceFileMutationIntentConflictError({
          ...fields,
          publicationOutcome: "unchanged",
        });
      if (cause.reason === "unavailable")
        return new WorkspaceFileMutationUnavailableError({
          ...fields,
          publicationOutcome: "unchanged",
        });
      if (cause.reason === "target")
        return new WorkspaceFileTargetChangedError({ ...fields, publicationOutcome: "unchanged" });
      return new WorkspaceFileRecoveryRequiredError({
        ...fields,
        recoveryId: cause.recoveryId,
        retainedPaths: [...cause.retainedPaths],
        publicationOutcome: "retained-attention",
      });
    }
    return new WorkspaceFileSystemOperationError({
      ...fields,
      operationPath: target,
      operation: "retained-publication",
      cause,
    });
  };
  // Interruption may abort queued acquisition, but its finalizer waits for owned native work and leases to retire.
  const owned = <A>(
    input: { cwd: string; relativePath: string },
    target: string,
    run: (signal: AbortSignal) => Promise<A>,
  ) =>
    Effect.callback<A, WorkspaceMutationError>((resume, signal) => {
      const retired = Promise.resolve()
        .then(() => run(signal))
        .then(
          (value) => {
            resume(Effect.succeed(value));
          },
          (cause) => {
            resume(Effect.fail(errorFor(input, target, cause)));
          },
        );
      return Effect.promise(() => retired);
    });
  const helperFor = () => {
    if (!deps.nativePublicationHelper)
      throw new RetainedMutationError(
        "unavailable",
        "Native publication helper is not configured.",
        "native-capability",
      );
    return deps.nativePublicationHelper;
  };
  const preparePrivateDirectory: WorkspaceRetainedFileMethods["prepareRetainedDirectory"] = (
    input,
  ) =>
    owned({ cwd: input.cwd, relativePath: "." }, input.retentionDirectory, async () => {
      if (!NodePath.isAbsolute(input.retentionDirectory))
        throw new RetainedMutationError(
          "unavailable",
          "Host retention must use an absolute configured directory.",
          "storage",
        );
      try {
        return await ensureNativePrivateRetentionDirectory(helperFor(), input.retentionDirectory);
      } catch (cause) {
        throw new RetainedMutationError(
          "unavailable",
          "Native private retention provisioning refused before payload or namespace admission.",
          "storage",
          [],
          { cause },
        );
      }
    });
  const resolveTarget = Effect.fn("WorkspaceFileSystem.resolveMutationTarget")(function* (
    input: { cwd: string; relativePath: string },
    history = false,
  ) {
    const named = yield* workspacePaths.resolveRelativePathWithinRoot({
      workspaceRoot: input.cwd,
      relativePath: input.relativePath,
    });
    const resolved = yield* Effect.tryPromise({
      try: async () => {
        const root = await NodeFSP.realpath(input.cwd),
          requestedPath = NodePath.join(root, named.relativePath);
        let candidate = named.absolutePath;
        const missing: string[] = [];
        for (;;) {
          try {
            const canonical = await NodeFSP.realpath(candidate),
              target = NodePath.join(canonical, ...missing);
            if (history && !within(root, target))
              return {
                root,
                target: requestedPath,
                physicalTarget: target,
                requestedPath,
                named,
                relativePath: named.relativePath,
                traversesSymlink: true,
              };
            return {
              root,
              target,
              physicalTarget: target,
              requestedPath,
              named,
              relativePath: NodePath.relative(root, target).replaceAll(NodePath.sep, "/"),
              traversesSymlink: target !== requestedPath,
            };
          } catch (e) {
            if (!isNodeError(e, "ENOENT") && !isNodeError(e, "ENOTDIR")) throw e;
            try {
              if ((await NodeFSP.lstat(candidate)).isSymbolicLink()) {
                if (history)
                  return {
                    root,
                    target: requestedPath,
                    physicalTarget: requestedPath,
                    requestedPath,
                    named,
                    relativePath: named.relativePath,
                    traversesSymlink: true,
                  };
                throw new RetainedMutationError(
                  "target",
                  "Dangling alias cannot authorize a new target.",
                  "binding",
                );
              }
            } catch (statError) {
              if (!isNodeError(statError, "ENOENT") && !isNodeError(statError, "ENOTDIR"))
                throw statError;
            }
            const parent = NodePath.dirname(candidate);
            if (parent === candidate) throw e;
            missing.unshift(NodePath.basename(candidate));
            candidate = parent;
          }
        }
      },
      catch: (cause) => errorFor(input, named.absolutePath, cause),
    });
    if (!within(resolved.root, resolved.target))
      return yield* new WorkspaceFilePathEscapeError({
        workspaceRoot: input.cwd,
        relativePath: input.relativePath,
        resolvedWorkspaceRoot: resolved.root,
        resolvedPath: resolved.target,
      });
    return resolved;
  });
  type Resolved = Effect.Success<ReturnType<typeof resolveTarget>>;
  const readOptional = async <A>(path: string, decode: (value: string) => A): Promise<A | null> => {
    try {
      return decode(await NodeFSP.readFile(path, "utf8"));
    } catch (e) {
      if (isNodeError(e, "ENOENT")) return null;
      throw e;
    }
  };
  const recordsIn = async (storage: string): Promise<Stored[]> => {
    let entries;
    try {
      await assertPrivateRetention(storage);
      entries = await NodeFSP.readdir(storage, { withFileTypes: true });
    } catch (e) {
      if (isNodeError(e, "ENOENT")) return [];
      throw e;
    }
    const records: Stored[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !/^[a-zA-Z0-9_-]{1,100}$/u.test(entry.name)) continue;
      const indexed = NodePath.join(storage, entry.name);
      await assertPrivateRetention(indexed);
      const reference = await readOptional(
        NodePath.join(indexed, "reference.json"),
        decodeReference,
      );
      const directory = reference?.recordDirectory ?? indexed;
      await assertPrivateRetention(directory);
      const text = await readOptional(NodePath.join(directory, "record.json"), (value) => value);
      if (text === null) {
        if (reference) {
          const refusalPath = NodePath.join(
            deps.retentionStorageDirectory,
            "mutation-identities",
            keyFor(reference.mutationId ?? entry.name),
            "refusal.json",
          );
          const refusal = await readOptional(refusalPath, (value) =>
            Schema.decodeUnknownSync(
              Schema.fromJsonString(
                Schema.Struct({
                  version: Schema.Literal(1),
                  outcome: Schema.Literal("unchanged"),
                  reason: Schema.String,
                }),
              ),
            )(value),
          );
          if (!refusal)
            records.push({
              directory,
              record: null,
              target: reference.target ?? null,
              requestedPath: reference.requestedPath ?? null,
              mutationId: reference.mutationId ?? entry.name,
            });
        }
        continue;
      }
      let record: Stored["record"] = null,
        header: typeof JournalHeader.Type = {};
      try {
        record = await readRetainedRecord(directory);
      } catch {
        try {
          header = decodeHeader(text);
        } catch {
          /* Unknown authority is explicit attention, never replay permission. */
        }
      }
      records.push({
        directory,
        record,
        target: record?.target ?? reference?.target ?? header.target ?? null,
        requestedPath:
          record?.version === 2
            ? (record.requestedPath ?? reference?.requestedPath ?? null)
            : (reference?.requestedPath ?? header.requestedPath ?? null),
        mutationId:
          record?.version === 2
            ? record.mutationId
            : (reference?.mutationId ?? header.mutationId ?? entry.name),
      });
    }
    return records;
  };
  const allRecords = async (): Promise<Stored[]> => {
    let parents;
    try {
      await assertPrivateRetention(deps.retentionStorageDirectory);
      parents = await NodeFSP.readdir(deps.retentionStorageDirectory, { withFileTypes: true });
    } catch (e) {
      if (isNodeError(e, "ENOENT")) return [];
      throw e;
    }
    const records: Stored[] = [];
    for (const parent of parents)
      if (
        parent.isDirectory() &&
        (/^\d+-\d+$/u.test(parent.name) || parent.name === "mutation-identities")
      )
        records.push(
          ...(await recordsIn(NodePath.join(deps.retentionStorageDirectory, parent.name))),
        );
    return [...new Map(records.map((record) => [record.directory, record])).values()];
  };
  const retainedTreeBytes = async (path: string): Promise<number> => {
    let stat;
    try {
      stat = await NodeFSP.lstat(path);
    } catch (cause) {
      if (isNodeError(cause, "ENOENT")) return 0;
      throw cause;
    }
    let bytes = stat.size;
    if (stat.isDirectory()) {
      for (const name of await NodeFSP.readdir(path))
        bytes += await retainedTreeBytes(NodePath.join(path, name));
    }
    return bytes; // Admission observation, not a hard filesystem quota against later outside writes.
  };
  const forTarget = (records: ReadonlyArray<Stored>, resolved: Resolved) =>
    records.filter(
      (entry) =>
        entry.target === null ||
        entry.target === resolved.target ||
        entry.requestedPath === resolved.requestedPath ||
        (entry.record?.version === 2 && entry.record.destination === resolved.target),
    );
  const nearestParent = async (root: string, target: string) => {
    let parent = NodePath.dirname(target);
    for (;;) {
      try {
        if ((await NodeFSP.realpath(parent)) !== parent)
          throw new RetainedMutationError(
            "target",
            "Canonical publication parent changed.",
            "parent-binding",
          );
        await directoryIdentity(parent);
        return bindNativeFilePublicationParent(helperFor(), root, NodePath.relative(root, parent));
      } catch (e) {
        if (!isNodeError(e, "ENOENT") && !isNodeError(e, "ENOTDIR")) throw e;
        if (parent === root || !within(root, parent)) throw e;
        parent = NodePath.dirname(parent);
      }
    }
  };
  const validBinding = async (binding: NativeFileBinding, directory: string) => {
    try {
      const fresh = await bindNativeFilePublication(helperFor(), {
        rootPath: binding.rootPath,
        parentRelativePath: binding.parentRelativePath,
        recordPath: directory,
      });
      return (
        sameIdentity(fresh.rootIdentity, binding.rootIdentity) &&
        sameIdentity(fresh.parentIdentity, binding.parentIdentity) &&
        sameIdentity(fresh.recordIdentity, binding.recordIdentity)
      );
    } catch {
      return false;
    }
  };
  const bindingsFor = async (
    base: ReadonlyArray<NativeFileLeaseBinding>,
    records: ReadonlyArray<Stored>,
  ) => {
    const bindings: NativeFileLeaseBinding[] = [...base];
    const privateDirectories: string[] = [];
    for (const { directory, record } of records) {
      // Private records are also mutation parents: journal fsync, compensation, views and tombstones stay owned.
      privateDirectories.push(directory);
      if (record?.version !== 2 || record.phase === "done") continue;
      if (record.binding && (await validBinding(record.binding, directory)))
        bindings.push(record.binding);
      if (record.destinationBinding && (await validBinding(record.destinationBinding, directory)))
        bindings.push(record.destinationBinding);
    }
    return publicationLeaseBindings(helperFor(), bindings, privateDirectories);
  };
  const settle = async (
    records: ReadonlyArray<Stored>,
    lease: NativeFilePublicationLease,
    skipDirectory?: string,
  ) => {
    for (const { directory, record, mutationId } of records) {
      if (!record || record.version !== 2 || record.phase === "done" || directory === skipDirectory)
        continue;
      if (
        !record.binding ||
        !(await validBinding(record.binding, directory)) ||
        (record.destinationBinding && !(await validBinding(record.destinationBinding, directory)))
      ) {
        await durableJson(NodePath.join(directory, "record.json"), {
          ...record,
          phase: "done",
          outcome: "attention",
          failure: "target",
          generation: record.generation + 1,
        });
        continue;
      }
      try {
        await mutateRetainedFile(
          {
            cwd: record.binding.rootPath,
            relativePath: NodePath.relative(record.binding.rootPath, record.target),
            retentionDirectory: NodePath.dirname(directory),
            id: NodePath.basename(directory),
            mutationId,
            expectedRevision: record.expected,
            nativePublicationHelper: helperFor(),
            kind: record.kind,
            condition: record.condition,
            executable: record.executable,
            ...(record.guardMaxBytes === null ? {} : { guardMaxBytes: record.guardMaxBytes }),
            ...(record.expectedMutationEpoch === undefined
              ? {}
              : { expectedMutationEpoch: record.expectedMutationEpoch }),
            ...(record.destination === null ? {} : { destination: record.destination }),
            ...(record.visibleRetentionPath === null
              ? {}
              : { visibleRetentionPath: record.visibleRetentionPath }),
            binding: record.binding,
            ...(record.destinationBinding ? { destinationBinding: record.destinationBinding } : {}),
            lease,
          },
          record.target,
        );
      } catch {
        const current = await readRetainedRecord(directory);
        if (current.version === 2 && current.phase !== "done")
          await durableJson(NodePath.join(directory, "record.json"), {
            ...current,
            phase: "done",
            outcome: "attention",
            failure: "recovery",
            generation: current.generation + 1,
          });
      }
    }
  };
  const withOwnership = async <A>(
    base: ReadonlyArray<NativeFileLeaseBinding>,
    discover: () => Promise<Stored[]>,
    body: (records: Stored[], lease: NativeFilePublicationLease) => Promise<A>,
    signal: AbortSignal,
  ) => {
    for (;;) {
      const before = await discover(),
        bindings = await bindingsFor(base, before);
      const held = new Set(
        bindings
          .filter((binding) => binding.mode === "exclusive")
          .map((binding) => `${binding.parentIdentity.dev}:${binding.parentIdentity.ino}`),
      );
      const result = await withNativeFilePublicationLease(
        helperFor(),
        bindings,
        async (lease) => {
          const records = await discover(),
            required = await bindingsFor(base, records);
          if (
            required.some(
              (binding) =>
                binding.mode === "exclusive" &&
                !held.has(`${binding.parentIdentity.dev}:${binding.parentIdentity.ino}`),
            )
          )
            return { reacquire: true as const };
          return { reacquire: false as const, value: await body(records, lease) };
        },
        { mode: "shared", signal },
      );
      if (!result.reacquire) return result.value;
      if (signal.aborted)
        throw new RetainedMutationError(
          "unavailable",
          "Publication acquisition cancelled before namespace work.",
          "cancelled",
        );
    }
  };
  const reviewed = async (entry: Stored, resolved: Resolved) => {
    const review = await readOptional(NodePath.join(entry.directory, "review.json"), decodeReview);
    if (!review) return false;
    try {
      const parent = await nearestParent(resolved.root, resolved.target);
      return (
        review.rootPath === resolved.root &&
        review.target === resolved.target &&
        sameIdentity(review.rootIdentity, parent.rootIdentity) &&
        sameIdentity(review.parentIdentity, parent.parentIdentity)
      );
    } catch {
      return false;
    }
  };
  const requiresAttention = (entry: Stored) => {
    const record = entry.record;
    if (
      !record ||
      record.version === 1 ||
      record.phase !== "done" ||
      record.sourceMutation === undefined
    )
      return true;
    // A completed receipt grants no permission to mutate or reapply its old binding.
    // Older successful creates linked the stage, and mount device IDs may change;
    // neither makes a retired success an unresolved operation. Fresh publications
    // still qualify today's binding and bytes, and modern creates isolate writers.
    return !(
      (record.outcome === "done" && record.failure === null) ||
      (record.outcome === "skipped" && record.sourceMutation === false)
    );
  };
  const bindingCurrent = async (binding: NativeFileLeaseBinding) => {
    const parentPath = NodePath.join(binding.rootPath, binding.parentRelativePath);
    try {
      return (
        (await NodeFSP.realpath(binding.rootPath)) === binding.rootPath &&
        (await NodeFSP.realpath(parentPath)) === parentPath &&
        sameIdentity(await directoryIdentity(binding.rootPath), binding.rootIdentity) &&
        sameIdentity(await directoryIdentity(parentPath), binding.parentIdentity)
      );
    } catch {
      return false;
    }
  };
  const ordinaryParents = async (root: string, target: string) => {
    let parent = root;
    for (const name of NodePath.relative(root, NodePath.dirname(target))
      .split(NodePath.sep)
      .filter(Boolean)) {
      parent = NodePath.join(parent, name);
      const stat = await NodeFSP.lstat(parent).catch((cause: NodeJS.ErrnoException) => {
        if (cause.code === "ENOENT") return null;
        throw cause;
      });
      if (!stat) return true;
      if (!stat.isDirectory() || stat.isSymbolicLink()) return false;
    }
    return true;
  };
  const proveMissing = async (
    resolved: Resolved,
    rootBinding: NativeFileLeaseBinding,
    capturedParent: NativeFileLeaseBinding | null,
  ) => {
    if (
      !capturedParent ||
      resolved.traversesSymlink ||
      resolved.target !== resolved.requestedPath ||
      !(await nativeFilePublicationCapabilities(helperFor())).strictCurrentRoot
    )
      return false;
    try {
      if (
        !(await bindingCurrent(rootBinding)) ||
        !(await bindingCurrent(capturedParent)) ||
        !(await ordinaryParents(resolved.root, resolved.requestedPath))
      )
        return false;
      const absent = async () =>
        NodeFSP.lstat(resolved.requestedPath).then(
          () => false,
          (cause: NodeJS.ErrnoException) => {
            if (cause.code === "ENOENT") return true;
            throw cause;
          },
        );
      if (!(await absent())) return false;
      const currentParent = await nearestParent(resolved.root, resolved.requestedPath);
      if (
        !sameIdentity(currentParent.rootIdentity, capturedParent.rootIdentity) ||
        !sameIdentity(currentParent.parentIdentity, capturedParent.parentIdentity) ||
        currentParent.parentRelativePath !== capturedParent.parentRelativePath
      )
        return false;
      return (
        (await absent()) &&
        (await ordinaryParents(resolved.root, resolved.requestedPath)) &&
        (await bindingCurrent(capturedParent)) &&
        (await bindingCurrent(rootBinding))
      );
    } catch {
      return false;
    }
  };
  const attentionFor = async (
    records: ReadonlyArray<Stored>,
    resolved: Resolved,
  ): Promise<ProjectFilePublicationAttention | null> => {
    const unresolved: Stored[] = [];
    for (const entry of forTarget(records, resolved))
      if ((await requiresAttention(entry)) && !(await reviewed(entry, resolved)))
        unresolved.push(entry);
    const first = unresolved[0];
    if (!first) return null;
    const paths: string[] = [];
    for (const entry of unresolved)
      for (const path of await retainedPaths(entry.directory))
        paths.push(
          await retainedViewPath(
            entry.directory,
            NodePath.basename(path) as (typeof retainedFileNames)[number],
            entry.target ?? resolved.target,
          ),
        );
    return {
      recoveryId: first.mutationId,
      mutationId: first.mutationId,
      retainedPaths: paths,
      message:
        "This retired publication requires explicit acceptance of the displayed current revision. Retained versions remain available.",
    };
  };
  const withParent = async <A>(
    resolved: Resolved,
    body: (
      records: Stored[],
      lease: NativeFilePublicationLease,
      rootBinding: NativeFileLeaseBinding,
      parentBinding: NativeFileLeaseBinding | null,
    ) => Promise<A>,
    signal: AbortSignal,
  ) => {
    const binding = await bindNativeFilePublicationParent(helperFor(), resolved.root, ""),
      parent = await nearestParent(resolved.root, resolved.requestedPath).catch(() => null);
    const discover = async () => forTarget(await allRecords(), resolved);
    return withOwnership(
      [
        { ...binding, mode: "exclusive" },
        ...(parent ? [{ ...parent, mode: "exclusive" as const }] : []),
      ],
      discover,
      async (records, lease) => {
        if (!(await bindingCurrent(binding)))
          throw new RetainedMutationError(
            "target",
            "Current root authority changed while waiting for ownership.",
            "root-binding",
          );
        await settle(records, lease);
        return body(await discover(), lease, binding, parent);
      },
      signal,
    );
  };
  const ensureParents = async (
    root: string,
    target: string,
    identityBinding: NativeFileLeaseBinding,
    admissionBinding: NativeFileLeaseBinding,
    signal: AbortSignal,
  ) => {
    const wanted = NodePath.dirname(target);
    for (;;) {
      const parent = await nearestParent(root, target),
        current = NodePath.join(root, parent.parentRelativePath);
      if (current === wanted) return;
      const name = NodePath.relative(current, wanted).split(NodePath.sep)[0]!;
      const bindings = await publicationLeaseBindings(helperFor(), [parent, identityBinding]);
      await withNativeFilePublicationLease(
        helperFor(),
        bindings,
        async (lease) => {
          if (
            !(await bindingCurrent(admissionBinding)) ||
            !sameIdentity(parent.rootIdentity, admissionBinding.rootIdentity)
          )
            throw new RetainedMutationError(
              "target",
              "Directory preparation cannot rebind admitted root or parent authority.",
              "parent-binding",
            );
          const rootCapabilities = await nativeFilePublicationCapabilities(helperFor(), root);
          const parentCapabilities = await nativeFilePublicationCapabilities(helperFor(), current);
          if (
            !rootCapabilities.strictCurrentRoot ||
            !rootCapabilities.publicationLease ||
            !rootCapabilities.exclusiveMove ||
            !rootCapabilities.exclusiveLink ||
            !parentCapabilities.strictCurrentRoot ||
            !parentCapabilities.publicationLease ||
            !parentCapabilities.exclusiveMove ||
            !parentCapabilities.exclusiveLink
          )
            throw new RetainedMutationError(
              "unavailable",
              "Fresh native directory-preparation qualification failed before mkdir.",
              "parent-binding",
            );
          const reply = await lease.runDirectory({ binding: parent, operation: "mkdir", name });
          if (
            reply.outcome !== "applied" ||
            reply.code !== 0 ||
            Object.values(reply.flush).some((code) => code > 0)
          ) {
            const directory = NodePath.join(current, name);
            // Another first-party actor may already have created this exact canonical directory.
            if (reply.outcome !== "unchanged" || (await NodeFSP.realpath(directory)) !== directory)
              throw new RetainedMutationError(
                "target",
                "Native workspace parent creation refused.",
                "parent-binding",
              );
            await directoryIdentity(directory);
          }
        },
        { mode: "exclusive", signal },
      );
    }
  };
  const qualifyBytePublication = async (
    input: { cwd: string; relativePath: string },
    resolved: Resolved,
    intent: Pick<
      RetainedMutationInput,
      | "kind"
      | "condition"
      | "expectedRevision"
      | "bytes"
      | "guardMaxBytes"
      | "expectedMutationEpoch"
      | "id"
    >,
    signal: AbortSignal,
  ) => {
    if (intent.kind !== "write" && intent.kind !== "create") return;
    const capabilities = await nativeFilePublicationCapabilities(helperFor(), resolved.root);
    if (
      !capabilities.strictCurrentRoot ||
      !capabilities.publicationLease ||
      !capabilities.exclusiveMove ||
      !capabilities.exclusiveLink
    )
      throw new RetainedMutationError(
        "unavailable",
        "This host has not qualified byte-publication ownership.",
        intent.id,
      );
    const existingParent = await nearestParent(resolved.root, resolved.target);
    const parentCapabilities = await nativeFilePublicationCapabilities(
      helperFor(),
      NodePath.join(existingParent.rootPath, existingParent.parentRelativePath),
    );
    const creation =
      intent.kind === "create" ||
      intent.condition === "absent" ||
      (intent.kind === "write" &&
        intent.condition === "unguarded" &&
        (await fileIdentity(resolved.target)) === null);
    const qualified = creation
      ? capabilities.atomicCreateMetadata && parentCapabilities.atomicCreateMetadata
      : capabilities.atomicExchange;
    await withRoot(
      resolved.root,
      async (_root, records, rootBinding, parentBinding) => {
        const attention = await attentionFor(records, resolved);
        if (attention)
          throw new RetainedMutationError(
            "recovery",
            attention.message,
            attention.recoveryId,
            attention.retainedPaths,
          );
        if (
          intent.expectedMutationEpoch !== undefined &&
          (await epochFor(resolved.root, records)) !== intent.expectedMutationEpoch
        )
          throw new RetainedMutationError(
            "target",
            "Workspace mutation epoch changed before byte publication.",
            intent.id,
          );
        if (qualified) {
          if (!(await bindingCurrent(rootBinding)) || !(await bindingCurrent(existingParent)))
            throw new RetainedMutationError(
              "target",
              "Byte-publication authority changed during fresh admission.",
              intent.id,
            );
          return;
        }
        const snapshot = await inspectGuardedFile(resolved.target, intent.guardMaxBytes);
        const fields = {
          workspaceRoot: input.cwd,
          relativePath: input.relativePath,
          resolvedPath: resolved.target,
          publicationOutcome: "unchanged" as const,
        };
        if (
          intent.condition === "revision" &&
          (!snapshot ||
            snapshot.revision !== intent.expectedRevision ||
            (intent.guardMaxBytes !== undefined &&
              (snapshot.byteLength > intent.guardMaxBytes || snapshot.binary)))
        ) {
          if (snapshot)
            throw new WorkspaceFileRevisionConflictError({
              ...fields,
              currentRevision:
                intent.guardMaxBytes === undefined ? snapshot.revision : snapshot.leadingRevision,
            });
          throw new RetainedMutationError(
            "target",
            "The guarded target is not a current ordinary file.",
            intent.id,
          );
        }
        if (intent.condition === "absent" && (await fileIdentity(resolved.target)))
          throw new WorkspaceFileExistsError(fields);
        if (
          !(await bindingCurrent(rootBinding)) ||
          (parentBinding && !(await bindingCurrent(parentBinding))) ||
          (snapshot && !sameIdentity(snapshot.identity, await fileIdentity(resolved.target)))
        )
          throw new RetainedMutationError(
            "target",
            "Current byte-publication authority changed during qualification.",
            intent.id,
          );
        if (
          intent.kind === "write" &&
          intent.condition !== "absent" &&
          intent.bytes != null &&
          snapshot?.revision === bytesRevision(intent.bytes)
        )
          return;
        throw new RetainedMutationError(
          "unavailable",
          "This host does not support the required atomic file publication operation.",
          intent.id,
        );
      },
      signal,
      resolved.relativePath,
    );
  };
  const publish = Effect.fn("WorkspaceFileSystem.publishRetainedIntent")(function* (
    input: { cwd: string; relativePath: string },
    resolved: Resolved,
    intent: Omit<RetainedMutationInput, "cwd" | "relativePath" | "retentionDirectory">,
    destination?: Resolved,
    retentionOverride?: string,
  ) {
    return yield* owned(input, resolved.target, async (signal) => {
      const helper = helperFor();
      let capabilities;
      try {
        capabilities = await nativeFilePublicationCapabilities(helper);
      } catch (cause) {
        throw new RetainedMutationError(
          "unavailable",
          "Native capability admission failed before namespace work.",
          intent.id,
          [],
          { cause },
        );
      }
      if (
        !capabilities.strictCurrentRoot ||
        !capabilities.publicationLease ||
        !capabilities.exclusiveMove ||
        !capabilities.exclusiveLink
      )
        throw new RetainedMutationError(
          "unavailable",
          "This host has not qualified the required publication authority primitives.",
          intent.id,
        );
      const mutationId = retentionOverride
        ? `overleaf-${NodeCrypto.createHash("sha256").update(`${retentionOverride}\0${intent.id}`).digest("hex")}`
        : (intent.mutationId ?? intent.id);
      const admissionParent = await nearestParent(resolved.root, resolved.target);
      const admissionDestination = destination
        ? await nearestParent(destination.root, destination.target)
        : null;
      await qualifyBytePublication(input, resolved, intent, signal);
      const id = retentionOverride ? intent.id : keyFor(mutationId);
      const indexRoot = await ensureNativePrivateRetentionDirectory(
        helper,
        NodePath.join(deps.retentionStorageDirectory, "mutation-identities"),
      );
      const identityDirectory = await prepareRetainedDirectory(
        indexRoot,
        keyFor(mutationId),
        helper,
      );
      const identityBinding = await bindNativeFilePublicationParent(helper, identityDirectory, "");
      const fingerprint = bytesRevision(
        Buffer.from(
          JSON.stringify({
            root: resolved.root,
            target: resolved.target,
            requestedPath: resolved.requestedPath,
            destination: destination?.target ?? intent.destination ?? null,
            requestedDestination: destination?.requestedPath ?? intent.requestedDestination ?? null,
            kind: intent.kind,
            condition: intent.condition,
            expected: intent.expectedRevision,
            desired: intent.bytes == null ? null : bytesRevision(intent.bytes),
            executable: intent.executable ?? false,
            guardMaxBytes: intent.guardMaxBytes ?? null,
            expectedMutationEpoch: intent.expectedMutationEpoch ?? null,
          }),
        ),
      );
      const identityPath = NodePath.join(identityDirectory, "reference.json");
      const preflight = await withNativeFilePublicationLease(
        helper,
        await publicationLeaseBindings(helper, [identityBinding]),
        async () => {
          const immutable = await readOptional(
            NodePath.join(identityDirectory, "intent.json"),
            (text) =>
              Schema.decodeUnknownSync(
                Schema.fromJsonString(Schema.Struct({ intent: Schema.String })),
              )(text),
          );
          if (immutable && immutable.intent !== fingerprint)
            throw new RetainedMutationError(
              "intent",
              "Mutation identity was reused for a changed target, condition or bytes.",
              mutationId,
            );
          if (await readOptional(NodePath.join(identityDirectory, "refusal.json"), (text) => text))
            throw new RetainedMutationError(
              "unavailable",
              "This intent was durably refused before publication; a reviewed new intent needs a new identity.",
              mutationId,
            );
          const original = await readOptional(identityPath, decodeReference);
          if (original) {
            let terminal;
            try {
              terminal = await retainedMutationReceipt(original.recordDirectory);
            } catch {
              throw new RetainedMutationError(
                "recovery",
                "The original intent has retained directory-preparation attention.",
                mutationId,
                await retainedPaths(original.recordDirectory),
              );
            }
            if (terminal) return terminal;
          }
          if (!immutable)
            await durableJson(NodePath.join(identityDirectory, "intent.json"), {
              intent: fingerprint,
            });
          return null;
        },
        { mode: "exclusive", signal },
      );
      if (preflight) return preflight;
      if (
        !(await bindingCurrent(admissionParent)) ||
        (admissionDestination && !(await bindingCurrent(admissionDestination)))
      )
        throw new RetainedMutationError(
          "target",
          "Admitted namespace authority changed before directory preparation.",
          mutationId,
        );
      const existingParent = admissionParent;
      const existingDestination = admissionDestination;
      if (
        existingDestination &&
        existingDestination.parentIdentity.dev !== existingParent.parentIdentity.dev
      )
        throw new RetainedMutationError(
          "unavailable",
          "Cross-volume rename cannot preserve an exclusive retained object.",
          mutationId,
        );
      await deps.retentionDirectoryFor(
        resolved.root,
        NodePath.join(existingParent.rootPath, existingParent.parentRelativePath),
      );
      if (
        deps.retentionLimitBytes != null &&
        (intent.bytes?.byteLength ?? 0) + 16384 > deps.retentionLimitBytes
      ) {
        await withNativeFilePublicationLease(
          helper,
          await publicationLeaseBindings(helper, [identityBinding]),
          () =>
            durableJson(NodePath.join(identityDirectory, "refusal.json"), {
              version: 1,
              outcome: "unchanged",
              reason: "storage",
            }),
          { mode: "exclusive", signal },
        );
        throw new RetainedMutationError(
          "unavailable",
          "Retained storage cannot admit even the desired object without retiring unresolved history.",
          mutationId,
        );
      }
      const missingParents =
        NodePath.join(resolved.root, existingParent.parentRelativePath) !==
          NodePath.dirname(resolved.target) ||
        (existingDestination !== null &&
          destination !== undefined &&
          NodePath.join(destination.root, existingDestination.parentRelativePath) !==
            NodePath.dirname(destination.target));
      if (missingParents) {
        await withNativeFilePublicationLease(
          helper,
          await publicationLeaseBindings(helper, [identityBinding]),
          async () => {
            await durableJson(NodePath.join(identityDirectory, "record.json"), {
              version: "directory-preparation",
              target: resolved.target,
              requestedPath: resolved.requestedPath,
              mutationId,
            });
            await durableJson(identityPath, {
              version: 1,
              recordDirectory: identityDirectory,
              target: resolved.target,
              requestedPath: resolved.requestedPath,
              mutationId,
              intent: fingerprint,
            });
          },
          { mode: "exclusive", signal },
        );
      }
      // Directory preparation is journaled before its first protected mkdir. A crash retains attention.
      try {
        await ensureParents(
          resolved.root,
          resolved.target,
          identityBinding,
          admissionParent,
          signal,
        );
        if (destination && admissionDestination)
          await ensureParents(
            destination.root,
            destination.target,
            identityBinding,
            admissionDestination,
            signal,
          );
      } catch (cause) {
        if (missingParents)
          throw new RetainedMutationError(
            "recovery",
            "Native directory preparation retired with durable attention.",
            mutationId,
            [],
            { cause },
          );
        throw cause;
      }
      try {
        const storage = await deps.retentionDirectoryFor(
          resolved.root,
          NodePath.dirname(resolved.target),
        );
        await assertPrivateRetention(storage);
        const directory = await prepareRetainedDirectory(retentionOverride ?? storage, id, helper);
        const indexed = retentionOverride
          ? await prepareRetainedDirectory(storage, keyFor(mutationId), helper)
          : directory;
        const binding = await bindNativeFilePublication(helper, {
          rootPath: resolved.root,
          parentRelativePath: NodePath.relative(resolved.root, NodePath.dirname(resolved.target)),
          recordPath: directory,
        });
        const destinationBinding = destination
          ? await bindNativeFilePublication(helper, {
              rootPath: destination.root,
              parentRelativePath: NodePath.relative(
                destination.root,
                NodePath.dirname(destination.target),
              ),
              recordPath: directory,
            })
          : undefined;
        const indexBinding = await bindNativeFilePublicationParent(helper, indexed, "");
        const epochBindings =
          intent.expectedMutationEpoch === undefined
            ? []
            : [await bindNativeFilePublicationParent(helper, resolved.root, "")];
        const budgetBindings =
          deps.retentionLimitBytes == null
            ? []
            : [
                {
                  ...(await bindNativeFilePublicationParent(
                    helper,
                    deps.retentionStorageDirectory,
                    "",
                  )),
                  mode: "exclusive" as const,
                },
              ];
        const base = [
          binding,
          await bindNativeFilePublicationParent(helper, directory, ""),
          identityBinding,
          indexBinding,
          ...epochBindings,
          ...budgetBindings,
          ...(destinationBinding ? [destinationBinding] : []),
        ];
        const discover = async () => [
          ...new Map(
            [
              ...(await recordsIn(storage)),
              ...(intent.expectedMutationEpoch === undefined
                ? forTarget(await allRecords(), resolved)
                : await recordsUnderRoot(resolved.root)),
            ].map((entry) => [entry.directory, entry]),
          ).values(),
        ];
        return await withOwnership(
          base,
          discover,
          async (records, lease) => {
            const original = await readOptional(identityPath, decodeReference);
            if (original && (original.intent !== fingerprint || original.mutationId !== mutationId))
              throw new RetainedMutationError(
                "intent",
                "Mutation identity was reused for a changed target, condition or bytes.",
                mutationId,
              );
            if (original) {
              if (original.recordDirectory !== identityDirectory) {
                const receipt = await retainedMutationReceipt(original.recordDirectory);
                if (receipt) return receipt; // Original receipt survives later D and explicit review/discard.
                if (original.recordDirectory !== directory)
                  throw new RetainedMutationError(
                    "recovery",
                    "The original publication has unknown authority; it cannot be adopted at a rebound parent.",
                    mutationId,
                    await retainedPaths(original.recordDirectory),
                  );
              }
            }
            const current = await Effect.runPromise(resolveTarget(input));
            if (current.target !== resolved.target || current.root !== resolved.root)
              throw new RetainedMutationError(
                "target",
                "Alias changed while waiting for native ownership.",
                mutationId,
              );
            if (
              !(await bindingCurrent(admissionParent)) ||
              (admissionDestination && !(await bindingCurrent(admissionDestination)))
            )
              throw new RetainedMutationError(
                "target",
                "Admitted root or physical parent changed before publication.",
                mutationId,
              );
            if (destination) {
              const currentDestination = await Effect.runPromise(
                resolveTarget({ cwd: input.cwd, relativePath: destination.named.relativePath }),
              );
              if (
                currentDestination.target !== destination.target ||
                currentDestination.root !== destination.root
              )
                throw new RetainedMutationError(
                  "target",
                  "Destination alias changed while waiting for native ownership.",
                  mutationId,
                );
            }
            await settle(records, lease, directory);
            if (
              intent.expectedMutationEpoch !== undefined &&
              (await epochFor(
                resolved.root,
                (await recordsUnderRoot(resolved.root)).filter(
                  (entry) => entry.directory !== directory && entry.directory !== identityDirectory,
                ),
              )) !== intent.expectedMutationEpoch
            )
              throw new RetainedMutationError(
                "target",
                "Workspace mutated after binary publication admission.",
                mutationId,
              );
            const earlier = records.filter(
              (entry) =>
                entry.mutationId === mutationId &&
                entry.directory !== directory &&
                entry.directory !== identityDirectory,
            );
            if (earlier.length > 1)
              throw new RetainedMutationError(
                "recovery",
                "Multiple retained records claim this intent identity; none may be replayed as a new mutation.",
                mutationId,
              );
            const prior = earlier[0];
            if (prior) {
              const record = prior.record;
              if (!record || record.version !== 2)
                throw new RetainedMutationError(
                  "recovery",
                  "An earlier legacy intent has unknown publication authority.",
                  mutationId,
                  await retainedPaths(prior.directory),
                );
              if (
                record.target !== resolved.target ||
                record.destination !== (destination?.target ?? intent.destination ?? null) ||
                record.kind !== intent.kind ||
                record.condition !== intent.condition ||
                record.expected !== intent.expectedRevision ||
                record.desired !== (intent.bytes == null ? null : bytesRevision(intent.bytes)) ||
                record.guardMaxBytes !== (intent.guardMaxBytes ?? null) ||
                (record.expectedMutationEpoch ?? null) !== (intent.expectedMutationEpoch ?? null)
              )
                throw new RetainedMutationError(
                  "intent",
                  "An earlier retained identity was reused with a different intent.",
                  mutationId,
                );
              const terminal = await retainedMutationReceipt(prior.directory);
              if (terminal) return terminal;
              throw new RetainedMutationError(
                "recovery",
                "An earlier retained identity is not a terminal publication receipt.",
                mutationId,
                await retainedPaths(prior.directory),
              );
            }
            const attention = await attentionFor(await discover(), resolved);
            if (attention && attention.mutationId !== mutationId)
              throw new RetainedMutationError(
                "recovery",
                attention.message,
                attention.recoveryId,
                attention.retainedPaths,
              );
            const reference = {
              version: 1 as const,
              recordDirectory: directory,
              target: resolved.target,
              requestedPath: resolved.requestedPath,
              mutationId,
              intent: fingerprint,
            };
            if (retentionOverride)
              await durableJson(NodePath.join(indexed, "reference.json"), reference);
            if (deps.retentionLimitBytes != null) {
              // The configured budget belongs to the shared store, not one source parent.
              // Its exclusive lease stays owned until journal and native work retire.
              const retainedBytes = await retainedTreeBytes(deps.retentionStorageDirectory);
              let externalBytes = 0;
              for (const entry of await allRecords()) {
                if (!within(deps.retentionStorageDirectory, entry.directory))
                  externalBytes += await retainedTreeBytes(entry.directory);
              }
              const targetBytes = await retainedTreeBytes(resolved.target);
              if (
                retainedBytes +
                  externalBytes +
                  targetBytes +
                  (intent.bytes?.byteLength ?? 0) +
                  16384 >
                deps.retentionLimitBytes
              ) {
                if (missingParents)
                  throw new RetainedMutationError(
                    "recovery",
                    "Directory preparation completed but storage could not admit the file publication.",
                    mutationId,
                  );
                await durableJson(NodePath.join(identityDirectory, "refusal.json"), {
                  version: 1,
                  outcome: "unchanged",
                  reason: "storage",
                });
                throw new RetainedMutationError(
                  "unavailable",
                  "The shared retained-object budget cannot safely admit this intent.",
                  mutationId,
                );
              }
            }
            if (!original || original.recordDirectory === identityDirectory)
              await durableJson(identityPath, reference);
            let sourceMayHaveChanged = false;
            const mutationLease: NativeFilePublicationLease = {
              ...lease,
              run: async (command) => {
                const previous = sourceMayHaveChanged;
                sourceMayHaveChanged = true;
                const reply = await lease.run(command);
                if (reply.outcome === "unchanged") sourceMayHaveChanged = previous;
                return reply;
              },
            };
            const completePublicationReceipt = async (
              result: RetainedMutationResult,
            ): Promise<RetainedMutationResult> => {
              if (
                intent.expectedMutationEpoch === undefined ||
                result.outcome !== "done" ||
                result.publicationEpoch !== undefined
              )
                return result;
              // The expected-epoch root EX lease remains held. Only this exact
              // namespace mutation can have advanced the captured native epoch.
              const terminal = await readRetainedRecord(result.recordDirectory);
              if (
                terminal.version !== 2 ||
                terminal.phase !== "done" ||
                terminal.expectedMutationEpoch !== intent.expectedMutationEpoch
              )
                throw new RetainedMutationError(
                  "recovery",
                  "The output receipt lost its exact publication fence.",
                  mutationId,
                  await retainedPaths(directory),
                );
              lease.assertHeld();
              const publicationEpoch = await epochFor(
                resolved.root,
                await recordsUnderRoot(resolved.root),
              );
              await durableJson(NodePath.join(result.recordDirectory, "record.json"), {
                ...terminal,
                publicationEpoch,
                generation: terminal.generation + 1,
              });
              return { ...result, publicationEpoch };
            };
            try {
              return await completePublicationReceipt(
                await mutateRetainedFile(
                  {
                    ...intent,
                    id,
                    mutationId,
                    cwd: resolved.root,
                    relativePath: resolved.relativePath,
                    requestedPath: resolved.requestedPath,
                    retentionDirectory: retentionOverride ?? storage,
                    nativePublicationHelper: helper,
                    binding,
                    ...(destinationBinding ? { destinationBinding } : {}),
                    lease: mutationLease,
                  },
                  resolved.target,
                  deps.retainedHooks,
                ),
              );
            } catch (cause) {
              if (cause instanceof RetainedMutationError && cause.reason === "intent") throw cause;
              let admitted;
              try {
                admitted = await readRetainedRecord(directory);
              } catch (e) {
                if (!isNodeError(e, "ENOENT"))
                  throw new RetainedMutationError(
                    "recovery",
                    "Admitted journal authority cannot be decoded safely.",
                    mutationId,
                    [],
                    { cause: e },
                  );
              }
              if (admitted?.version === 2) {
                if (admitted.phase === "done") {
                  try {
                    // A terminal JSON rename may be visible despite a failed
                    // directory sync. Re-establish durability before accepting it.
                    await syncDirectory(directory);
                    return await completePublicationReceipt(
                      (await retainedMutationReceipt(directory))!,
                    );
                  } catch (retirement) {
                    throw new RetainedMutationError(
                      "recovery",
                      "The completed namespace mutation has no durable acknowledgement.",
                      mutationId,
                      await retainedPaths(directory),
                      { cause: retirement },
                    );
                  }
                }
                await durableJson(NodePath.join(directory, "record.json"), {
                  ...admitted,
                  phase: "done",
                  outcome: "attention",
                  failure: "recovery",
                  generation: admitted.generation + 1,
                });
                throw new RetainedMutationError(
                  "recovery",
                  "Admitted native publication retired with retained attention.",
                  mutationId,
                  await retainedPaths(directory),
                  { cause },
                );
              }
              if (!admitted) {
                if (sourceMayHaveChanged) {
                  await durableJson(NodePath.join(directory, "record.json"), {
                    version: "native-publication-unknown",
                    target: resolved.target,
                    requestedPath: resolved.requestedPath,
                    mutationId,
                  }).catch(() => undefined); // The already-durable index still names this unknown authority if its journal cannot be restored.
                  throw new RetainedMutationError(
                    "recovery",
                    "Native namespace work lost its terminal journal; only explicit current review may retire it.",
                    mutationId,
                    await retainedPaths(directory),
                    { cause },
                  );
                }
                if (missingParents) {
                  await durableJson(identityPath, {
                    version: 1,
                    recordDirectory: identityDirectory,
                    target: resolved.target,
                    requestedPath: resolved.requestedPath,
                    mutationId,
                    intent: fingerprint,
                  });
                  throw new RetainedMutationError(
                    "recovery",
                    "Directory preparation remains retained after a pre-publication refusal.",
                    mutationId,
                    [],
                    { cause },
                  );
                }
                await durableJson(NodePath.join(identityDirectory, "refusal.json"), {
                  version: 1,
                  outcome: "unchanged",
                  reason: "native-admission",
                });
                throw new RetainedMutationError(
                  "unavailable",
                  "Native publication refused before any namespace displacement.",
                  mutationId,
                  [],
                  { cause },
                );
              }
              throw cause;
            }
          },
          signal,
        );
      } catch (cause) {
        if (
          missingParents &&
          (!(cause instanceof RetainedMutationError) || cause.reason !== "recovery")
        )
          throw new RetainedMutationError(
            "recovery",
            "Directory preparation changed the namespace before publication retired.",
            mutationId,
            [],
            { cause },
          );
        throw cause;
      }
    });
  });
  const receipt = Effect.fnUntraced(function* (
    input: { cwd: string; relativePath: string },
    resolved: { target: string },
    result: RetainedMutationResult,
  ) {
    if (result.outcome === "done") return result;
    const fields = {
      workspaceRoot: input.cwd,
      relativePath: input.relativePath,
      resolvedPath: resolved.target,
    };
    if (result.outcome === "skipped" && result.sourceMutation === false) {
      if (result.failure === "revision" && result.currentRevision)
        return yield* new WorkspaceFileRevisionConflictError({
          ...fields,
          currentRevision: result.currentRevision,
          publicationOutcome: "unchanged",
        });
      if (result.failure === "exists")
        return yield* new WorkspaceFileExistsError({ ...fields, publicationOutcome: "unchanged" });
      if (result.failure === "target")
        return yield* new WorkspaceFileTargetChangedError({
          ...fields,
          publicationOutcome: "unchanged",
        });
      if (result.failure === "unavailable")
        return yield* new WorkspaceFileMutationUnavailableError({
          ...fields,
          publicationOutcome: "unchanged",
        });
    }
    return yield* new WorkspaceFileRecoveryRequiredError({
      ...fields,
      recoveryId: result.mutationId ?? NodePath.basename(result.recordDirectory),
      retainedPaths: [...(result.retainedPaths ?? [])],
      publicationOutcome: "retained-attention",
    });
  });
  const replayTerminal = Effect.fnUntraced(function* (
    input: { cwd: string; relativePath: string; mutationId?: string | undefined },
    intent: Pick<
      RetainedMutationInput,
      | "kind"
      | "condition"
      | "expectedRevision"
      | "bytes"
      | "guardMaxBytes"
      | "expectedMutationEpoch"
      | "executable"
    >,
    destinationRelativePath?: string,
  ) {
    if (!input.mutationId) return null;
    const named = yield* workspacePaths.resolveRelativePathWithinRoot({
      workspaceRoot: input.cwd,
      relativePath: input.relativePath,
    });
    const namedDestination =
      destinationRelativePath === undefined
        ? null
        : yield* workspacePaths.resolveRelativePathWithinRoot({
            workspaceRoot: input.cwd,
            relativePath: destinationRelativePath,
          });
    return yield* owned(input, named.absolutePath, async (signal) => {
      const identityDirectory = NodePath.join(
        deps.retentionStorageDirectory,
        "mutation-identities",
        keyFor(input.mutationId!),
      );
      try {
        await assertPrivateRetention(identityDirectory);
      } catch (cause) {
        if (isNodeError(cause, "ENOENT")) return null;
        throw cause;
      }
      const original = await readOptional(
        NodePath.join(identityDirectory, "reference.json"),
        decodeReference,
      );
      if (!original) return null;
      let recorded;
      try {
        recorded = await readRetainedRecord(original.recordDirectory);
      } catch (cause) {
        throw new RetainedMutationError(
          "recovery",
          "The original intent index has undecodable retained authority.",
          input.mutationId!,
          await retainedPaths(original.recordDirectory),
          { cause },
        );
      }
      if (recorded.version !== 2 || recorded.phase !== "done")
        throw new RetainedMutationError(
          "recovery",
          "The original intent is not terminal; settled recovery must retire it before replay.",
          input.mutationId!,
          await retainedPaths(original.recordDirectory),
        );
      const privateBindings = await publicationLeaseBindings(
        helperFor(),
        [],
        [identityDirectory, original.recordDirectory],
      );
      return withNativeFilePublicationLease(
        helperFor(),
        privateBindings,
        async () => {
          const record = await readRetainedRecord(original.recordDirectory);
          if (record.version !== 2 || record.phase !== "done") return null;
          const root = await NodeFSP.realpath(input.cwd);
          const requestedPath = NodePath.join(root, named.relativePath);
          const destination =
            namedDestination === null ? null : NodePath.join(root, namedDestination.relativePath);
          if (
            ((record.requestedPath ?? record.target) !== requestedPath &&
              record.target !== requestedPath) ||
            (record.requestedDestination ?? record.destination) !== destination ||
            record.mutationId !== input.mutationId ||
            record.kind !== intent.kind ||
            record.condition !== intent.condition ||
            record.expected !== intent.expectedRevision ||
            record.guardMaxBytes !== (intent.guardMaxBytes ?? null) ||
            record.executable !== (intent.executable ?? false) ||
            (record.expectedMutationEpoch ?? null) !== (intent.expectedMutationEpoch ?? null) ||
            record.desired !== (intent.bytes == null ? null : bytesRevision(intent.bytes))
          )
            throw new RetainedMutationError(
              "intent",
              "Mutation identity was reused with different publication intent.",
              input.mutationId!,
            );
          try {
            await syncDirectory(original.recordDirectory);
          } catch (cause) {
            throw new RetainedMutationError(
              "recovery",
              "The original receipt could not be made durable before replay.",
              input.mutationId!,
              await retainedPaths(original.recordDirectory),
              { cause },
            );
          }
          return {
            result: (await retainedMutationReceipt(original.recordDirectory))!,
            target: record.target,
            relativePath: named.relativePath,
          };
        },
        { mode: "exclusive", signal },
      );
    });
  });
  const pruneParents = Effect.fnUntraced(function* (
    input: { cwd: string; relativePath: string },
    resolved: Resolved,
    mutationId: string,
  ) {
    let parent = NodePath.dirname(resolved.target);
    while (parent !== resolved.root && within(resolved.root, parent)) {
      const candidate = yield* resolveTarget({
        cwd: resolved.root,
        relativePath: NodePath.relative(resolved.root, parent),
      });
      if (candidate.traversesSymlink) return;
      const empty = yield* Effect.tryPromise({
        try: async () => (await NodeFSP.readdir(parent)).length === 0,
        catch: (cause) => errorFor(input, parent, cause),
      });
      if (!empty) return;
      const result = yield* publish(
        { cwd: resolved.root, relativePath: candidate.relativePath },
        candidate,
        {
          id: keyFor(`${mutationId}:prune:${parent}`),
          expectedRevision: null,
          kind: "prune",
          condition: "unguarded",
        },
      );
      if (result.outcome !== "done") return;
      parent = NodePath.dirname(parent);
    }
  });
  const inspectWriteTarget: WorkspaceFileMutationMethods["inspectWriteTarget"] = Effect.fn(
    "WorkspaceFileSystem.inspectWriteTarget",
  )(function* (input) {
    const resolved = yield* resolveTarget(input);
    return {
      relativePath: resolved.named.relativePath,
      canonicalRelativePath: resolved.relativePath,
      traversesSymlink: resolved.traversesSymlink,
    };
  });
  const writeFile: WorkspaceFileMutationMethods["writeFile"] = Effect.fn(
    "WorkspaceFileSystem.writeFile",
  )(function* (input) {
    const bytes = new TextEncoder().encode(input.contents),
      id = input.mutationId ?? NodeCrypto.randomUUID();
    const intent = {
      id,
      bytes,
      expectedRevision: input.expectedRevision ?? null,
      kind: input.createOnly ? ("create" as const) : ("write" as const),
      condition: input.createOnly
        ? ("absent" as const)
        : input.expectedRevision !== undefined
          ? ("revision" as const)
          : ("unguarded" as const),
      guardMaxBytes: 1024 * 1024,
    };
    const replay = yield* replayTerminal(input, intent);
    if (replay) {
      yield* receipt(input, replay, replay.result);
      yield* workspaceEntries.refresh(input.cwd);
      return {
        relativePath: replay.relativePath,
        revision: replay.result.revision!,
        mutationId: id,
      };
    }
    const resolved = yield* resolveTarget(input);
    const result = yield* publish(input, resolved, intent);
    yield* receipt(input, resolved, result);
    yield* workspaceEntries.refresh(input.cwd);
    return {
      relativePath: resolved.named.relativePath,
      revision: result.revision!,
      ...(input.mutationId ? { mutationId: id } : {}),
    };
  });
  const createBinaryFile: WorkspaceFileMutationMethods["createBinaryFile"] = Effect.fn(
    "WorkspaceFileSystem.createBinaryFile",
  )(function* (input) {
    const id = input.mutationId ?? NodeCrypto.randomUUID(),
      intent = {
        id,
        bytes: input.bytes,
        expectedRevision: null,
        kind: "create" as const,
        condition: "absent" as const,
      };
    const replay = yield* replayTerminal(input, intent);
    if (replay) {
      yield* receipt(input, replay, replay.result);
      return {
        relativePath: replay.relativePath,
        revision: replay.result.revision!,
        mutationId: id,
      };
    }
    const resolved = yield* resolveTarget(input);
    const result = yield* publish(input, resolved, intent);
    yield* receipt(input, resolved, result);
    yield* workspaceEntries.refresh(input.cwd);
    return {
      relativePath: resolved.named.relativePath,
      revision: result.revision!,
      ...(input.mutationId ? { mutationId: id } : {}),
    };
  });
  const writeBinaryFile: WorkspaceFileMutationMethods["writeBinaryFile"] = Effect.fn(
    "WorkspaceFileSystem.writeBinaryFile",
  )(function* (input) {
    const id = input.mutationId ?? NodeCrypto.randomUUID();
    const intent = {
      id,
      bytes: input.bytes,
      expectedRevision: input.expectedRevision ?? null,
      kind: input.createOnly ? ("create" as const) : ("write" as const),
      condition: input.createOnly
        ? ("absent" as const)
        : input.expectedRevision === undefined
          ? ("unguarded" as const)
          : ("revision" as const),
      ...(input.expectedMutationEpoch === undefined
        ? {}
        : { expectedMutationEpoch: input.expectedMutationEpoch }),
    };
    const replay = yield* replayTerminal(input, intent);
    if (replay) {
      yield* receipt(input, replay, replay.result);
      yield* workspaceEntries.refresh(input.cwd);
      return {
        relativePath: replay.relativePath,
        revision: replay.result.revision!,
        mutationId: id,
        ...(replay.result.publicationEpoch === undefined
          ? {}
          : { publicationEpoch: replay.result.publicationEpoch }),
      };
    }
    const resolved = yield* resolveTarget(input);
    const result = yield* publish(input, resolved, intent);
    yield* receipt(input, resolved, result);
    yield* workspaceEntries.refresh(input.cwd);
    return {
      relativePath: resolved.named.relativePath,
      revision: result.revision!,
      ...(input.mutationId ? { mutationId: id } : {}),
      ...(result.publicationEpoch === undefined
        ? {}
        : { publicationEpoch: result.publicationEpoch }),
    };
  });
  const renameFile: WorkspaceFileMutationMethods["renameFile"] = Effect.fn(
    "WorkspaceFileSystem.renameFile",
  )(function* (input) {
    const replay = yield* replayTerminal(
      input,
      {
        kind: "rename",
        condition: input.expectedRevision === undefined ? "unguarded" : "revision",
        expectedRevision: input.expectedRevision ?? null,
        ...(input.expectedRevision !== undefined ? { guardMaxBytes: 1024 * 1024 } : {}),
      },
      input.destinationRelativePath,
    );
    if (replay) {
      yield* receipt(input, replay, replay.result);
      yield* workspaceEntries.refresh(input.cwd);
      return {
        relativePath: replay.relativePath,
        destinationRelativePath: input.destinationRelativePath,
        revision: replay.result.revision!,
        mutationId: input.mutationId!,
      };
    }
    const source = yield* resolveTarget(input),
      destination = yield* resolveTarget({
        cwd: input.cwd,
        relativePath: input.destinationRelativePath,
      });
    if (source.target === destination.target)
      return yield* new WorkspaceFileExistsError({
        workspaceRoot: input.cwd,
        relativePath: input.destinationRelativePath,
        resolvedPath: destination.target,
      });
    const id = input.mutationId ?? NodeCrypto.randomUUID();
    const result = yield* publish(
      input,
      source,
      {
        id,
        expectedRevision: input.expectedRevision ?? null,
        kind: "rename",
        condition: input.expectedRevision === undefined ? "unguarded" : "revision",
        destination: destination.target,
        requestedDestination: destination.requestedPath,
        ...(input.expectedRevision !== undefined ? { guardMaxBytes: 1024 * 1024 } : {}),
      },
      destination,
    );
    yield* receipt(input, source, result);
    if (input.removeEmptyFolders) yield* pruneParents(input, source, id);
    yield* workspaceEntries.refresh(input.cwd);
    return {
      relativePath: source.named.relativePath,
      destinationRelativePath: destination.named.relativePath,
      revision: result.revision!,
      ...(input.mutationId ? { mutationId: id } : {}),
    };
  });
  const deleteFile: WorkspaceFileMutationMethods["deleteFile"] = Effect.fn(
    "WorkspaceFileSystem.deleteFile",
  )(function* (input) {
    const replay = yield* replayTerminal(input, {
      kind: "delete",
      condition: "revision",
      expectedRevision: input.expectedRevision,
      bytes: null,
      guardMaxBytes: 1024 * 1024,
    });
    if (replay) {
      yield* receipt(input, replay, replay.result);
      yield* workspaceEntries.refresh(input.cwd);
      return { relativePath: replay.relativePath, mutationId: input.mutationId! };
    }
    const resolved = yield* resolveTarget(input),
      id = input.mutationId ?? NodeCrypto.randomUUID();
    const finalLink = yield* Effect.tryPromise({
      try: async () =>
        NodeFSP.lstat(resolved.requestedPath).then(
          (stat) => stat.isSymbolicLink(),
          (e: NodeJS.ErrnoException) => {
            if (e.code === "ENOENT") return false;
            throw e;
          },
        ),
      catch: (cause) => errorFor(input, resolved.target, cause),
    });
    if (finalLink)
      return yield* new WorkspaceFileTargetChangedError({
        workspaceRoot: input.cwd,
        relativePath: input.relativePath,
        resolvedPath: resolved.target,
        publicationOutcome: "unchanged",
      });
    const result = yield* publish(input, resolved, {
      id,
      bytes: null,
      expectedRevision: input.expectedRevision,
      kind: "delete",
      condition: "revision",
      guardMaxBytes: 1024 * 1024,
    });
    yield* receipt(input, resolved, result);
    if (input.removeEmptyFolders) yield* pruneParents(input, resolved, id);
    yield* workspaceEntries.refresh(input.cwd);
    return {
      relativePath: resolved.named.relativePath,
      ...(input.mutationId ? { mutationId: id } : {}),
    };
  });
  const pruneRetainedDirectory = Effect.fnUntraced(function* (
    input: RetainedMutationInput,
    resolved: Resolved,
  ): Effect.fn.Return<RetainedMutationResult, MutationError> {
    const entries = yield* Effect.tryPromise({
      try: () => NodeFSP.readdir(resolved.target, { withFileTypes: true }),
      catch: (cause) => errorFor(input, resolved.target, cause),
    });
    for (const entry of entries)
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        const relativePath = NodePath.join(resolved.relativePath, entry.name);
        const child = yield* resolveTarget({ cwd: resolved.root, relativePath });
        if (child.traversesSymlink)
          return yield* new WorkspaceFileTargetChangedError({
            workspaceRoot: input.cwd,
            relativePath,
            resolvedPath: child.target,
            publicationOutcome: "unchanged",
          });
        const pruned = yield* pruneRetainedDirectory(input, child);
        if (pruned.outcome !== "done") return pruned;
      }
    return yield* publish(
      { cwd: resolved.root, relativePath: resolved.relativePath },
      resolved,
      {
        id: keyFor(`${input.id}:directory:${resolved.target}`),
        expectedRevision: null,
        kind: "prune",
        condition: "unguarded",
      },
      undefined,
      input.retentionDirectory,
    );
  });
  const replaceFileRetained: WorkspaceRetainedFileMethods["replaceFileRetained"] = Effect.fn(
    "WorkspaceFileSystem.replaceFileRetained",
  )(function* (input) {
    const intent = {
      ...input,
      kind: input.kind ?? (input.bytes === null ? ("delete" as const) : ("write" as const)),
      condition:
        input.condition ??
        (input.expectedRevision === null ? ("absent" as const) : ("revision" as const)),
    };
    const mutationId = `overleaf-${NodeCrypto.createHash("sha256").update(`${input.retentionDirectory}\0${input.id}`).digest("hex")}`;
    const replay = yield* replayTerminal({ ...input, mutationId }, intent);
    if (replay) {
      if (replay.result.outcome === "skipped" && replay.result.failure === "unavailable")
        yield* receipt(input, replay, replay.result);
      return replay.result;
    }
    yield* Effect.tryPromise({
      try: () => assertRootBinding(input.cwd, input.expectedRootIdentity),
      catch: (cause) => errorFor(input, input.cwd, cause),
    });
    const resolved = yield* resolveTarget(input);
    yield* owned(input, resolved.target, (signal) =>
      qualifyBytePublication(input, resolved, intent, signal),
    );
    if (input.bytes !== null && input.expectedRevision === null) {
      const directory = yield* Effect.tryPromise({
        try: async () =>
          NodeFSP.lstat(resolved.target).then(
            (stat) => stat.isDirectory() && !stat.isSymbolicLink(),
            (e: NodeJS.ErrnoException) => {
              if (e.code === "ENOENT") return false;
              throw e;
            },
          ),
        catch: (cause) => errorFor(input, resolved.target, cause),
      });
      if (directory) {
        const pruned = yield* pruneRetainedDirectory(input, resolved);
        if (pruned.outcome !== "done") return pruned;
      }
    }
    const result = yield* publish(input, resolved, intent, undefined, input.retentionDirectory);
    if (result.outcome === "skipped" && result.failure === "unavailable")
      yield* receipt(input, resolved, result);
    yield* workspaceEntries.refresh(input.cwd);
    return result;
  });
  const removeFileRetained: WorkspaceRetainedFileMethods["removeFileRetained"] = (input) =>
    replaceFileRetained({ ...input, bytes: null, kind: "delete", condition: "revision" });
  const registerRetainedFileHistory: WorkspaceRetainedFileMethods["registerRetainedFileHistory"] =
    Effect.fn("WorkspaceFileSystem.registerRetainedFileHistory")(function* (input) {
      const root = yield* workspacePaths.normalizeWorkspaceRoot(input.cwd);
      yield* owned({ cwd: input.cwd, relativePath: "." }, root, async (signal) => {
        const canonicalRoot = await NodeFSP.realpath(root),
          records = await recordsIn(input.retentionDirectory);
        for (const entry of records) {
          const target =
            entry.target && within(canonicalRoot, entry.target)
              ? entry.target
              : NodePath.join(canonicalRoot, ".retained-unknown-authority");
          const parent = await nearestParent(canonicalRoot, target),
            parentPath = NodePath.join(parent.rootPath, parent.parentRelativePath);
          const storage = await deps.retentionDirectoryFor(canonicalRoot, parentPath),
            id = `external-${NodeCrypto.createHash("sha256").update(entry.directory).digest("hex")}`;
          const index = await prepareRetainedDirectory(storage, id, helperFor());
          const rootBinding = await bindNativeFilePublicationParent(helperFor(), canonicalRoot, "");
          const privateBinding = await bindNativeFilePublicationParent(
            helperFor(),
            entry.directory,
            "",
          );
          const indexBinding = await bindNativeFilePublicationParent(helperFor(), index, "");
          const bindings = await bindingsFor(
            [{ ...rootBinding, mode: "exclusive" }, privateBinding, indexBinding],
            [entry],
          );
          await withNativeFilePublicationLease(
            helperFor(),
            bindings,
            async () => {
              await durableJson(NodePath.join(index, "reference.json"), {
                version: 1,
                recordDirectory: entry.directory,
                target: entry.target ?? target,
                requestedPath: entry.requestedPath ?? target,
                mutationId: entry.mutationId,
              });
            },
            { mode: "exclusive", signal },
          );
        }
      });
    });
  const withSettledFileRead: WorkspaceFileMutationMethods["withSettledFileRead"] =
    Effect.fnUntraced(function* <A, E, R>(
      input: { cwd: string; relativePath: string },
      read: (
        attention: ProjectFilePublicationAttention | null,
        settlement: WorkspaceFileReadSettlement,
      ) => Effect.Effect<A, E, R>,
    ) {
      const context = yield* Effect.context<R>();
      const normalized = yield* workspacePaths.normalizeWorkspaceRoot(input.cwd);
      const exit = yield* owned(input, normalized, (signal) =>
        withRoot(
          normalized,
          async (_root, records, rootBinding, parentBinding) => {
            const resolved = await Effect.runPromise(resolveTarget(input, true));
            const physicalParent = within(resolved.root, resolved.physicalTarget)
              ? await nearestParent(resolved.root, resolved.physicalTarget)
              : null;
            const currentMissing = await proveMissing(resolved, rootBinding, parentBinding);
            const readExit = await Effect.runPromiseExitWith(context)(
              read(await attentionFor(records, resolved), { currentMissing }),
              { signal },
            );
            const after = await Effect.runPromise(resolveTarget(input, true));
            if (
              after.root !== resolved.root ||
              after.target !== resolved.target ||
              after.physicalTarget !== resolved.physicalTarget ||
              (physicalParent && !(await bindingCurrent(physicalParent)))
            )
              throw new RetainedMutationError(
                "target",
                "Captured read alias or physical parent changed before the callback retired.",
                "read-binding",
              );
            if (
              !(await bindingCurrent(rootBinding)) ||
              (parentBinding && !(await bindingCurrent(parentBinding))) ||
              (currentMissing && !(await proveMissing(resolved, rootBinding, parentBinding)))
            )
              throw new RetainedMutationError(
                "target",
                "Captured read authority changed before the callback retired.",
                "read-binding",
              );
            return readExit;
          },
          signal,
          input.relativePath,
        ),
      );
      return Exit.isFailure(exit) ? yield* Effect.failCause(exit.cause) : exit.value;
    });
  const listFileVersions: WorkspaceFileMutationMethods["listFileVersions"] = Effect.fn(
    "WorkspaceFileSystem.listFileVersions",
  )(function* (input) {
    const resolved = yield* resolveTarget(input, true);
    return yield* owned(input, resolved.target, (signal) =>
      withParent(
        resolved,
        async (records) => {
          const versions: ProjectListFileVersionsResult["versions"][number][] = [];
          let retainedBytes = 0;
          for (const entry of records)
            for (const leaf of retainedFileNames) {
              if (entry.record?.version === 2 && entry.record.discarded.includes(leaf)) continue;
              const file = NodePath.join(entry.directory, leaf);
              let stat;
              try {
                stat = await NodeFSP.lstat(file);
              } catch (e) {
                if (isNodeError(e, "ENOENT")) continue;
                throw e;
              }
              if (
                entry.record?.version === 2 &&
                entry.record.outcome === "done" &&
                entry.record.publication === "create" &&
                leaf === "slot" &&
                sameIdentity(await fileIdentity(file), await fileIdentity(resolved.target))
              )
                continue;
              retainedBytes += stat.size;
              versions.push({
                versionId: `${keyFor(entry.mutationId)}:${leaf}`,
                mutationId: entry.mutationId,
                retainedPath: await retainedViewPath(
                  entry.directory,
                  leaf,
                  entry.target ?? resolved.target,
                ),
                revision: stat.isFile() && !stat.isSymbolicLink() ? await fileRevision(file) : null,
                byteLength: stat.size,
                retainedAt:
                  entry.record?.version === 2 ? entry.record.retainedAt : stat.birthtimeMs,
              });
            }
          versions.sort(
            (a, b) => b.retainedAt - a.retainedAt || a.versionId.localeCompare(b.versionId),
          );
          return {
            versions,
            retainedBytes,
            limitBytes: deps.retentionLimitBytes ?? null,
            attention: await attentionFor(records, resolved),
          };
        },
        signal,
      ),
    );
  });
  const discardFileVersion: WorkspaceFileMutationMethods["discardFileVersion"] = Effect.fn(
    "WorkspaceFileSystem.discardFileVersion",
  )(function* (input) {
    const resolved = yield* resolveTarget(input, true);
    return yield* owned(input, resolved.target, (signal) =>
      withParent(
        resolved,
        async (records) => {
          const match = /^(mutation-[a-f0-9]{64}):(slot|retained|provisional)$/u.exec(
            input.versionId,
          );
          if (!match)
            throw new RetainedMutationError(
              "intent",
              "Invalid retained version identity.",
              input.versionId,
            );
          const found = records.find((entry) => keyFor(entry.mutationId) === match[1]);
          if (!found)
            throw new RetainedMutationError(
              "target",
              "Retained version is not bound to this target.",
              input.versionId,
            );
          if (found.record?.version === 2) {
            if (found.record.phase !== "done")
              throw new RetainedMutationError(
                "recovery",
                "An active retained object cannot be discarded.",
                found.mutationId,
              );
            if (!found.record.discarded.includes(match[2]!))
              await durableJson(NodePath.join(found.directory, "record.json"), {
                ...found.record,
                discarded: [...found.record.discarded, match[2]],
                generation: found.record.generation + 1,
              });
          } else
            await durableJson(NodePath.join(found.directory, `discard-${match[2]}.json`), {
              version: 1,
              discarded: true,
            });
          await NodeFSP.unlink(NodePath.join(found.directory, match[2]!)).catch(
            (e: NodeJS.ErrnoException) => {
              if (e.code !== "ENOENT") throw e;
            },
          );
          const extension = NodePath.extname(found.target ?? resolved.target),
            safeExtension = /^\.[a-zA-Z0-9]{1,16}$/u.test(extension) ? extension : ".txt";
          await NodeFSP.unlink(
            NodePath.join(found.directory, `view-${match[2]}${safeExtension}`),
          ).catch((e: NodeJS.ErrnoException) => {
            if (e.code !== "ENOENT") throw e;
          });
          await syncDirectory(found.directory);
          return { versionId: input.versionId };
        },
        signal,
      ),
    );
  });
  const resolveFileMutation: WorkspaceFileMutationMethods["resolveFileMutation"] = Effect.fn(
    "WorkspaceFileSystem.resolveFileMutation",
  )(function* (input) {
    const resolved = yield* resolveTarget(input, true);
    return yield* owned(input, resolved.target, (signal) =>
      withParent(
        resolved,
        async (records, _lease, rootBinding, parentBinding) => {
          const found = records.find((entry) => entry.mutationId === input.recoveryId);
          if (!found || !(await requiresAttention(found)))
            throw new RetainedMutationError(
              "intent",
              "No retained attention exists for this recovery reference.",
              input.recoveryId,
            );
          if (found.target === null)
            throw new RetainedMutationError(
              "recovery",
              "This journal has no provable target; accepting one file cannot resolve unknown workspace authority.",
              found.mutationId,
              await retainedPaths(found.directory),
            );
          const oldReview = await readOptional(
            NodePath.join(found.directory, "review.json"),
            decodeReview,
          );
          if (oldReview) {
            if (
              oldReview.target !== resolved.target ||
              oldReview.revision !== input.currentRevision
            )
              throw new RetainedMutationError(
                "intent",
                "Recovery acceptance identity was reused with a different reviewed revision.",
                input.recoveryId,
              );
            return { recoveryId: input.recoveryId, revision: oldReview.revision };
          }
          if (!(await bindingCurrent(rootBinding)))
            throw new RetainedMutationError(
              "target",
              "Current root authority changed during recovery review.",
              input.recoveryId,
            );
          const binding = await nearestParent(resolved.root, resolved.target),
            before = await fileIdentity(resolved.target),
            snapshot = await inspectGuardedFile(resolved.target);
          const revision = snapshot?.revision ?? null;
          if (input.currentRevision === null) {
            if (!(await proveMissing(resolved, rootBinding, parentBinding)))
              throw new RetainedMutationError(
                "target",
                "Only observed current-root absence can acknowledge missing current.",
                input.recoveryId,
              );
          } else if (
            !before ||
            !snapshot ||
            revision !== input.currentRevision ||
            !sameIdentity(before, snapshot.identity) ||
            !sameIdentity(before, await fileIdentity(resolved.target)) ||
            !(await bindingCurrent(binding)) ||
            !(await bindingCurrent(rootBinding))
          )
            throw new RetainedMutationError(
              "target",
              "The exact displayed current file changed; review it again before acceptance.",
              input.recoveryId,
            );
          // Current root/parent authority is explicitly acknowledged; old paths are never restored or reauthorized.
          await durableJson(NodePath.join(found.directory, "review.json"), {
            version: 1,
            rootPath: resolved.root,
            target: resolved.target,
            rootIdentity: binding.rootIdentity,
            parentIdentity: binding.parentIdentity,
            revision,
          });
          return { recoveryId: input.recoveryId, revision };
        },
        signal,
      ),
    );
  });
  const recordsUnderRoot = async (root: string) =>
    (await allRecords()).filter(
      (entry) =>
        entry.target === null ||
        within(root, entry.target) ||
        (entry.record?.version === 2 &&
          entry.record.destination !== null &&
          within(root, entry.record.destination)),
    );
  const withRoot = async <A>(
    cwd: string,
    body: (
      root: string,
      records: Stored[],
      rootBinding: NativeFileLeaseBinding,
      parentBinding: NativeFileLeaseBinding | null,
    ) => Promise<A>,
    signal: AbortSignal,
    readPath?: string,
  ) => {
    const root = await NodeFSP.realpath(cwd),
      binding = await bindNativeFilePublicationParent(helperFor(), root, "");
    const target = readPath === undefined ? null : NodePath.resolve(root, readPath);
    const parent =
      target !== null && within(root, target) && target !== root
        ? await nearestParent(root, target).catch(() => null)
        : null;
    return withOwnership(
      [
        { ...binding, mode: "exclusive" },
        ...(parent ? [{ ...parent, mode: "exclusive" as const }] : []),
      ],
      () => recordsUnderRoot(root),
      async (records, lease) => {
        if (!(await bindingCurrent(binding)))
          throw new RetainedMutationError(
            "target",
            "Current root authority changed while waiting for ownership.",
            "root-binding",
          );
        await settle(records, lease);
        if (!(await bindingCurrent(binding)))
          throw new RetainedMutationError(
            "target",
            "Current root authority changed during settlement.",
            "root-binding",
          );
        return body(root, await recordsUnderRoot(root), binding, parent);
      },
      signal,
    );
  };
  const epochFor = async (root: string, records: ReadonlyArray<Stored>) => {
    const identity = await directoryIdentity(root),
      hash = NodeCrypto.createHash("sha256");
    hash.update(`${identity.dev}:${identity.ino}\n`);
    for (const entry of [...records].sort((a, b) => a.directory.localeCompare(b.directory))) {
      const record = entry.record;
      if (!record || record.version === 1) {
        if (!entry.target || !within(root, entry.target))
          throw new RetainedMutationError(
            "recovery",
            "Build input has unknown publication authority.",
            entry.mutationId,
            await retainedPaths(entry.directory),
          );
        const resolved = await Effect.runPromise(
          resolveTarget({ cwd: root, relativePath: NodePath.relative(root, entry.target) }, true),
        );
        if (!(await reviewed(entry, resolved)))
          throw new RetainedMutationError(
            "recovery",
            "Build input has unreviewed legacy publication attention.",
            entry.mutationId,
            await retainedPaths(entry.directory),
          );
        hash.update(`${entry.target}\0${entry.mutationId}\0legacy-attention\n`);
        continue;
      }
      if (record.phase !== "done")
        throw new RetainedMutationError(
          "recovery",
          "Build input has unretired publication authority.",
          entry.mutationId,
          await retainedPaths(entry.directory),
        );
      if (await requiresAttention(entry)) {
        const relativePath = NodePath.relative(root, record.target);
        const resolved = await Effect.runPromise(resolveTarget({ cwd: root, relativePath }, true));
        if (!(await reviewed(entry, resolved)))
          throw new RetainedMutationError(
            "recovery",
            "Build input has unresolved retained attention.",
            entry.mutationId,
            await retainedPaths(entry.directory),
          );
      }
      // Version discard, view creation, generation counters and review bookkeeping do not mutate sources.
      if (record.sourceMutation === false) continue;
      hash.update(
        `${record.target}\0${record.destination ?? ""}\0${record.mutationId}\0${record.outcome}\0${record.publishedRevision ?? ""}\0${record.publishedIdentity?.dev ?? ""}:${record.publishedIdentity?.ino ?? ""}\n`,
      );
    }
    return hash.digest("hex");
  };
  const getMutationEpoch: WorkspaceFileMutationMethods["getMutationEpoch"] = Effect.fn(
    "WorkspaceFileSystem.getMutationEpoch",
  )(function* (input) {
    // The epoch is workspace-wide so its token can be consumed by the short root publication fence.
    const normalized = yield* workspacePaths.normalizeWorkspaceRoot(input.cwd);
    return yield* owned({ cwd: input.cwd, relativePath: "." }, normalized, (signal) =>
      withRoot(normalized, epochFor, signal),
    );
  });
  const withSettledWorkspaceRead: WorkspaceFileMutationMethods["withSettledWorkspaceRead"] =
    Effect.fnUntraced(function* <A, E, R>(
      input: { cwd: string; relativePath?: string },
      read: (
        attention: ProjectFilePublicationAttention | null,
        settlement: WorkspaceFileReadSettlement,
      ) => Effect.Effect<A, E, R>,
    ) {
      const context = yield* Effect.context<R>();
      const normalized = yield* workspacePaths.normalizeWorkspaceRoot(input.cwd);
      const exit = yield* owned(
        { cwd: input.cwd, relativePath: input.relativePath ?? "." },
        normalized,
        (signal) =>
          withRoot(
            normalized,
            async (root, records, rootBinding, parentBinding) => {
              let attention: ProjectFilePublicationAttention | null = null,
                currentMissing = false;
              let resolved: Resolved | null = null;
              let physicalParent: NativeFileLeaseBinding | null = null;
              const path = input.relativePath,
                target = path === undefined ? null : NodePath.resolve(root, path);
              if (target !== null && target !== root && within(root, target)) {
                resolved = await Effect.runPromise(
                  resolveTarget({ cwd: root, relativePath: NodePath.relative(root, target) }, true),
                );
                physicalParent = within(resolved.root, resolved.physicalTarget)
                  ? await nearestParent(resolved.root, resolved.physicalTarget)
                  : null;
                attention = await attentionFor(records, resolved);
                currentMissing = await proveMissing(resolved, rootBinding, parentBinding);
              }
              const readExit = await Effect.runPromiseExitWith(context)(
                read(attention, { currentMissing }),
                { signal },
              );
              if (resolved) {
                const after = await Effect.runPromise(
                  resolveTarget(
                    { cwd: input.cwd, relativePath: NodePath.relative(root, target!) },
                    true,
                  ),
                );
                if (
                  after.root !== resolved.root ||
                  after.target !== resolved.target ||
                  after.physicalTarget !== resolved.physicalTarget ||
                  (physicalParent && !(await bindingCurrent(physicalParent)))
                )
                  throw new RetainedMutationError(
                    "target",
                    "Captured workspace-read alias or physical parent changed before the callback retired.",
                    "read-binding",
                  );
              }
              if (
                !(await bindingCurrent(rootBinding)) ||
                (parentBinding && !(await bindingCurrent(parentBinding))) ||
                (currentMissing &&
                  resolved &&
                  !(await proveMissing(resolved, rootBinding, parentBinding)))
              )
                throw new RetainedMutationError(
                  "target",
                  "Captured workspace-read authority changed before the callback retired.",
                  "read-binding",
                );
              return readExit;
            },
            signal,
            input.relativePath,
          ),
      );
      return Exit.isFailure(exit) ? yield* Effect.failCause(exit.cause) : exit.value;
    });
  const withWorkspacePublicationFence: WorkspaceFileMutationMethods["withWorkspacePublicationFence"] =
    Effect.fnUntraced(function* <A, E, R>(
      input: { cwd: string; expectedEpoch: string },
      commit: () => Effect.Effect<A, E, R>,
    ) {
      const context = yield* Effect.context<R>();
      const normalized = yield* workspacePaths.normalizeWorkspaceRoot(input.cwd);
      const exit = yield* owned({ cwd: input.cwd, relativePath: "." }, normalized, (signal) =>
        withRoot(
          normalized,
          async (root, records) => {
            if ((await epochFor(root, records)) !== input.expectedEpoch)
              throw new RetainedMutationError(
                "target",
                "Workspace mutated after build admission.",
                "build-fence",
              );
            return Effect.runPromiseExitWith(context)(commit(), { signal });
          },
          signal,
        ),
      );
      return Exit.isFailure(exit) ? yield* Effect.failCause(exit.cause) : exit.value;
    });
  return {
    prepareRetainedDirectory: preparePrivateDirectory,
    inspectWriteTarget,
    writeFile,
    createBinaryFile,
    writeBinaryFile,
    renameFile,
    deleteFile,
    replaceFileRetained,
    removeFileRetained,
    registerRetainedFileHistory,
    withSettledFileRead,
    withSettledWorkspaceRead,
    listFileVersions,
    discardFileVersion,
    resolveFileMutation,
    getMutationEpoch,
    withWorkspacePublicationFence,
  } satisfies WorkspaceFileMutationMethods;
});
