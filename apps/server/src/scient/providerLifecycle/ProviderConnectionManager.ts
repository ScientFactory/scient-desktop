import {
  ProviderConnectionError,
  ProviderDriverKind,
  type ProviderConnectionCancelInput,
  type ProviderConnectionDisconnectInput,
  type ProviderConnectionOperation,
  type ProviderConnectionStartInput,
  type ProviderConnectionSubmitAuthorizationCodeInput,
  type ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
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
import * as Scope from "effect/Scope";

import { ProviderRegistry } from "../../provider/Services/ProviderRegistry.ts";
import type { ProviderConnectionAttempt } from "../../provider/ProviderDriver.ts";
import { ProviderLifecycleCoordinator } from "./ProviderLifecycleCoordinator.ts";

export interface ProviderConnectionManagerShape {
  readonly start: (
    input: ProviderConnectionStartInput,
  ) => Effect.Effect<
    { readonly providers: ReadonlyArray<ServerProvider> },
    ProviderConnectionError
  >;
  readonly cancel: (
    input: ProviderConnectionCancelInput,
  ) => Effect.Effect<
    { readonly providers: ReadonlyArray<ServerProvider> },
    ProviderConnectionError
  >;
  readonly submitAuthorizationCode: (
    input: ProviderConnectionSubmitAuthorizationCodeInput,
  ) => Effect.Effect<
    { readonly providers: ReadonlyArray<ServerProvider> },
    ProviderConnectionError
  >;
  readonly disconnect: (
    input: ProviderConnectionDisconnectInput,
  ) => Effect.Effect<
    { readonly providers: ReadonlyArray<ServerProvider> },
    ProviderConnectionError
  >;
}

export class ProviderConnectionManager extends Context.Service<
  ProviderConnectionManager,
  ProviderConnectionManagerShape
>()("t3/scient/providerLifecycle/ProviderConnectionManager") {}

interface ActiveConnection {
  readonly operationId: string;
  readonly scope: Scope.Closeable;
  readonly attemptRef: Ref.Ref<ProviderConnectionAttempt | undefined>;
  readonly authorizationCodeSubmittedRef: Ref.Ref<boolean>;
  readonly fiberRef: Ref.Ref<Fiber.Fiber<void, never> | undefined>;
  readonly transitionLock: Semaphore.Semaphore;
}

type ActiveConnectionCleanupMode = "complete" | "interrupt";

const PROVIDER_CANCEL_TIMEOUT = "5 seconds";
const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));

function operation(input: {
  readonly operationId: string;
  readonly method: ProviderConnectionStartInput["method"];
  readonly status: ProviderConnectionOperation["status"];
  readonly startedAt: string;
  readonly finishedAt?: string | null;
  readonly message: string;
  readonly authorizationUrl?: string;
  readonly authorizationUrlKind?: ProviderConnectionOperation["authorizationUrlKind"];
  readonly acceptsAuthorizationCode?: boolean;
  readonly userCode?: string;
}): ProviderConnectionOperation {
  return {
    operationId: input.operationId,
    method: input.method,
    status: input.status,
    startedAt: input.startedAt,
    finishedAt: input.finishedAt ?? null,
    message: input.message,
    ...(input.authorizationUrl ? { authorizationUrl: input.authorizationUrl } : {}),
    ...(input.authorizationUrlKind ? { authorizationUrlKind: input.authorizationUrlKind } : {}),
    ...(input.acceptsAuthorizationCode !== undefined
      ? { acceptsAuthorizationCode: input.acceptsAuthorizationCode }
      : {}),
    ...(input.userCode ? { userCode: input.userCode } : {}),
  };
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

export const make = Effect.fn("ProviderConnectionManager.make")(function* () {
  const providerRegistry = yield* ProviderRegistry;
  const lifecycleCoordinator = yield* ProviderLifecycleCoordinator;
  const crypto = yield* Crypto.Crypto;
  const activeRef = yield* Ref.make<ReadonlyMap<ProviderInstanceId, ActiveConnection>>(new Map());

  const readTarget = Effect.fn("ProviderConnectionManager.readTarget")(function* (
    instanceId: ProviderInstanceId,
  ) {
    const [actions, providers] = yield* Effect.all([
      providerRegistry.getProviderConnectionActionsForInstance(instanceId),
      providerRegistry.getProviders,
    ]);
    const snapshot = providers.find((provider) => provider.instanceId === instanceId);
    const provider = snapshot?.driver ?? ProviderDriverKind.make("unknown");
    return { actions, providers, snapshot, provider };
  });

  const takeIfCurrent = (instanceId: ProviderInstanceId, operationId: string) =>
    Ref.modify(activeRef, (active) => {
      const current = active.get(instanceId);
      if (current?.operationId !== operationId) {
        return [undefined, active] as const;
      }
      const next = new Map(active);
      next.delete(instanceId);
      return [current, next] as const;
    });

  const cleanupOwnedResources = Effect.fn("ProviderConnectionManager.cleanupOwnedResources")(
    function* (active: ActiveConnection, mode: ActiveConnectionCleanupMode) {
      if (mode === "interrupt") {
        const attempt = yield* Ref.get(active.attemptRef);
        if (attempt) {
          yield* attempt.cancel.pipe(
            Effect.interruptible,
            Effect.timeout(PROVIDER_CANCEL_TIMEOUT),
            Effect.ignoreCause({ log: true }),
          );
        }
        const supervisor = yield* Ref.get(active.fiberRef);
        if (supervisor) yield* Fiber.interrupt(supervisor);
      }
      yield* Scope.close(active.scope, Exit.void).pipe(Effect.ignoreCause({ log: true }));
    },
  );

  const settleActive = <A, E, R>(
    active: ActiveConnection,
    mode: ActiveConnectionCleanupMode,
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

  const cleanupActive = (active: ActiveConnection, mode: ActiveConnectionCleanupMode) =>
    settleActive(active, mode, Effect.void);

  const cleanupIfCurrent = (
    instanceId: ProviderInstanceId,
    operationId: string,
    mode: ActiveConnectionCleanupMode,
  ) =>
    Effect.gen(function* () {
      const active = yield* takeIfCurrent(instanceId, operationId);
      if (active) yield* cleanupActive(active, mode);
      return active;
    });

  const cleanupAll = Effect.gen(function* () {
    const active = yield* Ref.getAndSet(activeRef, new Map());
    yield* Effect.forEach(active.values(), (connection) => cleanupActive(connection, "interrupt"), {
      discard: true,
    });
  });

  yield* Effect.addFinalizer(() => cleanupAll);

  const cleanupInterruptedStart = Effect.fn("ProviderConnectionManager.cleanupInterruptedStart")(
    function* (input: {
      readonly instanceId: ProviderInstanceId;
      readonly operationId: string;
      readonly method: ProviderConnectionStartInput["method"];
      readonly startedAt: string;
    }) {
      const active = yield* takeIfCurrent(input.instanceId, input.operationId);
      if (!active) return;
      yield* settleActive(
        active,
        "interrupt",
        Effect.gen(function* () {
          const previousOperation = (yield* providerRegistry.getProviders).find(
            (provider) => provider.instanceId === input.instanceId,
          )?.connection?.operation;
          if (previousOperation?.operationId !== input.operationId) return;
          const finishedAt = yield* nowIso;
          yield* providerRegistry.setProviderConnectionOperation({
            instanceId: input.instanceId,
            operation: operation({
              operationId: input.operationId,
              method: input.method,
              status: "cancelled",
              startedAt: input.startedAt,
              finishedAt,
              message: "Provider sign in cancelled.",
            }),
          });
        }),
      );
    },
  );

  const start: ProviderConnectionManagerShape["start"] = Effect.fn(
    "ProviderConnectionManager.start",
  )(function* (input) {
    // Account state can change outside Scient and immediately after a managed
    // install/reload. Re-probe before reserving or launching an account flow
    // so an existing provider session is treated as ready, not as a reason to
    // start a duplicate sign-in process.
    yield* providerRegistry.refreshInstance(input.instanceId);
    const target = yield* readTarget(input.instanceId);
    if (!target.actions || !target.snapshot) {
      return yield* makeError({
        provider: target.provider,
        instanceId: input.instanceId,
        reason: "unsupported_provider",
        message: "This provider instance is not available in the current Scient runtime.",
      });
    }
    if (!target.snapshot.enabled) {
      return yield* makeError({
        provider: target.provider,
        instanceId: input.instanceId,
        reason: "provider_disabled",
        message: "Enable this provider before connecting an account.",
      });
    }
    if (!target.snapshot.installed) {
      return yield* makeError({
        provider: target.provider,
        instanceId: input.instanceId,
        reason: "provider_not_installed",
        message: "Install this provider before connecting an account.",
      });
    }

    const actions = target.actions;
    if (!actions.methods.includes(input.method)) {
      return yield* makeError({
        provider: target.provider,
        instanceId: input.instanceId,
        reason: "invalid_method",
        message: "The selected connection method is not valid for this provider.",
      });
    }
    if (target.snapshot.auth.status === "authenticated" && input.mode !== "reauthenticate") {
      return { providers: target.providers };
    }

    const operationId = `connect-${yield* crypto.randomUUIDv4.pipe(Effect.orDie)}`;
    const startedAt = yield* nowIso;
    const scope = yield* Scope.make();
    const attemptRef = yield* Ref.make<ProviderConnectionAttempt | undefined>(undefined);
    const authorizationCodeSubmittedRef = yield* Ref.make(false);
    const fiberRef = yield* Ref.make<Fiber.Fiber<void, never> | undefined>(undefined);
    const transitionLock = yield* Semaphore.make(1);
    const active: ActiveConnection = {
      operationId,
      scope,
      attemptRef,
      authorizationCodeSubmittedRef,
      fiberRef,
      transitionLock,
    };
    const lifecycleReserved = yield* lifecycleCoordinator.reserve({
      instanceId: input.instanceId,
      provider: target.provider,
      reservation: { operationId, kind: "connection" },
    });
    if (!lifecycleReserved) {
      yield* Scope.close(scope, Exit.void).pipe(Effect.ignore);
      return yield* makeError({
        provider: target.provider,
        instanceId: input.instanceId,
        reason: "already_running",
        message: "Another setup or connection operation is already running for this provider.",
      });
    }
    const reserved = yield* Ref.modify(activeRef, (current) => {
      if (current.has(input.instanceId)) {
        return [false, current] as const;
      }
      const next = new Map(current);
      next.set(input.instanceId, active);
      return [true, next] as const;
    });
    if (!reserved) {
      yield* lifecycleCoordinator.release({ operationId });
      yield* Scope.close(scope, Exit.void).pipe(Effect.ignore);
      return yield* makeError({
        provider: target.provider,
        instanceId: input.instanceId,
        reason: "already_running",
        message: "A connection operation is already running for this provider.",
      });
    }

    return yield* Effect.gen(function* () {
      yield* providerRegistry.setProviderConnectionOperation({
        instanceId: input.instanceId,
        operation: operation({
          operationId,
          method: input.method,
          status: "starting",
          startedAt,
          message: "Starting secure provider sign in.",
        }),
      });

      const attemptResult = yield* actions.start(input.method).pipe(
        Effect.provideService(Scope.Scope, scope),
        Effect.result,
        Effect.catchCause(() =>
          Effect.succeed(
            Result.fail({
              message: "The provider sign-in flow stopped unexpectedly.",
            }),
          ),
        ),
      );
      if (attemptResult._tag === "Failure") {
        const removed = yield* takeIfCurrent(input.instanceId, operationId);
        // A second client may have cancelled while the provider was still
        // preparing its browser flow. Preserve that authoritative cancelled
        // state instead of overwriting it with a late startup failure.
        if (!removed) {
          return { providers: yield* providerRegistry.getProviders };
        }
        const finishedAt = yield* nowIso;
        yield* settleActive(
          removed,
          "complete",
          providerRegistry.setProviderConnectionOperation({
            instanceId: input.instanceId,
            operation: operation({
              operationId,
              method: input.method,
              status: "failed",
              startedAt,
              finishedAt,
              message: attemptResult.failure.message,
            }),
          }),
        );
        return yield* makeError({
          provider: target.provider,
          instanceId: input.instanceId,
          reason: "connection_failed",
          message: attemptResult.failure.message,
        });
      }

      const attempt = attemptResult.success;
      const waitingStatus = attempt.initialStatus;
      const waitingMessage =
        waitingStatus === "verifying"
          ? "Verifying the connected provider account."
          : waitingStatus === "waiting_for_device_code"
            ? "Enter the code in the provider's secure sign-in page."
            : "Finish signing in securely in your browser.";
      const waitingProviders = yield* transitionLock.withPermits(1)(
        Effect.gen(function* () {
          const current = (yield* Ref.get(activeRef)).get(input.instanceId);
          if (current?.operationId !== operationId) {
            // Cancellation can race the provider's initial URL discovery. The
            // scope has already been closed by cancel; ask the provider process
            // to stop as a best-effort fallback and never resurrect waiting.
            yield* attempt.cancel.pipe(Effect.ignoreCause({ log: true }));
            yield* Scope.close(scope, Exit.void).pipe(Effect.ignoreCause({ log: true }));
            return undefined;
          }
          yield* Ref.set(attemptRef, attempt);
          return yield* providerRegistry.setProviderConnectionOperation({
            instanceId: input.instanceId,
            operation: operation({
              operationId,
              method: input.method,
              status: waitingStatus,
              startedAt,
              message: waitingMessage,
              ...(attempt.authorizationUrl
                ? {
                    authorizationUrl: attempt.authorizationUrl,
                    ...(attempt.authorizationUrlKind
                      ? { authorizationUrlKind: attempt.authorizationUrlKind }
                      : {}),
                  }
                : {}),
              acceptsAuthorizationCode: attempt.submitAuthorizationCode !== undefined,
              ...(attempt.userCode ? { userCode: attempt.userCode } : {}),
            }),
          });
        }),
      );
      if (!waitingProviders) {
        return { providers: yield* providerRegistry.getProviders };
      }

      const supervise = attempt.waitForCompletion.pipe(
        Effect.result,
        Effect.flatMap((result) =>
          transitionLock.withPermits(1)(
            Effect.gen(function* () {
              const current = (yield* Ref.get(activeRef)).get(input.instanceId);
              if (current?.operationId !== operationId) {
                return;
              }
              let completion = result;
              if (completion._tag === "Success") {
                // Final account verification decides the truthful terminal state.
                // Keep it in the same transition claim as publication so a late
                // cancel cannot overwrite the probe-derived terminal result.
                yield* providerRegistry.setProviderConnectionOperation({
                  instanceId: input.instanceId,
                  operation: operation({
                    operationId,
                    method: input.method,
                    status: "verifying",
                    startedAt,
                    message: "Verifying the connected provider account.",
                  }),
                });
                const refreshed = yield* providerRegistry.refreshInstance(input.instanceId);
                const refreshedProvider = refreshed.find(
                  (provider) => provider.instanceId === input.instanceId,
                );
                if (
                  refreshedProvider?.auth.required !== false &&
                  refreshedProvider?.auth.status !== "authenticated"
                ) {
                  completion = Result.fail({
                    message:
                      "The provider finished sign in, but Scient could not verify the connected account.",
                  });
                }
              }
              const finishedAt = yield* nowIso;
              yield* providerRegistry.setProviderConnectionOperation({
                instanceId: input.instanceId,
                operation: operation({
                  operationId,
                  method: input.method,
                  status: completion._tag === "Success" ? "connected" : "failed",
                  startedAt,
                  finishedAt,
                  message:
                    completion._tag === "Success"
                      ? "Provider account connected."
                      : completion.failure.message,
                }),
              });
              yield* cleanupIfCurrent(input.instanceId, operationId, "complete");
            }),
          ),
        ),
        Effect.catchCause(() =>
          transitionLock.withPermits(1)(
            Effect.gen(function* () {
              const current = (yield* Ref.get(activeRef)).get(input.instanceId);
              if (current?.operationId !== operationId) return;
              const finishedAt = yield* nowIso;
              yield* providerRegistry
                .setProviderConnectionOperation({
                  instanceId: input.instanceId,
                  operation: operation({
                    operationId,
                    method: input.method,
                    status: "failed",
                    startedAt,
                    finishedAt,
                    message: "The provider sign-in flow stopped unexpectedly.",
                  }),
                })
                .pipe(
                  Effect.ensuring(
                    cleanupIfCurrent(input.instanceId, operationId, "complete").pipe(Effect.asVoid),
                  ),
                );
              yield* Effect.logError("Provider connection supervisor failed");
            }),
          ),
        ),
      );
      const handedOff = yield* Effect.uninterruptible(
        Effect.gen(function* () {
          const fiber = yield* Effect.forkDetach(supervise);
          yield* Ref.set(fiberRef, fiber);
          const stillCurrent = (yield* Ref.get(activeRef)).get(input.instanceId)?.operationId;
          if (stillCurrent === operationId) return true;
          // Cancellation can claim the operation before this handoff begins.
          // Register the detached fiber and close that race atomically so no
          // supervisor can outlive both manager ownership and its fiber handle.
          yield* Fiber.interrupt(fiber);
          return false;
        }),
      );
      if (!handedOff) {
        return { providers: yield* providerRegistry.getProviders };
      }

      return { providers: waitingProviders };
    }).pipe(
      Effect.onExit((exit) =>
        Exit.isSuccess(exit)
          ? Effect.void
          : cleanupInterruptedStart({
              instanceId: input.instanceId,
              operationId,
              method: input.method,
              startedAt,
            }),
      ),
    );
  });

  const submitAuthorizationCode: ProviderConnectionManagerShape["submitAuthorizationCode"] =
    Effect.fn("ProviderConnectionManager.submitAuthorizationCode")(function* (input) {
      const target = yield* readTarget(input.instanceId);
      const candidate = (yield* Ref.get(activeRef)).get(input.instanceId);
      if (!candidate || candidate.operationId !== input.operationId) {
        return yield* makeError({
          provider: target.provider,
          instanceId: input.instanceId,
          reason: "operation_not_found",
          message: "The connection operation is no longer active.",
        });
      }
      const prepared = yield* candidate.transitionLock.withPermits(1)(
        Effect.gen(function* () {
          const active = (yield* Ref.get(activeRef)).get(input.instanceId);
          if (!active || active.operationId !== input.operationId) {
            return yield* makeError({
              provider: target.provider,
              instanceId: input.instanceId,
              reason: "operation_not_found",
              message: "The connection operation is no longer active.",
            });
          }
          const attempt = yield* Ref.get(active.attemptRef);
          if (!attempt?.submitAuthorizationCode) {
            return yield* makeError({
              provider: target.provider,
              instanceId: input.instanceId,
              reason: "authorization_code_not_supported",
              message: "This provider sign-in flow does not accept an authorization code.",
            });
          }

          const claimed = yield* Ref.modify(
            active.authorizationCodeSubmittedRef,
            (alreadySubmitted) => (alreadySubmitted ? [false, true] : [true, true]),
          );
          if (!claimed) {
            return yield* makeError({
              provider: target.provider,
              instanceId: input.instanceId,
              reason: "authorization_code_not_supported",
              message: "Another one-time authorization code is being submitted.",
            });
          }
          return { active, submitAuthorizationCode: attempt.submitAuthorizationCode };
        }),
      );
      const submitted = yield* prepared
        .submitAuthorizationCode(input.authorizationCode)
        .pipe(
          Effect.ensuring(Ref.set(prepared.active.authorizationCodeSubmittedRef, false)),
          Effect.result,
        );
      if (submitted._tag === "Failure") {
        return yield* makeError({
          provider: target.provider,
          instanceId: input.instanceId,
          reason: "connection_failed",
          message: submitted.failure.message,
        });
      }
      return yield* candidate.transitionLock.withPermits(1)(
        Effect.gen(function* () {
          const active = (yield* Ref.get(activeRef)).get(input.instanceId);
          if (!active || active.operationId !== input.operationId) {
            return yield* makeError({
              provider: target.provider,
              instanceId: input.instanceId,
              reason: "operation_not_found",
              message: "The connection operation is no longer active.",
            });
          }
          const previous = (yield* providerRegistry.getProviders).find(
            (provider) => provider.instanceId === input.instanceId,
          )?.connection?.operation;
          const providers = yield* providerRegistry.setProviderConnectionOperation({
            instanceId: input.instanceId,
            operation:
              previous?.operationId === input.operationId
                ? {
                    ...previous,
                    status: "verifying",
                    message: "The provider is finishing secure sign in.",
                  }
                : null,
          });
          return { providers };
        }),
      );
    });

  const cancel: ProviderConnectionManagerShape["cancel"] = Effect.fn(
    "ProviderConnectionManager.cancel",
  )(function* (input) {
    const target = yield* readTarget(input.instanceId);
    const candidate = (yield* Ref.get(activeRef)).get(input.instanceId);
    if (!candidate || candidate.operationId !== input.operationId) {
      return yield* makeError({
        provider: target.provider,
        instanceId: input.instanceId,
        reason: "operation_not_found",
        message: "The connection operation is no longer active.",
      });
    }
    const active = yield* candidate.transitionLock.withPermits(1)(
      takeIfCurrent(input.instanceId, input.operationId),
    );
    if (!active) {
      return yield* makeError({
        provider: target.provider,
        instanceId: input.instanceId,
        reason: "operation_not_found",
        message: "The connection operation is no longer active.",
      });
    }
    const providers = yield* settleActive(
      active,
      "interrupt",
      Effect.gen(function* () {
        const previousOperation = (yield* providerRegistry.getProviders).find(
          (provider) => provider.instanceId === input.instanceId,
        )?.connection?.operation;
        const finishedAt = yield* nowIso;
        return yield* providerRegistry.setProviderConnectionOperation({
          instanceId: input.instanceId,
          operation: previousOperation
            ? {
                ...previousOperation,
                status: "cancelled",
                finishedAt,
                message: "Provider sign in cancelled.",
              }
            : null,
        });
      }),
    );
    return { providers };
  });

  const disconnect: ProviderConnectionManagerShape["disconnect"] = Effect.fn(
    "ProviderConnectionManager.disconnect",
  )(function* (input) {
    const target = yield* readTarget(input.instanceId);
    if (!target.actions || !target.snapshot || target.snapshot.connection?.canDisconnect !== true) {
      return yield* makeError({
        provider: target.provider,
        instanceId: input.instanceId,
        reason: "unsupported_provider",
        message: "This provider does not support assisted disconnection yet.",
      });
    }
    const actions = target.actions;
    const operationId = `disconnect-${yield* crypto.randomUUIDv4.pipe(Effect.orDie)}`;
    const reserved = yield* lifecycleCoordinator.reserve({
      instanceId: input.instanceId,
      provider: target.provider,
      reservation: { operationId, kind: "connection" },
    });
    if (!reserved) {
      return yield* makeError({
        provider: target.provider,
        instanceId: input.instanceId,
        reason: "already_running",
        message: "Finish or cancel the active setup operation before signing out.",
      });
    }

    return yield* Effect.gen(function* () {
      const result = yield* actions.disconnect.pipe(
        Effect.scoped,
        Effect.result,
        Effect.catchCause(() =>
          Effect.succeed(
            Result.fail({
              message: "The provider sign-out flow stopped unexpectedly.",
            }),
          ),
        ),
      );
      if (result._tag === "Failure") {
        return yield* makeError({
          provider: target.provider,
          instanceId: input.instanceId,
          reason: "disconnect_failed",
          message: result.failure.message,
        });
      }
      yield* providerRegistry.setProviderConnectionOperation({
        instanceId: input.instanceId,
        operation: null,
      });
      return { providers: yield* providerRegistry.refreshInstance(input.instanceId) };
    }).pipe(Effect.ensuring(lifecycleCoordinator.release({ operationId }).pipe(Effect.asVoid)));
  });

  return ProviderConnectionManager.of({ start, cancel, submitAuthorizationCode, disconnect });
});

export const layer = Layer.effect(ProviderConnectionManager, make());
