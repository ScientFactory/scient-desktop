import {
  PROVIDER_DISPLAY_NAMES,
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
import {
  managedRuntimeFailedCheck,
  managedRuntimeFailureClass,
  managedRuntimeFailureRetryable,
  managedRuntimeRetryAfterMs,
  markManagedRuntimeCheck,
} from "@scientfactory/provider-runtime";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import type {
  ProviderManagedRuntimeActions,
  ProviderManagedRuntimeProgress,
} from "../../provider/ScientProviderInstanceSeams.ts";
import { ProviderRegistry } from "../../provider/ProviderRegistry.ts";
import { ProviderSessionManagerV2 } from "../../orchestration-v2/ProviderSessionManager.ts";
import { ProviderActivity } from "./ProviderActivity.ts";
import { ProviderConnectionActionError } from "./ProviderConnectionActions.ts";
import { ProviderLifecycleCoordinator } from "./ProviderLifecycleCoordinator.ts";
import {
  ProviderRuntimeRequests,
  sameRuntime,
  type RuntimeRequest,
} from "./ProviderRuntimeRequests.ts";
import * as ScientAgentRuntimePolicy from "./ScientAgentRuntimePolicy.ts";
import { recordAfterUserChange } from "./ScientAgentRuntimePolicy.ts";

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
  /**
   * Reloads an instance whose runtime selection would change, once its
   * provider is idle. True when it reloaded.
   */
  readonly reselect: (instanceId: ProviderInstanceId) => Effect.Effect<boolean>;
  /**
   * Waits for a background recovery or Scient Agent provisioning attempt. A foreground
   * start preempts it until its runtime change commits.
   */
  readonly startInBackground: (
    input: ProviderRuntimeStartInput & { readonly attempt: number; readonly requestId?: string },
  ) => Effect.Effect<ProviderRuntimeOutcome, ProviderConnectionError>;
}

/** How a runtime change ended: `yielded` when a start by the user stopped a background one. */
export type ProviderRuntimeOutcome =
  | "succeeded"
  | "failed"
  | "cancelled"
  | "yielded"
  | "interrupted";

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
  readonly background: { readonly attempt: number; readonly requestId?: string } | undefined;
  readonly requestId: string | undefined;
  readonly outcome: Deferred.Deferred<ProviderRuntimeOutcome>;
  /** Set once the download is complete. */
  readonly downloadRef: Ref.Ref<ProviderRuntimeOperation["download"]>;
}

interface RuntimeStartup {
  readonly instanceId: ProviderInstanceId;
  readonly background: ActiveRuntimeOperation["background"];
  readonly interrupt: Effect.Effect<void>;
  readonly outcome: Deferred.Deferred<ProviderRuntimeOutcome>;
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
  readonly waitingForIdle?: boolean;
  readonly retrying?: boolean;
  readonly failureClass?: ProviderRuntimeOperation["failureClass"];
  readonly failedCheck?: ProviderRuntimeOperation["failedCheck"];
  readonly background?: { readonly attempt: number } | undefined;
  readonly download?: ProviderRuntimeOperation["download"];
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
    ...(input.waitingForIdle ? { waitingForIdle: true } : {}),
    ...(input.retrying ? { retrying: true } : {}),
    ...(input.failureClass === undefined ? {} : { failureClass: input.failureClass }),
    ...(input.failedCheck === undefined ? {} : { failedCheck: input.failedCheck }),
    ...(input.background ? { background: true, attempt: input.background.attempt } : {}),
    ...(input.download === undefined ? {} : { download: input.download }),
  };
}

const IDLE_POLL_INTERVAL = "1 second";
const RESELECT_INTERVAL = "10 minutes";
const STARTUP_SUMMARY_TIMEOUT = "2 minutes";

export const make = Effect.fn("ProviderRuntimeManager.make")(function* () {
  const providerRegistry = yield* ProviderRegistry;
  const providerSessions = yield* ProviderSessionManagerV2;
  const lifecycleCoordinator = yield* ProviderLifecycleCoordinator;
  const activity = yield* ProviderActivity;
  const requests = yield* ProviderRuntimeRequests;
  const agentPolicy = yield* ScientAgentRuntimePolicy.ScientAgentRuntimePolicy;
  const random = yield* SecureRandom.SecureRandom;
  const activeRef = yield* Ref.make<ReadonlyMap<ProviderInstanceId, ActiveRuntimeOperation>>(
    new Map(),
  );
  const startupsRef = yield* Ref.make<ReadonlyMap<string, RuntimeStartup>>(new Map());
  const publicationLock = yield* Semaphore.make(1);

  const pendingRecovery = (
    runtime: ProviderRuntimeSummary,
    request: RuntimeRequest | undefined,
  ): NonNullable<ProviderRuntimeSummary["pendingRecovery"]> | null =>
    request && !ACTIVE_RUNTIME_STATUSES.has(runtime.operation?.status ?? "failed")
      ? {
          requestId: request.requestId,
          action: request.action,
          nextRetryAt: DateTime.formatIso(DateTime.makeUnsafe(request.dueAt)),
        }
      : null;

  const publishRuntime: typeof providerRegistry.setProviderManagedRuntimeSummary = Effect.fn(
    "ProviderRuntimeManager.publishRuntime",
  )(function* (input) {
    return yield* publicationLock.withPermits(1)(
      Effect.gen(function* () {
        const request = (yield* requests.list).find(
          (candidate) => candidate.instanceId === input.instanceId,
        );
        return yield* providerRegistry.setProviderManagedRuntimeSummary({
          ...input,
          runtime: input.runtime
            ? { ...input.runtime, pendingRecovery: pendingRecovery(input.runtime, request) }
            : null,
        });
      }),
    );
  });

  const syncPendingRecovery = Effect.fn("ProviderRuntimeManager.syncPendingRecovery")(function* () {
    yield* publicationLock.withPermits(1)(
      Effect.gen(function* () {
        yield* requests.assertAvailable;
        const providers = yield* providerRegistry.getProviders;
        const pending = yield* requests.list;
        for (const request of pending) {
          const provider = providers.find(
            (candidate) => candidate.instanceId === request.instanceId,
          );
          if (!provider?.enabled || provider.driver !== request.driver) {
            yield* requests.update(request.requestId, () => undefined);
          }
        }
        const current = yield* requests.list;
        for (const provider of providers) {
          const runtime = provider.connection?.runtime;
          if (!runtime) continue;
          const next = pendingRecovery(
            runtime,
            current.find((request) => request.instanceId === provider.instanceId),
          );
          if (
            (runtime.pendingRecovery?.requestId ?? null) === (next?.requestId ?? null) &&
            runtime.pendingRecovery?.nextRetryAt === next?.nextRetryAt
          )
            continue;
          yield* providerRegistry.setProviderManagedRuntimeSummary({
            instanceId: provider.instanceId,
            runtime: { ...runtime, pendingRecovery: next },
          });
        }
      }),
    );
  });

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

  const persistCancellation = Effect.fn("ProviderRuntimeManager.persistCancellation")(function* (
    target: RuntimeTarget,
    action: ProviderManagedRuntimeAction,
    requestId: string | undefined,
  ) {
    if (target.provider === ProviderDriverKind.make("scient")) {
      const runtime = target.snapshot.connection?.runtime;
      const change = recordAfterUserChange(
        { action, status: "cancelled" },
        runtime?.availableManagedVersion ?? runtime?.qualifiedVersion ?? null,
      );
      if (change) yield* agentPolicy.update(change);
    }
    yield* requests.settled({
      instanceId: target.snapshot.instanceId,
      driver: target.provider,
      outcome: "cancelled",
      ...(requestId ? { requestId } : {}),
    });
  });

  const persistenceActionError = (target: RuntimeTarget, message: string) =>
    makeError({
      provider: target.provider,
      instanceId: target.snapshot.instanceId,
      reason: "runtime_operation_failed",
      message,
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
    // A finished change reports its own outcome before it settles.
    outcome: ProviderRuntimeOutcome = mode === "interrupt" ? "interrupted" : "failed",
  ): Effect.Effect<A, E, R> =>
    // Stop owned resources first, but keep lifecycle ownership until the
    // terminal write settles so an older operation cannot overwrite a newer one.
    cleanupOwnedResources(active, mode).pipe(
      Effect.andThen(terminalPublication),
      Effect.ensuring(
        lifecycleCoordinator
          .release({ operationId: active.operationId })
          .pipe(Effect.andThen(Deferred.succeed(active.outcome, outcome)), Effect.asVoid),
      ),
    );

  const cleanupActive = (active: ActiveRuntimeOperation, mode: ActiveRuntimeCleanupMode) =>
    settleActive(active, mode, Effect.void);

  const cleanupIfCurrent = Effect.fn("ProviderRuntimeManager.cleanupIfCurrent")(function* (
    instanceId: ProviderInstanceId,
    operationId: string,
    mode: ActiveRuntimeCleanupMode,
  ) {
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
  // Startups run here, not in the request that asked for them.
  const managerScope = yield* Scope.Scope;

  const publishCancelled = Effect.fn("ProviderRuntimeManager.publishCancelled")(function* (
    instanceId: ProviderInstanceId,
    active: ActiveRuntimeOperation,
  ) {
    const latestSummary = yield* active.actions.getSummary.pipe(
      Effect.orElseSucceed(() => active.baseSummary),
    );
    const finishedAt = yield* nowIso;
    return yield* publishRuntime({
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
          background: active.background,
          download: yield* Ref.get(active.downloadRef),
        }),
      },
    });
  });

  const cleanupInterruptedStart = Effect.fn("ProviderRuntimeManager.cleanupInterruptedStart")(
    function* (instanceId: ProviderInstanceId, operationId: string) {
      const candidate = (yield* Ref.get(activeRef)).get(instanceId);
      if (candidate?.operationId !== operationId) return;
      const active = yield* candidate.transitionLock.withPermits(1)(
        Effect.gen(function* () {
          if (yield* Ref.get(candidate.committedRef)) return undefined;
          return yield* takeIfCurrent(instanceId, operationId);
        }),
      );
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

  // Switching or reloading a runtime stops the provider's sessions, so it waits
  // until nothing would be interrupted. Idle sessions resume from their resume
  // cursor on the next message. After waiting, idle must hold for a second
  // poll: a queued follow-up starts its turn moments after the previous one.
  const waitForIdleTurns = Effect.fn("ProviderRuntimeManager.waitForIdleTurns")(function* (
    provider: ProviderDriverKind,
    onFirstWait: Effect.Effect<void>,
  ) {
    let waited = false;
    let confirmedIdle = false;
    while (true) {
      if (yield* activity.isBusy(provider)) {
        confirmedIdle = false;
        if (!waited) {
          yield* onFirstWait;
          waited = true;
        }
      } else if (!waited || confirmedIdle) {
        return;
      } else {
        confirmedIdle = true;
      }
      yield* Effect.sleep(IDLE_POLL_INTERVAL);
    }
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

  // Default installations share the driver's managed runtime selection. Custom
  // paths (healthy or unavailable) retain independent executable authority.
  const affectedRuntimeInstances = (provider: ProviderDriverKind, target: ProviderInstanceId) =>
    providerRegistry.getProviders.pipe(
      Effect.map((providers) => {
        const targetRuntime = providers.find((candidate) => candidate.instanceId === target)
          ?.connection?.runtime;
        return providers.filter((candidate) => {
          if (candidate.instanceId === target) return true;
          if (candidate.driver !== provider) return false;
          const runtime = candidate.connection?.runtime;
          const source = runtime?.source;
          if (provider === ProviderDriverKind.make("acpRegistry"))
            return (
              source !== "custom" &&
              runtime !== undefined &&
              targetRuntime !== undefined &&
              runtime.target === targetRuntime.target
            );
          return source === "system" || source === "missing" || source === "scient_managed";
        });
      }),
    );

  const closeRuntimeInstances = (provider: ProviderDriverKind, target: ProviderInstanceId) =>
    affectedRuntimeInstances(provider, target).pipe(
      Effect.flatMap((providers) =>
        Effect.forEach(
          providers,
          (candidate) => providerSessions.closeInstance(candidate.instanceId),
          {
            discard: true,
          },
        ),
      ),
    );

  const refreshRuntimeInstances = Effect.fn("ProviderRuntimeManager.refreshRuntimeInstances")(
    function* (provider: ProviderDriverKind, target: ProviderInstanceId) {
      const providers = yield* affectedRuntimeInstances(provider, target);
      const refreshCauses = yield* Effect.forEach(
        providers,
        (candidate) =>
          Effect.gen(function* () {
            const currentOperation = candidate.connection?.runtime?.operation ?? null;
            // Runtime selection happens while constructing the provider. Reload
            // first so removing a private runtime can discover a healthy system
            // fallback before the durable summary is published.
            yield* providerSessions.closeInstance(candidate.instanceId);
            yield* providerRegistry.reloadInstanceStrict(candidate.instanceId);
            const actions = yield* providerRegistry.getProviderManagedRuntimeActionsForInstance(
              candidate.instanceId,
            );
            if (actions) {
              const summary = yield* actions.getSummary;
              yield* publishRuntime({
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

  const startup = Effect.fn("ProviderRuntimeManager.startup")(function* (
    input: ProviderRuntimeStartInput,
    background: ActiveRuntimeOperation["background"],
    outcome: Deferred.Deferred<ProviderRuntimeOutcome>,
    operationId: string,
    registeredActiveRef: Ref.Ref<boolean>,
  ) {
    const target = yield* readTarget(input.instanceId);
    yield* requests.assertAvailable.pipe(
      Effect.mapError((error) => persistenceActionError(target, error.message)),
    );
    const planned = yield* plan({ instanceId: input.instanceId, action: input.action });
    if (planned.catalogRevision !== input.catalogRevision) {
      return yield* makeError({
        provider: target.provider,
        instanceId: input.instanceId,
        reason: "runtime_plan_stale",
        message: "The provider setup plan changed. Review it again before continuing.",
      });
    }
    if (
      background?.requestId &&
      !(yield* requests.list).some((request) => request.requestId === background.requestId)
    ) {
      yield* Deferred.succeed(outcome, "cancelled");
      return yield* Effect.interrupt;
    }
    if (
      background &&
      !background.requestId &&
      (yield* requests.list).some((request) =>
        sameRuntime(request, { instanceId: input.instanceId, driver: target.provider }),
      )
    ) {
      return yield* makeError({
        provider: target.provider,
        instanceId: input.instanceId,
        reason: "runtime_busy",
        message: "A requested runtime recovery owns this runtime.",
      });
    }
    if (
      background &&
      !background.requestId &&
      target.provider === ProviderDriverKind.make("scient")
    ) {
      const latest = yield* readTarget(input.instanceId);
      const record = yield* agentPolicy.read.pipe(
        Effect.mapError((error) => persistenceActionError(target, error.message)),
      );
      const eligible = ScientAgentRuntimePolicy.backgroundRuntimeAction(latest.snapshot, record);
      if (
        eligible.kind !== "start" ||
        eligible.action !== input.action ||
        eligible.version !== planned.version
      ) {
        return yield* makeError({
          provider: target.provider,
          instanceId: input.instanceId,
          reason: "runtime_plan_stale",
          message: "Automatic Agent setup policy changed. No runtime was started.",
        });
      }
    }
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
    if (background === undefined) {
      yield* requests
        .requested({
          requestId: operationId,
          instanceId: input.instanceId,
          driver: target.provider,
          action: input.action,
          catalogRevision: input.catalogRevision,
        })
        .pipe(Effect.mapError((error) => persistenceActionError(target, error.message)));
    }
    const startedAt = yield* nowIso;
    const baseSummary = yield* target.actions.getSummary.pipe(
      // Bound discovery even when no client cancels the pending request.
      Effect.timeoutOrElse({
        duration: STARTUP_SUMMARY_TIMEOUT,
        orElse: () =>
          Effect.fail(
            new ProviderConnectionActionError({
              message: "Scient could not read the provider runtime state in time. Try again.",
            }),
          ),
      }),
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
    if (background?.requestId) {
      const current = yield* readTarget(input.instanceId);
      const requested = (yield* requests.list).find(
        (request) => request.requestId === background.requestId,
      );
      if (
        !requested ||
        !current.snapshot.enabled ||
        current.provider !== target.provider ||
        current.actions !== target.actions ||
        requested.driver !== target.provider ||
        requested.action !== input.action ||
        requested.catalogRevision !== input.catalogRevision
      ) {
        yield* requests
          .update(background.requestId, () => undefined)
          .pipe(Effect.mapError((error) => persistenceActionError(target, error.message)));
        yield* Deferred.succeed(outcome, "cancelled");
        return yield* Effect.interrupt;
      }
    }
    const fiberRef = yield* Ref.make<Fiber.Fiber<void, never> | undefined>(undefined);
    const committedRef = yield* Ref.make(false);
    const transitionLock = yield* Semaphore.make(1);
    const downloadRef = yield* Ref.make<ProviderRuntimeOperation["download"]>(undefined);
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
      background,
      requestId: background === undefined ? operationId : background.requestId,
      outcome,
      downloadRef,
    };
    const runtimeReserved = yield* Effect.uninterruptible(
      Ref.modify(activeRef, (current) => {
        if ([...current.values()].some((candidate) => candidate.provider === target.provider)) {
          return [false, current] as const;
        }
        const next = new Map(current);
        next.set(input.instanceId, active);
        return [true, next] as const;
      }).pipe(
        Effect.tap((reserved) => (reserved ? Ref.set(registeredActiveRef, true) : Effect.void)),
      ),
    );
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

    // Places a failure: the same file error is an extraction failure while installing.
    let lastStage: ProviderManagedRuntimeProgress["status"] = "preparing";
    const publishProgress = Effect.fn("ProviderRuntimeManager.publishProgress")(function* (
      progress: ProviderManagedRuntimeProgress,
    ) {
      lastStage = progress.status;
      if (progress.download) yield* Ref.set(downloadRef, progress.download);
      const current = (yield* Ref.get(activeRef)).get(input.instanceId);
      if (current?.operationId !== operationId) return;
      yield* publishRuntime({
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
            ...(progress.waitingForIdle ? { waitingForIdle: true } : {}),
            ...(progress.retrying ? { retrying: true } : {}),
            background,
            download: yield* Ref.get(downloadRef),
          }),
        },
      });
    });

    const displayName = PROVIDER_DISPLAY_NAMES[target.provider] ?? target.provider;
    // Before commit the staged change is still cancellable, so the wait is
    // reported as `waitingForIdle`.
    const awaitActivationWindow = waitForIdleTurns(
      target.provider,
      publishProgress({
        status: input.action === "remove" ? "removing" : "activating",
        message: `Waiting for ${displayName} to finish its running work before changing its runtime.`,
        waitingForIdle: true,
      }),
    ).pipe(
      Effect.andThen(closeRuntimeInstances(target.provider, input.instanceId)),
      Effect.mapError((cause) =>
        markManagedRuntimeCheck(
          "stop_sessions",
          new ProviderConnectionActionError({
            message: `Scient could not stop idle ${displayName} sessions before changing its runtime.`,
            cause,
          }),
        ),
      ),
    );

    const initialProviders = yield* publishRuntime({
      instanceId: input.instanceId,
      runtime: {
        ...baseSummary,
        operation: operation({
          operationId,
          action: input.action,
          status: "preparing",
          startedAt,
          message: "Preparing the provider runtime operation.",
          background,
        }),
      },
    }).pipe(Effect.onExit(cleanupStartupExit));

    const publishUnexpectedFailure = Effect.gen(function* () {
      const finishedAt = yield* nowIso;
      yield* publishRuntime({
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
            failureClass: "other",
            background,
            download: yield* Ref.get(downloadRef),
          }),
        },
      });
      yield* Effect.logError("Provider runtime supervisor failed");
    });

    const runRuntimeAction = Effect.uninterruptibleMask((restore) =>
      restore(
        target.actions.run(
          input.action,
          input.catalogRevision,
          publishProgress,
          awaitActivationWindow,
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
            // Successful provider action is the durable commit boundary. User cancellation cannot
            // then claim the previous runtime survived; report finishing, not cancellable
            // waitingForIdle. Wait for turns before reload, while keeping reconciliation
            // interruptible for layer shutdown.
            yield* waitForIdleTurns(
              target.provider,
              publishProgress({
                status: "activating",
                message: `Finishing: ${displayName} restarts once its running work completes.`,
              }),
            );
            const reconciliation = yield* refreshRuntimeInstances(
              target.provider,
              input.instanceId,
            ).pipe(Effect.result);
            if (reconciliation._tag === "Failure") {
              // The new runtime is already active; only restarting its sessions failed.
              completion = Result.fail(markManagedRuntimeCheck("refresh", reconciliation.failure));
            }
          }
          const finishedAt = yield* nowIso;
          const download = yield* Ref.get(downloadRef);
          const retryAfterMs =
            completion._tag === "Failure"
              ? managedRuntimeRetryAfterMs(completion.failure)
              : undefined;
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
              yield* publishRuntime({
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
                    ...(completion._tag === "Success"
                      ? {}
                      : {
                          failureClass: managedRuntimeFailureClass(completion.failure, lastStage),
                          failedCheck: managedRuntimeFailedCheck(completion.failure),
                        }),
                    background,
                    download,
                  }),
                },
              }).pipe(
                Effect.catchCause(() => publishUnexpectedFailure),
                Effect.andThen(
                  requests
                    .settled({
                      instanceId: input.instanceId,
                      driver: target.provider,
                      ...(active.requestId ? { requestId: active.requestId } : {}),
                      ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
                      outcome:
                        completion._tag === "Success"
                          ? "succeeded"
                          : managedRuntimeFailureRetryable(completion.failure, lastStage)
                            ? "retryable"
                            : "failed",
                    })
                    .pipe(
                      Effect.catchTags({
                        ProviderRuntimeRequestsPersistenceError: () =>
                          Effect.logWarning(
                            "Runtime request settlement could not be persisted; retaining recovery intent",
                          ),
                      }),
                    ),
                ),
                Effect.andThen(
                  Deferred.succeed(outcome, completion._tag === "Success" ? "succeeded" : "failed"),
                ),
                Effect.ensuring(
                  cleanupIfCurrent(input.instanceId, operationId, "complete").pipe(Effect.asVoid),
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
  });

  const startupAdmission = yield* Semaphore.make(1);

  const interruptStartup = Effect.fn("ProviderRuntimeManager.interruptStartup")(function* (
    operationId: string,
    outcome: ProviderRuntimeOutcome,
  ) {
    const starting = (yield* Ref.get(startupsRef)).get(operationId);
    if (!starting) return;
    yield* Deferred.succeed(starting.outcome, outcome);
    yield* starting.interrupt;
  });

  const beginStartup = Effect.fn("ProviderRuntimeManager.beginStartup")(function* (
    input: ProviderRuntimeStartInput,
    background: ActiveRuntimeOperation["background"],
    outcome: Deferred.Deferred<ProviderRuntimeOutcome>,
  ) {
    return yield* Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const operationId = `runtime-${yield* random.uuidV4()}`;
        const registered = yield* Deferred.make<void>();
        const registeredActiveRef = yield* Ref.make(false);
        const fiber = yield* restore(
          Deferred.await(registered).pipe(
            Effect.andThen(startup(input, background, outcome, operationId, registeredActiveRef)),
          ),
        ).pipe(
          Effect.onExit((exit) =>
            Effect.gen(function* () {
              if (Exit.isFailure(exit)) {
                yield* cleanupInterruptedStart(input.instanceId, operationId);
                // After registration, the active operation's claimant owns release through publication.
                if (!(yield* Ref.get(registeredActiveRef))) {
                  const reservation = yield* lifecycleCoordinator.current(input.instanceId);
                  if (reservation?.operationId === operationId) {
                    yield* lifecycleCoordinator.release({ operationId });
                  }
                }
                yield* Deferred.succeed(outcome, "interrupted");
              }
              yield* Ref.update(startupsRef, (current) => {
                const next = new Map(current);
                next.delete(operationId);
                return next;
              });
            }),
          ),
          Effect.forkIn(managerScope),
        );
        yield* Ref.update(startupsRef, (current) =>
          new Map(current).set(operationId, {
            instanceId: input.instanceId,
            background,
            interrupt: Fiber.interrupt(fiber).pipe(Effect.asVoid),
            outcome,
          }),
        );
        yield* Deferred.succeed(registered, undefined);
        return fiber;
      }),
    );
  });

  const yieldBackgroundWork = Effect.fn("ProviderRuntimeManager.yieldBackgroundWork")(function* () {
    const background = [...(yield* Ref.get(activeRef))].filter(
      ([, active]) => active.background !== undefined,
    );
    for (const [instanceId, active] of background) {
      const claim = yield* active.transitionLock.withPermits(1)(
        Effect.gen(function* () {
          if (yield* Ref.get(active.committedRef)) return undefined;
          return yield* takeIfCurrent(instanceId, active.operationId);
        }),
      );
      if (!claim) continue;
      yield* interruptStartup(active.operationId, "yielded");
      yield* settleActive(claim, "interrupt", publishCancelled(instanceId, claim), "yielded").pipe(
        Effect.ignore,
      );
    }
    for (const [operationId, starting] of yield* Ref.get(startupsRef)) {
      if (!starting.background) continue;
      // Committed changes must finish reconciliation; only unregistered startup is left to yield.
      if ((yield* Ref.get(activeRef)).get(starting.instanceId)?.operationId === operationId)
        continue;
      yield* interruptStartup(operationId, "yielded");
    }
  });

  // A disconnected caller detaches from the reply; the manager still owns the startup.
  const start: ProviderRuntimeManagerShape["start"] = Effect.fn("ProviderRuntimeManager.start")(
    function* (input) {
      const outcome = yield* Deferred.make<ProviderRuntimeOutcome>();
      const fiber = yield* startupAdmission.withPermits(1)(
        Effect.gen(function* () {
          yield* yieldBackgroundWork();
          return yield* beginStartup(input, undefined, outcome);
        }),
      );
      return yield* Fiber.join(fiber);
    },
  );

  const startInBackground: ProviderRuntimeManagerShape["startInBackground"] = Effect.fn(
    "ProviderRuntimeManager.startInBackground",
  )(function* (input) {
    const outcome = yield* Deferred.make<ProviderRuntimeOutcome>();
    const fiber = yield* startupAdmission.withPermits(1)(
      Effect.gen(function* () {
        if ([...(yield* Ref.get(startupsRef)).values()].some((starting) => !starting.background)) {
          return yield* makeError({
            provider: ProviderDriverKind.make("unknown"),
            instanceId: input.instanceId,
            reason: "runtime_busy",
            message: "A requested runtime change is starting.",
          });
        }
        return yield* beginStartup(
          input,
          {
            attempt: input.attempt,
            ...(input.requestId ? { requestId: input.requestId } : {}),
          },
          outcome,
        );
      }),
    );
    const exit = yield* Fiber.await(fiber);
    if (Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause)) {
      return yield* Effect.failCause(exit.cause);
    }
    return yield* Deferred.await(outcome);
  });

  const cancel: ProviderRuntimeManagerShape["cancel"] = Effect.fn("ProviderRuntimeManager.cancel")(
    function* (input) {
      const target = yield* readTarget(input.instanceId);
      yield* requests.assertAvailable.pipe(
        Effect.mapError((error) => persistenceActionError(target, error.message)),
      );
      let candidate = (yield* Ref.get(activeRef)).get(input.instanceId);
      const pending =
        "requestId" in input
          ? (yield* requests.list).find(
              (request) =>
                request.instanceId === input.instanceId && request.requestId === input.requestId,
            )
          : undefined;
      let matchesActive =
        candidate &&
        ("operationId" in input
          ? candidate.operationId === input.operationId
          : pending !== undefined && candidate.requestId === input.requestId);
      if (!matchesActive && pending) {
        yield* persistCancellation(target, pending.action, pending.requestId).pipe(
          Effect.mapError((error) => persistenceActionError(target, error.message)),
        );
        for (const [operationId, starting] of yield* Ref.get(startupsRef)) {
          if (
            operationId === pending.requestId ||
            starting.background?.requestId === pending.requestId
          ) {
            if ((yield* Ref.get(activeRef)).get(starting.instanceId)?.operationId === operationId)
              continue;
            yield* interruptStartup(operationId, "cancelled");
          }
        }
        candidate = (yield* Ref.get(activeRef)).get(input.instanceId);
        if (candidate?.requestId !== pending.requestId) {
          yield* syncPendingRecovery().pipe(
            Effect.mapError((error) => persistenceActionError(target, error.message)),
          );
          return { providers: yield* providerRegistry.getProviders };
        }
        matchesActive = true;
      }
      if (!candidate || !matchesActive) {
        return yield* makeError({
          provider: target.provider,
          instanceId: input.instanceId,
          reason: "runtime_operation_not_found",
          message: "The provider runtime operation is no longer active.",
        });
      }
      const operationId = candidate.operationId;
      const claim = yield* candidate.transitionLock.withPermits(1)(
        Effect.gen(function* () {
          const current = (yield* Ref.get(activeRef)).get(input.instanceId);
          if (current?.operationId !== operationId) return undefined;
          if (yield* Ref.get(current.committedRef)) return "committed" as const;
          yield* persistCancellation(target, current.action, current.requestId).pipe(
            Effect.mapError((error) => persistenceActionError(target, error.message)),
          );
          if (yield* Ref.get(current.committedRef)) return "committed" as const;
          return yield* takeIfCurrent(input.instanceId, operationId);
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
      yield* interruptStartup(claim.operationId, "cancelled");
      const providers = yield* settleActive(
        claim,
        "interrupt",
        publishCancelled(input.instanceId, claim),
        "cancelled",
      );
      return { providers };
    },
    Effect.uninterruptible,
  );

  // Instances of one driver share its runtime, so one reselection per driver
  // covers them all; concurrent requests for the same driver are dropped.
  const reselectingRef = yield* Ref.make<ReadonlySet<ProviderDriverKind>>(new Set());
  const reselectOnce = (
    provider: ProviderDriverKind,
    reselection: Effect.Effect<boolean>,
  ): Effect.Effect<boolean> =>
    Effect.acquireUseRelease(
      Ref.modify(reselectingRef, (current) =>
        current.has(provider) ? [false, current] : [true, new Set([...current, provider])],
      ),
      (acquired) => (acquired ? reselection : Effect.succeed(false)),
      (acquired) =>
        acquired
          ? Ref.update(reselectingRef, (current) => {
              const next = new Set(current);
              next.delete(provider);
              return next;
            })
          : Effect.void,
    );

  const reselect: ProviderRuntimeManagerShape["reselect"] = Effect.fn(
    "ProviderRuntimeManager.reselect",
  )(function* (instanceId) {
    const target = yield* readTarget(instanceId).pipe(Effect.option);
    if (Option.isNone(target)) return false;
    const { actions, provider } = target.value;
    if (!actions.selectionChanged) return false;
    return yield* reselectOnce(provider, reselectWhenIdle(instanceId, provider, actions));
  });

  const reselectWhenIdle = Effect.fn("ProviderRuntimeManager.reselectWhenIdle")(function* (
    instanceId: ProviderInstanceId,
    provider: ProviderDriverKind,
    checkedActions: ProviderManagedRuntimeActions,
  ) {
    if (!checkedActions.selectionChanged || !(yield* checkedActions.selectionChanged)) {
      return false;
    }
    // Wait without holding the lifecycle reservation, so user actions stay
    // available while turns run; re-check once reserved.
    yield* waitForIdleTurns(provider, Effect.void);
    const operationId = `reselect-${yield* random.uuidV4()}`;
    const reserved = yield* lifecycleCoordinator.reserve({
      instanceId,
      provider,
      reservation: { operationId, kind: "runtime" },
    });
    if (!reserved) return false;
    return yield* Effect.gen(function* () {
      const changing = [...(yield* Ref.get(activeRef)).values()].some(
        (candidate) => candidate.provider === provider,
      );
      // A rebuilt instance already re-ran selection; its old answer is stale.
      const current = yield* readTarget(instanceId).pipe(Effect.option);
      const rebuilt = Option.isNone(current) || current.value.actions !== checkedActions;
      if (changing || rebuilt || (yield* activity.isBusy(provider))) return false;
      yield* refreshRuntimeInstances(provider, instanceId);
      return true;
    }).pipe(
      Effect.ensuring(lifecycleCoordinator.release({ operationId }).pipe(Effect.asVoid)),
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.interrupt
          : Effect.logError("provider runtime reselection failed", {
              provider,
              cause: Cause.pretty(cause),
            }).pipe(Effect.as(false)),
      ),
    );
  });

  // A fallback runtime can recover on its own (a slow first launch, a busy
  // disk), so instances standing in for a private runtime are re-checked.
  yield* Effect.gen(function* () {
    const providers = yield* providerRegistry.getProviders;
    yield* Effect.forEach(
      providers.filter(
        (provider) =>
          provider.connection?.runtime?.source === "system" &&
          provider.connection.runtime.managedVersion !== null,
      ),
      (provider) => reselect(provider.instanceId),
      { discard: true },
    );
  }).pipe(Effect.delay(RESELECT_INTERVAL), Effect.forever, Effect.forkScoped);

  yield* syncPendingRecovery().pipe(
    Effect.catchTags({
      ProviderRuntimeRequestsPersistenceError: () =>
        Effect.logWarning("Runtime recovery intent is unavailable; managed changes are disabled"),
    }),
  );
  yield* requests.changes.pipe(
    Stream.runForEach(() =>
      syncPendingRecovery().pipe(
        Effect.catchTags({
          ProviderRuntimeRequestsPersistenceError: () =>
            Effect.logWarning("Runtime recovery intent could not be pruned"),
        }),
      ),
    ),
    Effect.forkScoped,
  );
  yield* providerRegistry.streamChanges.pipe(
    Stream.runForEach(() =>
      syncPendingRecovery().pipe(
        Effect.catchTags({
          ProviderRuntimeRequestsPersistenceError: () =>
            Effect.logWarning("Runtime recovery intent could not be pruned"),
        }),
      ),
    ),
    Effect.forkScoped,
  );

  return ProviderRuntimeManager.of({ plan, start, cancel, reselect, startInBackground });
});

export const layer = Layer.effect(ProviderRuntimeManager, make()).pipe(
  Layer.provide(ScientAgentRuntimePolicy.layer),
);
