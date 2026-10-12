import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import type * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import type * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import type { NativeEventQueueCharge } from "./NativeEventQueueBudget.ts";

export interface NativeEventQueueStorage {
  readonly fileSystem: FileSystem.FileSystem;
  readonly path: Path.Path;
  readonly directory: string;
}
const json = Schema.fromJsonString(
  Schema.toCodecJson(Schema.Array(ProviderAdapter.ProviderAdapterV2Event)),
);
const encode = Schema.encodeEffect(json);
const decode = Schema.decodeEffect(json);
const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** A published consumer owns retained receipts after producer sealing, until EOF or abandonment. */
export const makeNativeEventQueue = Effect.fnUntraced(function* (
  storage?: NativeEventQueueStorage,
) {
  type Entry =
    | {
        readonly frames: ReadonlyArray<ProviderAdapter.ProviderAdapterV2Event>;
        readonly charge: NativeEventQueueCharge;
      }
    | { readonly spool: true };
  const queue = yield* Queue.unbounded<Entry, Cause.Done>();
  const permit = yield* Semaphore.make(1);
  const resourceScope = yield* Scope.make();
  let retained = false;
  let sealed = false;
  let disposed = false;
  yield* Effect.addFinalizer(() =>
    Effect.suspend(() => (retained ? Effect.void : Scope.close(resourceScope, Exit.void))),
  );
  const file = storage
    ? yield* Effect.gen(function* () {
        yield* storage.fileSystem.makeDirectory(storage.directory, { recursive: true });
        const directory = yield* storage.fileSystem.makeTempDirectoryScoped({
          directory: storage.directory,
          prefix: "native-event-backlog-",
        });
        yield* storage.fileSystem.chmod(directory, 0o700);
        return yield* storage.fileSystem.open(storage.path.join(directory, "events.bin"), {
          flag: "w+",
          mode: 0o600,
        });
      }).pipe(
        Scope.provide(resourceScope),
        Effect.onError(() => Scope.close(resourceScope, Exit.void)),
      )
    : undefined;
  const token: Entry = { spool: true };
  let tokenQueued = false;
  let spilled = false;
  let end = 0n;
  let cursor = 0n;
  const enqueueCursor = Effect.suspend(() => {
    if (tokenQueued || cursor === end) return Effect.void;
    tokenQueued = true;
    return Queue.offer(queue, token).pipe(Effect.asVoid);
  });
  const append = Effect.fnUntraced(function* (
    frames: ReadonlyArray<ProviderAdapter.ProviderAdapterV2Event>,
  ) {
    if (!file) return yield* Effect.die("Native event spill storage is unavailable");
    const payload = encoder.encode(yield* encode(frames));
    const bytes = new Uint8Array(4 + payload.length);
    new DataView(bytes.buffer).setUint32(0, payload.length);
    bytes.set(payload, 4);
    yield* file.seek(end, "start");
    yield* file.writeAll(bytes);
    end += BigInt(bytes.length);
  });
  const readBytes = Effect.fnUntraced(function* (length: number) {
    if (!file) return yield* Effect.die("Native event spill storage is unavailable");
    const bytes = new Uint8Array(length);
    let offset = 0;
    while (offset < length) {
      const count = yield* file.read(bytes.subarray(offset));
      if (count === 0) return yield* Effect.die("Native event spill receipt is incomplete");
      offset += count;
    }
    return bytes;
  });
  const readDisk = Effect.gen(function* () {
    if (!file) return yield* Effect.die("Native event spill storage is unavailable");
    yield* file.seek(cursor, "start");
    const header = yield* readBytes(4);
    const length = new DataView(header.buffer).getUint32(0);
    if (cursor + BigInt(4 + length) > end)
      return yield* Effect.die("Native event spill receipt is incomplete");
    const bytes = yield* readBytes(length);
    const frames = yield* decode(decoder.decode(bytes));
    cursor += BigInt(4 + length);
    return frames;
  });
  const spillUnsafe = Effect.gen(function* () {
    if (!file || sealed || disposed) return false;
    const entries: Entry[] = [];
    for (;;) {
      const next = Queue.takeUnsafe(queue);
      if (next === undefined || next._tag === "Failure") break;
      entries.push(next.value);
    }
    const start = end;
    return yield* Effect.gen(function* () {
      for (const entry of entries) if ("frames" in entry) yield* append(entry.frames);
      // Every payload was physically written before either charge is returned.
      spilled = true;
      for (const entry of entries) if ("frames" in entry) entry.charge.release();
      if (entries.some((entry) => "spool" in entry)) tokenQueued = false;
      yield* enqueueCursor;
      return true;
    }).pipe(
      Effect.catchCause(() =>
        Effect.gen(function* () {
          end = start;
          yield* file.truncate(Number(start)).pipe(Effect.ignore);
          yield* Queue.offerAll(queue, entries);
          return false;
        }),
      ),
    );
  }).pipe(Effect.uninterruptible);
  const spill = permit.withPermit(spillUnsafe);
  const endQueue = permit.withPermit(
    Effect.gen(function* () {
      if (sealed || disposed) return;
      // Seal without decoding unread disk. Failed transfer keeps actual memory
      // batches charged until the consumer reads or explicitly abandons them.
      if (retained && file) yield* spillUnsafe;
      sealed = true;
      yield* Queue.end(queue);
    }).pipe(Effect.uninterruptible),
  );
  const dispose = (reason: "eof" | "abandoned" | "unpublished") =>
    permit.withPermit(
      Effect.gen(function* () {
        if (disposed) return;
        disposed = true;
        let abandonedItems = 0;
        for (;;) {
          const next = Queue.takeUnsafe(queue);
          if (next === undefined || next._tag === "Failure") break;
          if ("frames" in next.value) {
            abandonedItems += next.value.charge.items;
            next.value.charge.release();
          }
        }
        if (reason === "abandoned")
          yield* Effect.logWarning("orchestration-v2.native-event-consumer-abandoned", {
            residentItems: abandonedItems,
            unreadSpoolBytes: String(end - cursor),
            disposition: "undelivered; consumer released",
          });
        if (reason !== "eof")
          yield* Queue.failCause(queue, Cause.die("Native event consumer released before EOF."));
        yield* Scope.close(resourceScope, Exit.void);
      }).pipe(Effect.uninterruptible),
    );
  const retain = permit.withPermit(
    Effect.sync(() => {
      if (disposed) throw new Error("Native event consumer is already disposed.");
      retained = true;
    }),
  );
  yield* Effect.addFinalizer(() =>
    endQueue.pipe(
      Effect.andThen(
        Effect.suspend(() => (!storage || retained ? Effect.void : dispose("unpublished"))),
      ),
      Effect.orDie,
    ),
  );
  const nextSpilled = permit.withPermit(
    Effect.gen(function* () {
      if (disposed) return yield* Effect.die("Native event consumer is already disposed.");
      if (cursor < end) return Option.some(yield* readDisk);
      tokenQueued = false;
      return Option.none();
    }),
  );
  let drained = false;
  const data = (
    storage ? Stream.fromEffectRepeat(Queue.take(queue)) : Stream.fromQueue(queue)
  ).pipe(
    Stream.flatMap((entry) => {
      if ("frames" in entry)
        return Stream.fromEffect(Effect.sync(() => entry.charge.release())).pipe(
          Stream.flatMap(() => Stream.fromIterable(entry.frames)),
        );
      return Stream.unfold(undefined, () =>
        nextSpilled.pipe(
          Effect.map((next) =>
            Option.isSome(next) ? ([next.value, undefined] as const) : undefined,
          ),
        ),
      ).pipe(Stream.flatMap((frames) => Stream.fromIterable(frames)));
    }),
  );
  return {
    spill,
    consumer: { retain, dispose: dispose("abandoned") },
    onDispose: (finalizer: Effect.Effect<void>) => Scope.addFinalizer(resourceScope, finalizer),
    queued: Queue.size(queue),
    offer: (
      frames: ReadonlyArray<ProviderAdapter.ProviderAdapterV2Event>,
      charge: NativeEventQueueCharge,
    ) =>
      permit.withPermit(
        Effect.gen(function* () {
          if (sealed || disposed) {
            charge.release();
            return yield* Effect.die("Native event producer is already sealed.");
          }
          if (spilled) {
            yield* append(frames).pipe(
              Effect.flatMap(() =>
                Effect.sync(() => charge.release()).pipe(Effect.andThen(enqueueCursor)),
              ),
              // On write failure preserve order, payload and charge in memory. New
              // controls follow it until reclamation successfully retries the spill.
              Effect.catchCause(() => {
                spilled = false;
                return Queue.offer(queue, { frames, charge });
              }),
            );
          } else yield* Queue.offer(queue, { frames, charge });
        }),
      ),
    end: endQueue.pipe(Effect.orDie),
    events: storage
      ? Stream.unwrap(retain.pipe(Effect.as(data))).pipe(
          Stream.concat(
            Stream.fromEffect(
              Effect.sync(() => {
                drained = true;
              }),
            ).pipe(Stream.drain),
          ),
          Stream.onExit(() => dispose(drained ? "eof" : "abandoned")),
        )
      : data,
  };
});
