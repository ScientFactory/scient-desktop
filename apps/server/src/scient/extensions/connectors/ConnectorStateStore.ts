// @effect-diagnostics nodeBuiltinImport:off -- This store owns its app-private state file.
/**
 * Preserve undecodable entries verbatim and refuse mutations when the file cannot load, rather than
 * overwriting recoverable state. Migrate format 1 to 2 atomically on load.
 */
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import {
  ConnectorId,
  ConnectorServerName,
  ConnectorSource,
  ConnectorStatus,
  CredentialStrategy,
  ExtensionsError,
  type ExtensionsDiagnostic,
  GrantScope,
  IsoDateTime,
  NonNegativeInt,
  ProjectId,
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
/** The reader refuses a larger file, so no write may produce one. */
export const MAX_STATE_BYTES = 4 * 1024 * 1024;

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
    storage: Schema.Literals(["owned", "bound"]),
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
  /** Credential generation (see `ConnectorSummary.authRevision`); absent in older records. */
  authRevision: NonNegativeInt.pipe(Schema.withDecodingDefault(Effect.succeed(0))),
  /** Projects whose sessions receive this connector; an empty list means none. */
  availability: GrantScope,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  lastError: Schema.optional(TrimmedNonEmptyString),
});
export type ConnectorRecord = typeof ConnectorRecord.Type;

const STATE_FORMAT_VERSION = 2;

const PersistedFile = Schema.Struct({
  formatVersion: Schema.Literal(STATE_FORMAT_VERSION),
  connectors: Schema.Array(Schema.Unknown),
});
/** Format 1: `projectPolicy` on each connector plus per-project selection records. */
const PersistedFileV1 = Schema.Struct({
  formatVersion: Schema.Literal(1),
  connectors: Schema.Array(Schema.Unknown),
  projectSelections: Schema.Array(Schema.Unknown),
});
type PersistedFileV1 = typeof PersistedFileV1.Type;
const LegacySelection = Schema.Struct({
  connectorId: Schema.String,
  projectId: ProjectId,
  enabled: Schema.Boolean,
});
const decodeFile = Schema.decodeUnknownExit(
  Schema.fromJsonString(Schema.Union([PersistedFile, PersistedFileV1])),
);
const decodeRecord = Schema.decodeUnknownExit(ConnectorRecord);
const decodeLegacySelection = Schema.decodeUnknownExit(LegacySelection);
const encodeRecord = Schema.encodeSync(ConnectorRecord);

/**
 * Format 1 → 2. `all-projects` stays all projects; `selected-projects` becomes
 * the projects whose selection was enabled (deduplicated, in file order). The
 * selection records are dropped. An entry with an unknown policy is kept
 * verbatim and stays unreadable.
 */
const migrateV1Connectors = (file: PersistedFileV1): ReadonlyArray<unknown> => {
  const selected = new Map<string, ProjectId[]>();
  for (const entry of file.projectSelections) {
    const selection = decodeLegacySelection(entry);
    if (Exit.isFailure(selection) || !selection.value.enabled) continue;
    const { connectorId, projectId } = selection.value;
    const projectIds = selected.get(connectorId) ?? [];
    if (!projectIds.includes(projectId)) projectIds.push(projectId);
    selected.set(connectorId, projectIds);
  }
  return file.connectors.map((entry) => {
    if (typeof entry !== "object" || entry === null || !("projectPolicy" in entry)) return entry;
    const connectorId = "connectorId" in entry ? String(entry.connectorId) : "";
    const availability: GrantScope | undefined =
      entry.projectPolicy === "all-projects"
        ? { type: "all-projects" }
        : entry.projectPolicy === "selected-projects"
          ? { type: "projects", projectIds: selected.get(connectorId) ?? [] }
          : undefined;
    if (availability === undefined) return entry;
    return {
      ...Object.fromEntries(Object.entries(entry).filter(([key]) => key !== "projectPolicy")),
      availability,
    };
  });
};

export interface ConnectorStateData {
  readonly connectors: ReadonlyArray<ConnectorRecord>;
}

export interface ConnectorStateSnapshot extends ConnectorStateData {
  readonly diagnostics: ReadonlyArray<ExtensionsDiagnostic>;
  /** False when the file could not be loaded; it is then never written. */
  readonly writable: boolean;
}

interface LoadedState extends ConnectorStateSnapshot {
  readonly unreadableConnectors: ReadonlyArray<unknown>;
  /** Loaded from an older format; saved in the current one right after loading. */
  readonly migrated: boolean;
}

export interface ConnectorStateStore {
  readonly read: Effect.Effect<ConnectorStateSnapshot>;
  /**
   * Serialized read-modify-write. The transform returns its result and the next
   * data; the data is persisted before the in-memory state changes. Returning
   * the given data unchanged (the same object) saves nothing.
   */
  readonly update: <A, E>(
    transform: (current: ConnectorStateData) => Effect.Effect<readonly [A, ConnectorStateData], E>,
  ) => Effect.Effect<A, E | ExtensionsError>;
}

const isNodeError = (error: unknown, code: string): error is NodeJS.ErrnoException =>
  error instanceof Error && "code" in error && error.code === code;

const unloadable = (message: string): LoadedState => ({
  connectors: [],
  unreadableConnectors: [],
  migrated: false,
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
        unreadableConnectors: [],
        migrated: false,
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
  const migrated = decoded.value.formatVersion === 1;
  const entries =
    decoded.value.formatVersion === 1
      ? migrateV1Connectors(decoded.value)
      : decoded.value.connectors;
  const connectors: ConnectorRecord[] = [];
  const unreadableConnectors: unknown[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
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
  return withDiagnostics({
    connectors,
    unreadableConnectors,
    migrated,
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

/** The complete file text for `state`, preserved entries included. */
const encodeState = (state: LoadedState): string =>
  `${JSON.stringify(
    {
      formatVersion: STATE_FORMAT_VERSION,
      connectors: [
        ...state.connectors.map((record) => encodeRecord(record)),
        ...state.unreadableConnectors,
      ],
    },
    null,
    2,
  )}\n`;

const fitsStateLimit = (text: string) => Buffer.byteLength(text, "utf8") <= MAX_STATE_BYTES;

export const writeExtensionState = async (
  statePath: string,
  text: string,
  platform: NodeJS.Platform,
) => {
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
  const loaded = yield* Effect.promise(() => loadState(statePath));
  if (!loaded.writable) {
    yield* Effect.logWarning("connected services state could not be loaded", {
      path: statePath,
    });
  }
  // A migrated file is saved in the current format at once, so the old
  // selection records are gone. If that fails, or the rewrite would exceed
  // the size limit, the old file stays and the next change saves it.
  const migratedText = loaded.migrated ? encodeState(loaded) : undefined;
  const initial =
    migratedText === undefined
      ? loaded
      : !fitsStateLimit(migratedText)
        ? yield* Effect.logWarning(
            "migrated connected services exceed the state size limit; the file was left unchanged",
            { path: statePath },
          ).pipe(Effect.as(loaded))
        : yield* Effect.tryPromise(() =>
            writeExtensionState(statePath, migratedText, platform),
          ).pipe(
            Effect.as({ ...loaded, migrated: false }),
            Effect.catch(() =>
              Effect.logWarning("migrated connected services could not be saved yet", {
                path: statePath,
              }).pipe(Effect.as(loaded)),
            ),
          );
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
          // The transform handed back the current state: nothing to save.
          if (next === current) return result;
          // A removed id takes its preserved duplicates with it, so none of
          // them can become live after a restart.
          const remaining = new Set(next.connectors.map((record) => record.connectorId));
          const removed = new Set<string>(
            current.connectors
              .map((record) => record.connectorId)
              .filter((connectorId) => !remaining.has(connectorId)),
          );
          const nextState = withDiagnostics({
            ...current,
            connectors: next.connectors,
            unreadableConnectors: current.unreadableConnectors.filter(
              (entry) => !removed.has(String(preservedConnectorId(entry))),
            ),
            migrated: false,
          });
          // Checked before anything changes, so the previous state survives.
          const text = encodeState(nextState);
          if (!fitsStateLimit(text)) {
            return yield* new ExtensionsError({
              reason: "limit-reached",
              message: `Connected services would exceed ${MAX_STATE_BYTES / (1024 * 1024)} MiB of saved state. Shorten names or descriptions, or remove a service.`,
            });
          }
          yield* Effect.tryPromise({
            try: () => writeExtensionState(statePath, text, platform),
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
