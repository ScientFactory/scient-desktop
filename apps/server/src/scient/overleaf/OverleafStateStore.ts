// @effect-diagnostics nodeBuiltinImport:off -- Durable replacement needs file and directory fsync.
/**
 * Private on-disk state for manual Overleaf connections, under
 * `stateDir/overleaf`:
 *
 * - `connections/<id>.json`: one document per connection, replaced durably and
 *   only by compare-and-set on its revision;
 * - `receipts/<connection>/<request>.json`: idempotency records, created once;
 * - `quarantine/`: unreadable documents moved aside with their bytes intact;
 * - `retained/<connection>/`: the applier's application directory, which holds
 *   displaced manuscript copies and must share the manuscript's volume;
 * - `lease.sqlite`: the process lease.
 *
 * Every mutation first holds the process lease, an exclusive SQLite lock held
 * for the service's lifetime. A second server process sharing this directory is
 * refused (`OverleafStateLockedError`) rather than waiting or stealing. The
 * lease is taken lazily, at the first mutation that needs it, so a process that
 * started while an older one was still exiting acquires it later instead of
 * losing writable access for its lifetime. Reads need no lease.
 */
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlError from "effect/sql/SqlError";

import * as ServerConfig from "../../config.ts";
import { makeRuntimeSqliteLayer } from "../../persistence/Sqlite.ts";
import { directoryIdentity, syncDirectory } from "../workspace/RetainedFileMutation.ts";
import {
  OverleafConnectionDocument,
  OverleafOperationReceipt,
  OverleafServerId,
  OverleafTransitionViolation,
  overleafTransitionViolation,
  OVERLEAF_CONNECTION_SCHEMA_VERSION,
} from "./OverleafConnectionState.ts";

export class OverleafStateLockedError extends Schema.TaggedError<OverleafStateLockedError>()(
  "OverleafStateLockedError",
  {},
) {
  override get message(): string {
    return "Another Scient server is using this Overleaf state.";
  }
}

export class OverleafStateIoError extends Schema.TaggedError<OverleafStateIoError>()(
  "OverleafStateIoError",
  {
    operation: Schema.Literals([
      "acquire-lease",
      "prepare-directory",
      "read",
      "list",
      "write",
      "quarantine",
      "prepare-retention",
    ]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Overleaf state ${this.operation} failed.`;
  }
}

export class OverleafConnectionExistsError extends Schema.TaggedError<OverleafConnectionExistsError>()(
  "OverleafConnectionExistsError",
  { connectionId: Schema.String },
) {
  override get message(): string {
    return "The Overleaf connection already exists.";
  }
}

export class OverleafConnectionStaleError extends Schema.TaggedError<OverleafConnectionStaleError>()(
  "OverleafConnectionStaleError",
  {
    connectionId: Schema.String,
    expectedRevision: Schema.Number,
    actualRevision: Schema.Number,
  },
) {
  override get message(): string {
    return "The Overleaf connection changed since it was read.";
  }
}

export class OverleafConnectionUnavailableError extends Schema.TaggedError<OverleafConnectionUnavailableError>()(
  "OverleafConnectionUnavailableError",
  {
    connectionId: Schema.String,
    condition: Schema.Literals(["missing", "corrupt", "unsupported", "valid"]),
  },
) {
  override get message(): string {
    return this.condition === "valid"
      ? "A readable Overleaf connection is never quarantined."
      : `The Overleaf connection is ${this.condition}.`;
  }
}

export class OverleafTransitionRejectedError extends Schema.TaggedError<OverleafTransitionRejectedError>()(
  "OverleafTransitionRejectedError",
  { connectionId: Schema.String, violation: OverleafTransitionViolation },
) {
  override get message(): string {
    return `Refused an Overleaf state change that would lose evidence (${this.violation}).`;
  }
}

export class OverleafRequestReusedError extends Schema.TaggedError<OverleafRequestReusedError>()(
  "OverleafRequestReusedError",
  { connectionId: Schema.String, requestId: Schema.String },
) {
  override get message(): string {
    return "This request ID was already used for a different request.";
  }
}

export class OverleafRecordInvalidError extends Schema.TaggedError<OverleafRecordInvalidError>()(
  "OverleafRecordInvalidError",
  { record: Schema.Literals(["connection", "receipt"]) },
) {
  override get message(): string {
    return `Refused to write an invalid Overleaf ${this.record} record.`;
  }
}

export class OverleafRetentionUnavailableError extends Schema.TaggedError<OverleafRetentionUnavailableError>()(
  "OverleafRetentionUnavailableError",
  {
    reason: Schema.Literals(["cross-volume", "inside-checkout", "unsafe-directory"]),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "cross-volume":
        return "The manuscript is on a different volume from Scient's state, so replaced files cannot be kept safely.";
      case "inside-checkout":
        return "Scient's state is inside the checkout, where checkout cleanup could erase kept files.";
      case "unsafe-directory":
        return "The folder for kept files is not a private directory owned by Scient.";
    }
  }
}

/** What is on disk for one connection. Unreadable documents are reported, never reset. */
export type OverleafConnectionRead =
  | { readonly _tag: "missing" }
  | { readonly _tag: "ready"; readonly document: OverleafConnectionDocument }
  | { readonly _tag: "corrupt" }
  | { readonly _tag: "unsupported" };

type WriteError = OverleafStateLockedError | OverleafStateIoError;

/** @public Context tag; the coordinator (contract step 2+) consumes it. */
export class OverleafStateStore extends Context.Service<
  OverleafStateStore,
  {
    readonly readConnection: (
      connectionId: string,
    ) => Effect.Effect<OverleafConnectionRead, OverleafStateIoError>;
    readonly listConnections: Effect.Effect<ReadonlyArray<string>, OverleafStateIoError>;
    readonly createConnection: (
      document: OverleafConnectionDocument,
    ) => Effect.Effect<
      void,
      WriteError | OverleafRecordInvalidError | OverleafConnectionExistsError
    >;
    /** Compare-and-set on `expectedRevision`; the next document must keep all evidence. */
    readonly replaceConnection: (input: {
      readonly expectedRevision: number;
      readonly next: OverleafConnectionDocument;
    }) => Effect.Effect<
      void,
      | WriteError
      | OverleafConnectionStaleError
      | OverleafConnectionUnavailableError
      | OverleafTransitionRejectedError
      | OverleafRecordInvalidError
    >;
    /** Moves an unreadable document aside, bytes intact; returns its quarantine name. */
    readonly quarantineConnection: (
      connectionId: string,
    ) => Effect.Effect<string, WriteError | OverleafConnectionUnavailableError>;
    /**
     * Records a request before its operation runs. A repeated request with the
     * same payload returns the existing receipt instead of running again.
     */
    readonly beginReceipt: (
      receipt: OverleafOperationReceipt,
    ) => Effect.Effect<
      | { readonly _tag: "created" }
      | { readonly _tag: "existing"; readonly receipt: OverleafOperationReceipt },
      WriteError | OverleafRecordInvalidError | OverleafRequestReusedError
    >;
    readonly finishReceipt: (input: {
      readonly connectionId: string;
      readonly requestId: string;
      readonly status: "completed" | "failed" | "unknown";
      readonly resultCategory: string;
    }) => Effect.Effect<void, WriteError | OverleafRecordInvalidError | OverleafRequestReusedError>;
    /**
     * Creates or verifies the connection's private application directory for
     * the applier. It must be on the manuscript checkout's volume and outside
     * the checkout, so checkpoint cleanup and worktree removal cannot erase it.
     */
    readonly prepareRetention: (input: {
      readonly connectionId: string;
      readonly checkoutRoot: string;
    }) => Effect.Effect<
      { readonly directory: string; readonly identity: { dev: string; ino: string } },
      WriteError | OverleafRetentionUnavailableError
    >;
  }
>()("t3/scient/overleaf/OverleafStateStore") {}

/** Fault points for tests; a hook that throws stops the write there, as a crash would. */
export interface OverleafStateStoreHooks {
  readonly at?: (
    point: "temporary-written" | "temporary-synced" | "before-publish" | "published",
    file: string,
  ) => Promise<void>;
}

const decodeConnection = Schema.decodeUnknownExit(
  Schema.fromJsonString(OverleafConnectionDocument),
);
const decodeReceipt = Schema.decodeUnknownExit(Schema.fromJsonString(OverleafOperationReceipt));
/** Documents are validated before they are written, not only when read back. */
const validateConnection = Schema.decodeUnknownExit(OverleafConnectionDocument);
const validateReceipt = Schema.decodeUnknownExit(OverleafOperationReceipt);
const encodeConnection = Schema.encodeSync(Schema.fromJsonString(OverleafConnectionDocument));
const encodeReceipt = Schema.encodeSync(Schema.fromJsonString(OverleafOperationReceipt));
const isServerId = Schema.is(OverleafServerId);

const errorCode = (error: unknown) => (error as NodeJS.ErrnoException | undefined)?.code;

/** Owner-only, non-symlink directory created by this process's user. */
async function privateDirectory(directory: string, userId: number | undefined): Promise<boolean> {
  await NodeFSP.mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await NodeFSP.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) return false;
  if (userId !== undefined && stat.uid !== userId) return false;
  if ((stat.mode & 0o077) !== 0) await NodeFSP.chmod(directory, 0o700);
  return true;
}

export const make = (options: {
  readonly root: string;
  readonly hooks?: OverleafStateStoreHooks;
}) =>
  Effect.gen(function* () {
    const userId = yield* HostProcess.UserId;
    const root = options.root;
    const connections = NodePath.join(root, "connections");
    const receipts = NodePath.join(root, "receipts");
    const quarantine = NodePath.join(root, "quarantine");
    const retained = NodePath.join(root, "retained");
    const hook = (point: Parameters<NonNullable<OverleafStateStoreHooks["at"]>>[0], file: string) =>
      options.hooks?.at?.(point, file) ?? Promise.resolve();

    const io = <A>(operation: OverleafStateIoError["operation"], run: () => Promise<A>) =>
      Effect.tryPromise({
        try: run,
        catch: (cause) => new OverleafStateIoError({ operation, cause }),
      });

    // One writer at a time inside this process; the lease excludes other processes.
    // Every mutation runs uninterruptibly while holding this permit, so an
    // interrupted caller cannot leave a filesystem write running after another
    // writer has started, and shutdown cannot release the lease mid-write.
    const writes = yield* Semaphore.make(1);
    const leasePath = NodePath.join(root, "lease.sqlite");
    let lease: {
      readonly scope: Scope.Closeable;
      readonly root: { dev: string; ino: string };
      readonly file: { dev: string; ino: string };
    } | null = null;
    const releaseLease = Effect.suspend(() => {
      const held = lease;
      lease = null;
      return held === null ? Effect.void : Scope.close(held.scope, Exit.void);
    });
    yield* Effect.addFinalizer(() => writes.withPermits(1)(releaseLease));

    const acquireLease = Effect.gen(function* () {
      yield* io("prepare-directory", async () => {
        for (const directory of [root, connections, receipts, quarantine])
          if (!(await privateDirectory(directory, userId)))
            throw new Error("Overleaf state directory is not private.");
      });
      const scope = yield* Scope.make();
      yield* Effect.gen(function* () {
        const context = yield* Layer.buildWithScope(
          makeRuntimeSqliteLayer({ filename: leasePath, busyTimeout: 0, disableWAL: true }),
          scope,
        );
        const sql = Context.get(context, SqlClient.SqlClient);
        yield* sql`PRAGMA busy_timeout = 0`;
        // The first write takes an exclusive lock that this connection keeps
        // until it closes. The kernel releases it if the process dies.
        yield* sql`PRAGMA locking_mode = EXCLUSIVE`;
        yield* sql`CREATE TABLE IF NOT EXISTS overleaf_lease (id INTEGER PRIMARY KEY CHECK (id = 1), acquired_at INTEGER NOT NULL)`;
        const now = yield* Clock.currentTimeMillis;
        yield* sql`INSERT OR REPLACE INTO overleaf_lease (id, acquired_at) VALUES (1, ${now})`;
      }).pipe(
        Effect.onError((cause) => Scope.close(scope, Exit.failCause(cause))),
        Effect.mapError((error) =>
          SqlError.isSqlError(error) && error.reason._tag === "LockTimeoutError"
            ? new OverleafStateLockedError()
            : new OverleafStateIoError({ operation: "acquire-lease", cause: error }),
        ),
      );
      const identities = yield* io("acquire-lease", async () => {
        await NodeFSP.chmod(leasePath, 0o600);
        return { root: await directoryIdentity(root), file: await leaseFileIdentity() };
      }).pipe(Effect.onError(() => Scope.close(scope, Exit.void)));
      lease = { scope, ...identities };
      // Only this process writes here now: temporaries from a dead writer are orphans.
      yield* io("prepare-directory", async () => {
        for (const directory of [connections, receipts]) {
          const entries = await NodeFSP.readdir(directory, { recursive: true });
          for (const entry of entries)
            if (NodePath.basename(entry).endsWith(".tmp"))
              await NodeFSP.rm(NodePath.join(directory, entry), { force: true });
        }
      });
    });
    const leaseFileIdentity = async () => {
      const stat = await NodeFSP.lstat(leasePath, { bigint: true });
      if (!stat.isFile()) throw new Error("Overleaf lease is not a regular file.");
      return { dev: String(stat.dev), ino: String(stat.ino) };
    };
    /**
     * The lock protects the file this connection opened. If that file or the
     * state root was replaced, another process may lock the replacement, so the
     * old lease is dropped and the lock is taken again on what is there now.
     * A replacement between this check and the write that follows is not
     * detected; that window is the boundary of this protection.
     */
    const ensureLease = Effect.gen(function* () {
      const held = lease;
      if (held !== null) {
        const current = yield* Effect.promise(async () => {
          try {
            return { root: await directoryIdentity(root), file: await leaseFileIdentity() };
          } catch {
            return null;
          }
        });
        if (
          current !== null &&
          current.root.dev === held.root.dev &&
          current.root.ino === held.root.ino &&
          current.file.dev === held.file.dev &&
          current.file.ino === held.file.ino
        )
          return;
        yield* releaseLease;
      }
      yield* acquireLease;
    });
    const withLease = <A, E>(effect: Effect.Effect<A, E>) =>
      writes.withPermits(1)(Effect.uninterruptible(ensureLease.pipe(Effect.andThen(effect))));

    /** Writes a complete, synced temporary next to `file`. */
    const writeTemporary = async (file: string, contents: string) => {
      const temporary = NodePath.join(
        NodePath.dirname(file),
        `.${NodePath.basename(file)}.${NodeCrypto.randomUUID()}.tmp`,
      );
      const handle = await NodeFSP.open(temporary, "wx", 0o600);
      try {
        await handle.writeFile(contents);
        await hook("temporary-written", file);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await hook("temporary-synced", file);
      return temporary;
    };
    /** Replaces `file` atomically, then makes the rename durable. */
    const replaceDurably = async (file: string, contents: string) => {
      const temporary = await writeTemporary(file, contents);
      try {
        await hook("before-publish", file);
        await NodeFSP.rename(temporary, file);
      } catch (error) {
        // A temporary left by a crash is removed at the next lease acquisition.
        await NodeFSP.rm(temporary, { force: true });
        throw error;
      }
      await hook("published", file);
      await syncDirectory(NodePath.dirname(file));
    };
    /** Publishes `file` only if nothing exists there yet. */
    const createDurably = async (file: string, contents: string): Promise<boolean> => {
      const temporary = await writeTemporary(file, contents);
      try {
        await hook("before-publish", file);
        await NodeFSP.link(temporary, file);
      } catch (error) {
        if (errorCode(error) === "EEXIST") return false;
        throw error;
      } finally {
        await NodeFSP.rm(temporary, { force: true });
      }
      await hook("published", file);
      await syncDirectory(NodePath.dirname(file));
      return true;
    };

    const connectionFile = (connectionId: string) => {
      if (!isServerId(connectionId)) throw new Error("Invalid connection id.");
      return NodePath.join(connections, `${connectionId}.json`);
    };
    const receiptFile = (connectionId: string, requestId: string) => {
      if (!isServerId(connectionId) || !isServerId(requestId)) throw new Error("Invalid id.");
      return NodePath.join(receipts, connectionId, `${requestId}.json`);
    };

    const readConnection: OverleafStateStore["Service"]["readConnection"] = (connectionId) =>
      io("read", async (): Promise<OverleafConnectionRead> => {
        let text: string;
        try {
          text = await NodeFSP.readFile(connectionFile(connectionId), "utf8");
        } catch (error) {
          if (errorCode(error) === "ENOENT") return { _tag: "missing" };
          throw error;
        }
        const decoded = decodeConnection(text);
        if (Exit.isSuccess(decoded)) {
          // A document filed under another name is not this connection's state.
          if (decoded.value.connectionId !== connectionId) return { _tag: "corrupt" };
          return { _tag: "ready", document: decoded.value };
        }
        let version: unknown;
        try {
          version = (JSON.parse(text) as { schemaVersion?: unknown } | null)?.schemaVersion;
        } catch {
          return { _tag: "corrupt" };
        }
        return typeof version === "number" && version !== OVERLEAF_CONNECTION_SCHEMA_VERSION
          ? { _tag: "unsupported" }
          : { _tag: "corrupt" };
      });

    const listConnections: OverleafStateStore["Service"]["listConnections"] = io(
      "list",
      async () => {
        const entries = await NodeFSP.readdir(connections).catch((error: unknown) => {
          if (errorCode(error) === "ENOENT") return [];
          throw error;
        });
        return entries
          .filter((entry) => entry.endsWith(".json") && !entry.startsWith("."))
          .map((entry) => entry.slice(0, -".json".length))
          .filter((id) => isServerId(id))
          .sort();
      },
    );

    const requireValid = (record: "connection" | "receipt", value: unknown) =>
      (
        record === "connection"
          ? Exit.isSuccess(validateConnection(value))
          : Exit.isSuccess(validateReceipt(value))
      )
        ? Effect.void
        : Effect.fail(new OverleafRecordInvalidError({ record }));

    const createConnection: OverleafStateStore["Service"]["createConnection"] = (document) =>
      withLease(
        Effect.gen(function* () {
          yield* requireValid("connection", document);
          const created = yield* io("write", () =>
            createDurably(connectionFile(document.connectionId), encodeConnection(document)),
          );
          if (!created)
            return yield* new OverleafConnectionExistsError({
              connectionId: document.connectionId,
            });
        }),
      );

    const replaceConnection: OverleafStateStore["Service"]["replaceConnection"] = (input) =>
      withLease(
        Effect.gen(function* () {
          const connectionId = input.next.connectionId;
          yield* requireValid("connection", input.next);
          const current = yield* readConnection(connectionId);
          if (current._tag !== "ready")
            return yield* new OverleafConnectionUnavailableError({
              connectionId,
              condition: current._tag,
            });
          if (current.document.revision !== input.expectedRevision)
            return yield* new OverleafConnectionStaleError({
              connectionId,
              expectedRevision: input.expectedRevision,
              actualRevision: current.document.revision,
            });
          const now = yield* Clock.currentTimeMillis;
          const violation = overleafTransitionViolation(current.document, input.next, now);
          if (violation !== null)
            return yield* new OverleafTransitionRejectedError({ connectionId, violation });
          yield* io("write", () =>
            replaceDurably(connectionFile(connectionId), encodeConnection(input.next)),
          );
        }),
      );

    const quarantineConnection: OverleafStateStore["Service"]["quarantineConnection"] = (
      connectionId,
    ) =>
      withLease(
        Effect.gen(function* () {
          const current = yield* readConnection(connectionId);
          if (current._tag === "ready" || current._tag === "missing")
            return yield* new OverleafConnectionUnavailableError({
              connectionId,
              condition: current._tag === "ready" ? "valid" : "missing",
            });
          const now = yield* Clock.currentTimeMillis;
          return yield* io("quarantine", async () => {
            const name = `${connectionId}.${now}.${NodeCrypto.randomUUID()}.json`;
            await NodeFSP.rename(connectionFile(connectionId), NodePath.join(quarantine, name));
            await syncDirectory(quarantine);
            await syncDirectory(connections);
            return name;
          });
        }),
      );

    const readReceipt = (file: string) =>
      io("read", async () => {
        const decoded = decodeReceipt(await NodeFSP.readFile(file, "utf8"));
        if (Exit.isFailure(decoded)) throw new Error("Unreadable Overleaf request receipt.");
        return decoded.value;
      });

    const beginReceipt: OverleafStateStore["Service"]["beginReceipt"] = (receipt) =>
      withLease(
        Effect.gen(function* () {
          yield* requireValid("receipt", receipt);
          const file = yield* io("write", async () => {
            const file = receiptFile(receipt.connectionId, receipt.requestId);
            if (!(await privateDirectory(NodePath.dirname(file), userId)))
              throw new Error("Overleaf receipt directory is not private.");
            return file;
          });
          const created = yield* io("write", () => createDurably(file, encodeReceipt(receipt)));
          if (created) return { _tag: "created" as const };
          const existing = yield* readReceipt(file);
          if (existing.kind !== receipt.kind || existing.payloadDigest !== receipt.payloadDigest)
            return yield* new OverleafRequestReusedError({
              connectionId: receipt.connectionId,
              requestId: receipt.requestId,
            });
          return { _tag: "existing" as const, receipt: existing };
        }),
      );

    const finishReceipt: OverleafStateStore["Service"]["finishReceipt"] = (input) =>
      withLease(
        Effect.gen(function* () {
          const file = yield* io("write", async () =>
            receiptFile(input.connectionId, input.requestId),
          );
          const existing = yield* readReceipt(file);
          // A terminal receipt is final; a second terminal status cannot replace it.
          if (existing.status !== "running") {
            if (
              existing.status === input.status &&
              existing.resultCategory === input.resultCategory
            )
              return;
            return yield* new OverleafRequestReusedError({
              connectionId: input.connectionId,
              requestId: input.requestId,
            });
          }
          const finished: OverleafOperationReceipt = {
            ...existing,
            status: input.status,
            resultCategory: input.resultCategory,
            updatedAt: DateTime.formatIso(yield* DateTime.now),
          };
          yield* requireValid("receipt", finished);
          yield* io("write", () => replaceDurably(file, encodeReceipt(finished)));
        }),
      );

    const prepareRetention: OverleafStateStore["Service"]["prepareRetention"] = (input) =>
      withLease(
        Effect.gen(function* () {
          const checked = yield* io("prepare-retention", async () => {
            if (!isServerId(input.connectionId)) throw new Error("Invalid connection id.");
            const directory = NodePath.join(retained, input.connectionId);
            if (
              !(await privateDirectory(retained, userId)) ||
              !(await privateDirectory(directory, userId))
            )
              return "unsafe-directory" as const;
            const realDirectory = await NodeFSP.realpath(directory);
            const realCheckout = await NodeFSP.realpath(input.checkoutRoot);
            if (
              realDirectory === realCheckout ||
              realDirectory.startsWith(`${realCheckout}${NodePath.sep}`)
            )
              return "inside-checkout" as const;
            const [vault, checkout] = await Promise.all([
              NodeFSP.stat(realDirectory, { bigint: true }),
              NodeFSP.stat(realCheckout, { bigint: true }),
            ]);
            if (vault.dev !== checkout.dev) return "cross-volume" as const;
            return { directory: realDirectory, identity: await directoryIdentity(realDirectory) };
          });
          if (typeof checked === "string")
            return yield* new OverleafRetentionUnavailableError({ reason: checked });
          return checked;
        }),
      );

    return OverleafStateStore.of({
      readConnection,
      listConnections,
      createConnection,
      replaceConnection,
      quarantineConnection,
      beginReceipt,
      finishReceipt,
      prepareRetention,
    });
  });

/** @public Service construction is part of the canonical Effect module API. */
export const layer = Layer.effect(
  OverleafStateStore,
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    return yield* make({ root: NodePath.join(config.stateDir, "overleaf") });
  }),
);
