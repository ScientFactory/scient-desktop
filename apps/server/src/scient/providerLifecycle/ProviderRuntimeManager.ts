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

  const removeIfCurrent = (instanceId: ProviderInstanceId, operationId: string) =>
    Effect.gen(function* () {
      const removed = yield* Ref.modify(activeRef, (active) => {
        const current = active.get(instanceId);
        if (current?.operationId !== operationId) return [undefined, active] as const;
        const next = new Map(active);
        next.delete(instanceId);
        return [current, next] as const;
      });
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
            const actions = yield* providerRegistry.getProviderManagedRuntimeActionsForInstance(
              candidate.instanceId,
            );
            if (actions) {
              const summary = yield* actions.getSummary;
              yield* providerRegistry.setProviderManagedRuntimeSummary({
                instanceId: candidate.instanceId,
                runtime: summary,
              });
            }
            yield* providerRegistry.refreshInstance(candidate.instanceId);
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

      const supervise = target.actions
        .run(input.action, input.catalogRevision, publishProgress)
        .pipe(
          Effect.result,
          Effect.flatMap((result) =>
            Effect.gen(function* () {
              if (result._tag === "Success") {
                yield* refreshRuntimeInstances(target.provider);
              }
              const removed = yield* removeIfCurrent(input.instanceId, operationId);
              if (!removed) return;
              const finishedAt = yield* nowIso;
              const latestSummary = yield* target.actions.getSummary.pipe(
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
                        ? input.action === "remove"
                          ? "Scient's private provider runtime was removed."
                          : input.action === "update"
                            ? "The provider runtime was updated and verified."
                            : "The provider runtime is installed and verified."
                        : result.failure.message,
                  }),
                },
              });
            }),
          ),
          Effect.catchCause(() =>
            Effect.gen(function* () {
              const removed = yield* removeIfCurrent(input.instanceId, operationId);
              if (!removed) return;
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
            }),
          ),
        );
      const fiber = yield* Effect.forkDetach(supervise);
      yield* Ref.set(fiberRef, fiber);
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
