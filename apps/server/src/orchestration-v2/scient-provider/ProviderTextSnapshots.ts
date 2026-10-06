import type {
  NodeId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  RunAttemptId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import type * as Stream from "effect/Stream";

import {
  ProviderTextSnapshotError,
  type CapturedProviderText,
  type ProviderAdapterV2Error,
  type ProviderAdapterV2Event,
  type ProviderAdapterV2InternalEvent,
  type ProviderAdapterV2SessionRuntime,
  type ProviderTextSnapshotBatch,
  type ProviderTextSnapshotConsumer,
  type ProviderTextSnapshotConsumerOwner,
  type ProviderTextSnapshotOwner,
} from "../ProviderAdapter.ts";
import type { ProviderTextDeltaCoalescer } from "../Adapters/ProviderTextDeltaCoalescer.ts";

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

type CodexSnapshotTurnContext = {
  readonly subagent: unknown;
  readonly input: {
    readonly threadId: ThreadId;
    readonly runId: RunId;
    readonly attemptId: RunAttemptId;
    readonly runOrdinal: number;
  };
  readonly rootNodeId: NodeId;
  readonly providerTurnId: ProviderTurnId;
  readonly providerThread: {
    readonly id: ProviderThreadId;
    readonly nativeThreadRef: { readonly nativeId: string | null } | null;
    readonly providerSessionId: ProviderSessionId | null;
  };
};

type NodeUpdated = Extract<ProviderAdapterV2Event, { readonly type: "node.updated" }>;
type MessageUpdated = Extract<ProviderAdapterV2Event, { readonly type: "message.updated" }>;
type TurnItemUpdated = Extract<ProviderAdapterV2Event, { readonly type: "turn_item.updated" }>;

/** Running-fork text capture for one Codex app-server session. */
export const makeCodexTextSnapshots = <Context extends CodexSnapshotTurnContext>(input: {
  readonly driver: ProviderDriverKind;
  readonly instanceId: ProviderInstanceId;
  readonly providerSessionId: ProviderSessionId;
  readonly nativeEvents: Stream.Stream<ProviderAdapterV2InternalEvent, ProviderAdapterV2Error>;
  readonly events: Queue.Enqueue<ProviderAdapterV2InternalEvent>;
  readonly generationEnded: Deferred.Deferred<never, ProviderTextSnapshotError>;
  readonly isGenerationEnded: () => boolean;
  readonly activeTurns: Ref.Ref<Map<string, Context>>;
  readonly interruptingNativeTurns: Ref.Ref<Set<string>>;
  readonly finalAnswerItemIdsByTurn: Ref.Ref<Map<string, Set<string>>>;
  readonly completedFinalAnswerTextsByTurn: Ref.Ref<Map<string, Set<string>>>;
  readonly turnTerminalizationPermit: Semaphore.Semaphore;
  readonly agentMessageDeltas: Pick<ProviderTextDeltaCoalescer, "withSnapshot" | "withWatermark">;
  readonly buildAgentMessageArtifacts: (
    context: Context,
    item: { readonly id: string; readonly text: string },
    completed: boolean,
  ) => Effect.Effect<{
    readonly node: NodeUpdated["node"];
    readonly message: MessageUpdated["message"];
    readonly turnItem: TurnItemUpdated["turnItem"];
  }>;
}): NonNullable<ProviderAdapterV2SessionRuntime["textSnapshots"]> => {
  const {
    activeTurns,
    agentMessageDeltas,
    buildAgentMessageArtifacts,
    completedFinalAnswerTextsByTurn,
    events,
    finalAnswerItemIdsByTurn,
    interruptingNativeTurns,
    turnTerminalizationPermit,
  } = input;
  const CODEX_PROVIDER = input.driver;
  const textSnapshotOwners = new Map<
    symbol,
    {
      readonly context: Context;
      readonly owner: ProviderTextSnapshotOwner;
    }
  >();
  const snapshotContext = Effect.fnUntraced(function* (owner: ProviderTextSnapshotOwner) {
    const context = (yield* Ref.get(activeTurns)).get(owner.nativeTurnId);
    if (
      input.isGenerationEnded() ||
      context === undefined ||
      context.subagent !== null ||
      context.input.threadId !== owner.threadId ||
      context.input.runId !== owner.runId ||
      context.input.attemptId !== owner.activeAttemptId ||
      context.rootNodeId !== owner.rootNodeId ||
      context.input.runOrdinal !== owner.runOrdinal ||
      context.providerTurnId !== owner.providerTurnId ||
      context.providerThread.id !== owner.providerThreadId ||
      context.providerThread.nativeThreadRef?.nativeId !== owner.nativeThreadId ||
      context.providerThread.providerSessionId !== owner.providerSessionId ||
      owner.providerSessionId !== input.providerSessionId ||
      owner.providerInstanceId !== input.instanceId ||
      owner.driver !== CODEX_PROVIDER ||
      (yield* Ref.get(interruptingNativeTurns)).has(owner.nativeTurnId)
    )
      return yield* new ProviderTextSnapshotError({ reason: "owner-lost" });
    return context;
  });
  return {
    events: input.nativeEvents,
    ended: Deferred.await(input.generationEnded),
    request: (owner, token) =>
      turnTerminalizationPermit.withPermit(
        Effect.gen(function* () {
          const context = yield* snapshotContext(owner);
          yield* agentMessageDeltas.withSnapshot(owner.nativeTurnId, (snapshot) =>
            Effect.gen(function* () {
              const artifacts: ProviderAdapterV2Event[] = [];
              const finalItems = (yield* Ref.get(finalAnswerItemIdsByTurn)).get(owner.nativeTurnId);
              const completedTexts = (yield* Ref.get(completedFinalAnswerTextsByTurn)).get(
                owner.nativeTurnId,
              );
              for (const item of snapshot.items) {
                if (
                  finalItems?.has(item.itemId) &&
                  ((completedTexts?.size ?? 0) > 0 ||
                    finalItems.values().next().value !== item.itemId)
                )
                  return yield* new ProviderTextSnapshotError({
                    reason: "not-native-ready",
                  });
                const built = yield* buildAgentMessageArtifacts(
                  context,
                  { id: item.itemId, text: item.text },
                  false,
                );
                artifacts.push(
                  { type: "node.updated", driver: CODEX_PROVIDER, node: built.node },
                  {
                    type: "message.updated",
                    driver: CODEX_PROVIDER,
                    message: built.message,
                  },
                  {
                    type: "turn_item.updated",
                    driver: CODEX_PROVIDER,
                    turnItem: built.turnItem,
                  },
                );
              }
              textSnapshotOwners.set(token, { context, owner });
              const offered = yield* Queue.offer(events, {
                type: "internal.text_snapshot",
                token,
                owner,
                watermark: snapshot.watermark,
                events: artifacts,
              });
              if (!offered)
                return yield* new ProviderTextSnapshotError({ reason: "consumer-ended" });
            }),
          );
        }),
      ),
    withCurrent: (token, watermark, commit) =>
      turnTerminalizationPermit.withPermit(
        Effect.gen(function* () {
          const captured = textSnapshotOwners.get(token);
          if (captured === undefined)
            return yield* new ProviderTextSnapshotError({ reason: "owner-lost" });
          if ((yield* snapshotContext(captured.owner)) !== captured.context)
            return yield* new ProviderTextSnapshotError({ reason: "owner-lost" });
          if (watermark === undefined) return yield* commit;
          const result = yield* agentMessageDeltas.withWatermark(
            captured.owner.nativeTurnId,
            watermark,
            commit,
          );
          if (Option.isNone(result))
            return yield* new ProviderTextSnapshotError({ reason: "newer-delta" });
          return result.value;
        }),
      ),
    release: (token) =>
      Effect.sync(() => {
        textSnapshotOwners.delete(token);
      }),
  };
};
