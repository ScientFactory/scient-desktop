import type { ProviderSessionId, ThreadId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";

import {
  ProviderTextSnapshotError,
  type CapturedProviderText,
  type ProviderAdapterV2InternalEvent,
  type ProviderAdapterV2SessionRuntime,
  type ProviderTextSnapshotBatch,
  type ProviderTextSnapshotConsumer,
  type ProviderTextSnapshotConsumerOwner,
  type ProviderTextSnapshotOwner,
} from "../ProviderAdapter.ts";

const isProviderTextSnapshotError = Schema.is(ProviderTextSnapshotError);

type SnapshotSessionEntry = {
  readonly runtime: ProviderAdapterV2SessionRuntime;
  readonly scope: Scope.Closeable;
  readonly attachedThreadIds: ReadonlySet<ThreadId>;
};

type SnapshotConsumerQueue = Queue.Enqueue<
  { readonly type: "event"; readonly event: ProviderAdapterV2InternalEvent },
  Cause.Done
>;

/** Running-fork text capture: exact live owners, their run consumers and pending waiters. */
export const makeProviderTextSnapshots = <Entry extends SnapshotSessionEntry>(input: {
  readonly sessions: Ref.Ref<Map<string, Entry>>;
  readonly sessionKey: (providerSessionId: ProviderSessionId) => string;
  readonly releasingRuntimes: WeakSet<ProviderAdapterV2SessionRuntime>;
}) =>
  Effect.gen(function* () {
    const { sessions, sessionKey, releasingRuntimes } = input;
    const textSnapshotPermit = yield* Semaphore.make(1);
    const textSnapshotConsumers = new Map<
      number,
      {
        readonly runtime: ProviderAdapterV2SessionRuntime;
        readonly owner: ProviderTextSnapshotConsumerOwner;
        readonly queue: SnapshotConsumerQueue;
      }
    >();
    const textSnapshots = new Map<
      symbol,
      {
        readonly entry: Entry;
        readonly owner: ProviderTextSnapshotOwner;
        readonly consumerId: number;
        readonly done: Deferred.Deferred<CapturedProviderText, ProviderTextSnapshotError>;
        retired: boolean;
      }
    >();
    const matchesTextConsumer = (
      consumer: ProviderTextSnapshotConsumerOwner,
      owner: ProviderTextSnapshotConsumerOwner,
    ) =>
      consumer.threadId === owner.threadId &&
      consumer.runId === owner.runId &&
      consumer.activeAttemptId === owner.activeAttemptId &&
      consumer.rootNodeId === owner.rootNodeId &&
      consumer.runOrdinal === owner.runOrdinal &&
      consumer.providerThreadId === owner.providerThreadId &&
      consumer.providerSessionId === owner.providerSessionId &&
      consumer.providerInstanceId === owner.providerInstanceId &&
      consumer.driver === owner.driver;
    const retireTextSnapshots = (runtime: ProviderAdapterV2SessionRuntime, threadId?: ThreadId) =>
      Effect.forEach(
        Array.from(textSnapshots.values()).filter(
          (pending) =>
            pending.entry.runtime === runtime &&
            (threadId === undefined || pending.owner.threadId === threadId),
        ),
        (pending) => {
          pending.retired = true;
          return Deferred.fail(
            pending.done,
            new ProviderTextSnapshotError({ reason: "owner-lost" }),
          );
        },
        { discard: true },
      );
    const withTextSnapshotCurrent = <A, E, R>(
      token: symbol,
      watermark: number | undefined,
      commit: Effect.Effect<A, E, R>,
    ) =>
      textSnapshotPermit.withPermit(
        Effect.gen(function* () {
          const pending = textSnapshots.get(token);
          if (pending === undefined || pending.retired)
            return yield* new ProviderTextSnapshotError({ reason: "owner-lost" });
          const current = (yield* Ref.get(sessions)).get(
            sessionKey(pending.owner.providerSessionId),
          );
          if (
            current?.runtime !== pending.entry.runtime ||
            current.scope !== pending.entry.scope ||
            !current.attachedThreadIds.has(pending.owner.threadId) ||
            releasingRuntimes.has(current.runtime) ||
            !textSnapshotConsumers.has(pending.consumerId) ||
            current.runtime.textSnapshots === undefined
          )
            return yield* new ProviderTextSnapshotError({ reason: "owner-lost" });
          return yield* current.runtime.textSnapshots.withCurrent(token, watermark, commit);
        }),
      );
    // Retiring a waiter is not native generation retirement. It must not wait
    // behind its in-flight SQL consumer; genuine committed facts are retained.
    const releaseTextSnapshot = (token: symbol) =>
      Effect.uninterruptible(
        Effect.gen(function* () {
          const pending = textSnapshots.get(token);
          if (pending === undefined) return;
          pending.retired = true;
          textSnapshots.delete(token);
          yield* Deferred.fail(
            pending.done,
            new ProviderTextSnapshotError({ reason: "consumer-ended" }),
          );
          yield* pending.entry.runtime.textSnapshots?.release(token) ?? Effect.void;
        }),
      );
    const captureRunningForkText = Effect.fn("ProviderSessionManager.captureRunningForkText")(
      function* (owner: ProviderTextSnapshotOwner) {
        const token = Symbol("native-text-snapshot");
        return yield* Effect.gen(function* () {
          const entry = yield* textSnapshotPermit.withPermit(
            Effect.gen(function* () {
              const current = (yield* Ref.get(sessions)).get(sessionKey(owner.providerSessionId));
              if (
                current === undefined ||
                releasingRuntimes.has(current.runtime) ||
                !current.attachedThreadIds.has(owner.threadId) ||
                current.runtime.instanceId !== owner.providerInstanceId ||
                current.runtime.driver !== owner.driver
              )
                return yield* new ProviderTextSnapshotError({ reason: "owner-lost" });
              if (current.runtime.textSnapshots === undefined)
                return yield* new ProviderTextSnapshotError({ reason: "unsupported" });
              const consumer = Array.from(textSnapshotConsumers).find(
                ([, row]) =>
                  row.runtime === current.runtime && matchesTextConsumer(row.owner, owner),
              );
              if (consumer === undefined)
                return yield* new ProviderTextSnapshotError({ reason: "consumer-ended" });
              if (
                Array.from(textSnapshots.values()).some(
                  (row) =>
                    row.entry.runtime === current.runtime && matchesTextConsumer(row.owner, owner),
                )
              )
                return yield* new ProviderTextSnapshotError({ reason: "busy" });
              const done = yield* Deferred.make<CapturedProviderText, ProviderTextSnapshotError>();
              textSnapshots.set(token, {
                entry: current,
                owner,
                consumerId: consumer[0],
                done,
                retired: false,
              });
              return current;
            }),
          );
          yield* entry.runtime.textSnapshots!.request(owner, token);
          return yield* Effect.raceFirst(
            Deferred.await(textSnapshots.get(token)!.done),
            entry.runtime.textSnapshots!.ended,
          );
        }).pipe(
          Effect.onExit((exit) =>
            Exit.isFailure(exit) ? releaseTextSnapshot(token) : Effect.void,
          ),
        );
      },
    );

    /**
     * Ends one run subscriber's consumer now. Returns the effect that fails its
     * pending waiters, or undefined when it has none, so an ordinary close runs
     * no extra steps.
     */
    const endConsumer = (subscriberId: number): Effect.Effect<void> | undefined => {
      textSnapshotConsumers.delete(subscriberId);
      let hasWaiters = false;
      for (const pending of textSnapshots.values())
        if (pending.consumerId === subscriberId) hasWaiters = true;
      if (!hasWaiters) return undefined;
      return Effect.gen(function* () {
        for (const pending of textSnapshots.values()) {
          if (pending.consumerId !== subscriberId) continue;
          pending.retired = true;
          yield* Deferred.fail(
            pending.done,
            new ProviderTextSnapshotError({ reason: "consumer-ended" }),
          );
        }
      });
    };

    const consumer = (
      subscriberId: number,
      runtime: ProviderAdapterV2SessionRuntime,
      queue: SnapshotConsumerQueue,
    ): ProviderTextSnapshotConsumer => ({
      bind: (owner) =>
        textSnapshotPermit.withPermit(
          Effect.sync(() => {
            textSnapshotConsumers.set(subscriberId, { runtime, owner, queue });
          }),
        ),
      consume: (batch, write) =>
        Effect.gen(function* () {
          const pending = textSnapshots.get(batch.token);
          if (pending === undefined) return;
          if (
            pending.consumerId !== subscriberId ||
            pending.owner !== batch.owner ||
            !matchesTextConsumer(
              textSnapshotConsumers.get(subscriberId)?.owner ?? batch.owner,
              pending.owner,
            )
          ) {
            yield* Deferred.fail(
              pending.done,
              new ProviderTextSnapshotError({ reason: "owner-lost" }),
            );
            return;
          }
          const result = yield* withTextSnapshotCurrent(batch.token, batch.watermark, write).pipe(
            Effect.exit,
          );
          if (Exit.isFailure(result)) {
            const cause = Cause.squash(result.cause);
            yield* Deferred.fail(
              pending.done,
              isProviderTextSnapshotError(cause)
                ? cause
                : new ProviderTextSnapshotError({
                    reason: "capture-failed",
                    cause: result.cause,
                  }),
            );
          } else {
            yield* Deferred.succeed(pending.done, {
              ...result.value,
              token: batch.token,
              owner: batch.owner,
              watermark: batch.watermark,
            });
          }
        }),
    });

    /** Routes a native snapshot batch from the session pump to its exact run consumer. */
    const route = (runtime: ProviderAdapterV2SessionRuntime, event: ProviderTextSnapshotBatch) =>
      Effect.gen(function* () {
        const pending = textSnapshots.get(event.token);
        const consumer =
          pending === undefined ? undefined : textSnapshotConsumers.get(pending.consumerId);
        if (pending === undefined) return;
        if (
          pending.retired ||
          pending.entry.runtime !== runtime ||
          pending.owner !== event.owner ||
          consumer?.runtime !== runtime
        ) {
          yield* Deferred.fail(
            pending.done,
            new ProviderTextSnapshotError({ reason: "owner-lost" }),
          );
          return;
        }
        yield* Queue.offer(consumer.queue, { type: "event", event });
      });

    return {
      permit: textSnapshotPermit,
      retire: retireTextSnapshots,
      withCurrent: withTextSnapshotCurrent,
      release: releaseTextSnapshot,
      capture: captureRunningForkText,
      endConsumer,
      consumer,
      route,
    };
  });
