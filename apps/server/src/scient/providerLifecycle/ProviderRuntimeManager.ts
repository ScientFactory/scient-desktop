import {
  ProviderConnectionError,
  ProviderDriverKind,
  type ProviderInstanceId,
  type ProviderManagedRuntimeAction,
  type ProviderRuntimeCancelInput,
  type ProviderRuntimeOperation,
  type ProviderRuntimePlan,
  type ProviderRuntimePlanInput,
  type ProviderRuntimeStartInput,
  type ProviderRuntimeSummary,
  type ServerProvider,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Semaphore from "effect/Semaphore";

import type {
  ProviderManagedRuntimeActions,
  ProviderManagedRuntimeProgress,
} from "../../provider/ProviderDriver.ts";
import { ProviderRegistry } from "../../provider/Services/ProviderRegistry.ts";
import { ProviderLifecycleCoordinator } from "./ProviderLifecycleCoordinator.ts";

export interface ProviderRuntimeManagerShape {
  readonly plan: (
    input: ProviderRuntimePlanInput,
  ) => Effect.Effect<ProviderRuntimePlan, ProviderConnectionError>;
  readonly start: (
    input: ProviderRuntimeStartInput,
  ) => Effect.Effect<
    { readonly providers: ReadonlyArray<ServerProvider> },
    ProviderConnectionError
  >;
  readonly cancel: (
    input: ProviderRuntimeCancelInput,
  ) => Effect.Effect<
    { readonly providers: ReadonlyArray<ServerProvider> },
    ProviderConnectionError
  >;
}

export class ProviderRuntimeManager extends Context.Service<
  ProviderRuntimeManager,
  ProviderRuntimeManagerShape
>()("t3/scient/providerLifecycle/ProviderRuntimeManager") {}

interface RuntimeTarget {
  readonly actions: ProviderManagedRuntimeActions;
  readonly snapshot: ServerProvider;
  readonly provider: ProviderDriverKind;
}

interface ActiveRuntimeOperation {
  readonly operationId: string;
  readonly provider: ProviderDriverKind;
  readonly action: ProviderManagedRuntimeAction;
  readonly startedAt: string;
  readonly baseSummary: ProviderRuntimeSummary;
  readonly actions: ProviderManagedRuntimeActions;
  readonly committedRef: Ref.Ref<boolean>;
  readonly fiberRef: Ref.Ref<Fiber.Fiber<void, never> | undefined>;
  readonly transitionLock: Semaphore.Semaphore;
}

type ActiveRuntimeCleanupMode = "complete" | "interrupt";

const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));

const ACTIVE_RUNTIME_STATUSES = new Set<ProviderRuntimeOperation["status"]>([
  "preparing",
  "downloading",
  "verifying",
  "installing",
  "testing",
  "activating",
  "removing",
]);

function runtimeSuccessMessage(action: ProviderManagedRuntimeAction): string {
  switch (action) {
    case "install":
      return "The provider runtime was installed and verified.";
    case "update":
      return "The provider runtime was updated and verified.";
    case "repair":
      return "The provider runtime was repaired and verified successfully.";
    case "remove":
      return "Scient's private provider runtime was removed.";
  }
}

const makeError = (input: {
  readonly provider: ProviderDriverKind;
  readonly instanceId: ProviderInstanceId;
  readonly reason: ProviderConnectionError["reason"];
  readonly message: string;
}) =>
  new ProviderConnectionError({
    provider: input.provider,
    instanceId: input.instanceId,
    reason: input.reason,
    message: input.message,
  });

function operation(input: {
  readonly operationId: string;
  readonly action: ProviderManagedRuntimeAction;
  readonly status: ProviderRuntimeOperation["status"];
  readonly startedAt: string;
  readonly finishedAt?: string | null;
  readonly message: string;
  readonly downloadedBytes?: number;
  readonly totalBytes?: number;
}): ProviderRuntimeOperation {
  return {
    operationId: input.operationId,
    action: input.action,
    status: input.status,
    startedAt: input.startedAt,
    finishedAt: input.finishedAt ?? null,
    message: input.message,
    ...(input.downloadedBytes === undefined
      ? {}
      : { downloadedBytes: Math.max(0, Math.floor(input.downloadedBytes)) }),
    ...(input.totalBytes === undefined
      ? {}
      : { totalBytes: Math.max(1, Math.floor(input.totalBytes)) }),
  };
}

export const make = Effect.fn("ProviderRuntimeManager.make")(function* () {
  const providerRegistry = yield* ProviderRegistry;
  const lifecycleCoordinator = yield* ProviderLifecycleCoordinator;
  const crypto = yield* Crypto.Crypto;
  const activeRef = yield* Ref.make<ReadonlyMap<ProviderInstanceId, ActiveRuntimeOperation>>(
    new Map(),
  );

  const readTarget = Effect.fn("ProviderRuntimeManager.readTarget")(function* (
    instanceId: ProviderInstanceId,
  ): Effect.fn.Return<RuntimeTarget, ProviderConnectionError> {
    const [actions, providers] = yield* Effect.all([
      providerRegistry.getProviderManagedRuntimeActionsForInstance(instanceId),
      providerRegistry.getProviders,
    ]);
    const snapshot = providers.find((provider) => provider.instanceId === instanceId);
    const provider = snapshot?.driver ?? ProviderDriverKind.make("unknown");
    if (!actions || !snapshot) {
      return yield* makeError({
        provider,
        instanceId,
        reason: "runtime_unsupported",
        message: "This provider does not offer an assisted runtime on this host.",
      });
    }
    return { actions, snapshot, provider };
  });

  const takeIfCurrent = (instanceId: ProviderInstanceId, operationId: string) =>
    Ref.modify(activeRef, (active) => {
      const current = active.get(instanceId);
      if (current?.operationId !== operationId) return [undefined, active] as const;
      const next = new Map(active);
      next.delete(instanceId);
      return [current, next] as const;
    });

  const cleanupOwnedResources = Effect.fn("ProviderRuntimeManager.cleanupOwnedResources")(
    function* (active: ActiveRuntimeOperation, mode: ActiveRuntimeCleanupMode) {
      if (mode === "interrupt") {
        const fiber = yield* Ref.get(active.fiberRef);
        if (fiber) yield* Fiber.interrupt(fiber);
      }
    },
  );

  const settleActive = <A, E, R>(
    active: ActiveRuntimeOperation,
    mode: ActiveRuntimeCleanupMode,
    terminalPublication: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E, R> =>
    // Stop owned resources first, but keep lifecycle ownership until the
    // terminal write settles so an older operation cannot overwrite a newer one.
    cleanupOwnedResources(active, mode).pipe(
      Effect.andThen(terminalPublication),
      Effect.ensuring(
        lifecycleCoordinator.release({ operationId: active.operationId }).pipe(Effect.asVoid),
      ),
    );

  const cleanupActive = (active: ActiveRuntimeOperation, mode: ActiveRuntimeCleanupMode) =>
    settleActive(active, mode, Effect.void);

  const cleanupIfCurrent = (
    instanceId: ProviderInstanceId,
    operationId: string,
    mode: ActiveRuntimeCleanupMode,
  ) =>
    Effect.gen(function* () {
      const active = yield* takeIfCurrent(instanceId, operationId);
      if (active) yield* cleanupActive(active, mode);
      return active;
    });

  const cleanupAll = Effect.gen(function* () {
    const active = yield* Ref.getAndSet(activeRef, new Map());
    yield* Effect.forEach(active.values(), (runtime) => cleanupActive(runtime, "interrupt"), {
      discard: true,
    });
  });

  yield* Effect.addFinalizer(() => cleanupAll);

  const publishCancelled = Effect.fn("ProviderRuntimeManager.publishCancelled")(function* (
    instanceId: ProviderInstanceId,
    active: ActiveRuntimeOperation,
  ) {
    const latestSummary = yield* active.actions.getSummary.pipe(
      Effect.orElseSucceed(() => active.baseSummary),
    );
    const finishedAt = yield* nowIso;
    return yield* providerRegistry.setProviderManagedRuntimeSummary({
      instanceId,
      runtime: {
        ...latestSummary,
        operation: operation({
          operationId: active.operationId,
          action: active.action,
          status: "cancelled",
          startedAt: active.startedAt,
          finishedAt,
          message: "Provider runtime setup cancelled. The previous working runtime was preserved.",
        }),
      },
    });
  });

  const cleanupInterruptedStart = Effect.fn("ProviderRuntimeManager.cleanupInterruptedStart")(
    function* (instanceId: ProviderInstanceId, operationId: string) {
      const active = yield* takeIfCurrent(instanceId, operationId);
      if (!active) return;
      yield* settleActive(
        active,
        "interrupt",
        Effect.gen(function* () {
          const visibleOperation = (yield* providerRegistry.getProviders).find(
            (provider) => provider.instanceId === instanceId,
          )?.connection?.runtime?.operation;
          if (visibleOperation?.operationId !== operationId) return;
          yield* publishCancelled(instanceId, active);
        }),
      );
    },
  );

  const plan: ProviderRuntimeManagerShape["plan"] = Effect.fn("ProviderRuntimeManager.plan")(
    function* (input) {
      const target = yield* readTarget(input.instanceId);
      const planned = yield* target.actions.plan(input.action).pipe(
        Effect.mapError((failure) =>
          makeError({
            provider: target.provider,
            instanceId: input.instanceId,
            reason: "invalid_runtime_action",
            message: failure.message,
          }),
        ),
      );
      return { ...planned, instanceId: input.instanceId };
    },
  );

  const refreshRuntimeInstances = Effect.fn("ProviderRuntimeManager.refreshRuntimeInstances")(
    function* (provider: ProviderDriverKind) {
      const providers = yield* providerRegistry.getProviders;
      const refreshCauses = yield* Effect.forEach(
        providers.filter((candidate) => candidate.driver === provider),
        (candidate) =>
          Effect.gen(function* () {
            const currentOperation = candidate.connection?.runtime?.operation ?? null;
            // Runtime selection happens while constructing the provider. Reload
            // first so removing a private runtime can discover a healthy system
            // fallback before the durable summary is published.
            yield* providerRegistry.reloadInstanceStrict(candidate.instanceId);
            const actions = yield* providerRegistry.getProviderManagedRuntimeActionsForInstance(
              candidate.instanceId,
            );
            if (actions) {
              const summary = yield* actions.getSummary;
              yield* providerRegistry.setProviderManagedRuntimeSummary({
                instanceId: candidate.instanceId,
                runtime: {
                  ...summary,
                  // `getSummary` describes durable runtime state and therefore has no
                  // in-flight operation. Keep the supervisor-owned operation visible until
                  // probing and instance reload have both finished; otherwise the UI can
                  // briefly expose conflicting sign-in or management actions.
                  operation:
                    currentOperation && ACTIVE_RUNTIME_STATUSES.has(currentOperation.status)
                      ? currentOperation
                      : summary.operation,
                },
              });
            }
          }).pipe(
            Effect.as<Cause.Cause<unknown> | undefined>(undefined),
            Effect.catchCause((cause) =>
              Cause.hasInterruptsOnly(cause) ? Effect.interrupt : Effect.succeed(cause),
            ),
          ),
        { concurrency: 1 },
      );
      const failures = refreshCauses.filter(
        (cause): cause is Cause.Cause<unknown> => cause !== undefined,
      );
      if (failures.length > 0) {
        yield* Effect.logError("provider runtime reconciliation failed", {
          provider,
          causes: failures.map(Cause.pretty),
        });
        return yield* Effect.fail({
          message:
            "The runtime change finished, but Scient could not verify the resulting provider state.",
        });
      }
    },
  );

  const start: ProviderRuntimeManagerShape["start"] = Effect.fn("ProviderRuntimeManager.start")(
    function* (input) {
      const target = yield* readTarget(input.instanceId);
      const planned = yield* plan({ instanceId: input.instanceId, action: input.action });
      if (planned.catalogRevision !== input.catalogRevision) {
        return yield* makeError({
          provider: target.provider,
          instanceId: input.instanceId,
          reason: "runtime_plan_stale",
          message: "The provider setup plan changed. Review it again before continuing.",
        });
      }
      const operationId = `runtime-${yield* crypto.randomUUIDv4.pipe(Effect.orDie)}`;
      const reserved = yield* lifecycleCoordinator.reserve({
        instanceId: input.instanceId,
        provider: target.provider,
        reservation: { operationId, kind: "runtime" },
      });
      if (!reserved) {
        return yield* makeError({
          provider: target.provider,
          instanceId: input.instanceId,
          reason: "runtime_busy",
          message: "Another setup or connection operation is already running for this provider.",
        });
      }
      const startedAt = yield* nowIso;
      const baseSummary = yield* target.actions.getSummary.pipe(
        Effect.mapError((failure) =>
          makeError({
            provider: target.provider,
            instanceId: input.instanceId,
            reason: "runtime_operation_failed",
            message: failure.message,
          }),
        ),
        Effect.onExit((exit) =>
          Exit.isSuccess(exit)
            ? Effect.void
            : lifecycleCoordinator.release({ operationId }).pipe(Effect.asVoid),
        ),
      );
      const fiberRef = yield* Ref.make<Fiber.Fiber<void, never> | undefined>(undefined);
      const committedRef = yield* Ref.make(false);
      const transitionLock = yield* Semaphore.make(1);
      const active: ActiveRuntimeOperation = {
        operationId,
        provider: target.provider,
        action: input.action,
        startedAt,
        baseSummary,
        actions: target.actions,
        committedRef,
        fiberRef,
        transitionLock,
      };
      const runtimeReserved = yield* Ref.modify(activeRef, (current) => {
        if ([...current.values()].some((candidate) => candidate.provider === target.provider)) {
          return [false, current] as const;
        }
        const next = new Map(current);
        next.set(input.instanceId, active);
        return [true, next] as const;
      });
      if (!runtimeReserved) {
        yield* lifecycleCoordinator.release({ operationId });
        return yield* makeError({
          provider: target.provider,
          instanceId: input.instanceId,
          reason: "runtime_busy",
          message: "Another account is already changing this shared provider runtime.",
        });
      }

      const cleanupStartupExit = <A, E>(exit: Exit.Exit<A, E>): Effect.Effect<void> =>
        Exit.isSuccess(exit)
          ? Effect.void
          : Cause.hasInterrupts(exit.cause)
            ? cleanupInterruptedStart(input.instanceId, operationId)
            : cleanupIfCurrent(input.instanceId, operationId, "interrupt").pipe(Effect.asVoid);

      const publishProgress = (progress: ProviderManagedRuntimeProgress) =>
        Effect.gen(function* () {
          const current = (yield* Ref.get(activeRef)).get(input.instanceId);
          if (current?.operationId !== operationId) return;
          yield* providerRegistry.setProviderManagedRuntimeSummary({
            instanceId: input.instanceId,
            runtime: {
              ...baseSummary,
              operation: operation({
                operationId,
                action: input.action,
                status: progress.status,
                startedAt,
                message: progress.message,
                ...(progress.downloadedBytes === undefined
                  ? {}
                  : { downloadedBytes: progress.downloadedBytes }),
                ...(progress.totalBytes === undefined ? {} : { totalBytes: progress.totalBytes }),
              }),
            },
          });
        });

      const initialProviders = yield* providerRegistry
        .setProviderManagedRuntimeSummary({
          instanceId: input.instanceId,
          runtime: {
            ...baseSummary,
            operation: operation({
              operationId,
              action: input.action,
              status: "preparing",
              startedAt,
              message: "Preparing the provider runtime operation.",
            }),
          },
        })
        .pipe(Effect.onExit(cleanupStartupExit));

      const publishUnexpectedFailure = Effect.gen(function* () {
        const finishedAt = yield* nowIso;
        yield* providerRegistry.setProviderManagedRuntimeSummary({
          instanceId: input.instanceId,
          runtime: {
            ...baseSummary,
            operation: operation({
              operationId,
              action: input.action,
              status: "failed",
              startedAt,
              finishedAt,
              message: "The provider runtime operation stopped unexpectedly.",
            }),
          },
        });
        yield* Effect.logError("Provider runtime supervisor failed");
      });

      const runRuntimeAction = Effect.uninterruptibleMask((restore) =>
        restore(
          providerRegistry.stopProviderSessions(target.provider).pipe(
            Effect.mapError((cause) => ({
              message: `Scient could not stop active ${target.provider} sessions before changing its runtime.`,
              cause,
            })),
            Effect.andThen(
              target.actions.run(input.action, input.catalogRevision, publishProgress),
            ),
          ),
        ).pipe(Effect.tap(() => Ref.set(committedRef, true))),
      );

      const supervise = runRuntimeAction.pipe(
        Effect.result,
        Effect.flatMap((result) =>
          Effect.gen(function* () {
            let completion = result;
            if (result._tag === "Success") {
              const current = (yield* Ref.get(activeRef)).get(input.instanceId);
              if (current?.operationId !== operationId) return;
              // The provider action returning successfully is the durable commit
              // boundary. Reconciliation remains interruptible during layer
              // shutdown, but a user cancellation can no longer claim that the
              // previous runtime was preserved after this point.
              const reconciliation = yield* refreshRuntimeInstances(target.provider).pipe(
                Effect.result,
              );
              if (reconciliation._tag === "Failure") {
                completion = Result.fail(reconciliation.failure);
              }
            }
            const finishedAt = yield* nowIso;
            const latestSummary =
              result._tag === "Success"
                ? ((yield* providerRegistry.getProviders).find(
                    (provider) => provider.instanceId === input.instanceId,
                  )?.connection?.runtime ?? baseSummary)
                : yield* target.actions.getSummary.pipe(Effect.orElseSucceed(() => baseSummary));
            yield* transitionLock.withPermits(1)(
              Effect.gen(function* () {
                const current = (yield* Ref.get(activeRef)).get(input.instanceId);
                if (current?.operationId !== operationId) return;
                yield* providerRegistry
                  .setProviderManagedRuntimeSummary({
                    instanceId: input.instanceId,
                    runtime: {
                      ...latestSummary,
                      operation: operation({
                        operationId,
                        action: input.action,
                        status: completion._tag === "Success" ? "succeeded" : "failed",
                        startedAt,
                        finishedAt,
                        message:
                          completion._tag === "Success"
                            ? runtimeSuccessMessage(input.action)
                            : completion.failure.message,
                      }),
                    },
                  })
                  .pipe(
                    Effect.catchCause(() => publishUnexpectedFailure),
                    Effect.ensuring(
                      cleanupIfCurrent(input.instanceId, operationId, "complete").pipe(
                        Effect.asVoid,
                      ),
                    ),
                  );
              }),
            );
          }),
        ),
        Effect.catchCause(() =>
          transitionLock.withPermits(1)(
            Effect.gen(function* () {
              const current = (yield* Ref.get(activeRef)).get(input.instanceId);
              if (current?.operationId !== operationId) return;
              yield* publishUnexpectedFailure.pipe(
                Effect.ensuring(
                  cleanupIfCurrent(input.instanceId, operationId, "complete").pipe(Effect.asVoid),
                ),
              );
            }),
          ),
        ),
      );
      yield* Effect.uninterruptible(
        Effect.gen(function* () {
          const fiber = yield* Effect.forkDetach(supervise);
          yield* Ref.set(fiberRef, fiber);
          const stillCurrent = (yield* Ref.get(activeRef)).get(input.instanceId)?.operationId;
          if (stillCurrent !== operationId) {
            // Cancellation can claim the operation before this handoff begins.
            // Register the detached fiber and close that race atomically so no
            // supervisor can outlive both manager ownership and its fiber handle.
            yield* Fiber.interrupt(fiber);
          }
        }),
      ).pipe(Effect.onExit(cleanupStartupExit));
      return { providers: initialProviders };
    },
  );

  const cancel: ProviderRuntimeManagerShape["cancel"] = Effect.fn("ProviderRuntimeManager.cancel")(
    function* (input) {
      const target = yield* readTarget(input.instanceId);
      const candidate = (yield* Ref.get(activeRef)).get(input.instanceId);
      if (!candidate || candidate.operationId !== input.operationId) {
        return yield* makeError({
          provider: target.provider,
          instanceId: input.instanceId,
          reason: "runtime_operation_not_found",
          message: "The provider runtime operation is no longer active.",
        });
      }
      const claim = yield* candidate.transitionLock.withPermits(1)(
        Effect.gen(function* () {
          const current = (yield* Ref.get(activeRef)).get(input.instanceId);
          if (current?.operationId !== input.operationId) return undefined;
          if (yield* Ref.get(current.committedRef)) return "committed" as const;
          return yield* takeIfCurrent(input.instanceId, input.operationId);
        }),
      );
      if (claim === "committed") {
        return yield* makeError({
          provider: target.provider,
          instanceId: input.instanceId,
          reason: "runtime_operation_not_found",
          message: "The runtime change is already being finalized and can no longer be cancelled.",
        });
      }
      if (!claim) {
        return yield* makeError({
          provider: target.provider,
          instanceId: input.instanceId,
          reason: "runtime_operation_not_found",
          message: "The provider runtime operation is no longer active.",
        });
      }
      const providers = yield* settleActive(
        claim,
        "interrupt",
        publishCancelled(input.instanceId, claim),
      );
      return { providers };
    },
  );

  return ProviderRuntimeManager.of({ plan, start, cancel });
});

export const layer = Layer.effect(ProviderRuntimeManager, make());
