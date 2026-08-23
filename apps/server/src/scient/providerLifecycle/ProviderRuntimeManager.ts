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
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

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
  readonly fiberRef: Ref.Ref<Fiber.Fiber<void, never> | undefined>;
}

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

  const removeIfCurrent = (instanceId: ProviderInstanceId, operationId: string) =>
    Effect.gen(function* () {
      const removed = yield* takeIfCurrent(instanceId, operationId);
      if (removed) yield* lifecycleCoordinator.release({ operationId });
      return removed;
    });

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
      yield* Effect.forEach(
        providers.filter((candidate) => candidate.driver === provider),
        (candidate) =>
          Effect.gen(function* () {
            const currentOperation = candidate.connection?.runtime?.operation ?? null;
            // Runtime selection happens while constructing the provider. Reload
            // first so removing a private runtime can discover a healthy system
            // fallback before the durable summary is published.
            yield* providerRegistry.reloadInstance(candidate.instanceId);
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
          }).pipe(Effect.ignore),
        { concurrency: 1, discard: true },
      );
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
        Effect.tapError(() => lifecycleCoordinator.release({ operationId })),
      );
      const fiberRef = yield* Ref.make<Fiber.Fiber<void, never> | undefined>(undefined);
      const active: ActiveRuntimeOperation = {
        operationId,
        provider: target.provider,
        action: input.action,
        startedAt,
        baseSummary,
        actions: target.actions,
        fiberRef,
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

      const initialProviders = yield* providerRegistry.setProviderManagedRuntimeSummary({
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
      });

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

      const supervise = providerRegistry.stopProviderSessions(target.provider).pipe(
        Effect.mapError((cause) => ({
          message: `Scient could not stop active ${target.provider} sessions before changing its runtime.`,
          cause,
        })),
        Effect.andThen(target.actions.run(input.action, input.catalogRevision, publishProgress)),
        Effect.result,
        Effect.flatMap((result) =>
          Effect.gen(function* () {
            // Claim finalization atomically. If cancellation won, the
            // operation must not reload providers or publish a late success.
            const claimed = yield* takeIfCurrent(input.instanceId, operationId);
            if (!claimed) return;
            yield* Effect.gen(function* () {
              if (result._tag === "Success") {
                yield* refreshRuntimeInstances(target.provider);
              }
              const finishedAt = yield* nowIso;
              const latestActions =
                result._tag === "Success"
                  ? ((yield* providerRegistry.getProviderManagedRuntimeActionsForInstance(
                      input.instanceId,
                    )) ?? target.actions)
                  : target.actions;
              const latestSummary = yield* latestActions.getSummary.pipe(
                Effect.orElseSucceed(() => baseSummary),
              );
              yield* providerRegistry.setProviderManagedRuntimeSummary({
                instanceId: input.instanceId,
                runtime: {
                  ...latestSummary,
                  operation: operation({
                    operationId,
                    action: input.action,
                    status: result._tag === "Success" ? "succeeded" : "failed",
                    startedAt,
                    finishedAt,
                    message:
                      result._tag === "Success"
                        ? runtimeSuccessMessage(input.action)
                        : result.failure.message,
                  }),
                },
              });
            }).pipe(
              Effect.catchCause(() => publishUnexpectedFailure),
              Effect.ensuring(lifecycleCoordinator.release({ operationId }).pipe(Effect.asVoid)),
            );
          }),
        ),
        Effect.catchCause(() =>
          Effect.gen(function* () {
            const claimed = yield* takeIfCurrent(input.instanceId, operationId);
            if (!claimed) return;
            yield* publishUnexpectedFailure.pipe(
              Effect.ensuring(lifecycleCoordinator.release({ operationId }).pipe(Effect.asVoid)),
            );
          }),
        ),
      );
      const fiber = yield* Effect.forkDetach(supervise);
      yield* Ref.set(fiberRef, fiber);
      const stillCurrent = (yield* Ref.get(activeRef)).get(input.instanceId)?.operationId;
      if (stillCurrent !== operationId) {
        // Cancellation can arrive between publishing the operation and
        // storing its fiber. Close that tiny race by interrupting immediately.
        yield* Fiber.interrupt(fiber);
      }
      return { providers: initialProviders };
    },
  );

  const cancel: ProviderRuntimeManagerShape["cancel"] = Effect.fn("ProviderRuntimeManager.cancel")(
    function* (input) {
      const target = yield* readTarget(input.instanceId);
      const active = yield* removeIfCurrent(input.instanceId, input.operationId);
      if (!active) {
        return yield* makeError({
          provider: target.provider,
          instanceId: input.instanceId,
          reason: "runtime_operation_not_found",
          message: "The provider runtime operation is no longer active.",
        });
      }
      const fiber = yield* Ref.get(active.fiberRef);
      if (fiber) yield* Fiber.interrupt(fiber);
      const latestSummary = yield* active.actions.getSummary.pipe(
        Effect.orElseSucceed(() => active.baseSummary),
      );
      const finishedAt = yield* nowIso;
      const providers = yield* providerRegistry.setProviderManagedRuntimeSummary({
        instanceId: input.instanceId,
        runtime: {
          ...latestSummary,
          operation: operation({
            operationId: input.operationId,
            action: active.action,
            status: "cancelled",
            startedAt: active.startedAt,
            finishedAt,
            message:
              "Provider runtime setup cancelled. The previous working runtime was preserved.",
          }),
        },
      });
      return { providers };
    },
  );

  return ProviderRuntimeManager.of({ plan, start, cancel });
});

export const layer = Layer.effect(ProviderRuntimeManager, make());
