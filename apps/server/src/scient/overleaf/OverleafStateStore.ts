// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";

import type {
  ScientOverleafAccount,
  ScientOverleafConnection,
  ScientOverleafOperationSnapshot,
  ScientOverleafSaveAccountRequest,
} from "@t3tools/contracts";
import {
  ScientOverleafAccount as ScientOverleafAccountSchema,
  ScientOverleafCommitPolicy,
  ScientOverleafConflictDetail,
  ScientOverleafConnection as ScientOverleafConnectionSchema,
  ScientOverleafOperationError,
  ScientOverleafOperationSnapshot as ScientOverleafOperationSnapshotSchema,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import { ServerSecretStore } from "../../auth/ServerSecretStore.ts";
import * as ServerConfig from "../../config.ts";
import {
  type OperationContext,
  type PersistedOverleafAccount,
  type PersistedOverleafConnection,
  type PersistedOverleafOperation,
  type TreeManifest,
  terminalOverleafPhases,
} from "./model.ts";

const TreeFileSchema = Schema.Struct({
  path: Schema.String,
  hash: Schema.String,
  size: Schema.Number,
  executable: Schema.Boolean,
});
const TreeManifestSchema = Schema.Struct({
  files: Schema.Array(TreeFileSchema),
  totalBytes: Schema.Number,
});
const PersistedAccountSchema = Schema.Struct({
  ...ScientOverleafAccountSchema.fields,
  secretRef: Schema.String,
});
const {
  state: _stateSchema,
  remoteBaselineCommit: _remoteBaselineCommitSchema,
  lastConvergedCommit: _lastConvergedCommitSchema,
  localAhead: _localAheadSchema,
  lastSyncedAtEpochMs: _lastSyncedAtEpochMsSchema,
  ...ConnectionRecordFields
} = ScientOverleafConnectionSchema.fields;
const PersistedConnectionRecordSchema = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  ...ConnectionRecordFields,
});
const PersistedBaselineSchema = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  state: ScientOverleafConnectionSchema.fields.state,
  remoteBaselineCommit: ScientOverleafConnectionSchema.fields.remoteBaselineCommit,
  lastConvergedCommit: ScientOverleafConnectionSchema.fields.lastConvergedCommit,
  localAhead: ScientOverleafConnectionSchema.fields.localAhead,
  lastSyncedAtEpochMs: ScientOverleafConnectionSchema.fields.lastSyncedAtEpochMs,
  workspaceBaselineManifest: TreeManifestSchema,
  pendingRemoteCommit: Schema.NullOr(Schema.String),
  activeOperationId: Schema.NullOr(Schema.String),
});
const CompanionWriteSchema = Schema.Struct({
  relativePath: Schema.String,
  materialPath: Schema.String,
});
const OperationContextSchema = Schema.Struct({
  workspaceRoot: Schema.optionalKey(Schema.String),
  relativeFolder: Schema.optionalKey(Schema.String),
  accountId: Schema.optionalKey(Schema.String),
  projectUrl: Schema.optionalKey(Schema.String),
  gitUrl: Schema.optionalKey(Schema.String),
  host: Schema.optionalKey(Schema.String),
  label: Schema.optionalKey(Schema.String),
  commitPolicy: Schema.optionalKey(ScientOverleafCommitPolicy),
  commitMessage: Schema.optionalKey(Schema.String),
  clickManifest: Schema.optionalKey(TreeManifestSchema),
  remoteManifest: Schema.optionalKey(TreeManifestSchema),
  candidateCommit: Schema.optionalKey(Schema.String),
  candidateTree: Schema.optionalKey(Schema.String),
  prePushBase: Schema.optionalKey(Schema.String),
  snapshotCommit: Schema.optionalKey(Schema.String),
  workspaceBaseCommit: Schema.optionalKey(Schema.String),
  initialMode: Schema.optionalKey(
    Schema.Literals(["combine", "replace-local", "replace-overleaf"]),
  ),
  conflicts: Schema.optionalKey(Schema.Array(ScientOverleafConflictDetail)),
  review: Schema.optionalKey(
    Schema.Struct({
      candidateCommit: Schema.String,
      changes: Schema.Array(
        Schema.Struct({
          kind: Schema.Literals(["added", "modified", "renamed", "deleted"]),
          path: Schema.String,
          oldPath: Schema.optionalKey(Schema.String),
          similarity: Schema.optionalKey(Schema.Number),
        }),
      ),
      warnings: Schema.Array(
        Schema.Struct({
          kind: Schema.Literals([
            "deletion",
            "historical_revert",
            "whole_tree_revert",
            "rename",
            "file_count",
            "large_file",
            "large_editable_text",
            "large_editable_material",
            "project_size",
            "track_changes_metadata",
            "replacement",
          ]),
          message: Schema.String,
          paths: Schema.Array(Schema.String),
          blocking: Schema.Boolean,
          suppressible: Schema.Boolean,
        }),
      ),
      requiresConfirmation: Schema.Boolean,
    }),
  ),
  companionWrites: Schema.optionalKey(Schema.Array(CompanionWriteSchema)),
  disconnectAfterSync: Schema.optionalKey(Schema.Boolean),
  localReconcile: Schema.optionalKey(Schema.Boolean),
  suppressRenameAfterSuccess: Schema.optionalKey(Schema.Boolean),
});
const PersistedOperationSchema = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  snapshot: ScientOverleafOperationSnapshotSchema,
  context: OperationContextSchema,
});
const RegistrySchema = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  accounts: Schema.Array(PersistedAccountSchema),
  connectionIds: Schema.Array(Schema.String),
  operations: Schema.Array(
    Schema.Struct({
      operationId: Schema.String,
      connectionId: Schema.NullOr(Schema.String),
    }),
  ),
});

type Registry = typeof RegistrySchema.Type;

const emptyManifest: TreeManifest = { files: [], totalBytes: 0 };
const emptyRegistry: Registry = {
  schemaVersion: 1,
  accounts: [],
  connectionIds: [],
  operations: [],
};
const encodeUnknownJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

function stateError(
  code:
    | "authentication_failed"
    | "corrupt_state"
    | "filesystem_failed"
    | "invalid_request"
    | "not_found"
    | "operation_active",
  message: string,
  retryable = false,
) {
  return new ScientOverleafOperationError({ code, message, retryable });
}

const decodeRegistryJson = Schema.decodeUnknownEffect(Schema.fromJsonString(RegistrySchema));
const decodeConnectionJson = Schema.decodeUnknownEffect(
  Schema.fromJsonString(PersistedConnectionRecordSchema),
);
const decodeBaselineJson = Schema.decodeUnknownEffect(
  Schema.fromJsonString(PersistedBaselineSchema),
);
const decodeOperationJson = Schema.decodeUnknownEffect(
  Schema.fromJsonString(PersistedOperationSchema),
);

export class OverleafStateStore extends Context.Service<
  OverleafStateStore,
  {
    readonly root: string;
    readonly runtimeRoot: string;
    readonly newId: Effect.Effect<string, ScientOverleafOperationError>;
    readonly overview: (workspaceRoot: string) => Effect.Effect<
      {
        readonly accounts: ReadonlyArray<ScientOverleafAccount>;
        readonly connections: ReadonlyArray<ScientOverleafConnection>;
        readonly operations: ReadonlyArray<ScientOverleafOperationSnapshot>;
      },
      ScientOverleafOperationError
    >;
    readonly saveAccount: (
      input: ScientOverleafSaveAccountRequest,
    ) => Effect.Effect<ScientOverleafAccount, ScientOverleafOperationError>;
    readonly removeAccount: (
      accountId: string,
    ) => Effect.Effect<void, ScientOverleafOperationError>;
    readonly accountWithToken: (
      accountId: string,
    ) => Effect.Effect<
      { account: PersistedOverleafAccount; token: Uint8Array },
      ScientOverleafOperationError
    >;
    readonly markAccountValidated: (
      accountId: string,
    ) => Effect.Effect<void, ScientOverleafOperationError>;
    readonly listConnections: Effect.Effect<
      ReadonlyArray<PersistedOverleafConnection>,
      ScientOverleafOperationError
    >;
    readonly getConnection: (
      connectionId: string,
    ) => Effect.Effect<PersistedOverleafConnection, ScientOverleafOperationError>;
    readonly saveConnection: (
      connection: PersistedOverleafConnection,
    ) => Effect.Effect<void, ScientOverleafOperationError>;
    readonly createConnection: (
      input: Omit<PersistedOverleafConnection, "workspaceBaselineManifest"> & {
        workspaceBaselineManifest?: TreeManifest;
      },
    ) => Effect.Effect<PersistedOverleafConnection, ScientOverleafOperationError>;
    readonly deleteConnection: (
      connectionId: string,
      preserveOperationId?: string,
    ) => Effect.Effect<void, ScientOverleafOperationError>;
    readonly getOperation: (
      operationId: string,
    ) => Effect.Effect<PersistedOverleafOperation, ScientOverleafOperationError>;
    readonly saveOperation: (
      operation: PersistedOverleafOperation,
    ) => Effect.Effect<void, ScientOverleafOperationError>;
    readonly createOperation: (
      kind: ScientOverleafOperationSnapshot["kind"],
      connectionId: string | null,
      context: OperationContext,
    ) => Effect.Effect<PersistedOverleafOperation, ScientOverleafOperationError>;
    readonly removeOperation: (
      operationId: string,
    ) => Effect.Effect<void, ScientOverleafOperationError>;
    readonly connectionDirectory: (connectionId: string) => string;
    readonly operationDirectory: (operationId: string) => string;
  }
>()("t3/scient/overleaf/OverleafStateStore") {}

export const make = Effect.fn("OverleafStateStore.make")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const config = yield* ServerConfig.ServerConfig;
  const secrets = yield* ServerSecretStore;
  const lock = yield* Semaphore.make(1);
  const root = path.join(config.stateDir, "scient", "overleaf", "v1");
  const registryPath = path.join(root, "registry.json");
  const connectionsRoot = path.join(root, "connections");
  const orphanOperationsRoot = path.join(root, "orphan-operations");
  const runtimeRoot = path.join(root, "runtime");
  const operationConnections = new Map<string, string | null>();

  const mapFs = <A, E, R>(effect: Effect.Effect<A, E, R>, message: string) =>
    effect.pipe(Effect.mapError(() => stateError("filesystem_failed", message, true)));
  const writeJson = (filePath: string, value: unknown) =>
    Effect.tryPromise({
      try: async () => {
        const directory = path.dirname(filePath);
        const temporary = path.join(
          directory,
          `${path.basename(filePath)}.${NodeCrypto.randomUUID()}.tmp`,
        );
        await NodeFSP.mkdir(directory, { recursive: true });
        try {
          const handle = await NodeFSP.open(temporary, "wx", 0o600);
          try {
            await handle.writeFile(`${encodeUnknownJson(value)}\n`, "utf8");
            await handle.sync();
          } finally {
            await handle.close();
          }
          await NodeFSP.rename(temporary, filePath);
          try {
            const directoryHandle = await NodeFSP.open(directory, "r");
            try {
              await directoryHandle.sync();
            } finally {
              await directoryHandle.close();
            }
          } catch {
            // Directory fsync is not supported by every platform/filesystem.
          }
        } finally {
          await NodeFSP.rm(temporary, { force: true });
        }
      },
      catch: () => stateError("filesystem_failed", "Unable to persist Overleaf state.", true),
    });
  const readOptional = (filePath: string) =>
    fs.readFileString(filePath).pipe(
      Effect.map(Option.some),
      Effect.catch((cause) =>
        cause.reason._tag === "NotFound"
          ? Effect.succeed(Option.none())
          : Effect.fail(stateError("filesystem_failed", "Unable to read Overleaf state.", true)),
      ),
    );

  yield* mapFs(
    fs.makeDirectory(connectionsRoot, { recursive: true }),
    "Unable to prepare Overleaf state.",
  );
  yield* mapFs(
    fs.makeDirectory(orphanOperationsRoot, { recursive: true }),
    "Unable to prepare Overleaf state.",
  );
  yield* fs.chmod(root, 0o700).pipe(Effect.ignore);
  yield* mapFs(
    fs.remove(runtimeRoot, { recursive: true, force: true }),
    "Unable to clear abandoned Overleaf credentials.",
  );
  yield* mapFs(
    fs.makeDirectory(runtimeRoot, { recursive: true }),
    "Unable to prepare Overleaf runtime state.",
  );

  const readRegistry = Effect.fn("OverleafStateStore.readRegistry")(function* () {
    const contents = yield* readOptional(registryPath);
    if (Option.isNone(contents)) return emptyRegistry;
    const registry = yield* decodeRegistryJson(contents.value).pipe(
      Effect.mapError(() => stateError("corrupt_state", "Saved Overleaf registry is unreadable.")),
    );
    for (const operation of registry.operations) {
      operationConnections.set(operation.operationId, operation.connectionId);
    }
    return registry;
  });
  const writeRegistry = (registry: Registry) => writeJson(registryPath, registry);
  const connectionDirectory = (connectionId: string) => path.join(connectionsRoot, connectionId);
  const connectionPath = (connectionId: string) =>
    path.join(connectionDirectory(connectionId), "connection.json");
  const baselinePath = (connectionId: string) =>
    path.join(connectionDirectory(connectionId), "baseline.json");
  const operationDirectory = (operationId: string) => {
    const connectionId = operationConnections.get(operationId) ?? null;
    return connectionId === null
      ? path.join(orphanOperationsRoot, operationId)
      : path.join(connectionDirectory(connectionId), "operations", operationId);
  };
  const operationPath = (operationId: string) =>
    path.join(operationDirectory(operationId), "operation.json");
  const newId = crypto.randomUUIDv4.pipe(
    Effect.mapError(() =>
      stateError("filesystem_failed", "Unable to allocate Overleaf state.", true),
    ),
  );

  const writeConnectionFiles = Effect.fnUntraced(function* (
    connection: PersistedOverleafConnection,
  ) {
    const {
      state: connectionState,
      remoteBaselineCommit,
      lastConvergedCommit,
      localAhead,
      lastSyncedAtEpochMs,
      workspaceBaselineManifest,
      pendingRemoteCommit,
      activeOperationId,
      ...record
    } = connection;
    yield* writeJson(connectionPath(connection.connectionId), { schemaVersion: 1, ...record });
    yield* writeJson(baselinePath(connection.connectionId), {
      schemaVersion: 1,
      state: connectionState,
      remoteBaselineCommit,
      lastConvergedCommit,
      localAhead,
      lastSyncedAtEpochMs,
      workspaceBaselineManifest,
      pendingRemoteCommit,
      activeOperationId,
    });
  });
  const writeOperationFile = (operation: PersistedOverleafOperation) =>
    writeJson(operationPath(operation.snapshot.operationId), { schemaVersion: 1, ...operation });

  const readConnection = Effect.fn("OverleafStateStore.readConnection")(function* (
    connectionId: string,
  ) {
    const [connectionContents, baselineContents] = yield* Effect.all([
      readOptional(connectionPath(connectionId)),
      readOptional(baselinePath(connectionId)),
    ]);
    if (Option.isNone(connectionContents) && Option.isNone(baselineContents))
      return yield* stateError("not_found", "The Overleaf connection was not found.");
    if (Option.isNone(connectionContents) || Option.isNone(baselineContents))
      return yield* stateError("corrupt_state", "Saved Overleaf connection state is incomplete.");
    const record = yield* decodeConnectionJson(connectionContents.value).pipe(
      Effect.mapError(() =>
        stateError("corrupt_state", "Saved Overleaf connection is unreadable."),
      ),
    );
    const baseline = yield* decodeBaselineJson(baselineContents.value).pipe(
      Effect.mapError(() => stateError("corrupt_state", "Saved Overleaf baseline is unreadable.")),
    );
    const { schemaVersion: _recordVersion, ...connectionRecord } = record;
    const { schemaVersion: _baselineVersion, ...connectionBaseline } = baseline;
    return { ...connectionRecord, ...connectionBaseline } satisfies PersistedOverleafConnection;
  });
  const readOperation = Effect.fn("OverleafStateStore.readOperation")(function* (
    operationId: string,
  ) {
    const contents = yield* readOptional(operationPath(operationId));
    if (Option.isNone(contents))
      return yield* stateError("not_found", "The Overleaf operation was not found.");
    const decoded = yield* decodeOperationJson(contents.value).pipe(
      Effect.mapError(() => stateError("corrupt_state", "Saved Overleaf operation is unreadable.")),
    );
    const { schemaVersion: _schemaVersion, ...operation } = decoded;
    return operation;
  });

  const listConnections = Effect.gen(function* () {
    const registry = yield* readRegistry();
    return yield* Effect.all(registry.connectionIds.map(readConnection), { concurrency: 8 });
  });
  const listOperations = Effect.gen(function* () {
    const registry = yield* readRegistry();
    return yield* Effect.all(
      registry.operations.map(({ operationId }) => readOperation(operationId)),
      { concurrency: 8 },
    );
  });

  // A process restart cannot resume a scoped Git child. Human decision points and
  // already-known recovery states remain resumable; an in-flight push becomes
  // outcome-unknown, while an interrupted local projection remains offline-retryable.
  yield* lock.withPermits(1)(
    Effect.gen(function* () {
      const operations = yield* listOperations;
      for (const operation of operations) {
        if (terminalOverleafPhases.has(operation.snapshot.phase)) continue;
        const now = yield* Clock.currentTimeMillis;
        const connection =
          operation.snapshot.connectionId === null
            ? Option.none<PersistedOverleafConnection>()
            : yield* readConnection(operation.snapshot.connectionId).pipe(Effect.option);
        const resumableDecision = new Set([
          "awaiting_commit_message",
          "awaiting_push_confirmation",
          "awaiting_conflicts",
          "awaiting_local_conflicts",
          "push_outcome_unknown",
          "remote_synced_local_pending",
        ]).has(operation.snapshot.phase);
        if (resumableDecision) {
          if (Option.isSome(connection)) {
            const recoveryState =
              operation.snapshot.phase === "push_outcome_unknown"
                ? ("push_outcome_unknown" as const)
                : operation.snapshot.phase === "remote_synced_local_pending" ||
                    operation.snapshot.phase === "awaiting_local_conflicts"
                  ? ("local_projection_pending" as const)
                  : ("operation_active" as const);
            yield* writeConnectionFiles({
              ...connection.value,
              state: recoveryState,
              activeOperationId: operation.snapshot.operationId,
            });
          }
          continue;
        }
        if (
          operation.snapshot.phase === "pushing" &&
          operation.context.candidateTree !== undefined
        ) {
          yield* writeOperationFile({
            ...operation,
            snapshot: {
              ...operation.snapshot,
              phase: "push_outcome_unknown",
              message:
                "The app restarted during the push. The local project is untouched; choose Retry to verify Overleaf.",
              errorCode: "push_outcome_unknown",
              retryable: true,
              updatedAtEpochMs: now,
            },
          });
          if (Option.isSome(connection)) {
            yield* writeConnectionFiles({
              ...connection.value,
              state: "push_outcome_unknown",
              activeOperationId: operation.snapshot.operationId,
            });
          }
          continue;
        }
        if (
          operation.snapshot.phase === "projecting" &&
          Option.isSome(connection) &&
          connection.value.pendingRemoteCommit !== null
        ) {
          yield* writeOperationFile({
            ...operation,
            snapshot: {
              ...operation.snapshot,
              phase: "remote_synced_local_pending",
              message: "Overleaf is updated. Retry the interrupted local projection.",
              errorCode: "local_projection_pending",
              retryable: true,
              updatedAtEpochMs: now,
            },
          });
          yield* writeConnectionFiles({
            ...connection.value,
            state: "local_projection_pending",
            activeOperationId: operation.snapshot.operationId,
          });
          continue;
        }
        if (
          operation.snapshot.phase === "publishing" &&
          Option.isSome(connection) &&
          connection.value.activeOperationId === null
        ) {
          yield* writeOperationFile({
            ...operation,
            snapshot: {
              ...operation.snapshot,
              phase: "succeeded",
              message: "Overleaf and the local project are synchronized.",
              review: operation.context.review ?? null,
              conflicts: [],
              errorCode: null,
              retryable: false,
              updatedAtEpochMs: now,
            },
          });
          continue;
        }
        yield* writeOperationFile({
          ...operation,
          snapshot: {
            ...operation.snapshot,
            phase: "interrupted",
            message:
              "The app restarted before this operation finished. Retry or repair explicitly.",
            errorCode: "interrupted_state",
            retryable: true,
            updatedAtEpochMs: now,
          },
        } satisfies PersistedOverleafOperation);
        if (Option.isSome(connection)) {
          yield* writeConnectionFiles({
            ...connection.value,
            state: "repair_required",
            activeOperationId: null,
          } satisfies PersistedOverleafConnection);
        }
      }
    }),
  );

  const overview: OverleafStateStore["Service"]["overview"] = (workspaceRoot) =>
    lock.withPermits(1)(
      Effect.gen(function* () {
        const registry = yield* readRegistry();
        const connections = (yield* listConnections).filter(
          (connection) => connection.workspaceRoot === workspaceRoot,
        );
        const connectionIds = new Set(connections.map((connection) => connection.connectionId));
        const operations = (yield* listOperations)
          .filter(
            (operation) =>
              operation.context.workspaceRoot === workspaceRoot ||
              (operation.snapshot.connectionId !== null &&
                connectionIds.has(operation.snapshot.connectionId)),
          )
          .map((operation) => operation.snapshot);
        return {
          accounts: registry.accounts.map(({ secretRef: _secretRef, ...account }) => account),
          connections,
          operations,
        };
      }),
    );

  const saveAccount: OverleafStateStore["Service"]["saveAccount"] = (input) =>
    lock.withPermits(1)(
      Effect.gen(function* () {
        const registry = yield* readRegistry();
        const existing =
          input.accountId === undefined
            ? undefined
            : registry.accounts.find((account) => account.accountId === input.accountId);
        if (input.accountId !== undefined && existing === undefined)
          return yield* stateError("not_found", "The Overleaf account was not found.");
        if (existing === undefined && input.token === undefined)
          return yield* stateError(
            "invalid_request",
            "A token is required for a new Overleaf account.",
          );
        const accountId = existing?.accountId ?? (yield* newId);
        const secretRef = existing?.secretRef ?? `scient-overleaf-${accountId}`;
        const token = input.token?.trim();
        if (token !== undefined && token.length === 0)
          return yield* stateError("invalid_request", "The Overleaf token cannot be empty.");
        const now = yield* Clock.currentTimeMillis;
        const rawHost = input.host
          .replace(/^https:\/\//iu, "")
          .replace(/\/$/u, "")
          .toLowerCase();
        let host: string;
        try {
          const parsed = new URL(`https://${rawHost}`);
          if (
            parsed.pathname !== "/" ||
            parsed.search ||
            parsed.hash ||
            parsed.username ||
            parsed.password
          )
            throw new Error("invalid host");
          host = parsed.host.toLowerCase();
        } catch {
          return yield* stateError(
            "invalid_request",
            "Enter the exact Overleaf Git host without a path or credentials.",
          );
        }
        if (input.kind === "cloud" && host !== "git.overleaf.com")
          return yield* stateError(
            "invalid_request",
            "Overleaf Cloud accounts use git.overleaf.com.",
          );
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(input.authorEmail))
          return yield* stateError("invalid_request", "Enter the human author's email address.");
        if (existing !== undefined && (existing.host !== host || existing.kind !== input.kind)) {
          const connections = yield* listConnections;
          if (connections.some((connection) => connection.accountId === existing.accountId)) {
            return yield* stateError(
              "invalid_request",
              "Disconnect projects that use this account before changing its Overleaf host or kind.",
            );
          }
        }
        const account: PersistedOverleafAccount = {
          accountId,
          label: input.label,
          kind: input.kind,
          host,
          authorName: input.authorName,
          authorEmail: input.authorEmail,
          credentialStatus: "saved",
          createdAtEpochMs: existing?.createdAtEpochMs ?? now,
          updatedAtEpochMs: now,
          lastValidatedAtEpochMs: existing?.lastValidatedAtEpochMs ?? null,
          secretRef,
        };
        if (token !== undefined) {
          yield* secrets
            .set(secretRef, new TextEncoder().encode(token))
            .pipe(
              Effect.mapError(() =>
                stateError("filesystem_failed", "Unable to save the Overleaf token.", true),
              ),
            );
        }
        yield* writeRegistry({
          ...registry,
          accounts: [
            ...registry.accounts.filter((candidate) => candidate.accountId !== accountId),
            account,
          ],
        });
        const { secretRef: _secretRef, ...wire } = account;
        return wire;
      }),
    );

  const removeAccount: OverleafStateStore["Service"]["removeAccount"] = (accountId) =>
    lock.withPermits(1)(
      Effect.gen(function* () {
        const registry = yield* readRegistry();
        const account = registry.accounts.find((candidate) => candidate.accountId === accountId);
        if (!account) return yield* stateError("not_found", "The Overleaf account was not found.");
        const connections = yield* listConnections;
        if (connections.some((connection) => connection.accountId === accountId))
          return yield* stateError(
            "invalid_request",
            "Disconnect projects that use this account before removing it.",
          );
        const operations = yield* listOperations;
        if (
          operations.some(
            (operation) =>
              !terminalOverleafPhases.has(operation.snapshot.phase) &&
              operation.context.accountId === accountId,
          )
        ) {
          return yield* stateError(
            "operation_active",
            "Cancel the active Overleaf connection check before removing this account.",
          );
        }
        yield* secrets
          .remove(account.secretRef)
          .pipe(
            Effect.mapError(() =>
              stateError("filesystem_failed", "Unable to remove the Overleaf token.", true),
            ),
          );
        yield* writeRegistry({
          ...registry,
          accounts: registry.accounts.filter((candidate) => candidate.accountId !== accountId),
        });
      }),
    );

  const accountWithToken: OverleafStateStore["Service"]["accountWithToken"] = (accountId) =>
    lock.withPermits(1)(
      Effect.gen(function* () {
        const registry = yield* readRegistry();
        const account = registry.accounts.find((candidate) => candidate.accountId === accountId);
        if (!account) return yield* stateError("not_found", "The Overleaf account was not found.");
        const token = yield* secrets
          .get(account.secretRef)
          .pipe(
            Effect.mapError(() =>
              stateError("filesystem_failed", "Unable to read the Overleaf token.", true),
            ),
          );
        if (Option.isNone(token))
          return yield* stateError("authentication_failed", "The saved Overleaf token is missing.");
        return { account, token: token.value };
      }),
    );

  const markAccountValidated: OverleafStateStore["Service"]["markAccountValidated"] = (accountId) =>
    lock.withPermits(1)(
      Effect.gen(function* () {
        const registry = yield* readRegistry();
        const account = registry.accounts.find((candidate) => candidate.accountId === accountId);
        if (!account) return yield* stateError("not_found", "The Overleaf account was not found.");
        const now = yield* Clock.currentTimeMillis;
        yield* writeRegistry({
          ...registry,
          accounts: registry.accounts.map((candidate) =>
            candidate.accountId === accountId
              ? { ...candidate, credentialStatus: "saved" as const, lastValidatedAtEpochMs: now }
              : candidate,
          ),
        });
      }),
    );

  const saveConnection: OverleafStateStore["Service"]["saveConnection"] = (connection) =>
    lock.withPermits(1)(
      Effect.gen(function* () {
        const registry = yield* readRegistry();
        yield* mapFs(
          fs.makeDirectory(connectionDirectory(connection.connectionId), { recursive: true }),
          "Unable to prepare Overleaf connection state.",
        );
        yield* writeConnectionFiles(connection);
        if (!registry.connectionIds.includes(connection.connectionId))
          yield* writeRegistry({
            ...registry,
            connectionIds: [...registry.connectionIds, connection.connectionId],
          });
      }),
    );

  const createConnection: OverleafStateStore["Service"]["createConnection"] = (input) =>
    Effect.gen(function* () {
      const connection: PersistedOverleafConnection = {
        ...input,
        workspaceBaselineManifest: input.workspaceBaselineManifest ?? emptyManifest,
      };
      yield* saveConnection(connection);
      return connection;
    });

  const deleteConnection: OverleafStateStore["Service"]["deleteConnection"] = (
    connectionId,
    preserveOperationId,
  ) =>
    lock.withPermits(1)(
      Effect.gen(function* () {
        const registry = yield* readRegistry();
        if (preserveOperationId !== undefined) {
          const registered = registry.operations.find(
            (operation) =>
              operation.operationId === preserveOperationId &&
              operation.connectionId === connectionId,
          );
          if (registered === undefined)
            return yield* stateError(
              "not_found",
              "The completing Overleaf operation was not found.",
            );
          const source = operationDirectory(preserveOperationId);
          const destination = path.join(orphanOperationsRoot, preserveOperationId);
          yield* mapFs(
            fs.makeDirectory(orphanOperationsRoot, { recursive: true }),
            "Unable to retain the disconnect result.",
          );
          yield* mapFs(fs.rename(source, destination), "Unable to retain the disconnect result.");
          operationConnections.set(preserveOperationId, null);
        }
        yield* mapFs(
          fs.remove(connectionDirectory(connectionId), { recursive: true, force: true }),
          "Unable to remove Overleaf connection state.",
        );
        const removedOperations = registry.operations.filter(
          (operation) =>
            operation.connectionId === connectionId &&
            operation.operationId !== preserveOperationId,
        );
        for (const operation of removedOperations)
          operationConnections.delete(operation.operationId);
        yield* writeRegistry({
          ...registry,
          connectionIds: registry.connectionIds.filter((id) => id !== connectionId),
          operations: registry.operations
            .filter(
              (operation) =>
                operation.connectionId !== connectionId ||
                operation.operationId === preserveOperationId,
            )
            .map((operation) =>
              operation.operationId === preserveOperationId
                ? { ...operation, connectionId: null }
                : operation,
            ),
        });
      }),
    );

  const saveOperation: OverleafStateStore["Service"]["saveOperation"] = (operation) =>
    lock.withPermits(1)(
      Effect.gen(function* () {
        const registry = yield* readRegistry();
        operationConnections.set(operation.snapshot.operationId, operation.snapshot.connectionId);
        yield* mapFs(
          fs.makeDirectory(operationDirectory(operation.snapshot.operationId), { recursive: true }),
          "Unable to prepare Overleaf operation state.",
        );
        yield* writeOperationFile(operation);
        if (
          !registry.operations.some(
            (candidate) => candidate.operationId === operation.snapshot.operationId,
          )
        ) {
          yield* writeRegistry({
            ...registry,
            operations: [
              ...registry.operations,
              {
                operationId: operation.snapshot.operationId,
                connectionId: operation.snapshot.connectionId,
              },
            ],
          });
        }
      }),
    );

  const createOperation: OverleafStateStore["Service"]["createOperation"] = (
    kind,
    connectionId,
    context,
  ) =>
    Effect.gen(function* () {
      const operationId = yield* newId;
      operationConnections.set(operationId, connectionId);
      const now = yield* Clock.currentTimeMillis;
      const operation: PersistedOverleafOperation = {
        snapshot: {
          operationId,
          generation: 1,
          kind,
          connectStage: kind === "connect" ? "preflight" : null,
          connectionId,
          phase: "preparing",
          startedAtEpochMs: now,
          updatedAtEpochMs: now,
          message: "Preparing Overleaf operation…",
          review: null,
          conflicts: [],
          errorCode: null,
          retryable: false,
        },
        context,
      };
      yield* saveOperation(operation);
      return operation;
    });

  const removeOperation: OverleafStateStore["Service"]["removeOperation"] = (operationId) =>
    lock.withPermits(1)(
      Effect.gen(function* () {
        const registry = yield* readRegistry();
        yield* mapFs(
          fs.remove(operationDirectory(operationId), { recursive: true, force: true }),
          "Unable to remove Overleaf operation state.",
        );
        operationConnections.delete(operationId);
        yield* writeRegistry({
          ...registry,
          operations: registry.operations.filter(
            (operation) => operation.operationId !== operationId,
          ),
        });
      }),
    );

  return OverleafStateStore.of({
    root,
    runtimeRoot,
    newId,
    overview,
    saveAccount,
    removeAccount,
    accountWithToken,
    markAccountValidated,
    listConnections,
    getConnection: readConnection,
    saveConnection,
    createConnection,
    deleteConnection,
    getOperation: readOperation,
    saveOperation,
    createOperation,
    removeOperation,
    connectionDirectory,
    operationDirectory,
  });
});

export const layer = Layer.effect(OverleafStateStore, make());
