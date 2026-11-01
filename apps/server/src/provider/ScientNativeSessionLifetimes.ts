/**
 * Scient's native session lifetimes for the provider instance registry: every
 * opened native session is a child of both its configured instance and its
 * caller, and a retired instance never reaches its old native transport.
 */
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import {
  ProviderAdapterOpenSessionError,
  ProviderAdapterProtocolError,
  type ProviderAdapterV2Event,
  type ProviderAdapterV2InternalEvent,
  type ProviderAdapterV2SessionRuntime,
} from "@t3tools/provider-core/server/ProviderAdapter";
import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import {
  isOrchestrationV2WorkActive,
  type OrchestrationV2TurnItem,
  TextGenerationError,
} from "@t3tools/contracts";

/** A retired instance must never reach its old native transport again. */
const guardSessionLifetime = (
  runtime: ProviderAdapterV2SessionRuntime,
  scope: Scope.Scope,
  instanceScope: Scope.Scope,
  sessionClosed: Deferred.Deferred<boolean>,
): ProviderAdapterV2SessionRuntime => {
  const guard = <A, E>(
    operation: () => Effect.Effect<A, E>,
  ): Effect.Effect<A, E | ProviderAdapterProtocolError> =>
    Effect.suspend((): Effect.Effect<A, E | ProviderAdapterProtocolError> =>
      scope.state._tag === "Closed"
        ? Effect.fail(
            new ProviderAdapterProtocolError({
              driver: runtime.driver,
              detail: "The provider instance or session lifetime has ended.",
            }),
          )
        : operation(),
    );
  const {
    injectHistory,
    compactThread,
    stopSubagent,
    unloadThread,
    uploadFeedback,
    hasPendingBackgroundWork,
    hasPendingBackgroundWorkForThread,
    subscribeEvents,
    textSnapshots,
  } = runtime;
  const instanceClosing = () => instanceScope.state._tag === "Closed";
  const retired = Deferred.await(sessionClosed).pipe(
    Effect.flatMap((byInstance) => (byInstance ? Effect.void : Effect.never)),
  );
  // Retirement closes the session without a native stop, so its streams may never end and no
  // provider event can close its open items. Reporting both lets the manager release the session
  // and fail any run still open.
  const reportRetirement = <A extends ProviderAdapterV2Event | ProviderAdapterV2InternalEvent, E>(
    events: Stream.Stream<A, E>,
  ) =>
    Stream.suspend(() => {
      const openItems = new Map<string, OrchestrationV2TurnItem>();
      const retirementEvents = Effect.gen(function* () {
        // Native cleanup can end the stream first, so wait for it before reporting.
        if (!instanceClosing() || !(yield* Deferred.await(sessionClosed))) return Stream.empty;
        const updatedAt = yield* DateTime.now;
        const closed = [...openItems.values()].map((turnItem): ProviderAdapterV2Event => ({
          type: "turn_item.updated",
          driver: runtime.driver,
          turnItem: { ...turnItem, status: "interrupted", completedAt: updatedAt, updatedAt },
        }));
        const stopped: ProviderAdapterV2Event = {
          type: "provider_session.updated",
          driver: runtime.driver,
          providerSession: { ...runtime.providerSession, status: "stopped", updatedAt },
        };
        return Stream.fromIterable([...closed, stopped]);
      });
      return events.pipe(
        Stream.tap((event) =>
          Effect.sync(() => {
            if (event.type !== "turn_item.updated") return;
            if (isOrchestrationV2WorkActive(event.turnItem.status))
              openItems.set(event.turnItem.id, event.turnItem);
            else openItems.delete(event.turnItem.id);
          }),
        ),
        Stream.interruptWhen(retired),
        Stream.catchCause((cause) =>
          instanceClosing() && Cause.hasInterruptsOnly(cause)
            ? Stream.empty
            : Stream.failCause(cause),
        ),
        Stream.concat(Stream.unwrap(retirementEvents)),
      );
    });
  return {
    ...runtime,
    get providerSession() {
      return runtime.providerSession;
    },
    events: reportRetirement(runtime.events),
    ...(textSnapshots
      ? { textSnapshots: { ...textSnapshots, events: reportRetirement(textSnapshots.events) } }
      : {}),
    ...(subscribeEvents
      ? {
          subscribeEvents: Effect.map(subscribeEvents, (subscription) => ({
            ...subscription,
            events: subscription.events.pipe(Stream.interruptWhen(retired)),
          })),
        }
      : {}),
    ensureThread: (input) => guard(() => runtime.ensureThread(input)),
    resumeThread: (input) => guard(() => runtime.resumeThread(input)),
    startTurn: (input) => guard(() => runtime.startTurn(input)),
    steerTurn: (input) => guard(() => runtime.steerTurn(input)),
    interruptTurn: (input) => guard(() => runtime.interruptTurn(input)),
    respondToRuntimeRequest: (input) => guard(() => runtime.respondToRuntimeRequest(input)),
    readThreadSnapshot: (input) => guard(() => runtime.readThreadSnapshot(input)),
    rollbackThread: (input) => guard(() => runtime.rollbackThread(input)),
    forkThread: (input) => guard(() => runtime.forkThread(input)),
    ...(injectHistory ? { injectHistory: (input) => guard(() => injectHistory(input)) } : {}),
    ...(compactThread ? { compactThread: (input) => guard(() => compactThread(input)) } : {}),
    ...(stopSubagent
      ? { stopSubagent: (input) => guard(() => stopSubagent.call(runtime, input)) }
      : {}),
    ...(unloadThread ? { unloadThread: (input) => guard(() => unloadThread(input)) } : {}),
    ...(uploadFeedback ? { uploadFeedback: (input) => guard(() => uploadFeedback(input)) } : {}),
    ...(hasPendingBackgroundWork
      ? {
          hasPendingBackgroundWork: Effect.suspend(() =>
            scope.state._tag === "Closed" ? Effect.succeed(false) : hasPendingBackgroundWork,
          ),
        }
      : {}),
    ...(hasPendingBackgroundWorkForThread
      ? {
          hasPendingBackgroundWorkForThread: (input) =>
            Effect.suspend(() =>
              scope.state._tag === "Closed"
                ? Effect.succeed(false)
                : hasPendingBackgroundWorkForThread(input),
            ),
        }
      : {}),
  };
};

/** Native sessions are children of both their configured instance and caller. */
export const ownNativeSessionLifetimes = (
  instance: ProviderInstance,
  instanceScope: Scope.Scope,
): ProviderInstance => {
  const adapter = instance.orchestrationAdapter;
  const generation = instance.textGeneration;
  const ownGeneration = <A>(task: Effect.Effect<A, TextGenerationError>) =>
    Effect.scoped(
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const callerScope = yield* Scope.Scope;
          const retired = () =>
            new TextGenerationError({
              operation: "provider-instance",
              detail: "The configured provider instance has been retired.",
            });
          if (instanceScope.state._tag === "Closed") return yield* retired();
          const taskScope = yield* Scope.fork(instanceScope);
          yield* Scope.addFinalizerExit(callerScope, (exit) => Scope.close(taskScope, exit));
          if (taskScope.state._tag === "Closed") return yield* retired();
          const fiber = yield* restore(task).pipe(
            Effect.provideService(Scope.Scope, taskScope),
            Effect.forkIn(taskScope),
          );
          return yield* restore(Fiber.join(fiber)).pipe(
            Effect.catchCause((cause) =>
              instanceScope.state._tag === "Closed"
                ? Effect.fail(retired())
                : Effect.failCause(cause),
            ),
          );
        }),
      ),
    );
  return {
    ...instance,
    textGeneration: {
      generateCommitMessage: (input) => ownGeneration(generation.generateCommitMessage(input)),
      generatePrContent: (input) => ownGeneration(generation.generatePrContent(input)),
      generateBranchName: (input) => ownGeneration(generation.generateBranchName(input)),
      generateThreadTitle: (input) => ownGeneration(generation.generateThreadTitle(input)),
      generateReviewGuide: (input) => ownGeneration(generation.generateReviewGuide(input)),
    },
    orchestrationAdapter: {
      ...adapter,
      openSession: Effect.fn("ScientNativeSessionLifetimes.openSession")(function* (input) {
        const callerScope = yield* Scope.Scope;
        const retired = () =>
          new ProviderAdapterOpenSessionError({
            driver: instance.driverKind,
            providerSessionId: input.providerSessionId,
            cause: "The configured provider instance has been retired.",
          });
        if (instanceScope.state._tag === "Closed" || callerScope.state._tag === "Closed")
          return yield* retired();
        const sessionScope = yield* Scope.fork(instanceScope);
        const sessionClosed = yield* Deferred.make<boolean>();
        // Added first, so it runs after native cleanup. A caller's own close keeps its normal path.
        yield* Scope.addFinalizer(
          sessionScope,
          Effect.suspend(() =>
            Deferred.succeed(sessionClosed, instanceScope.state._tag === "Closed"),
          ),
        );
        yield* Scope.addFinalizerExit(callerScope, (exit) => Scope.close(sessionScope, exit));
        if (yield* Effect.sync(() => sessionScope.state._tag === "Closed")) return yield* retired();
        const opening = yield* adapter
          .openSession(input)
          .pipe(
            Effect.provideService(Scope.Scope, sessionScope),
            Effect.interruptible,
            Effect.forkIn(sessionScope),
          );
        const runtime = yield* Fiber.join(opening).pipe(
          // Instance retirement is an opening failure, so the manager's
          // failure path also revokes newly issued MCP credentials.
          Effect.catchCause((cause) =>
            instanceScope.state._tag === "Closed"
              ? Effect.fail(retired())
              : Effect.failCause(cause),
          ),
          Effect.onExit((exit) =>
            Exit.isFailure(exit) ? Scope.close(sessionScope, exit) : Effect.void,
          ),
        );
        if (yield* Effect.sync(() => sessionScope.state._tag === "Closed")) return yield* retired();
        return guardSessionLifetime(runtime, sessionScope, instanceScope, sessionClosed);
      }),
    },
  };
};
