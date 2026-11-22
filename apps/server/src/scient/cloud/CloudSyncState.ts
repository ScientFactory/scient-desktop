/**
 * This computer's cloud copy state in `<stateDir>/scient/cloud-sync/state.json`, kept beside the
 * database so no upstream migration is needed. It is also the lease guard's source: a thread
 * another computer continued is listed in `moved` and takes no new turns here.
 */
import { EnvironmentId, IsoDateTime, NonNegativeInt, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import * as ServerConfig from "../../config.ts";

import { scientCloudLive } from "./availability.ts";

export const CopiedThread = Schema.Struct({
  contentDigest: Schema.String,
  title: Schema.String,
  archived: Schema.Boolean,
  uploadedAt: IsoDateTime,
  bytes: NonNegativeInt,
  /** The shell's `updatedAt` this copy reflects; startup reconcile compares it. */
  sourceUpdatedAt: IsoDateTime,
});
export type CopiedThread = typeof CopiedThread.Type;

export const MovedThread = Schema.Struct({
  movedTo: EnvironmentId,
  movedAt: IsoDateTime,
});
export type MovedThread = typeof MovedThread.Type;

export const CloudSyncStateDocument = Schema.Struct({
  version: Schema.Literal(1),
  /** The cloud account this computer is enrolled with; null when not enrolled. */
  userId: Schema.NullOr(Schema.String),
  cloudUrl: Schema.NullOr(Schema.String),
  threads: Schema.Record(ThreadId, CopiedThread),
  /** Too large to copy even without the work log, at this digest. */
  skipped: Schema.Record(ThreadId, Schema.String),
  moved: Schema.Record(ThreadId, MovedThread),
  /** Threads this computer imported by taking over, and their source. */
  continuedFrom: Schema.Record(
    ThreadId,
    Schema.Struct({ env: EnvironmentId, thread: ThreadId, generation: NonNegativeInt }),
  ),
  movedCursor: Schema.NullOr(IsoDateTime),
});
export type CloudSyncStateDocument = typeof CloudSyncStateDocument.Type;

export const emptyCloudSyncState: CloudSyncStateDocument = {
  version: 1,
  userId: null,
  cloudUrl: null,
  threads: {},
  skipped: {},
  moved: {},
  continuedFrom: {},
  movedCursor: null,
};

const StateJson = Schema.fromJsonString(CloudSyncStateDocument);
const decodeState = Schema.decodeUnknownEffect(StateJson);
const encodeState = Schema.encodeEffect(StateJson);

export class CloudSyncState extends Context.Service<
  CloudSyncState,
  {
    readonly get: Effect.Effect<CloudSyncStateDocument>;
    /** Applies `change` and persists the result; writes are serialized. */
    readonly update: (
      change: (state: CloudSyncStateDocument) => CloudSyncStateDocument,
    ) => Effect.Effect<CloudSyncStateDocument>;
  }
>()("t3/scient/cloud/CloudSyncState") {}

/**
 * Turn admission asks this before a new turn starts. Present only where the cloud state is
 * mounted, so orchestration without it admits every turn.
 */
export class CloudLeaseGuard extends Context.Service<
  CloudLeaseGuard,
  { readonly movedTo: (threadId: ThreadId) => Effect.Effect<MovedThread | undefined> }
>()("t3/scient/cloud/CloudSyncState/CloudLeaseGuard") {}

const makeInMemory = Effect.fn("CloudSyncState.makeInMemory")(function* (
  initial: CloudSyncStateDocument = emptyCloudSyncState,
) {
  let state = initial;
  const lock = yield* Semaphore.make(1);
  return CloudSyncState.of({
    get: Effect.sync(() => state),
    update: Effect.fn("CloudSyncState.update")((change) =>
      lock.withPermits(1)(
        Effect.sync(() => {
          state = change(state);
          return state;
        }),
      ),
    ),
  });
});

const makeFile = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = path.join(config.stateDir, "scient", "cloud-sync");
  const file = path.join(directory, "state.json");
  const initial = yield* fileSystem.readFileString(file).pipe(
    Effect.flatMap(decodeState),
    Effect.catchCause((cause) =>
      fileSystem.exists(file).pipe(
        Effect.orElseSucceed(() => false),
        Effect.tap((exists) =>
          exists
            ? Effect.logWarning("Cloud copy state could not be read; starting over.", { cause })
            : Effect.void,
        ),
        Effect.as(emptyCloudSyncState),
      ),
    ),
  );
  let state = initial;
  const lock = yield* Semaphore.make(1);
  const persist = Effect.fn("CloudSyncState.persist")(
    function* (next: CloudSyncStateDocument) {
      const text = yield* encodeState(next);
      yield* fileSystem.makeDirectory(directory, { recursive: true });
      const partial = `${file}.partial`;
      yield* fileSystem.writeFileString(partial, text);
      yield* fileSystem.rename(partial, file);
    },
    Effect.catchCause((cause) => Effect.logWarning("Cloud copy state was not saved.", { cause })),
  );
  return CloudSyncState.of({
    get: Effect.sync(() => state),
    update: Effect.fn("CloudSyncState.update")((change) =>
      lock.withPermits(1)(
        Effect.gen(function* () {
          const next = change(state);
          if (next === state) return state;
          state = next;
          yield* persist(next);
          return next;
        }),
      ),
    ),
  });
});

const guardFrom = (store: CloudSyncState["Service"], live = true) =>
  CloudLeaseGuard.of({
    movedTo: Effect.fn("CloudLeaseGuard.movedTo")((threadId) =>
      live ? store.get.pipe(Effect.map((state) => state.moved[threadId])) : Effect.undefined,
    ),
  });

/** One file-backed state shared by the sync worker, the HTTP routes and turn admission. */
export const layer = Layer.effectContext(
  Effect.gen(function* () {
    const store = yield* makeFile;
    // Without Scient Cloud, no conversation counts as continued elsewhere.
    const live = yield* scientCloudLive;
    return Context.make(CloudSyncState, store).pipe(
      Context.add(CloudLeaseGuard, guardFrom(store, live)),
    );
  }),
);

export const layerInMemory = (initial?: CloudSyncStateDocument) =>
  Layer.effectContext(
    Effect.gen(function* () {
      const store = yield* makeInMemory(initial);
      return Context.make(CloudSyncState, store).pipe(
        Context.add(CloudLeaseGuard, guardFrom(store)),
      );
    }),
  );
