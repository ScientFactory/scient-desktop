// @effect-diagnostics nodeBuiltinImport:off -- This store owns its app-private state file.
/**
 * `<stateDir>/scient-extensions.json`: connector records and per-project
 * selections. Versioned; written atomically (temporary file + rename).
 * Entries that do not decode are preserved verbatim and written back, and a
 * file that cannot be loaded is never overwritten: mutations fail instead.
 */
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import {
  ConnectorId,
  ConnectorProjectPolicy,
  ConnectorProjectSelection,
  ConnectorServerName,
  ConnectorSource,
  ConnectorStatus,
  CredentialStrategy,
  ExtensionsError,
  type ExtensionsDiagnostic,
  IsoDateTime,
  TrimmedNonEmptyString,
  VaultSecretRef,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

export const CONNECTOR_STATE_FILE = "scient-extensions.json";
const MAX_STATE_BYTES = 4 * 1024 * 1024;

export const ConnectorAuthRecord = Schema.Union([
  Schema.Struct({ type: Schema.Literal("none") }),
  Schema.Struct({
    type: Schema.Literal("oauth"),
    /** Tokens and client registrations; absent until a client or sign-in exists. */
    credentialRef: Schema.optional(VaultSecretRef),
    usesOwnClient: Schema.Boolean,
    issuer: Schema.optional(TrimmedNonEmptyString),
    scopes: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
  }),
  Schema.Struct({
    type: Schema.Literal("credential"),
    strategy: CredentialStrategy,
    headerName: Schema.optional(TrimmedNonEmptyString),
    storage: Schema.Literal("owned"),
    credentialRef: VaultSecretRef,
  }),
]);
export type ConnectorAuthRecord = typeof ConnectorAuthRecord.Type;

export const ConnectorRecord = Schema.Struct({
  connectorId: ConnectorId,
  serverName: ConnectorServerName,
  displayName: TrimmedNonEmptyString,
  description: Schema.optional(TrimmedNonEmptyString),
  url: TrimmedNonEmptyString,
  source: ConnectorSource,
  auth: ConnectorAuthRecord,
  status: ConnectorStatus,
  enabled: Schema.Boolean,
  projectPolicy: ConnectorProjectPolicy,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  lastError: Schema.optional(TrimmedNonEmptyString),
});
export type ConnectorRecord = typeof ConnectorRecord.Type;

const PersistedFile = Schema.Struct({
  formatVersion: Schema.Literal(1),
  connectors: Schema.Array(Schema.Unknown),
  projectSelections: Schema.Array(Schema.Unknown),
});
const decodeFile = Schema.decodeUnknownExit(Schema.fromJsonString(PersistedFile));
const decodeRecord = Schema.decodeUnknownExit(ConnectorRecord);
const decodeSelection = Schema.decodeUnknownExit(ConnectorProjectSelection);
const encodeRecord = Schema.encodeSync(ConnectorRecord);
const encodeSelection = Schema.encodeSync(ConnectorProjectSelection);

export interface ConnectorStateData {
  readonly connectors: ReadonlyArray<ConnectorRecord>;
  readonly selections: ReadonlyArray<ConnectorProjectSelection>;
}

export interface ConnectorStateSnapshot extends ConnectorStateData {
  readonly diagnostics: ReadonlyArray<ExtensionsDiagnostic>;
  /** False when the file could not be loaded; it is then never written. */
  readonly writable: boolean;
}

interface LoadedState extends ConnectorStateSnapshot {
  readonly unreadableConnectors: ReadonlyArray<unknown>;
  readonly unreadableSelections: ReadonlyArray<unknown>;
}

export interface ConnectorStateStore {
  readonly read: Effect.Effect<ConnectorStateSnapshot>;
  /**
   * Serialized read-modify-write. The transform returns its result and the next
   * data; the data is persisted before the in-memory state changes.
   */
  readonly update: <A, E>(
    transform: (current: ConnectorStateData) => Effect.Effect<readonly [A, ConnectorStateData], E>,
  ) => Effect.Effect<A, E | ExtensionsError>;
}

const isNodeError = (error: unknown, code: string): error is NodeJS.ErrnoException =>
  error instanceof Error && "code" in error && error.code === code;

const unloadable = (message: string): LoadedState => ({
  connectors: [],
  selections: [],
  unreadableConnectors: [],
  unreadableSelections: [],
  diagnostics: [{ code: "state-unreadable", message }],
  writable: false,
});

const loadState = async (statePath: string): Promise<LoadedState> => {
  let stat;
  try {
    stat = await NodeFSP.lstat(statePath);
  } catch (error) {
    if (isNodeError(error, "ENOENT")) {
      return {
        connectors: [],
        selections: [],
        unreadableConnectors: [],
        unreadableSelections: [],
        diagnostics: [],
        writable: true,
      };
    }
    return unloadable("Connected services could not be read. The file was left unchanged.");
  }
  if (!stat.isFile() || stat.size > MAX_STATE_BYTES) {
    return unloadable(
      `${CONNECTOR_STATE_FILE} is not a regular file of at most 4 MiB. It was left unchanged.`,
    );
  }
  let text: string;
  try {
    text = await NodeFSP.readFile(statePath, "utf8");
  } catch {
    return unloadable("Connected services could not be read. The file was left unchanged.");
  }
  const decoded = decodeFile(text);
  if (Exit.isFailure(decoded)) {
    return unloadable(
      `${CONNECTOR_STATE_FILE} is unreadable or was written by a newer Scient. It was left unchanged; connected services cannot be changed until it is repaired.`,
    );
  }
  const connectors: ConnectorRecord[] = [];
  const unreadableConnectors: unknown[] = [];
  const seen = new Set<string>();
  for (const entry of decoded.value.connectors) {
    const record = decodeRecord(entry);
    if (Exit.isSuccess(record) && !seen.has(record.value.connectorId)) {
      seen.add(record.value.connectorId);
      connectors.push(record.value);
      continue;
    }
    // Undecodable entries and duplicates of a live id are kept verbatim but
    // never become live; removing that id purges them too (see `update`).
    unreadableConnectors.push(entry);
  }
  const selections: ConnectorProjectSelection[] = [];
  const unreadableSelections: unknown[] = [];
  for (const entry of decoded.value.projectSelections) {
    const selection = decodeSelection(entry);
    if (Exit.isSuccess(selection)) selections.push(selection.value);
    else unreadableSelections.push(entry);
  }
  return withDiagnostics({
    connectors,
    selections,
    unreadableConnectors,
    unreadableSelections,
    diagnostics: [],
    writable: true,
  });
};

const withDiagnostics = (state: LoadedState): LoadedState => ({
  ...state,
  diagnostics: state.unreadableConnectors.map((): ExtensionsDiagnostic => ({
    code: "connector-record-unreadable",
    message: "A connected service entry could not be read. It is kept unchanged in the file.",
  })),
});

/** The `connectorId` a preserved entry claims, if it names one. */
const preservedConnectorId = (entry: unknown): unknown =>
  typeof entry === "object" && entry !== null && "connectorId" in entry
    ? entry.connectorId
    : undefined;

/** Durably replaces the file: data and directory entry are synced before success. */

const writeState = async (statePath: string, state: LoadedState, platform: NodeJS.Platform) => {
  const text = `${JSON.stringify(
    {
      formatVersion: 1,
      connectors: [
        ...state.connectors.map((record) => encodeRecord(record)),
        ...state.unreadableConnectors,
      ],
      projectSelections: [
        ...state.selections.map((selection) => encodeSelection(selection)),
        ...state.unreadableSelections,
      ],
    },
    null,
    2,
  )}\n`;
  await NodeFSP.mkdir(NodePath.dirname(statePath), { recursive: true });
  const temporaryPath = `${statePath}.${NodeCrypto.randomUUID()}.tmp`;
  try {
    const file = await NodeFSP.open(temporaryPath, "wx", 0o600);
    try {
      await file.writeFile(text, "utf8");
      await file.sync();
    } finally {
      await file.close();
    }
    await NodeFSP.rename(temporaryPath, statePath);
  } finally {
    await NodeFSP.rm(temporaryPath, { force: true });
  }
  await syncDirectory(NodePath.dirname(statePath), platform);
};

/** Only a platform that cannot open or sync a directory (Windows) skips the sync. */
const directorySyncUnsupported = (error: unknown, platform: NodeJS.Platform) =>
  isNodeError(error, "EINVAL") ||
  isNodeError(error, "ENOTSUP") ||
  isNodeError(error, "EISDIR") ||
  (platform === "win32" && isNodeError(error, "EPERM"));

/** Persists the rename itself; real sync failures fail the commit. */
const syncDirectory = async (directory: string, platform: NodeJS.Platform) => {
  let handle: NodeFSP.FileHandle;
  try {
    handle = await NodeFSP.open(directory, "r");
  } catch (error) {
    if (directorySyncUnsupported(error, platform)) return;
    throw error;
  }
  try {
    await handle.sync();
  } catch (error) {
    if (!directorySyncUnsupported(error, platform)) throw error;
  } finally {
    await handle.close();
  }
};

export const makeConnectorStateStore = Effect.fn("ConnectorStateStore.make")(function* (
  stateDir: string,
) {
  const statePath = NodePath.join(stateDir, CONNECTOR_STATE_FILE);
  const platform = yield* HostProcess.Platform;
  const initial = yield* Effect.promise(() => loadState(statePath));
  if (!initial.writable) {
    yield* Effect.logWarning("connected services state could not be loaded", {
      path: statePath,
    });
  }
  const state = yield* Ref.make(initial);
  const writePermit = yield* Semaphore.make(1);

  const store: ConnectorStateStore = {
    read: Ref.get(state),
    update: (transform) =>
      writePermit.withPermits(1)(
        Effect.gen(function* () {
          const current = yield* Ref.get(state);
          if (!current.writable) {
            return yield* new ExtensionsError({
              reason: "state-unavailable",
              message: `${CONNECTOR_STATE_FILE} could not be loaded, so connected services cannot be changed. Repair or move the file and restart Scient.`,
            });
          }
          const [result, next] = yield* transform(current);
          // A removed id takes its preserved duplicates and selections with it,
          // so none of them can become live after a restart.
          const remaining = new Set(next.connectors.map((record) => record.connectorId));
          const removed = new Set<string>(
            current.connectors
              .map((record) => record.connectorId)
              .filter((connectorId) => !remaining.has(connectorId)),
          );
          const nextState = withDiagnostics({
            ...current,
            connectors: next.connectors,
            selections: next.selections,
            unreadableConnectors: current.unreadableConnectors.filter(
              (entry) => !removed.has(String(preservedConnectorId(entry))),
            ),
            unreadableSelections: current.unreadableSelections.filter(
              (entry) => !removed.has(String(preservedConnectorId(entry))),
            ),
          });
          yield* Effect.tryPromise({
            try: () => writeState(statePath, nextState, platform),
            catch: () =>
              new ExtensionsError({
                reason: "state-unavailable",
                message: "Connected services could not be saved.",
              }),
          });
          yield* Ref.set(state, nextState);
          return result;
        }),
      ),
  };
  return store;
});
