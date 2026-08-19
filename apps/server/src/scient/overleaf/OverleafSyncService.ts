// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import type {
  ScientOverleafAccount,
  ScientOverleafChange,
  ScientOverleafCommitPolicy,
  ScientOverleafConflictDetail,
  ScientOverleafConflictResolutionRequest,
  ScientOverleafConnection,
  ScientOverleafConnectionSettingsRequest,
  ScientOverleafContinueRequest,
  ScientOverleafDisconnectRequest,
  ScientOverleafDisconnectResult,
  ScientOverleafOperationSnapshot,
  ScientOverleafOverview,
  ScientOverleafPreflightCompleteRequest,
  ScientOverleafPreflightStartRequest,
  ScientOverleafReviewConfirmationRequest,
  ScientOverleafSaveAccountRequest,
  ScientOverleafSyncStartRequest,
  ScientOverleafWarning,
} from "@t3tools/contracts";
import { ScientOverleafOperationError } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import { WorkspaceEntries } from "../../workspace/WorkspaceEntries.ts";
import { advisoryWarnings, ManagedTree, normalizeManagedPath } from "./ManagedTree.ts";
import type {
  OperationContext,
  PersistedOverleafAccount,
  PersistedOverleafConnection,
  PersistedOverleafOperation,
  TreeFile,
  TreeManifest,
} from "./model.ts";
import { manifestMap } from "./model.ts";
import { OverleafMirror } from "./OverleafMirror.ts";
import { OverleafStateStore } from "./OverleafStateStore.ts";
import { normalizeRelativeFolder, parseOverleafProjectInput } from "./urls.ts";
import { WorkspaceProjector } from "./WorkspaceProjector.ts";

const emptyManifest: TreeManifest = { files: [], totalBytes: 0 };
const isOverleafOperationError = Schema.is(ScientOverleafOperationError);

function publicError(error: unknown): ScientOverleafOperationError {
  if (isOverleafOperationError(error)) return error;
  return new ScientOverleafOperationError({
    code: "filesystem_failed",
    message: "The Overleaf operation could not be completed.",
    retryable: true,
  });
}

function manifestsEqual(left: TreeManifest, right: TreeManifest): boolean {
  if (left.totalBytes !== right.totalBytes || left.files.length !== right.files.length)
    return false;
  return left.files.every((file, index) => {
    const other = right.files[index];
    return (
      other !== undefined &&
      file.path === other.path &&
      file.hash === other.hash &&
      file.size === other.size
    );
  });
}

function manifestChanges(
  base: TreeManifest,
  candidate: TreeManifest,
): ReadonlyArray<ScientOverleafChange> {
  const before = manifestMap(base);
  const after = manifestMap(candidate);
  const deleted = [...before.values()].filter((file) => !after.has(file.path));
  const added = [...after.values()].filter((file) => !before.has(file.path));
  const claimedAdded = new Set<string>();
  const claimedDeleted = new Set<string>();
  const changes: ScientOverleafChange[] = [];
  for (const oldFile of deleted) {
    const renamed = added.find(
      (file) => !claimedAdded.has(file.path) && file.hash === oldFile.hash,
    );
    if (!renamed) continue;
    claimedDeleted.add(oldFile.path);
    claimedAdded.add(renamed.path);
    changes.push({ kind: "renamed", oldPath: oldFile.path, path: renamed.path, similarity: 100 });
  }
  for (const file of before.values()) {
    const next = after.get(file.path);
    if (next && next.hash !== file.hash) changes.push({ kind: "modified", path: file.path });
  }
  for (const file of deleted)
    if (!claimedDeleted.has(file.path)) changes.push({ kind: "deleted", path: file.path });
  for (const file of added)
    if (!claimedAdded.has(file.path)) changes.push({ kind: "added", path: file.path });
  return changes.toSorted((left, right) => left.path.localeCompare(right.path));
}

function targetFolder(workspaceRoot: string, relativeFolder: string): string {
  return relativeFolder.length === 0
    ? NodePath.resolve(workspaceRoot)
    : NodePath.resolve(workspaceRoot, ...relativeFolder.split("/"));
}

function isNestedOrSame(left: string, right: string): boolean {
  const relative = NodePath.relative(left, right);
  return relative === "" || (!relative.startsWith("..") && !NodePath.isAbsolute(relative));
}

async function canonicalWorkspaceMapping(
  workspaceRoot: string,
  relativeFolder: string,
): Promise<{ readonly workspaceRoot: string; readonly folder: string }> {
  const requestedRoot = NodePath.resolve(workspaceRoot);
  let canonicalRoot: string;
  try {
    canonicalRoot = await NodeFSP.realpath(requestedRoot);
    const rootInfo = await NodeFSP.lstat(canonicalRoot);
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error("not a directory");
  } catch {
    throw new ScientOverleafOperationError({
      code: "unsafe_tree",
      message: "The selected workspace root must be a real accessible directory.",
      retryable: false,
    });
  }
  const folder = targetFolder(canonicalRoot, relativeFolder);
  if (!isNestedOrSame(canonicalRoot, folder))
    throw new ScientOverleafOperationError({
      code: "unsafe_tree",
      message: "The selected Overleaf folder must stay inside the workspace.",
      retryable: false,
    });
  let current = canonicalRoot;
  for (const segment of relativeFolder.split("/").filter(Boolean)) {
    current = NodePath.join(current, segment);
    let info: NodeFS.Stats;
    try {
      info = await NodeFSP.lstat(current);
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") break;
      throw new ScientOverleafOperationError({
        code: "filesystem_failed",
        message: "The selected Overleaf folder could not be inspected.",
        retryable: true,
      });
    }
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new ScientOverleafOperationError({
        code: "unsafe_tree",
        message: "The selected Overleaf folder cannot traverse a symlink, junction, or file.",
        retryable: false,
      });
  }
  return { workspaceRoot: canonicalRoot, folder };
}

function resolveCommitMessage(
  connection: Pick<PersistedOverleafConnection, "commitPolicy">,
  prompted?: string,
): Effect.Effect<string, ScientOverleafOperationError> {
  if (connection.commitPolicy.kind === "neutral") return Effect.succeed("Update project");
  if (connection.commitPolicy.kind === "custom") {
    const message = connection.commitPolicy.message?.trim();
    if (message) return Effect.succeed(message);
  }
  const promptedMessage = prompted?.trim();
  if (promptedMessage) return Effect.succeed(promptedMessage);
  return Effect.fail(
    new ScientOverleafOperationError({
      code: "invalid_request",
      message: "Enter a commit message before synchronizing this project.",
      retryable: false,
    }),
  );
}

function validateCommitPolicy(
  policy: ScientOverleafCommitPolicy,
): Effect.Effect<void, ScientOverleafOperationError> {
  if (policy.kind === "custom" && !policy.message?.trim()) {
    return Effect.fail(
      new ScientOverleafOperationError({
        code: "invalid_request",
        message: "A custom Overleaf commit policy requires a nonempty message.",
        retryable: false,
      }),
    );
  }
  return Effect.void;
}

function preview(bytes: Uint8Array): string | null {
  if (bytes.byteLength > 2 * 1024 * 1024 || bytes.includes(0)) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

function conflictMaterialDirectory(operationDirectory: string, conflictId: string) {
  return NodePath.join(
    operationDirectory,
    "conflicts",
    Buffer.from(conflictId).toString("base64url"),
  );
}

export class OverleafSyncService extends Context.Service<
  OverleafSyncService,
  {
    readonly overview: (
      workspaceRoot: string,
    ) => Effect.Effect<ScientOverleafOverview, ScientOverleafOperationError>;
    readonly saveAccount: (
      input: ScientOverleafSaveAccountRequest,
    ) => Effect.Effect<ScientOverleafAccount, ScientOverleafOperationError>;
    readonly removeAccount: (
      accountId: string,
    ) => Effect.Effect<void, ScientOverleafOperationError>;
    readonly startPreflight: (
      input: ScientOverleafPreflightStartRequest,
    ) => Effect.Effect<ScientOverleafOperationSnapshot, ScientOverleafOperationError>;
    readonly operationStatus: (
      operationId: string,
    ) => Effect.Effect<ScientOverleafOperationSnapshot, ScientOverleafOperationError>;
    readonly completePreflight: (
      input: ScientOverleafPreflightCompleteRequest,
    ) => Effect.Effect<ScientOverleafOperationSnapshot, ScientOverleafOperationError>;
    readonly cancelOperation: (
      operationId: string,
    ) => Effect.Effect<ScientOverleafOperationSnapshot, ScientOverleafOperationError>;
    readonly updateConnection: (
      input: ScientOverleafConnectionSettingsRequest,
    ) => Effect.Effect<ScientOverleafConnection, ScientOverleafOperationError>;
    readonly startSync: (
      input: ScientOverleafSyncStartRequest,
    ) => Effect.Effect<ScientOverleafOperationSnapshot, ScientOverleafOperationError>;
    readonly retryOperation: (
      operationId: string,
    ) => Effect.Effect<ScientOverleafOperationSnapshot, ScientOverleafOperationError>;
    readonly confirmReview: (
      input: ScientOverleafReviewConfirmationRequest,
    ) => Effect.Effect<ScientOverleafOperationSnapshot, ScientOverleafOperationError>;
    readonly conflicts: (
      operationId: string,
    ) => Effect.Effect<ReadonlyArray<ScientOverleafConflictDetail>, ScientOverleafOperationError>;
    readonly conflictDetail: (
      operationId: string,
      conflictId: string,
    ) => Effect.Effect<ScientOverleafConflictDetail, ScientOverleafOperationError>;
    readonly resolveConflict: (
      input: ScientOverleafConflictResolutionRequest,
    ) => Effect.Effect<ScientOverleafOperationSnapshot, ScientOverleafOperationError>;
    readonly continueOperation: (
      input: ScientOverleafContinueRequest,
    ) => Effect.Effect<ScientOverleafOperationSnapshot, ScientOverleafOperationError>;
    readonly reconcileLocal: (
      connectionId: string,
    ) => Effect.Effect<ScientOverleafOperationSnapshot, ScientOverleafOperationError>;
    readonly repair: (
      connectionId: string,
    ) => Effect.Effect<ScientOverleafOperationSnapshot, ScientOverleafOperationError>;
    readonly disconnect: (
      input: ScientOverleafDisconnectRequest,
    ) => Effect.Effect<ScientOverleafDisconnectResult, ScientOverleafOperationError>;
  }
>()("t3/scient/overleaf/OverleafSyncService") {}

export const make = Effect.fn("OverleafSyncService.make")(function* () {
  const state = yield* OverleafStateStore;
  const mirror = yield* OverleafMirror;
  const tree = yield* ManagedTree;
  const projector = yield* WorkspaceProjector;
  const workspaceEntries = yield* WorkspaceEntries;
  const fibers = new Map<string, Fiber.Fiber<void, never>>();
  const launchingOperations = new Set<string>();
  const completingPreflights = new Set<string>();
  const activeConnections = new Set<string>();
  const mutationLocks = new Map<string, Semaphore.Semaphore>();
  const registryMutationLock = Semaphore.makeUnsafe(1);

  const mutationLock = (key: string) => {
    const existing = mutationLocks.get(key);
    if (existing !== undefined) return existing;
    const created = Semaphore.makeUnsafe(1);
    mutationLocks.set(key, created);
    return created;
  };

  const mutationBusy = () =>
    new ScientOverleafOperationError({
      code: "operation_active",
      message: "Another Overleaf action is already changing this state.",
      retryable: false,
    });

  const withExclusive = <A, E, R>(semaphore: Semaphore.Semaphore, effect: Effect.Effect<A, E, R>) =>
    semaphore
      .withPermitsIfAvailable(1)(effect)
      .pipe(
        Effect.flatMap(
          (result): Effect.Effect<A, E | ScientOverleafOperationError, R> =>
            Option.isSome(result) ? Effect.succeed(result.value) : Effect.fail(mutationBusy()),
        ),
      );

  const withOperationExclusive = <A, E, R>(operationId: string, effect: Effect.Effect<A, E, R>) =>
    state
      .getOperation(operationId)
      .pipe(
        Effect.flatMap((operation) =>
          withExclusive(
            mutationLock(operation.snapshot.connectionId ?? `operation:${operationId}`),
            effect,
          ),
        ),
      );

  const validateWorkspaceMapping = (workspaceRoot: string, relativeFolder: string) =>
    Effect.tryPromise({
      try: () => canonicalWorkspaceMapping(workspaceRoot, relativeFolder),
      catch: publicError,
    });

  const patchOperation = Effect.fnUntraced(function* (
    operationId: string,
    patch: Partial<ScientOverleafOperationSnapshot>,
    contextPatch: Partial<OperationContext> = {},
  ) {
    const now = yield* Clock.currentTimeMillis;
    return yield* state.updateOperation(operationId, (current) => ({
      snapshot: {
        ...current.snapshot,
        ...patch,
        generation: current.snapshot.generation + 1,
        updatedAtEpochMs: now,
      },
      context: { ...current.context, ...contextPatch },
    }));
  });

  const releaseConnection = Effect.fnUntraced(function* (connectionId: string | null) {
    if (connectionId === null) return;
    activeConnections.delete(connectionId);
    const connection = yield* state.getConnection(connectionId).pipe(Effect.option);
    if (Option.isNone(connection)) return;
    if (connection.value.state === "operation_active") {
      yield* state.saveConnection({
        ...connection.value,
        state: connection.value.localAhead ? "local_ahead" : "ready",
        activeOperationId: null,
      });
    }
  });

  const failOperation = Effect.fnUntraced(function* (
    operationId: string,
    cause: Cause.Cause<unknown>,
  ) {
    const failure = cause.reasons.find(Cause.isFailReason)?.error;
    const error = publicError(failure);
    const current = yield* state.getOperation(operationId).pipe(Effect.option);
    if (Option.isNone(current)) return;
    if (current.value.snapshot.phase === "cancelled") return;
    if (current.value.snapshot.phase === "pushing") {
      yield* patchOperation(operationId, {
        phase: "push_outcome_unknown",
        message:
          "The push was interrupted after it began. The local project is untouched; choose Retry to verify Overleaf.",
        errorCode: "push_outcome_unknown",
        retryable: true,
      });
      if (current.value.snapshot.connectionId !== null) {
        const connection = yield* state
          .getConnection(current.value.snapshot.connectionId)
          .pipe(Effect.option);
        if (Option.isSome(connection))
          yield* state.saveConnection({
            ...connection.value,
            state: "push_outcome_unknown",
            pendingRemoteCommit: current.value.context.candidateCommit ?? null,
            activeOperationId: operationId,
          });
      }
      return;
    }
    yield* patchOperation(operationId, {
      phase: Cause.hasInterruptsOnly(cause) ? "cancelled" : "failed",
      message: Cause.hasInterruptsOnly(cause) ? "Overleaf operation cancelled." : error.message,
      errorCode: Cause.hasInterruptsOnly(cause) ? null : error.code,
      retryable: !Cause.hasInterruptsOnly(cause) && error.retryable,
    });
    if (current.value.snapshot.connectionId !== null) {
      yield* mirror
        .releaseOperationRef({
          operationId,
          cwd: mirror.mirrorRoot(current.value.snapshot.connectionId),
        })
        .pipe(Effect.ignore);
    }
    if (
      ["connect", "repair"].includes(current.value.snapshot.kind) &&
      current.value.snapshot.connectionId !== null
    ) {
      const connection = yield* state
        .getConnection(current.value.snapshot.connectionId)
        .pipe(Effect.option);
      activeConnections.delete(current.value.snapshot.connectionId);
      if (Option.isSome(connection)) {
        yield* state.saveConnection({
          ...connection.value,
          state: "repair_required",
          activeOperationId: null,
        });
      }
    } else {
      yield* releaseConnection(current.value.snapshot.connectionId);
    }
  });

  const launch = Effect.fnUntraced(function* (
    operationId: string,
    task: Effect.Effect<void, ScientOverleafOperationError>,
  ) {
    if (fibers.has(operationId) || launchingOperations.has(operationId)) {
      return yield* new ScientOverleafOperationError({
        code: "operation_active",
        message: "This Overleaf operation is already running.",
        retryable: false,
      });
    }
    launchingOperations.add(operationId);
    // User-facing transitions hold the connection lock while they publish the next
    // durable phase. The launched task is then the sole writer until it reaches a
    // waiting or terminal phase; trying to reacquire the same permit here would
    // deadlock the child against the transition that launched it.
    const fiber = yield* task.pipe(
      Effect.catchCause((cause) =>
        failOperation(operationId, cause).pipe(Effect.catchCause(() => Effect.void)),
      ),
      Effect.ensuring(
        Effect.sync(() => {
          fibers.delete(operationId);
          launchingOperations.delete(operationId);
        }),
      ),
      Effect.forkDetach,
      Effect.ensuring(Effect.sync(() => launchingOperations.delete(operationId))),
    );
    fibers.set(operationId, fiber);
    if (fiber.pollUnsafe() !== undefined) fibers.delete(operationId);
  });

  const scanTarget = Effect.fnUntraced(function* (
    operationId: string,
    workspaceRoot: string,
    relativeFolder: string,
    trackedPaths: ReadonlyArray<string> = [],
    excludedPaths: ReadonlyArray<string> = [],
  ) {
    const mapping = yield* validateWorkspaceMapping(workspaceRoot, relativeFolder);
    const folder = mapping.folder;
    const target = yield* Effect.tryPromise({
      try: async () => {
        try {
          return await NodeFSP.lstat(folder);
        } catch (cause) {
          if ((cause as NodeJS.ErrnoException).code === "ENOENT") return undefined;
          throw cause;
        }
      },
      catch: () =>
        new ScientOverleafOperationError({
          code: "filesystem_failed",
          message: "Unable to inspect the selected Overleaf folder.",
          retryable: true,
        }),
    });
    if (target === undefined) return emptyManifest;
    if (!target.isDirectory() || target.isSymbolicLink())
      return yield* new ScientOverleafOperationError({
        code: "unsafe_tree",
        message: "The selected Overleaf folder is not a safe directory.",
        retryable: false,
      });
    return yield* tree.scan({ operationId, root: folder, trackedPaths, excludedPaths });
  });

  const ensureProjectionDisk = (
    workspaceRoot: string,
    desired: TreeManifest,
    current: TreeManifest,
  ) =>
    Effect.tryPromise({
      try: async () => {
        const stats = await NodeFSP.statfs(workspaceRoot);
        const available = Number(stats.bavail) * Number(stats.bsize);
        const required = desired.totalBytes + current.totalBytes + 16 * 1024 * 1024;
        if (Number.isFinite(available) && available < required) {
          throw new ScientOverleafOperationError({
            code: "disk_failed",
            message: "There is not enough free disk space for a crash-safe local projection.",
            retryable: true,
          });
        }
      },
      catch: (cause) =>
        isOverleafOperationError(cause)
          ? cause
          : new ScientOverleafOperationError({
              code: "disk_failed",
              message: "Unable to verify free disk space for local projection.",
              retryable: true,
            }),
    });

  const gitContext = (
    operationId: string,
    connection: PersistedOverleafConnection,
    account: PersistedOverleafAccount,
    token: Uint8Array,
  ) => ({
    operationId,
    cwd: mirror.mirrorRoot(connection.connectionId),
    account,
    token,
    branch: connection.branch,
  });

  const credentialsForConnection = Effect.fnUntraced(function* (
    connection: PersistedOverleafConnection,
  ) {
    const credentials = yield* state.accountWithToken(connection.accountId);
    if (credentials.account.host !== connection.host) {
      return yield* new ScientOverleafOperationError({
        code: "authentication_failed",
        message: "The saved Overleaf account no longer matches this connection's exact Git host.",
        retryable: false,
      });
    }
    return credentials;
  });

  const captureWorkspaceBase = Effect.fnUntraced(function* (
    operationId: string,
    connection: PersistedOverleafConnection,
    clickManifest: TreeManifest,
    remoteManifest: TreeManifest,
    remoteCommit: string,
  ) {
    const credentials = yield* credentialsForConnection(connection);
    const context = gitContext(operationId, connection, credentials.account, credentials.token);
    yield* mirror.applyWorkspace({
      ...context,
      workspaceRoot: targetFolder(connection.workspaceRoot, connection.relativeFolder),
      desired: clickManifest,
      previous: remoteManifest,
    });
    const privateCommit = yield* mirror.commitSnapshot({ ...context, message: "Update project" });
    const workspaceBaseCommit = privateCommit ?? remoteCommit;
    yield* mirror.retainWorkspaceBase({ ...context, commit: workspaceBaseCommit });
    yield* patchOperation(operationId, {}, { workspaceBaseCommit });
    yield* mirror.checkout({ ...context, commit: remoteCommit });
    return workspaceBaseCommit;
  });

  const writeCompanions = Effect.fnUntraced(function* (
    operation: PersistedOverleafOperation,
    connection: PersistedOverleafConnection,
  ) {
    if (!operation.context.companionWrites?.length) return connection;
    const root = targetFolder(connection.workspaceRoot, connection.relativeFolder);
    const operationRoot = NodePath.resolve(
      state.operationDirectory(operation.snapshot.operationId),
    );
    const companions = [...connection.localOnlyCompanions];
    for (const companion of operation.context.companionWrites) {
      const target = NodePath.resolve(root, ...companion.relativePath.split("/"));
      if (!target.startsWith(`${root}${NodePath.sep}`)) {
        return yield* new ScientOverleafOperationError({
          code: "unsafe_tree",
          message: "A conflict companion path escapes the project.",
          retryable: false,
        });
      }
      const material = NodePath.resolve(companion.materialPath);
      if (!material.startsWith(`${operationRoot}${NodePath.sep}`))
        return yield* new ScientOverleafOperationError({
          code: "corrupt_state",
          message: "A conflict companion references material outside its operation.",
          retryable: false,
        });
      yield* Effect.tryPromise({
        try: async () => {
          const parent = NodePath.dirname(target);
          const relativeParent = NodePath.relative(root, parent);
          let cursor = root;
          for (const segment of ["", ...relativeParent.split(NodePath.sep).filter(Boolean)]) {
            cursor = NodePath.join(cursor, segment);
            try {
              await NodeFSP.lstat(cursor);
            } catch (cause) {
              if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
              await NodeFSP.mkdir(cursor);
            }
            const stat = await NodeFSP.lstat(cursor);
            if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("unsafe parent");
          }
          const [realRoot, realParent] = await Promise.all([
            NodeFSP.realpath(root),
            NodeFSP.realpath(parent),
          ]);
          const relativeReal = NodePath.relative(realRoot, realParent);
          if (
            relativeReal === ".." ||
            relativeReal.startsWith(`..${NodePath.sep}`) ||
            NodePath.isAbsolute(relativeReal)
          )
            throw new Error("escaped parent");
        },
        catch: () =>
          new ScientOverleafOperationError({
            code: "unsafe_tree",
            message: "A local-only companion path traverses an unsafe directory.",
            retryable: false,
          }),
      });
      const materialIdentity = yield* tree.hashFile(material);
      const written = yield* Effect.tryPromise({
        try: async () => {
          try {
            await NodeFSP.copyFile(material, target, NodeFS.constants.COPYFILE_EXCL);
          } catch (cause) {
            if ((cause as NodeJS.ErrnoException).code !== "EEXIST") throw cause;
          }
          return await NodeFSP.lstat(target);
        },
        catch: () =>
          new ScientOverleafOperationError({
            code: "filesystem_failed",
            message: "Unable to preserve the unselected conflict side.",
            retryable: true,
          }),
      });
      if (!written.isFile() || written.isSymbolicLink())
        return yield* new ScientOverleafOperationError({
          code: "filesystem_failed",
          message: "The local-only companion path is no longer a regular file.",
          retryable: true,
        });
      const targetIdentity = yield* tree.hashFile(target);
      if (targetIdentity.hash !== materialIdentity.hash)
        return yield* new ScientOverleafOperationError({
          code: "workspace_changed",
          message:
            "A local-only companion path was changed before it could be published. Choose a different sibling path.",
          retryable: false,
        });
      if (!companions.includes(companion.relativePath)) companions.push(companion.relativePath);
    }
    return { ...connection, localOnlyCompanions: companions };
  });

  const completeProjection = Effect.fnUntraced(function* (
    operationId: string,
    connection: PersistedOverleafConnection,
    acceptedCommit: string,
    desired: TreeManifest,
  ) {
    const operation = yield* state.getOperation(operationId);
    const clickManifest = operation.context.clickManifest ?? connection.workspaceBaselineManifest;
    const root = targetFolder(connection.workspaceRoot, connection.relativeFolder);
    const diskCheck = yield* ensureProjectionDisk(
      connection.workspaceRoot,
      desired,
      clickManifest,
    ).pipe(Effect.result);
    if (Result.isFailure(diskCheck)) {
      yield* state.saveConnection({
        ...connection,
        state: "local_projection_pending",
        pendingRemoteCommit: acceptedCommit,
        activeOperationId: operationId,
      });
      yield* patchOperation(operationId, {
        phase: "remote_synced_local_pending",
        message:
          "The remote candidate is safe, but local projection needs more free disk space. Retry after making space.",
        errorCode: diskCheck.failure.code,
        retryable: true,
      });
      return;
    }
    const observed = yield* scanTarget(
      operationId,
      connection.workspaceRoot,
      connection.relativeFolder,
      clickManifest.files.map((file) => file.path),
      connection.localOnlyCompanions,
    );
    const alreadyProjected = manifestsEqual(observed, desired);
    if (!manifestsEqual(observed, clickManifest) && !alreadyProjected) {
      yield* state.saveConnection({
        ...connection,
        state: "local_projection_pending",
        pendingRemoteCommit: acceptedCommit,
        activeOperationId: operationId,
      });
      yield* patchOperation(operationId, {
        phase: "remote_synced_local_pending",
        message:
          "Overleaf is updated, but local files changed before projection. Reconcile local to preserve those edits.",
        errorCode: "workspace_changed",
        retryable: false,
      });
      return;
    }
    if (!alreadyProjected) {
      yield* Effect.tryPromise({
        try: () => NodeFSP.mkdir(root, { recursive: true }),
        catch: () =>
          new ScientOverleafOperationError({
            code: "filesystem_failed",
            message: "Unable to create the selected Overleaf folder.",
            retryable: true,
          }),
      });
      yield* patchOperation(operationId, {
        phase: "projecting",
        message: "Updating local project files…",
        errorCode: null,
        retryable: false,
      });
      const projected = yield* projector
        .project({
          sourceRoot: mirror.mirrorRoot(connection.connectionId),
          targetRoot: root,
          desired,
          expected: clickManifest,
          previousManaged: connection.workspaceBaselineManifest,
          operationDirectory: state.operationDirectory(operationId),
          ...(operation.snapshot.kind === "connect" &&
          operation.context.initialMode === "replace-local"
            ? {
                backupDirectory: NodePath.join(
                  state.connectionDirectory(connection.connectionId),
                  "preconnect-backup",
                ),
              }
            : {}),
        })
        .pipe(Effect.result);
      if (Result.isFailure(projected)) {
        const pending = {
          ...connection,
          state: "local_projection_pending" as const,
          pendingRemoteCommit: acceptedCommit,
          activeOperationId: operationId,
        };
        yield* state.saveConnection(pending);
        yield* patchOperation(operationId, {
          phase: "remote_synced_local_pending",
          message:
            projected.failure.code === "workspace_changed"
              ? "Overleaf is updated, but local files changed before projection. Reconcile local to preserve those edits."
              : "Overleaf is updated. Retry the local projection when the filesystem is available.",
          errorCode: projected.failure.code,
          retryable: true,
        });
        return;
      }
    }
    const companionResult = yield* writeCompanions(operation, connection).pipe(Effect.result);
    if (Result.isFailure(companionResult)) {
      yield* state.saveConnection({
        ...connection,
        state: "local_projection_pending",
        pendingRemoteCommit: acceptedCommit,
        activeOperationId: operationId,
      });
      yield* patchOperation(operationId, {
        phase: "remote_synced_local_pending",
        message:
          "The project was updated, but a requested local-only conflict companion could not be preserved. Retry after resolving the filesystem problem.",
        errorCode: companionResult.failure.code,
        retryable: true,
      });
      return;
    }
    let completed = companionResult.success;
    const now = yield* Clock.currentTimeMillis;
    completed = {
      ...completed,
      state: "ready",
      remoteBaselineCommit: acceptedCommit,
      lastConvergedCommit: acceptedCommit,
      workspaceBaselineManifest: desired,
      localAhead: false,
      pendingRemoteCommit: null,
      activeOperationId: null,
      lastSyncedAtEpochMs: now,
      suppressRenameWarning:
        completed.suppressRenameWarning || operation.context.suppressRenameAfterSuccess === true,
    };
    yield* patchOperation(operationId, {
      phase: "publishing",
      message: "Publishing synchronized state…",
    });
    yield* state.saveConnection(completed);
    activeConnections.delete(connection.connectionId);
    yield* mirror
      .releaseOperationRef({
        operationId,
        cwd: mirror.mirrorRoot(connection.connectionId),
      })
      .pipe(Effect.ignore);
    yield* workspaceEntries.refresh(connection.workspaceRoot).pipe(Effect.ignore);
    if (operation.context.disconnectAfterSync) {
      yield* state.deleteConnection(connection.connectionId, operationId);
    }
    yield* patchOperation(operationId, {
      phase: "succeeded",
      message: operation.context.disconnectAfterSync
        ? "Synchronized and disconnected."
        : "Overleaf and the local project are synchronized.",
      review: operation.context.review ?? null,
      conflicts: [],
      errorCode: null,
      retryable: false,
    });
  });

  const pushCandidate = Effect.fnUntraced(function* (operationId: string) {
    let operation = yield* state.getOperation(operationId);
    const connectionId = operation.snapshot.connectionId;
    if (connectionId === null)
      return yield* new ScientOverleafOperationError({
        code: "not_found",
        message: "The Overleaf connection is unavailable.",
        retryable: false,
      });
    const connection = yield* state.getConnection(connectionId);
    const credentials = yield* credentialsForConnection(connection);
    const context = gitContext(operationId, connection, credentials.account, credentials.token);
    const storedCandidateCommit = operation.context.candidateCommit;
    const storedCandidateManifest = operation.context.remoteManifest;
    if (!storedCandidateCommit || !storedCandidateManifest)
      return yield* new ScientOverleafOperationError({
        code: "corrupt_state",
        message: "The pending Overleaf candidate is incomplete.",
        retryable: false,
      });
    let candidateCommit: string = storedCandidateCommit;
    let candidateManifest: TreeManifest = storedCandidateManifest;
    const clickManifest = operation.context.clickManifest ?? connection.workspaceBaselineManifest;
    yield* ensureProjectionDisk(connection.workspaceRoot, candidateManifest, clickManifest);

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const current = yield* scanTarget(
        operationId,
        connection.workspaceRoot,
        connection.relativeFolder,
        clickManifest.files.map((file) => file.path),
        connection.localOnlyCompanions,
      );
      if (!manifestsEqual(current, clickManifest))
        return yield* new ScientOverleafOperationError({
          code: "workspace_changed",
          message: "The project changed after Sync began. Start Sync again to include those edits.",
          retryable: true,
        });
      const candidateTree = yield* mirror.treeHash({ ...context, commit: candidateCommit });
      yield* patchOperation(
        operationId,
        { phase: "pushing", message: "Pushing to Overleaf…", review: null },
        { candidateTree },
      );
      const pushed = yield* mirror.push(context);
      if (pushed === "confirmed") {
        const prePushBase = operation.context.prePushBase;
        if (!prePushBase)
          return yield* new ScientOverleafOperationError({
            code: "corrupt_state",
            message: "The pending Overleaf push is missing its remote base.",
            retryable: false,
          });
        const verified = yield* mirror
          .candidateAccepted({
            ...context,
            candidateCommit,
            candidateTree,
            prePushBase,
          })
          .pipe(Effect.result);
        if (Result.isFailure(verified) || !verified.success.accepted) {
          yield* state.saveConnection({
            ...connection,
            state: "push_outcome_unknown",
            pendingRemoteCommit: candidateCommit,
            activeOperationId: operationId,
          });
          yield* patchOperation(operationId, {
            phase: "push_outcome_unknown",
            message:
              "The push completed, but its canonical Overleaf result could not be verified. The local project is untouched; choose Retry.",
            errorCode: "push_outcome_unknown",
            retryable: true,
          });
          return;
        }
        const acceptedCommit = verified.success.head;
        const acceptedManifest = yield* mirror.manifest({ ...context, commit: acceptedCommit });
        const pendingConnection = {
          ...connection,
          state: "local_projection_pending" as const,
          remoteBaselineCommit: acceptedCommit,
          pendingRemoteCommit: acceptedCommit,
        };
        yield* state.saveConnection(pendingConnection);
        return yield* completeProjection(
          operationId,
          pendingConnection,
          acceptedCommit,
          acceptedManifest,
        );
      }
      if (pushed === "unknown") {
        yield* state.saveConnection({
          ...connection,
          state: "push_outcome_unknown",
          pendingRemoteCommit: candidateCommit,
          activeOperationId: operationId,
        });
        yield* patchOperation(
          operationId,
          {
            phase: "push_outcome_unknown",
            message:
              "Overleaf may have accepted the push. The local project is untouched; choose Retry to verify it.",
            errorCode: "push_outcome_unknown",
            retryable: true,
          },
          { candidateTree },
        );
        return;
      }

      yield* patchOperation(operationId, {
        phase: "fetching",
        message: `Overleaf changed; fetching the latest ${connection.branch}…`,
        review: null,
      });
      const prePushBase = yield* mirror.fetch(context);
      const rebased = yield* mirror.rebaseSnapshot({
        ...context,
        snapshotCommit: operation.context.snapshotCommit ?? candidateCommit,
      });
      if (rebased.conflicted) {
        const conflicts = yield* mirror.conflicts(context);
        yield* patchOperation(
          operationId,
          {
            phase: "awaiting_conflicts",
            message: "Resolve overlapping Overleaf and local edits.",
            conflicts: conflicts.map((item) => item.conflict),
            errorCode: "conflict",
            retryable: false,
          },
          { conflicts, prePushBase },
        );
        return;
      }
      candidateCommit = rebased.candidateCommit;
      candidateManifest = yield* mirror.manifest({ ...context, commit: candidateCommit });
      const review = yield* mirror.review({
        ...context,
        connection,
        candidateCommit,
        candidateManifest,
      });
      operation = yield* patchOperation(
        operationId,
        {
          phase: review.requiresConfirmation ? "awaiting_push_confirmation" : "rebasing",
          message: review.requiresConfirmation
            ? "The rebased candidate needs renewed review."
            : "Retrying the fast-forward push…",
          review: review.requiresConfirmation ? review : null,
        },
        { candidateCommit, remoteManifest: candidateManifest, prePushBase, review },
      );
      if (review.requiresConfirmation) return;
    }
    return yield* new ScientOverleafOperationError({
      code: "push_race",
      message: "Overleaf kept changing during Sync. Try again after collaborators pause editing.",
      retryable: true,
    });
  });

  const prepareCandidate = Effect.fnUntraced(function* (
    operationId: string,
    connection: PersistedOverleafConnection,
    snapshotCommit: string | null,
  ) {
    const credentials = yield* credentialsForConnection(connection);
    const context = gitContext(operationId, connection, credentials.account, credentials.token);
    yield* patchOperation(operationId, {
      phase: "fetching",
      message: `Fetching Overleaf ${connection.branch}…`,
    });
    const prePushBase = yield* mirror.fetch(context);
    yield* patchOperation(operationId, {
      phase: "rebasing",
      message: "Merging Overleaf and local changes…",
    });
    const rebased = yield* mirror.rebaseSnapshot({ ...context, snapshotCommit });
    if (rebased.conflicted) {
      const conflicts = yield* mirror.conflicts(context);
      yield* patchOperation(
        operationId,
        {
          phase: "awaiting_conflicts",
          message: "Resolve overlapping Overleaf and local edits.",
          conflicts: conflicts.map((item) => item.conflict),
          errorCode: "conflict",
          retryable: false,
        },
        {
          conflicts,
          prePushBase,
          ...(snapshotCommit === null ? {} : { snapshotCommit }),
        },
      );
      return;
    }
    const candidateCommit = rebased.candidateCommit;
    const candidateManifest = yield* mirror.manifest({ ...context, commit: candidateCommit });
    const review = yield* mirror.review({
      ...context,
      connection,
      candidateCommit,
      candidateManifest,
    });
    yield* patchOperation(
      operationId,
      {
        phase: review.requiresConfirmation ? "awaiting_push_confirmation" : "rebasing",
        message: review.requiresConfirmation
          ? "Review these outbound changes before pushing."
          : "Candidate is ready to push.",
        review: review.requiresConfirmation ? review : null,
        errorCode: review.requiresConfirmation ? "review_required" : null,
        retryable: false,
      },
      {
        candidateCommit,
        remoteManifest: candidateManifest,
        prePushBase,
        review,
        ...(snapshotCommit === null ? {} : { snapshotCommit }),
      },
    );
    if (!review.requiresConfirmation) yield* pushCandidate(operationId);
  });

  const runSync = Effect.fnUntraced(function* (operationId: string, promptedMessage?: string) {
    const operation = yield* state.getOperation(operationId);
    const connectionId = operation.snapshot.connectionId!;
    const connection = yield* state.getConnection(connectionId);
    const credentials = yield* credentialsForConnection(connection);
    const context = gitContext(operationId, connection, credentials.account, credentials.token);
    const tracked = connection.workspaceBaselineManifest.files.map((file) => file.path);
    const clickManifest = yield* scanTarget(
      operationId,
      connection.workspaceRoot,
      connection.relativeFolder,
      tracked,
      connection.localOnlyCompanions,
    );
    const baseline = connection.remoteBaselineCommit ?? `refs/remotes/origin/${connection.branch}`;
    yield* patchOperation(
      operationId,
      { phase: "preparing", message: "Capturing the local project snapshot…" },
      { clickManifest, workspaceBaseCommit: baseline },
    );
    const remoteManifest = yield* mirror.manifest({ ...context, commit: baseline });
    yield* mirror.applyWorkspace({
      ...context,
      workspaceRoot: targetFolder(connection.workspaceRoot, connection.relativeFolder),
      desired: clickManifest,
      previous: remoteManifest,
    });
    if (promptedMessage !== undefined)
      yield* patchOperation(operationId, {}, { commitMessage: promptedMessage });
    yield* finishInitialCandidate(operationId);
  });

  const syntheticConflicts = Effect.fnUntraced(function* (
    operationId: string,
    connection: PersistedOverleafConnection,
    local: TreeManifest,
    remote: TreeManifest,
  ) {
    const root = targetFolder(connection.workspaceRoot, connection.relativeFolder);
    const mirrorRoot = mirror.mirrorRoot(connection.connectionId);
    const localMap = manifestMap(local);
    const remoteMap = manifestMap(remote);
    const conflicts: ScientOverleafConflictDetail[] = [];
    const structuralRoots = new Set<string>();
    for (const localFile of local.files) {
      const parts = localFile.path.split("/");
      for (let index = 1; index < parts.length; index += 1) {
        const ancestor = parts.slice(0, index).join("/");
        if (remoteMap.has(ancestor)) structuralRoots.add(ancestor);
      }
    }
    for (const remoteFile of remote.files) {
      const parts = remoteFile.path.split("/");
      for (let index = 1; index < parts.length; index += 1) {
        const ancestor = parts.slice(0, index).join("/");
        if (localMap.has(ancestor)) structuralRoots.add(ancestor);
      }
    }
    const structuralPaths = new Set<string>();
    for (const rootPath of structuralRoots) {
      const localFiles = local.files.filter(
        (file) => file.path === rootPath || file.path.startsWith(`${rootPath}/`),
      );
      const remoteFiles = remote.files.filter(
        (file) => file.path === rootPath || file.path.startsWith(`${rootPath}/`),
      );
      for (const file of localFiles) structuralPaths.add(file.path);
      const material = conflictMaterialDirectory(
        state.operationDirectory(operationId),
        `structural:${rootPath}`,
      );
      const localTree = NodePath.join(material, "local-tree");
      yield* Effect.tryPromise({
        try: async () => {
          for (const file of localFiles) {
            const source = NodePath.join(root, ...file.path.split("/"));
            const destination = NodePath.join(localTree, ...file.path.split("/"));
            await NodeFSP.mkdir(NodePath.dirname(destination), { recursive: true });
            await NodeFSP.copyFile(source, destination);
          }
        },
        catch: () =>
          new ScientOverleafOperationError({
            code: "filesystem_failed",
            message: "Unable to snapshot a structural local conflict.",
            retryable: true,
          }),
      });
      const localExact = localMap.get(rootPath);
      const remoteExact = remoteMap.get(rootPath);
      const previewExact = (file: TreeFile | undefined, baseRoot: string) =>
        Effect.tryPromise({
          try: async () =>
            file && file.size <= 2 * 1024 * 1024
              ? preview(await NodeFSP.readFile(NodePath.join(baseRoot, ...file.path.split("/"))))
              : null,
          catch: () => null,
        }).pipe(Effect.orElseSucceed(() => null));
      conflicts.push({
        conflict: {
          conflictId: `structural:${rootPath}`,
          kind: "file_directory",
          path: rootPath,
          overleafPath: rootPath,
          localPath: rootPath,
          baseSize: null,
          overleafSize: remoteFiles.reduce((total, file) => total + file.size, 0),
          localSize: localFiles.reduce((total, file) => total + file.size, 0),
          baseHash: null,
          overleafHash: remoteExact?.hash ?? null,
          localHash: localExact?.hash ?? null,
          previewable: localExact !== undefined && remoteExact !== undefined,
          resolved: false,
        },
        base: null,
        overleaf: yield* previewExact(remoteExact, mirrorRoot),
        local: yield* previewExact(localExact, root),
      });
    }
    for (const [relative, localFile] of localMap) {
      if (structuralPaths.has(relative)) continue;
      const remoteFile = remoteMap.get(relative);
      const localPath = NodePath.join(root, ...relative.split("/"));
      const mirrorPath = NodePath.join(mirrorRoot, ...relative.split("/"));
      if (remoteFile === undefined) {
        yield* Effect.tryPromise({
          try: async () => {
            await NodeFSP.mkdir(NodePath.dirname(mirrorPath), { recursive: true });
            await NodeFSP.copyFile(localPath, mirrorPath);
          },
          catch: () =>
            new ScientOverleafOperationError({
              code: "filesystem_failed",
              message: "Unable to combine a local project file.",
              retryable: true,
            }),
        });
        continue;
      }
      if (remoteFile.hash === localFile.hash) continue;
      const material = conflictMaterialDirectory(state.operationDirectory(operationId), relative);
      const overleafPath = NodePath.join(material, "overleaf");
      const localMaterialPath = NodePath.join(material, "local");
      const [overleafPreview, localPreview] = yield* Effect.tryPromise({
        try: async () => {
          await NodeFSP.mkdir(material, { recursive: true });
          await NodeFSP.copyFile(mirrorPath, overleafPath);
          await NodeFSP.copyFile(localPath, localMaterialPath);
          const readPreview = async (filePath: string) => {
            const size = (await NodeFSP.stat(filePath)).size;
            return size > 2 * 1024 * 1024 ? null : preview(await NodeFSP.readFile(filePath));
          };
          return await Promise.all([readPreview(overleafPath), readPreview(localMaterialPath)]);
        },
        catch: () =>
          new ScientOverleafOperationError({
            code: "filesystem_failed",
            message: "Unable to prepare initial conflict material.",
            retryable: true,
          }),
      });
      conflicts.push({
        conflict: {
          conflictId: relative,
          kind: overleafPreview === null || localPreview === null ? "binary" : "content",
          path: relative,
          baseSize: null,
          overleafSize: remoteFile.size,
          localSize: localFile.size,
          baseHash: null,
          overleafHash: remoteFile.hash,
          localHash: localFile.hash,
          previewable: overleafPreview !== null && localPreview !== null,
          resolved: false,
        },
        base: null,
        overleaf: overleafPreview,
        local: localPreview,
      });
    }
    const credentials = yield* credentialsForConnection(connection);
    yield* mirror.stageAll(
      gitContext(operationId, connection, credentials.account, credentials.token),
    );
    return conflicts;
  });

  const finishInitialCandidate = Effect.fnUntraced(function* (operationId: string) {
    const operation = yield* state.getOperation(operationId);
    const connection = yield* state.getConnection(operation.snapshot.connectionId!);
    const credentials = yield* credentialsForConnection(connection);
    const context = gitContext(operationId, connection, credentials.account, credentials.token);
    yield* mirror.stageAll(context);
    const hasChanges = yield* mirror.hasChanges(context);
    if (
      hasChanges &&
      connection.commitPolicy.kind === "prompt" &&
      operation.context.commitMessage === undefined
    ) {
      yield* patchOperation(operationId, {
        phase: "awaiting_commit_message",
        message:
          "Enter the human commit message for this local snapshot. No fetch or push has started.",
        errorCode: null,
        retryable: false,
      });
      return;
    }
    const message = hasChanges
      ? yield* resolveCommitMessage(connection, operation.context.commitMessage)
      : "Update project";
    const snapshotCommit = yield* mirror.commitSnapshot({ ...context, message });
    if (snapshotCommit !== null && operation.context.initialMode === undefined) {
      yield* mirror.retainWorkspaceBase({ ...context, commit: snapshotCommit });
      yield* patchOperation(operationId, {}, { workspaceBaseCommit: snapshotCommit });
    }
    yield* prepareCandidate(operationId, connection, snapshotCommit);
  });

  const startPreflight: OverleafSyncService["Service"]["startPreflight"] = (input) =>
    withExclusive(
      registryMutationLock,
      Effect.gen(function* () {
        yield* validateCommitPolicy(input.commitPolicy);
        const parsed = parseOverleafProjectInput(input.projectInput);
        const relativeFolder = normalizeRelativeFolder(input.relativeFolder);
        const credentials = yield* state.accountWithToken(input.accountId);
        if (credentials.account.host !== parsed.host || credentials.account.kind !== parsed.kind)
          return yield* new ScientOverleafOperationError({
            code: "invalid_request",
            message:
              "The selected account belongs to a different Overleaf host or deployment kind.",
            retryable: false,
          });
        const mapping = yield* validateWorkspaceMapping(input.workspaceRoot, relativeFolder);
        const root = mapping.workspaceRoot;
        const folder = mapping.folder;
        const existing = yield* state.listConnections;
        if (existing.some((connection) => connection.gitUrl === parsed.gitUrl))
          return yield* new ScientOverleafOperationError({
            code: "invalid_request",
            message: "This Overleaf project is already connected in this environment.",
            retryable: false,
          });
        if (
          existing.some((connection) => {
            const current = targetFolder(connection.workspaceRoot, connection.relativeFolder);
            return isNestedOrSame(current, folder) || isNestedOrSame(folder, current);
          })
        )
          return yield* new ScientOverleafOperationError({
            code: "invalid_request",
            message: "Overleaf project mappings cannot overlap.",
            retryable: false,
          });
        const connectionId = yield* state.newId;
        const operation = yield* state.createOperation("connect", connectionId, {
          workspaceRoot: root,
          relativeFolder,
          accountId: input.accountId,
          projectUrl: parsed.projectUrl,
          gitUrl: parsed.gitUrl,
          host: parsed.host,
          label: input.label ?? `Overleaf ${parsed.projectId}`,
          commitPolicy: input.commitPolicy,
        });
        yield* launch(
          operation.snapshot.operationId,
          Effect.gen(function* () {
            const context = {
              operationId: operation.snapshot.operationId,
              cwd: mirror.mirrorRoot(connectionId),
              account: credentials.account,
              token: credentials.token,
            };
            yield* patchOperation(operation.snapshot.operationId, {
              phase: "fetching",
              message: "Checking Overleaf Git access…",
            });
            yield* mirror.initialize({ ...context, connectionId, gitUrl: parsed.gitUrl });
            const branch = yield* mirror.discoverBranch(context);
            const branchContext = { ...context, branch };
            const remoteHead = yield* mirror.fetch(branchContext);
            const remoteManifest = yield* mirror.manifest({ ...branchContext, commit: remoteHead });
            const localManifest = yield* scanTarget(
              operation.snapshot.operationId,
              root,
              relativeFolder,
            );
            const combinedFiles = [
              ...new Map(
                [...remoteManifest.files, ...localManifest.files].map((file) => [file.path, file]),
              ).values(),
            ];
            const combined: TreeManifest = {
              files: combinedFiles.toSorted((a, b) => a.path.localeCompare(b.path)),
              totalBytes: combinedFiles.reduce((total, file) => total + file.size, 0),
            };
            const reviewWarnings = advisoryWarnings(combined);
            yield* patchOperation(
              operation.snapshot.operationId,
              {
                phase: "awaiting_push_confirmation",
                message: "Choose how the existing local and Overleaf files should be combined.",
                review: {
                  candidateCommit: remoteHead,
                  changes: [],
                  warnings: reviewWarnings,
                  requiresConfirmation: reviewWarnings.length > 0,
                },
              },
              {
                clickManifest: localManifest,
                remoteManifest,
                candidateCommit: remoteHead,
                prePushBase: remoteHead,
                branch,
              },
            );
          }),
        );
        return operation.snapshot;
      }),
    );

  const completePreflight: OverleafSyncService["Service"]["completePreflight"] = (input) => {
    let claimedConnectionId: string | null = null;
    return withExclusive(
      registryMutationLock,
      Effect.suspend(() => {
        if (completingPreflights.has(input.operationId)) {
          return Effect.fail(
            new ScientOverleafOperationError({
              code: "operation_active",
              message: "This Overleaf connection is already being completed.",
              retryable: false,
            }),
          );
        }
        completingPreflights.add(input.operationId);
        return Effect.gen(function* () {
          const operation = yield* state.getOperation(input.operationId);
          if (
            operation.snapshot.kind !== "connect" ||
            operation.snapshot.phase !== "awaiting_push_confirmation" ||
            operation.snapshot.generation !== input.generation
          )
            return yield* new ScientOverleafOperationError({
              code: "invalid_request",
              message: "The connection preflight changed; review it again.",
              retryable: false,
            });
          const context = operation.context;
          if (
            !context.workspaceRoot ||
            context.relativeFolder === undefined ||
            !context.accountId ||
            !context.projectUrl ||
            !context.gitUrl ||
            !context.branch ||
            !context.host ||
            !context.label ||
            !context.commitPolicy ||
            !context.candidateCommit ||
            !context.remoteManifest ||
            !context.clickManifest
          )
            return yield* new ScientOverleafOperationError({
              code: "corrupt_state",
              message: "The connection preflight is incomplete.",
              retryable: false,
            });
          const targetManifest =
            input.mode === "replace-local"
              ? context.remoteManifest
              : input.mode === "replace-overleaf"
                ? context.clickManifest
                : {
                    files: [
                      ...new Map(
                        [...context.remoteManifest.files, ...context.clickManifest.files].map(
                          (file) => [file.path, file],
                        ),
                      ).values(),
                    ].toSorted((left, right) => left.path.localeCompare(right.path)),
                    totalBytes: 0,
                  };
          const normalizedTarget =
            targetManifest.totalBytes === 0 && targetManifest.files.length > 0
              ? {
                  ...targetManifest,
                  totalBytes: targetManifest.files.reduce((total, file) => total + file.size, 0),
                }
              : targetManifest;
          const selectedChanges =
            input.mode === "replace-local"
              ? manifestChanges(context.clickManifest, context.remoteManifest)
              : input.mode === "replace-overleaf"
                ? manifestChanges(context.remoteManifest, context.clickManifest)
                : [];
          const selectedWarnings: ScientOverleafWarning[] = [...advisoryWarnings(normalizedTarget)];
          if (input.mode === "replace-local")
            selectedWarnings.push({
              kind: "replacement",
              message:
                "Overleaf managed files will replace the local managed tree. Replaced and deleted files are retained in the pre-connect backup.",
              paths: selectedChanges.map((change) => change.path),
              blocking: true,
              suppressible: false,
            });
          if (input.mode === "replace-overleaf")
            selectedWarnings.push({
              kind: "track_changes_metadata",
              message:
                "The local managed tree will replace Overleaf files. Comments and Track Changes metadata may be displaced.",
              paths: selectedChanges.map((change) => change.path),
              blocking: true,
              suppressible: false,
            });
          const selectedReview = {
            candidateCommit: context.candidateCommit,
            changes: selectedChanges,
            warnings: selectedWarnings,
            requiresConfirmation: selectedWarnings.some((warning) => warning.blocking),
          };
          if (
            context.initialMode !== input.mode &&
            selectedReview.requiresConfirmation &&
            (input.mode !== "combine" || !input.acknowledgeWarnings)
          ) {
            const staged = yield* patchOperation(
              input.operationId,
              {
                phase: "awaiting_push_confirmation",
                message: "Review the exact changes for the selected connection mode.",
                review: selectedReview,
              },
              { initialMode: input.mode, review: selectedReview },
            );
            return staged.snapshot;
          }
          if (selectedReview.requiresConfirmation && !input.acknowledgeWarnings)
            return yield* new ScientOverleafOperationError({
              code: "limit_acknowledgement_required",
              message: "Review and acknowledge the selected connection changes before connecting.",
              retryable: false,
            });
          const connection: PersistedOverleafConnection = {
            connectionId: operation.snapshot.connectionId!,
            accountId: context.accountId,
            label: context.label,
            workspaceRoot: context.workspaceRoot,
            relativeFolder: context.relativeFolder,
            projectUrl: context.projectUrl,
            gitUrl: context.gitUrl,
            host: context.host,
            branch: context.branch,
            commitPolicy: context.commitPolicy,
            suppressRenameWarning: false,
            state: "operation_active",
            remoteBaselineCommit: context.candidateCommit,
            lastConvergedCommit: null,
            localAhead: false,
            localOnlyCompanions: [],
            lastSyncedAtEpochMs: null,
            workspaceBaselineManifest: context.clickManifest,
            pendingRemoteCommit: null,
            activeOperationId: input.operationId,
          };
          if (activeConnections.has(connection.connectionId))
            return yield* new ScientOverleafOperationError({
              code: "operation_active",
              message: "This Overleaf connection is already being created.",
              retryable: false,
            });
          const existing = yield* state.listConnections;
          if (existing.some((candidate) => candidate.gitUrl === connection.gitUrl))
            return yield* new ScientOverleafOperationError({
              code: "invalid_request",
              message: "This Overleaf project is already connected in this environment.",
              retryable: false,
            });
          if (
            existing.some((candidate) => {
              const current = targetFolder(candidate.workspaceRoot, candidate.relativeFolder);
              const selected = targetFolder(connection.workspaceRoot, connection.relativeFolder);
              return isNestedOrSame(current, selected) || isNestedOrSame(selected, current);
            })
          )
            return yield* new ScientOverleafOperationError({
              code: "invalid_request",
              message: "Overleaf project mappings cannot overlap.",
              retryable: false,
            });
          activeConnections.add(connection.connectionId);
          claimedConnectionId = connection.connectionId;
          yield* state.createConnection(connection);
          yield* patchOperation(
            input.operationId,
            {
              phase: "preparing",
              connectStage: "connected",
              message: "Applying the selected connection mode…",
              review: null,
            },
            {
              initialMode: input.mode,
              ...(input.commitMessage === undefined ? {} : { commitMessage: input.commitMessage }),
            },
          );
          yield* launch(
            input.operationId,
            Effect.gen(function* () {
              const credentials = yield* credentialsForConnection(connection);
              const git = gitContext(
                input.operationId,
                connection,
                credentials.account,
                credentials.token,
              );
              yield* mirror.checkout({ ...git, commit: context.candidateCommit! });
              yield* captureWorkspaceBase(
                input.operationId,
                connection,
                context.clickManifest!,
                context.remoteManifest!,
                context.candidateCommit!,
              );
              if (input.mode === "replace-local") {
                return yield* completeProjection(
                  input.operationId,
                  connection,
                  context.candidateCommit!,
                  context.remoteManifest!,
                );
              }
              if (input.mode === "replace-overleaf") {
                yield* mirror.applyWorkspace({
                  ...git,
                  workspaceRoot: targetFolder(connection.workspaceRoot, connection.relativeFolder),
                  desired: context.clickManifest!,
                  previous: context.remoteManifest!,
                });
                return yield* finishInitialCandidate(input.operationId);
              }
              const conflicts = yield* syntheticConflicts(
                input.operationId,
                connection,
                context.clickManifest!,
                context.remoteManifest!,
              );
              if (conflicts.length > 0) {
                yield* patchOperation(
                  input.operationId,
                  {
                    phase: "awaiting_conflicts",
                    message: "Choose a version for files that differ locally and on Overleaf.",
                    conflicts: conflicts.map((item) => item.conflict),
                    errorCode: "conflict",
                  },
                  { conflicts },
                );
                return;
              }
              yield* finishInitialCandidate(input.operationId);
            }),
          );
          return (yield* state.getOperation(input.operationId)).snapshot;
        }).pipe(
          Effect.tapError(() =>
            claimedConnectionId === null
              ? Effect.void
              : state
                  .deleteConnection(claimedConnectionId)
                  .pipe(
                    Effect.ensuring(
                      Effect.sync(() => activeConnections.delete(claimedConnectionId!)),
                    ),
                    Effect.ignore,
                  ),
          ),
          Effect.ensuring(Effect.sync(() => completingPreflights.delete(input.operationId))),
        );
      }),
    );
  };

  const startSync: OverleafSyncService["Service"]["startSync"] = (input) =>
    withExclusive(
      mutationLock(input.connectionId),
      Effect.gen(function* () {
        const connection = yield* state.getConnection(input.connectionId);
        if (
          activeConnections.has(connection.connectionId) ||
          connection.activeOperationId !== null ||
          !["ready", "local_ahead"].includes(connection.state)
        )
          return yield* new ScientOverleafOperationError({
            code: "operation_active",
            message: "Resolve the current Overleaf operation before starting another Sync.",
            retryable: false,
          });
        activeConnections.add(connection.connectionId);
        const operation = yield* state.createOperation("sync", connection.connectionId, {
          workspaceRoot: connection.workspaceRoot,
          relativeFolder: connection.relativeFolder,
        });
        yield* state.saveConnection({
          ...connection,
          state: "operation_active",
          activeOperationId: operation.snapshot.operationId,
        });
        yield* launch(
          operation.snapshot.operationId,
          runSync(operation.snapshot.operationId, input.commitMessage),
        );
        return operation.snapshot;
      }).pipe(Effect.tapError(() => releaseConnection(input.connectionId))),
    );

  const operationStatus = (operationId: string) =>
    state.getOperation(operationId).pipe(Effect.map((operation) => operation.snapshot));

  const confirmReview: OverleafSyncService["Service"]["confirmReview"] = (input) =>
    withOperationExclusive(
      input.operationId,
      Effect.gen(function* () {
        const operation = yield* state.getOperation(input.operationId);
        if (
          operation.snapshot.phase !== "awaiting_push_confirmation" ||
          operation.snapshot.generation !== input.generation ||
          operation.context.candidateCommit !== input.candidateCommit ||
          !input.acknowledgeWarnings
        )
          return yield* new ScientOverleafOperationError({
            code: "review_required",
            message: "The Overleaf candidate changed or has not been acknowledged.",
            retryable: false,
          });
        const maySuppressRename = operation.context.review?.warnings.some(
          (warning) => warning.kind === "rename" && warning.suppressible,
        );
        if (input.suppressFutureRenameWarnings && !maySuppressRename)
          return yield* new ScientOverleafOperationError({
            code: "invalid_request",
            message: "This reviewed candidate does not contain a suppressible rename warning.",
            retryable: false,
          });
        yield* patchOperation(
          input.operationId,
          {
            phase: "rebasing",
            message: "Review confirmed; preparing push…",
            review: null,
            errorCode: null,
          },
          input.suppressFutureRenameWarnings ? { suppressRenameAfterSuccess: true } : {},
        );
        yield* launch(input.operationId, pushCandidate(input.operationId));
        return (yield* state.getOperation(input.operationId)).snapshot;
      }),
    );

  const getConflicts = (operationId: string) =>
    state
      .getOperation(operationId)
      .pipe(Effect.map((operation) => operation.context.conflicts ?? []));
  const conflictDetail = Effect.fnUntraced(function* (operationId: string, conflictId: string) {
    const detail = (yield* getConflicts(operationId)).find(
      (candidate) => candidate.conflict.conflictId === conflictId,
    );
    if (!detail)
      return yield* new ScientOverleafOperationError({
        code: "not_found",
        message: "The Overleaf conflict was not found.",
        retryable: false,
      });
    return detail;
  });

  const resolveConflict: OverleafSyncService["Service"]["resolveConflict"] = (input) =>
    withOperationExclusive(
      input.operationId,
      Effect.gen(function* () {
        const operation = yield* state.getOperation(input.operationId);
        if (
          !["awaiting_conflicts", "awaiting_local_conflicts"].includes(operation.snapshot.phase) ||
          operation.snapshot.generation !== input.generation
        )
          return yield* new ScientOverleafOperationError({
            code: "conflict",
            message: "The conflict state changed; reopen the resolver.",
            retryable: false,
          });
        const detail = yield* conflictDetail(input.operationId, input.conflictId);
        const connection = yield* state.getConnection(operation.snapshot.connectionId!);
        const material = conflictMaterialDirectory(
          state.operationDirectory(input.operationId),
          input.conflictId,
        );
        const credentials = yield* credentialsForConnection(connection);
        const git = gitContext(
          input.operationId,
          connection,
          credentials.account,
          credentials.token,
        );
        let keepBothPath: string | null = null;
        if (input.resolution === "both") {
          if (!input.keepBothPath)
            return yield* new ScientOverleafOperationError({
              code: "invalid_request",
              message: "Choose a non-colliding managed path for Keep both.",
              retryable: false,
            });
          keepBothPath = yield* Effect.try({
            try: () => normalizeManagedPath(input.keepBothPath!),
            catch: (cause) => publicError(cause),
          });
          if (
            keepBothPath === detail.conflict.path ||
            keepBothPath === detail.conflict.overleafPath ||
            keepBothPath === detail.conflict.localPath
          )
            return yield* new ScientOverleafOperationError({
              code: "invalid_request",
              message: "The Keep both path must differ from both conflicting paths.",
              retryable: false,
            });
          const keepBothTarget = NodePath.join(
            mirror.mirrorRoot(connection.connectionId),
            ...keepBothPath.split("/"),
          );
          const occupied = yield* Effect.tryPromise({
            try: async () => {
              try {
                await NodeFSP.lstat(keepBothTarget);
                return true;
              } catch (cause) {
                return (cause as NodeJS.ErrnoException).code !== "ENOENT";
              }
            },
            catch: () => true,
          }).pipe(Effect.orElseSucceed(() => true));
          if (occupied)
            return yield* new ScientOverleafOperationError({
              code: "invalid_request",
              message: "The Keep both path already exists in the candidate.",
              retryable: false,
            });
        }
        if (
          operation.context.initialMode === "combine" &&
          detail.conflict.kind === "file_directory"
        ) {
          if (input.keepOtherSide)
            return yield* new ScientOverleafOperationError({
              code: "invalid_request",
              message:
                "Use Keep both for a structural conflict; local-only companion preservation applies to individual files.",
              retryable: false,
            });
          const destination = NodePath.join(
            mirror.mirrorRoot(connection.connectionId),
            ...detail.conflict.path.split("/"),
          );
          const localSnapshot = NodePath.join(
            material,
            "local-tree",
            ...detail.conflict.path.split("/"),
          );
          yield* Effect.tryPromise({
            try: async () => {
              if (input.resolution === "delete" || input.resolution === "local") {
                await NodeFSP.rm(destination, { recursive: true, force: true });
              }
              if (input.resolution === "local") {
                await NodeFSP.mkdir(NodePath.dirname(destination), { recursive: true });
                await NodeFSP.cp(localSnapshot, destination, {
                  recursive: true,
                  force: false,
                  errorOnExist: true,
                });
              }
              if (input.resolution === "both" && keepBothPath !== null) {
                const second = NodePath.join(
                  mirror.mirrorRoot(connection.connectionId),
                  ...keepBothPath.split("/"),
                );
                await NodeFSP.mkdir(NodePath.dirname(second), { recursive: true });
                await NodeFSP.cp(localSnapshot, second, {
                  recursive: true,
                  force: false,
                  errorOnExist: true,
                });
              }
            },
            catch: () =>
              new ScientOverleafOperationError({
                code: "filesystem_failed",
                message: "Unable to apply the structural conflict choice.",
                retryable: true,
              }),
          });
          yield* mirror.stageAll(git);
        } else if (operation.context.initialMode === "combine") {
          const selected =
            input.resolution === "local" || input.resolution === "both"
              ? NodePath.join(material, "local")
              : NodePath.join(material, "overleaf");
          const destination = NodePath.join(
            mirror.mirrorRoot(connection.connectionId),
            ...detail.conflict.path.split("/"),
          );
          yield* Effect.tryPromise({
            try: async () => {
              if (input.resolution === "delete") await NodeFSP.rm(destination, { force: true });
              else {
                await NodeFSP.mkdir(NodePath.dirname(destination), { recursive: true });
                await NodeFSP.copyFile(selected, destination);
              }
              if (input.resolution === "both" && keepBothPath !== null) {
                const second = NodePath.join(
                  mirror.mirrorRoot(connection.connectionId),
                  ...keepBothPath.split("/"),
                );
                await NodeFSP.mkdir(NodePath.dirname(second), { recursive: true });
                await NodeFSP.copyFile(
                  NodePath.join(material, "overleaf"),
                  second,
                  NodeFS.constants.COPYFILE_EXCL,
                );
              }
            },
            catch: () =>
              new ScientOverleafOperationError({
                code: "filesystem_failed",
                message: "Unable to apply the conflict choice.",
                retryable: true,
              }),
          });
          yield* mirror.stageAll(git);
        } else {
          yield* mirror.resolveConflict({ ...git, conflict: detail, resolution: input.resolution });
          if (input.resolution === "both" && keepBothPath !== null) {
            const overleafHash = detail.conflict.overleafHash;
            const overleafSize = detail.conflict.overleafSize;
            if (overleafHash === null || overleafSize === null)
              return yield* new ScientOverleafOperationError({
                code: "conflict",
                message: "The Overleaf side cannot be retained at another path.",
                retryable: false,
              });
            yield* mirror.materializeBlob({
              ...git,
              hash: overleafHash,
              destination: NodePath.join(
                mirror.mirrorRoot(connection.connectionId),
                ...keepBothPath.split("/"),
              ),
              maxBytes: overleafSize + 1,
            });
            yield* mirror.stageAll(git);
          }
        }
        const companions = [...(operation.context.companionWrites ?? [])];
        if (input.keepOtherSide && input.resolution !== "delete" && input.resolution !== "both") {
          const chosenLocal = input.resolution === "local";
          const otherHash = chosenLocal ? detail.conflict.overleafHash : detail.conflict.localHash;
          const side = chosenLocal ? "overleaf" : "local";
          if (otherHash !== null) {
            const extension = NodePath.extname(detail.conflict.path);
            const stem = detail.conflict.path.slice(
              0,
              detail.conflict.path.length - extension.length,
            );
            const companionPath = yield* Effect.try({
              try: () =>
                normalizeManagedPath(
                  input.companionPath ?? `${stem}.${side}-${otherHash.slice(0, 8)}${extension}`,
                ),
              catch: (cause) => publicError(cause),
            });
            if (
              NodePath.posix.dirname(companionPath) !== NodePath.posix.dirname(detail.conflict.path)
            ) {
              return yield* new ScientOverleafOperationError({
                code: "invalid_request",
                message: "A preserved conflict side must use a sibling path.",
                retryable: false,
              });
            }
            if (companions.some((candidate) => candidate.relativePath === companionPath)) {
              return yield* new ScientOverleafOperationError({
                code: "invalid_request",
                message: "That local-only companion path is already reserved by this operation.",
                retryable: false,
              });
            }
            const companionTarget = NodePath.join(
              targetFolder(connection.workspaceRoot, connection.relativeFolder),
              ...companionPath.split("/"),
            );
            const candidateCompanionTarget = NodePath.join(
              mirror.mirrorRoot(connection.connectionId),
              ...companionPath.split("/"),
            );
            const companionExists = yield* Effect.tryPromise({
              try: async () => {
                for (const candidate of [companionTarget, candidateCompanionTarget]) {
                  try {
                    await NodeFSP.lstat(candidate);
                    return true;
                  } catch (cause) {
                    if ((cause as NodeJS.ErrnoException).code !== "ENOENT") return true;
                  }
                }
                return false;
              },
              catch: () => true,
            }).pipe(Effect.orElseSucceed(() => true));
            if (companionExists)
              return yield* new ScientOverleafOperationError({
                code: "invalid_request",
                message:
                  "That local-only companion path already exists locally or in the candidate.",
                retryable: false,
              });
            const materialPath =
              operation.context.initialMode === "combine"
                ? NodePath.join(material, side)
                : NodePath.join(material, side);
            if (operation.context.initialMode !== "combine") {
              const otherSize =
                side === "overleaf" ? detail.conflict.overleafSize : detail.conflict.localSize;
              if (otherSize === null)
                return yield* new ScientOverleafOperationError({
                  code: "conflict",
                  message: "The unselected conflict side no longer exists.",
                  retryable: false,
                });
              yield* mirror.materializeBlob({
                ...git,
                hash: otherHash,
                destination: materialPath,
                maxBytes: otherSize + 1,
              });
            }
            companions.push({ relativePath: companionPath, materialPath });
          }
        }
        const conflicts = (operation.context.conflicts ?? []).map((candidate) =>
          candidate.conflict.conflictId === input.conflictId
            ? { ...candidate, conflict: { ...candidate.conflict, resolved: true } }
            : candidate,
        );
        const updated = yield* patchOperation(
          input.operationId,
          { conflicts: conflicts.map((candidate) => candidate.conflict) },
          { conflicts, companionWrites: companions },
        );
        return updated.snapshot;
      }),
    );

  const finishLocalReconcile = Effect.fnUntraced(function* (
    operationId: string,
    connection: PersistedOverleafConnection,
    acceptedCommit: string,
  ) {
    const credentials = yield* credentialsForConnection(connection);
    const context = gitContext(operationId, connection, credentials.account, credentials.token);
    const operation = yield* state.getOperation(operationId);
    const desired = yield* mirror.manifest({ ...context, commit: "HEAD" });
    const root = targetFolder(connection.workspaceRoot, connection.relativeFolder);
    const expected =
      operation.context.clickManifest ??
      (yield* scanTarget(
        operationId,
        connection.workspaceRoot,
        connection.relativeFolder,
        connection.workspaceBaselineManifest.files.map((file) => file.path),
        connection.localOnlyCompanions,
      ));
    const observed = yield* scanTarget(
      operationId,
      connection.workspaceRoot,
      connection.relativeFolder,
      expected.files.map((file) => file.path),
      connection.localOnlyCompanions,
    );
    if (!manifestsEqual(observed, desired)) {
      if (!manifestsEqual(observed, expected)) {
        yield* state.saveConnection({
          ...connection,
          state: "local_projection_pending",
          pendingRemoteCommit: acceptedCommit,
          activeOperationId: operationId,
        });
        yield* patchOperation(operationId, {
          phase: "remote_synced_local_pending",
          message:
            "Local files changed while reconciliation was being applied. Retry Reconcile local to preserve them.",
          errorCode: "workspace_changed",
          retryable: false,
        });
        return;
      }
      const projected = yield* projector
        .project({
          sourceRoot: mirror.mirrorRoot(connection.connectionId),
          targetRoot: root,
          desired,
          expected,
          previousManaged: connection.workspaceBaselineManifest,
          operationDirectory: state.operationDirectory(operationId),
        })
        .pipe(Effect.result);
      if (Result.isFailure(projected)) {
        yield* state.saveConnection({
          ...connection,
          state: "local_projection_pending",
          pendingRemoteCommit: acceptedCommit,
          activeOperationId: operationId,
        });
        yield* patchOperation(operationId, {
          phase: "remote_synced_local_pending",
          message:
            projected.failure.code === "workspace_changed"
              ? "Local files changed while reconciliation was being applied. Retry Reconcile local to preserve them."
              : "Local reconciliation is ready. Retry when the filesystem is available.",
          errorCode: projected.failure.code,
          retryable: projected.failure.retryable,
        });
        return;
      }
    }
    const resultCommit = yield* mirror.treeHash({ ...context, commit: "HEAD" });
    const remoteTree = yield* mirror.treeHash({ ...context, commit: acceptedCommit });
    const companionResult = yield* writeCompanions(operation, connection).pipe(Effect.result);
    if (Result.isFailure(companionResult)) {
      yield* state.saveConnection({
        ...connection,
        state: "local_projection_pending",
        pendingRemoteCommit: acceptedCommit,
        activeOperationId: operationId,
      });
      yield* patchOperation(operationId, {
        phase: "remote_synced_local_pending",
        message:
          "Local reconciliation was projected, but a requested companion could not be preserved. Retry after resolving the path.",
        errorCode: companionResult.failure.code,
        retryable: companionResult.failure.retryable,
      });
      return;
    }
    const now = yield* Clock.currentTimeMillis;
    yield* patchOperation(operationId, {
      phase: "publishing",
      message: "Publishing reconciled local state…",
    });
    yield* state.saveConnection({
      ...companionResult.success,
      state: resultCommit === remoteTree ? "ready" : "local_ahead",
      remoteBaselineCommit: acceptedCommit,
      lastConvergedCommit: acceptedCommit,
      workspaceBaselineManifest: desired,
      localAhead: resultCommit !== remoteTree,
      pendingRemoteCommit: null,
      activeOperationId: null,
      lastSyncedAtEpochMs: now,
      suppressRenameWarning:
        connection.suppressRenameWarning || operation.context.suppressRenameAfterSuccess === true,
    });
    activeConnections.delete(connection.connectionId);
    yield* mirror.releaseOperationRef(context).pipe(Effect.ignore);
    yield* workspaceEntries.refresh(connection.workspaceRoot).pipe(Effect.ignore);
    yield* patchOperation(operationId, {
      phase: "succeeded",
      message:
        resultCommit === remoteTree
          ? "Local files now match Overleaf."
          : "Local reconciliation completed. A later manual Sync will push the preserved edits.",
      review: operation.context.review ?? null,
      conflicts: [],
      errorCode: null,
      retryable: false,
    });
  });

  const continueOperation: OverleafSyncService["Service"]["continueOperation"] = (input) =>
    withOperationExclusive(
      input.operationId,
      Effect.gen(function* () {
        const operationId = input.operationId;
        const operation = yield* state.getOperation(operationId);
        if (operation.snapshot.phase === "awaiting_commit_message") {
          const connection = yield* state.getConnection(operation.snapshot.connectionId!);
          const commitMessage = yield* resolveCommitMessage(connection, input.commitMessage);
          const clickManifest =
            operation.context.clickManifest ?? connection.workspaceBaselineManifest;
          const observed = yield* scanTarget(
            operationId,
            connection.workspaceRoot,
            connection.relativeFolder,
            clickManifest.files.map((file) => file.path),
            connection.localOnlyCompanions,
          );
          if (!manifestsEqual(observed, clickManifest))
            return yield* new ScientOverleafOperationError({
              code: "workspace_changed",
              message:
                "The project changed while waiting for a commit message. Cancel and start Sync again.",
              retryable: false,
            });
          yield* patchOperation(
            operationId,
            { phase: "preparing", message: "Creating the local snapshot commit…", errorCode: null },
            { commitMessage },
          );
          yield* launch(operationId, finishInitialCandidate(operationId));
          return (yield* state.getOperation(operationId)).snapshot;
        }
        if (!["awaiting_conflicts", "awaiting_local_conflicts"].includes(operation.snapshot.phase))
          return yield* new ScientOverleafOperationError({
            code: "invalid_request",
            message: "This Overleaf operation is not waiting for conflict resolution.",
            retryable: false,
          });
        if (operation.context.conflicts?.some((item) => !item.conflict.resolved))
          return yield* new ScientOverleafOperationError({
            code: "conflict",
            message: "Resolve every conflict before continuing.",
            retryable: false,
          });
        const connection = yield* state.getConnection(operation.snapshot.connectionId!);
        yield* patchOperation(operationId, {
          phase: "rebasing",
          message: "Applying conflict resolutions…",
          conflicts: [],
          errorCode: null,
        });
        yield* launch(
          operationId,
          Effect.gen(function* () {
            if (operation.context.initialMode === "combine")
              return yield* finishInitialCandidate(operationId);
            const credentials = yield* credentialsForConnection(connection);
            const continued = yield* mirror.continueRebase(
              gitContext(operationId, connection, credentials.account, credentials.token),
            );
            if (continued.conflicted) {
              const remaining = yield* mirror.conflicts(
                gitContext(operationId, connection, credentials.account, credentials.token),
              );
              yield* patchOperation(
                operationId,
                {
                  phase: operation.context.localReconcile
                    ? "awaiting_local_conflicts"
                    : "awaiting_conflicts",
                  message: "More overlapping edits need resolution.",
                  conflicts: remaining.map((item) => item.conflict),
                  errorCode: "conflict",
                },
                { conflicts: remaining },
              );
              return;
            }
            if (operation.context.localReconcile) {
              if (connection.pendingRemoteCommit === null)
                return yield* new ScientOverleafOperationError({
                  code: "corrupt_state",
                  message: "Local reconciliation is missing its accepted Overleaf commit.",
                  retryable: false,
                });
              return yield* finishLocalReconcile(
                operationId,
                connection,
                connection.pendingRemoteCommit,
              );
            }
            const candidateManifest = yield* mirror.manifest({
              ...gitContext(operationId, connection, credentials.account, credentials.token),
              commit: continued.candidateCommit,
            });
            const review = yield* mirror.review({
              ...gitContext(operationId, connection, credentials.account, credentials.token),
              connection,
              candidateCommit: continued.candidateCommit,
              candidateManifest,
            });
            yield* patchOperation(
              operationId,
              {
                phase: review.requiresConfirmation ? "awaiting_push_confirmation" : "rebasing",
                message: review.requiresConfirmation
                  ? "Review the resolved candidate before pushing."
                  : "Conflict resolutions are ready to push.",
                review: review.requiresConfirmation ? review : null,
              },
              {
                candidateCommit: continued.candidateCommit,
                remoteManifest: candidateManifest,
                review,
              },
            );
            if (!review.requiresConfirmation) yield* pushCandidate(operationId);
          }),
        );
        return (yield* state.getOperation(operationId)).snapshot;
      }),
    );

  const retryOperation: OverleafSyncService["Service"]["retryOperation"] = (operationId) =>
    withOperationExclusive(
      operationId,
      Effect.gen(function* () {
        const operation = yield* state.getOperation(operationId);
        const connection =
          operation.snapshot.connectionId === null
            ? null
            : yield* state.getConnection(operation.snapshot.connectionId);
        if (operation.snapshot.phase === "push_outcome_unknown" && connection !== null) {
          const candidateCommit = operation.context.candidateCommit;
          const candidateTree = operation.context.candidateTree;
          const prePushBase = operation.context.prePushBase;
          if (!candidateCommit || !candidateTree || !prePushBase)
            return yield* new ScientOverleafOperationError({
              code: "corrupt_state",
              message: "The uncertain Overleaf push is missing required recovery identity.",
              retryable: false,
            });
          yield* patchOperation(operationId, {
            phase: "fetching",
            message: "Verifying whether Overleaf accepted the push…",
            errorCode: null,
          });
          yield* launch(
            operationId,
            Effect.gen(function* () {
              const credentials = yield* credentialsForConnection(connection);
              const context = gitContext(
                operationId,
                connection,
                credentials.account,
                credentials.token,
              );
              const result = yield* mirror.candidateAccepted({
                ...context,
                candidateCommit,
                candidateTree,
                prePushBase,
              });
              if (result.accepted) {
                const desired = yield* mirror.manifest({ ...context, commit: result.head });
                return yield* completeProjection(operationId, connection, result.head, desired);
              }
              const rebased = yield* mirror.rebaseSnapshot({
                ...context,
                snapshotCommit: operation.context.snapshotCommit ?? candidateCommit,
              });
              if (rebased.conflicted) {
                const conflicts = yield* mirror.conflicts(context);
                yield* patchOperation(
                  operationId,
                  {
                    phase: "awaiting_conflicts",
                    message: "Overleaf changed while the push outcome was uncertain.",
                    conflicts: conflicts.map((item) => item.conflict),
                    errorCode: "conflict",
                  },
                  { conflicts },
                );
                return;
              }
              const desired = yield* mirror.manifest({
                ...context,
                commit: rebased.candidateCommit,
              });
              if (rebased.candidateCommit === result.head) {
                const remoteOnly = {
                  ...connection,
                  state: "local_projection_pending" as const,
                  remoteBaselineCommit: result.head,
                  pendingRemoteCommit: result.head,
                  activeOperationId: operationId,
                };
                yield* state.saveConnection(remoteOnly);
                return yield* completeProjection(operationId, remoteOnly, result.head, desired);
              }
              const review = yield* mirror.review({
                ...context,
                connection,
                candidateCommit: rebased.candidateCommit,
                candidateManifest: desired,
              });
              yield* patchOperation(
                operationId,
                {
                  phase: review.requiresConfirmation ? "awaiting_push_confirmation" : "rebasing",
                  message: review.requiresConfirmation
                    ? "Overleaf changed; review the newly rebased candidate before retrying."
                    : "The earlier push was not accepted; retrying safely…",
                  review: review.requiresConfirmation ? review : null,
                  errorCode: review.requiresConfirmation ? "review_required" : null,
                },
                {
                  candidateCommit: rebased.candidateCommit,
                  remoteManifest: desired,
                  prePushBase: result.head,
                  review,
                },
              );
              if (review.requiresConfirmation) return;
              yield* pushCandidate(operationId);
            }),
          );
          return (yield* state.getOperation(operationId)).snapshot;
        }
        if (
          operation.snapshot.phase === "remote_synced_local_pending" &&
          connection !== null &&
          connection.pendingRemoteCommit !== null
        ) {
          const pendingRemoteCommit = connection.pendingRemoteCommit;
          if (operation.context.localReconcile) {
            yield* launch(
              operationId,
              finishLocalReconcile(operationId, connection, pendingRemoteCommit),
            );
            return operation.snapshot;
          }
          const current = yield* scanTarget(
            operationId,
            connection.workspaceRoot,
            connection.relativeFolder,
            connection.workspaceBaselineManifest.files.map((file) => file.path),
            connection.localOnlyCompanions,
          );
          if (
            !manifestsEqual(
              current,
              operation.context.clickManifest ?? connection.workspaceBaselineManifest,
            )
          )
            return yield* patchOperation(operationId, {
              phase: "awaiting_local_conflicts",
              message: "Local files changed; use Reconcile local to preserve them.",
              errorCode: "workspace_changed",
              retryable: false,
            }).pipe(Effect.map((value) => value.snapshot));
          yield* launch(
            operationId,
            Effect.gen(function* () {
              const credentials = yield* credentialsForConnection(connection);
              const context = gitContext(
                operationId,
                connection,
                credentials.account,
                credentials.token,
              );
              const desired = yield* mirror.manifest({
                ...context,
                commit: pendingRemoteCommit,
              });
              yield* completeProjection(operationId, connection, pendingRemoteCommit, desired);
            }),
          );
          return operation.snapshot;
        }
        return yield* new ScientOverleafOperationError({
          code: "invalid_request",
          message: "This Overleaf operation has nothing retryable pending.",
          retryable: false,
        });
      }),
    );

  const reconcileLocal: OverleafSyncService["Service"]["reconcileLocal"] = (connectionId) =>
    withExclusive(
      mutationLock(connectionId),
      Effect.gen(function* () {
        const connection = yield* state.getConnection(connectionId);
        if (
          connection.state !== "local_projection_pending" ||
          connection.pendingRemoteCommit === null ||
          connection.activeOperationId === null
        )
          return yield* new ScientOverleafOperationError({
            code: "invalid_request",
            message: "This connection has no local reconciliation pending.",
            retryable: false,
          });
        const operationId = connection.activeOperationId;
        const operation = yield* state.getOperation(operationId);
        const current = yield* scanTarget(
          operationId,
          connection.workspaceRoot,
          connection.relativeFolder,
          connection.workspaceBaselineManifest.files.map((file) => file.path),
          connection.localOnlyCompanions,
        );
        yield* patchOperation(
          operationId,
          {
            phase: "rebasing",
            message: "Reconciling current local edits offline…",
            errorCode: null,
          },
          { clickManifest: current, localReconcile: true },
        );
        yield* launch(
          operationId,
          Effect.gen(function* () {
            const credentials = yield* credentialsForConnection(connection);
            const context = gitContext(
              operationId,
              connection,
              credentials.account,
              credentials.token,
            );
            const base =
              operation.context.workspaceBaseCommit ??
              operation.context.snapshotCommit ??
              operation.context.prePushBase ??
              connection.remoteBaselineCommit!;
            yield* mirror.checkout({ ...context, commit: base });
            yield* mirror.applyWorkspace({
              ...context,
              workspaceRoot: targetFolder(connection.workspaceRoot, connection.relativeFolder),
              desired: current,
              previous: operation.context.clickManifest ?? connection.workspaceBaselineManifest,
            });
            const localCommit = yield* mirror.commitSnapshot({
              ...context,
              message: "Update project",
            });
            if (localCommit === null) {
              yield* mirror.checkout({ ...context, commit: connection.pendingRemoteCommit! });
              return yield* finishLocalReconcile(
                operationId,
                connection,
                connection.pendingRemoteCommit!,
              );
            }
            const rebased = yield* mirror.rebaseRangeOnto({
              ...context,
              upstream: connection.pendingRemoteCommit!,
              fromExclusive: base,
            });
            if (rebased.conflicted) {
              const conflicts = yield* mirror.conflicts(context);
              yield* patchOperation(
                operationId,
                {
                  phase: "awaiting_local_conflicts",
                  message:
                    "Choose how the accepted Overleaf result and later local edits should combine.",
                  conflicts: conflicts.map((item) => item.conflict),
                  errorCode: "conflict",
                },
                { conflicts },
              );
              return;
            }
            yield* finishLocalReconcile(operationId, connection, connection.pendingRemoteCommit!);
          }),
        );
        return (yield* state.getOperation(operationId)).snapshot;
      }),
    );

  const updateConnection: OverleafSyncService["Service"]["updateConnection"] = (input) =>
    withExclusive(
      mutationLock(input.connectionId),
      Effect.gen(function* () {
        const connection = yield* state.getConnection(input.connectionId);
        if (connection.activeOperationId !== null)
          return yield* new ScientOverleafOperationError({
            code: "operation_active",
            message: "Wait for the active Overleaf operation before changing settings.",
            retryable: false,
          });
        if (input.commitPolicy !== undefined) yield* validateCommitPolicy(input.commitPolicy);
        const includedCompanion =
          input.includeCompanionPath === undefined
            ? null
            : yield* Effect.try({
                try: () => normalizeManagedPath(input.includeCompanionPath!),
                catch: (cause) => publicError(cause),
              });
        if (
          includedCompanion !== null &&
          !connection.localOnlyCompanions.includes(includedCompanion)
        ) {
          return yield* new ScientOverleafOperationError({
            code: "invalid_request",
            message: "That path is not a connection-owned local-only companion.",
            retryable: false,
          });
        }
        const updated = {
          ...connection,
          ...(input.label === undefined ? {} : { label: input.label }),
          ...(input.commitPolicy === undefined ? {} : { commitPolicy: input.commitPolicy }),
          ...(input.suppressRenameWarning === undefined
            ? {}
            : { suppressRenameWarning: input.suppressRenameWarning }),
          ...(includedCompanion === null
            ? {}
            : {
                localOnlyCompanions: connection.localOnlyCompanions.filter(
                  (path) => path !== includedCompanion,
                ),
              }),
        };
        yield* state.saveConnection(updated);
        return updated;
      }),
    );

  const cancelOperation: OverleafSyncService["Service"]["cancelOperation"] = (operationId) =>
    Effect.gen(function* () {
      const operation = yield* state.getOperation(operationId);
      if (["succeeded", "failed", "cancelled"].includes(operation.snapshot.phase))
        return yield* new ScientOverleafOperationError({
          code: "invalid_request",
          message: "This Overleaf operation has already finished.",
          retryable: false,
        });
      if (
        [
          "pushing",
          "push_outcome_unknown",
          "projecting",
          "remote_synced_local_pending",
          "awaiting_local_conflicts",
          "publishing",
        ].includes(operation.snapshot.phase)
      ) {
        return yield* new ScientOverleafOperationError({
          code: "operation_active",
          message:
            "This phase cannot be cancelled safely. Wait for it to finish or use the explicit recovery action it provides.",
          retryable: false,
        });
      }
      const fiber = fibers.get(operationId);
      if (fiber) yield* Fiber.interrupt(fiber);
      const afterInterrupt = yield* state.getOperation(operationId);
      if (afterInterrupt.snapshot.phase === "push_outcome_unknown") return afterInterrupt.snapshot;
      if (operation.snapshot.connectionId !== null) {
        const connection = yield* state
          .getConnection(operation.snapshot.connectionId)
          .pipe(Effect.option);
        if (Option.isSome(connection)) {
          const context = { operationId, cwd: mirror.mirrorRoot(connection.value.connectionId) };
          yield* mirror.abortRebase(context).pipe(Effect.ignore);
          yield* mirror.releaseOperationRef(context).pipe(Effect.ignore);
        }
      }
      const cancelled = yield* patchOperation(operationId, {
        phase: "cancelled",
        message: "Overleaf operation cancelled.",
        errorCode: null,
        retryable: false,
      });
      if (operation.snapshot.kind === "connect" && operation.snapshot.connectionId !== null) {
        activeConnections.delete(operation.snapshot.connectionId);
        yield* state.deleteConnection(operation.snapshot.connectionId);
        return cancelled.snapshot;
      }
      yield* releaseConnection(operation.snapshot.connectionId);
      return cancelled.snapshot;
    });

  const repair: OverleafSyncService["Service"]["repair"] = (connectionId) =>
    withExclusive(
      mutationLock(connectionId),
      Effect.gen(function* () {
        const connection = yield* state.getConnection(connectionId);
        if (activeConnections.has(connectionId) || connection.activeOperationId !== null)
          return yield* new ScientOverleafOperationError({
            code: "operation_active",
            message: "Resolve the active Overleaf operation before repairing this connection.",
            retryable: false,
          });
        activeConnections.add(connectionId);
        const operation = yield* state.createOperation("repair", connectionId, {
          workspaceRoot: connection.workspaceRoot,
          relativeFolder: connection.relativeFolder,
          initialMode: "combine",
        });
        yield* state.saveConnection({
          ...connection,
          state: "operation_active",
          activeOperationId: operation.snapshot.operationId,
        });
        yield* launch(
          operation.snapshot.operationId,
          Effect.gen(function* () {
            const operationsDirectory = NodePath.join(
              state.connectionDirectory(connectionId),
              "operations",
            );
            const priorOperations = yield* Effect.tryPromise({
              try: async () => await NodeFSP.readdir(operationsDirectory, { withFileTypes: true }),
              catch: () => [],
            }).pipe(Effect.orElseSucceed(() => []));
            for (const entry of priorOperations) {
              if (!entry.isDirectory() || entry.name === operation.snapshot.operationId) continue;
              yield* projector.recover({
                operationDirectory: NodePath.join(operationsDirectory, entry.name),
                targetRoot: targetFolder(connection.workspaceRoot, connection.relativeFolder),
              });
            }
            const credentials = yield* credentialsForConnection(connection);
            const mirrorRoot = mirror.mirrorRoot(connectionId);
            yield* Effect.tryPromise({
              try: () => NodeFSP.rm(mirrorRoot, { recursive: true, force: true }),
              catch: () =>
                new ScientOverleafOperationError({
                  code: "filesystem_failed",
                  message: "Unable to replace the private Overleaf mirror.",
                  retryable: true,
                }),
            });
            const context = gitContext(
              operation.snapshot.operationId,
              connection,
              credentials.account,
              credentials.token,
            );
            yield* mirror.initialize({ ...context, connectionId, gitUrl: connection.gitUrl });
            const head = yield* mirror.fetch(context);
            const remote = yield* mirror.manifest({ ...context, commit: head });
            const local = yield* scanTarget(
              operation.snapshot.operationId,
              connection.workspaceRoot,
              connection.relativeFolder,
              connection.workspaceBaselineManifest.files.map((file) => file.path),
              connection.localOnlyCompanions,
            );
            const repaired = { ...connection, remoteBaselineCommit: head };
            yield* state.saveConnection(repaired);
            yield* patchOperation(
              operation.snapshot.operationId,
              {
                phase: "preparing",
                message: "Comparing the repaired mirror through Safe Combine…",
              },
              {
                clickManifest: local,
                remoteManifest: remote,
                candidateCommit: head,
                prePushBase: head,
                initialMode: "combine",
              },
            );
            yield* captureWorkspaceBase(
              operation.snapshot.operationId,
              repaired,
              local,
              remote,
              head,
            );
            const conflicts = yield* syntheticConflicts(
              operation.snapshot.operationId,
              repaired,
              local,
              remote,
            );
            if (conflicts.length > 0) {
              yield* patchOperation(
                operation.snapshot.operationId,
                {
                  phase: "awaiting_conflicts",
                  message: "Resolve files that differ after mirror repair.",
                  conflicts: conflicts.map((item) => item.conflict),
                  errorCode: "conflict",
                },
                { conflicts },
              );
              return;
            }
            yield* finishInitialCandidate(operation.snapshot.operationId);
          }),
        );
        return operation.snapshot;
      }).pipe(Effect.tapError(() => releaseConnection(connectionId))),
    );

  const disconnect: OverleafSyncService["Service"]["disconnect"] = (input) =>
    withExclusive(
      mutationLock(input.connectionId),
      Effect.gen(function* () {
        const connection = yield* state.getConnection(input.connectionId);
        if (activeConnections.has(connection.connectionId) || connection.activeOperationId !== null)
          return yield* new ScientOverleafOperationError({
            code: "operation_active",
            message: "Resolve the active Overleaf operation before disconnecting.",
            retryable: false,
          });
        const operationId = yield* state.newId;
        const current = yield* scanTarget(
          operationId,
          connection.workspaceRoot,
          connection.relativeFolder,
          connection.workspaceBaselineManifest.files.map((file) => file.path),
          connection.localOnlyCompanions,
        ).pipe(Effect.ensuring(state.removeOperation(operationId).pipe(Effect.ignore)));
        const hasUnsyncedChanges =
          connection.localAhead || !manifestsEqual(current, connection.workspaceBaselineManifest);
        if (input.mode === "check")
          return {
            disconnected: false,
            hasUnsyncedChanges,
            companionPaths: connection.localOnlyCompanions,
            operation: null,
          };
        if (input.mode === "sync-and-disconnect") {
          activeConnections.add(connection.connectionId);
          const started = yield* Effect.gen(function* () {
            const operation = yield* state.createOperation("disconnect", connection.connectionId, {
              workspaceRoot: connection.workspaceRoot,
              relativeFolder: connection.relativeFolder,
              disconnectAfterSync: true,
            });
            yield* state.saveConnection({
              ...connection,
              state: "operation_active",
              activeOperationId: operation.snapshot.operationId,
            });
            yield* launch(
              operation.snapshot.operationId,
              runSync(operation.snapshot.operationId, input.commitMessage),
            );
            return operation.snapshot;
          }).pipe(Effect.tapError(() => releaseConnection(connection.connectionId)));
          return {
            disconnected: false,
            hasUnsyncedChanges,
            companionPaths: connection.localOnlyCompanions,
            operation: started,
          };
        }
        yield* state.deleteConnection(input.connectionId);
        return {
          disconnected: true,
          hasUnsyncedChanges,
          companionPaths: connection.localOnlyCompanions,
          operation: null,
        };
      }),
    );

  return OverleafSyncService.of({
    overview: (workspaceRoot) =>
      validateWorkspaceMapping(workspaceRoot, "").pipe(
        Effect.flatMap((mapping) => state.overview(mapping.workspaceRoot)),
      ),
    saveAccount: (input) => withExclusive(registryMutationLock, state.saveAccount(input)),
    removeAccount: (accountId) =>
      withExclusive(registryMutationLock, state.removeAccount(accountId)),
    startPreflight,
    operationStatus,
    completePreflight,
    cancelOperation,
    updateConnection,
    startSync,
    retryOperation,
    confirmReview,
    conflicts: getConflicts,
    conflictDetail,
    resolveConflict,
    continueOperation,
    reconcileLocal,
    repair,
    disconnect,
  });
});

export const layer = Layer.effect(OverleafSyncService, make());
