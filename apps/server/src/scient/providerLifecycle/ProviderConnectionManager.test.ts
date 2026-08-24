import { describe, it, assert } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderConnectionOperation,
  type ServerProvider,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import {
  ProviderRegistry,
  type ProviderRegistryShape,
} from "../../provider/Services/ProviderRegistry.ts";
import { makeManualOnlyProviderMaintenanceCapabilities } from "../../provider/providerMaintenance.ts";
import { type ProviderConnectionActions } from "../../provider/ProviderDriver.ts";
import { ProviderConnectionActionError } from "./ProviderConnectionActions.ts";
import { make } from "./ProviderConnectionManager.ts";
import {
  make as makeLifecycleCoordinator,
  ProviderLifecycleCoordinator,
} from "./ProviderLifecycleCoordinator.ts";

const CODEX = ProviderDriverKind.make("codex");
const CODEX_INSTANCE = ProviderInstanceId.make("codex");

const disconnectedProvider: ServerProvider = {
  instanceId: CODEX_INSTANCE,
  driver: CODEX,
  enabled: true,
  installed: true,
  version: "0.147.0",
  status: "warning",
  auth: { status: "unauthenticated", required: true },
  checkedAt: "2026-08-09T00:00:00.000Z",
  models: [],
  slashCommands: [],
  skills: [],
  connection: {
    methods: ["codex_browser", "codex_device_code"],
    canDisconnect: false,
    operation: null,
  },
};

const authenticatedProvider = (provider: ServerProvider): ServerProvider => ({
  ...provider,
  status: "ready",
  auth: { status: "authenticated", required: true },
  ...(provider.connection ? { connection: { ...provider.connection, canDisconnect: true } } : {}),
});

const yieldUntil = <A>(
  effect: Effect.Effect<A, never, never>,
  predicate: (value: A) => boolean,
): Effect.Effect<A, never, never> =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const value = yield* effect;
      if (predicate(value)) {
        return value;
      }
      yield* Effect.yieldNow;
    }
    return yield* Effect.die(new Error("Timed out waiting for provider connection state."));
  });

function makeHarness(options?: {
  readonly provider?: ServerProvider;
  readonly actions?: ProviderConnectionActions | undefined;
  readonly beforeSetProviderConnectionOperation?: (
    operation: ProviderConnectionOperation | null,
  ) => Effect.Effect<void>;
  readonly beforeRefreshInstance?: (
    instanceId: ProviderInstanceId,
    refreshCount: number,
  ) => Effect.Effect<void>;
  readonly refreshProvider?: (provider: ServerProvider, refreshCount: number) => ServerProvider;
}) {
  return Effect.gen(function* () {
    const providersRef = yield* Ref.make<ReadonlyArray<ServerProvider>>([
      options?.provider ?? disconnectedProvider,
    ]);
    const transitionsRef = yield* Ref.make<ReadonlyArray<ProviderConnectionOperation | null>>([]);
    const refreshCountRef = yield* Ref.make(0);

    const setProviderConnectionOperation: ProviderRegistryShape["setProviderConnectionOperation"] =
      (input) =>
        Effect.gen(function* () {
          yield* options?.beforeSetProviderConnectionOperation?.(input.operation) ?? Effect.void;
          yield* Ref.update(transitionsRef, (transitions) => [...transitions, input.operation]);
          return yield* Ref.updateAndGet(providersRef, (providers) =>
            providers.map((provider) =>
              provider.instanceId === input.instanceId && provider.connection
                ? {
                    ...provider,
                    connection: { ...provider.connection, operation: input.operation },
                  }
                : provider,
            ),
          );
        });

    const registry: ProviderRegistryShape = {
      getProviders: Ref.get(providersRef),
      refresh: () => Ref.get(providersRef),
      refreshInstance: (instanceId) =>
        Effect.gen(function* () {
          const refreshCount = yield* Ref.updateAndGet(refreshCountRef, (count) => count + 1);
          yield* options?.beforeRefreshInstance?.(instanceId, refreshCount) ?? Effect.void;
          return yield* Ref.updateAndGet(providersRef, (providers) =>
            providers.map((provider) =>
              provider.instanceId === instanceId
                ? (options?.refreshProvider?.(provider, refreshCount) ?? provider)
                : provider,
            ),
          );
        }),
      reloadInstance: () => Ref.get(providersRef),
      getProviderMaintenanceCapabilitiesForInstance: (_instanceId, provider) =>
        Effect.succeed(
          makeManualOnlyProviderMaintenanceCapabilities({ provider, packageName: null }),
        ),
      getProviderConnectionActionsForInstance: () => Effect.succeed(options?.actions),
      getProviderManagedRuntimeActionsForInstance: () => Effect.succeed(undefined),
      stopProviderSessions: () => Effect.void,
      setProviderManagedRuntimeSummary: () => Effect.succeed([]),
      setProviderMaintenanceActionState: () => Ref.get(providersRef),
      setProviderConnectionOperation,
      streamChanges: Stream.empty,
    };

    const lifecycleCoordinator = yield* makeLifecycleCoordinator;
    const lifecycleReleaseCountRef = yield* Ref.make(0);
    const trackedLifecycleCoordinator = ProviderLifecycleCoordinator.of({
      ...lifecycleCoordinator,
      release: (input) =>
        Ref.update(lifecycleReleaseCountRef, (count) => count + 1).pipe(
          Effect.andThen(lifecycleCoordinator.release(input)),
        ),
    });
    const managerScope = yield* Scope.make();
    yield* Effect.addFinalizer(() => Scope.close(managerScope, Exit.void));
    const manager = yield* make().pipe(
      Effect.provideService(ProviderRegistry, registry),
      Effect.provideService(ProviderLifecycleCoordinator, trackedLifecycleCoordinator),
      Effect.provide(NodeServices.layer),
      Scope.provide(managerScope),
    );
    return {
      manager,
      providersRef,
      transitionsRef,
      refreshCountRef,
      lifecycleCoordinator: trackedLifecycleCoordinator,
      lifecycleReleaseCountRef,
      closeManager: Scope.close(managerScope, Exit.void),
    };
  });
}

describe("ProviderConnectionManager", () => {
  it.effect(
    "publishes waiting, verifying, and connected states around one provider-owned flow",
    () =>
      Effect.gen(function* () {
        const completed = yield* Deferred.make<void, ProviderConnectionActionError>();
        const actions: ProviderConnectionActions = {
          methods: ["codex_browser", "codex_device_code"],
          start: () =>
            Effect.succeed({
              authorizationUrl: "https://auth.openai.com/",
              authorizationUrlKind: "primary",
              initialStatus: "waiting_for_browser",
              waitForCompletion: Deferred.await(completed),
              cancel: Effect.void,
            }),
          disconnect: Effect.void,
        };
        const { manager, transitionsRef, refreshCountRef } = yield* makeHarness({
          actions,
          refreshProvider: (provider, refreshCount) =>
            refreshCount >= 2 ? authenticatedProvider(provider) : provider,
        });

        const started = yield* manager.start({
          instanceId: CODEX_INSTANCE,
          method: "codex_browser",
        });
        assert.strictEqual(
          started.providers[0]?.connection?.operation?.status,
          "waiting_for_browser",
        );
        assert.strictEqual(
          started.providers[0]?.connection?.operation?.authorizationUrl,
          "https://auth.openai.com/",
        );
        assert.strictEqual(
          started.providers[0]?.connection?.operation?.authorizationUrlKind,
          "primary",
        );
        assert.strictEqual(
          started.providers[0]?.connection?.operation?.acceptsAuthorizationCode,
          false,
        );

        yield* Deferred.succeed(completed, undefined);
        const transitions = yield* yieldUntil(Ref.get(transitionsRef), (items) =>
          items.some((item) => item?.status === "connected"),
        );
        assert.deepStrictEqual(
          transitions.map((item) => item?.status ?? null),
          ["starting", "waiting_for_browser", "verifying", "connected"],
        );
        assert.strictEqual(yield* Ref.get(refreshCountRef), 2);
      }),
  );

  it.effect("publishes Grok device-code state and the provider-owned user code", () =>
    Effect.gen(function* () {
      const completed = yield* Deferred.make<void, ProviderConnectionActionError>();
      const grokProvider: ServerProvider = {
        ...disconnectedProvider,
        driver: ProviderDriverKind.make("grok"),
        connection: {
          methods: ["grok_account", "grok_device_code"],
          canDisconnect: false,
          operation: null,
        },
      };
      const actions: ProviderConnectionActions = {
        methods: ["grok_account", "grok_device_code"],
        start: () =>
          Effect.succeed({
            authorizationUrl: "https://accounts.x.ai/device?user_code=GROK-1234",
            authorizationUrlKind: "manual_fallback",
            initialStatus: "waiting_for_device_code",
            userCode: "GROK-1234",
            waitForCompletion: Deferred.await(completed),
            cancel: Effect.void,
          }),
        disconnect: Effect.void,
      };
      const { manager, transitionsRef } = yield* makeHarness({
        actions,
        provider: grokProvider,
        refreshProvider: (provider, refreshCount) =>
          refreshCount >= 2 ? authenticatedProvider(provider) : provider,
      });

      const started = yield* manager.start({
        instanceId: CODEX_INSTANCE,
        method: "grok_device_code",
      });
      assert.strictEqual(
        started.providers[0]?.connection?.operation?.status,
        "waiting_for_device_code",
      );
      assert.strictEqual(started.providers[0]?.connection?.operation?.userCode, "GROK-1234");

      yield* Deferred.succeed(completed, undefined);
      yield* yieldUntil(Ref.get(transitionsRef), (items) =>
        items.some((item) => item?.status === "connected"),
      );
    }),
  );

  it.effect("verifies an account that connects before the provider publishes a page", () =>
    Effect.gen(function* () {
      const completed = yield* Deferred.make<void, ProviderConnectionActionError>();
      const actions: ProviderConnectionActions = {
        methods: ["grok_account"],
        start: () =>
          Effect.succeed({
            initialStatus: "verifying",
            waitForCompletion: Deferred.await(completed),
            cancel: Effect.void,
          }),
        disconnect: Effect.void,
      };
      const { manager, transitionsRef } = yield* makeHarness({
        actions,
        refreshProvider: (provider, refreshCount) =>
          refreshCount >= 2 ? authenticatedProvider(provider) : provider,
      });

      const started = yield* manager.start({
        instanceId: CODEX_INSTANCE,
        method: "grok_account",
      });
      assert.strictEqual(started.providers[0]?.connection?.operation?.status, "verifying");
      assert.strictEqual(started.providers[0]?.connection?.operation?.authorizationUrl, undefined);

      yield* Deferred.succeed(completed, undefined);
      yield* yieldUntil(Ref.get(transitionsRef), (items) =>
        items.some((item) => item?.status === "connected"),
      );
    }),
  );

  it.effect("forwards an optional authorization code only to the matching live attempt", () =>
    Effect.gen(function* () {
      const completed = yield* Deferred.make<void, ProviderConnectionActionError>();
      const submittedCode = yield* Ref.make<string | null>(null);
      const actions: ProviderConnectionActions = {
        methods: ["claude_subscription"],
        start: () =>
          Effect.succeed({
            authorizationUrl: "https://claude.ai/oauth/authorize",
            authorizationUrlKind: "manual_fallback",
            initialStatus: "waiting_for_browser",
            submitAuthorizationCode: (code) => Ref.set(submittedCode, code),
            waitForCompletion: Deferred.await(completed),
            cancel: Effect.void,
          }),
        disconnect: Effect.void,
      };
      const { manager } = yield* makeHarness({
        actions,
        provider: {
          ...disconnectedProvider,
          driver: ProviderDriverKind.make("claudeAgent"),
          connection: {
            methods: ["claude_subscription"],
            canDisconnect: false,
            operation: null,
          },
        },
      });
      const started = yield* manager.start({
        instanceId: CODEX_INSTANCE,
        method: "claude_subscription",
      });
      const operationId = started.providers[0]?.connection?.operation?.operationId;
      assert.ok(operationId);
      assert.strictEqual(
        started.providers[0]?.connection?.operation?.authorizationUrlKind,
        "manual_fallback",
      );
      assert.strictEqual(
        started.providers[0]?.connection?.operation?.acceptsAuthorizationCode,
        true,
      );

      const wrongOperation = yield* manager
        .submitAuthorizationCode({
          instanceId: CODEX_INSTANCE,
          operationId: "not-current",
          authorizationCode: "must-not-be-forwarded",
        })
        .pipe(Effect.flip);
      assert.strictEqual(wrongOperation.reason, "operation_not_found");
      assert.strictEqual(yield* Ref.get(submittedCode), null);

      const submitted = yield* manager.submitAuthorizationCode({
        instanceId: CODEX_INSTANCE,
        operationId,
        authorizationCode: "one-time-code",
      });
      assert.strictEqual(yield* Ref.get(submittedCode), "one-time-code");
      assert.strictEqual(submitted.providers[0]?.connection?.operation?.status, "verifying");

      yield* manager.submitAuthorizationCode({
        instanceId: CODEX_INSTANCE,
        operationId,
        authorizationCode: "second-code",
      });
      assert.strictEqual(yield* Ref.get(submittedCode), "second-code");

      yield* Deferred.succeed(completed, undefined);
    }),
  );

  it.effect("allows the user to retry when forwarding the authorization code fails", () =>
    Effect.gen(function* () {
      const completed = yield* Deferred.make<void, ProviderConnectionActionError>();
      const submittedCodes = yield* Ref.make<ReadonlyArray<string>>([]);
      const actions: ProviderConnectionActions = {
        methods: ["claude_console"],
        start: () =>
          Effect.succeed({
            authorizationUrl: "https://platform.claude.com/oauth/authorize",
            authorizationUrlKind: "manual_fallback",
            initialStatus: "waiting_for_browser",
            submitAuthorizationCode: (code) =>
              Ref.updateAndGet(submittedCodes, (codes) => [...codes, code]).pipe(
                Effect.flatMap((codes) =>
                  codes.length === 1
                    ? Effect.fail(
                        new ProviderConnectionActionError({
                          message: "The Claude login process was not ready for the code.",
                        }),
                      )
                    : Effect.void,
                ),
              ),
            waitForCompletion: Deferred.await(completed),
            cancel: Effect.void,
          }),
        disconnect: Effect.void,
      };
      const { manager } = yield* makeHarness({
        actions,
        provider: {
          ...disconnectedProvider,
          driver: ProviderDriverKind.make("claudeAgent"),
          connection: {
            methods: ["claude_console"],
            canDisconnect: false,
            operation: null,
          },
        },
      });
      const started = yield* manager.start({
        instanceId: CODEX_INSTANCE,
        method: "claude_console",
      });
      const operationId = started.providers[0]?.connection?.operation?.operationId;
      assert.ok(operationId);

      const first = yield* manager
        .submitAuthorizationCode({
          instanceId: CODEX_INSTANCE,
          operationId,
          authorizationCode: "first-code",
        })
        .pipe(Effect.flip);
      assert.strictEqual(first.reason, "connection_failed");

      yield* manager.submitAuthorizationCode({
        instanceId: CODEX_INSTANCE,
        operationId,
        authorizationCode: "second-code",
      });
      assert.deepStrictEqual(yield* Ref.get(submittedCodes), ["first-code", "second-code"]);

      yield* Deferred.succeed(completed, undefined);
    }),
  );

  it.effect("serializes fallback-code writes to the live Claude process", () =>
    Effect.gen(function* () {
      const completed = yield* Deferred.make<void, ProviderConnectionActionError>();
      const codeStarted = yield* Deferred.make<void>();
      const releaseCode = yield* Deferred.make<void>();
      const actions: ProviderConnectionActions = {
        methods: ["claude_subscription"],
        start: () =>
          Effect.succeed({
            authorizationUrl: "https://claude.ai/oauth/authorize",
            authorizationUrlKind: "manual_fallback",
            initialStatus: "waiting_for_browser",
            submitAuthorizationCode: () =>
              Deferred.succeed(codeStarted, undefined).pipe(
                Effect.andThen(Deferred.await(releaseCode)),
              ),
            waitForCompletion: Deferred.await(completed),
            cancel: Effect.void,
          }),
        disconnect: Effect.void,
      };
      const { manager } = yield* makeHarness({
        actions,
        provider: {
          ...disconnectedProvider,
          driver: ProviderDriverKind.make("claudeAgent"),
          connection: {
            methods: ["claude_subscription"],
            canDisconnect: false,
            operation: null,
          },
        },
      });
      const started = yield* manager.start({
        instanceId: CODEX_INSTANCE,
        method: "claude_subscription",
      });
      const operationId = started.providers[0]?.connection?.operation?.operationId;
      assert.ok(operationId);

      const first = yield* manager
        .submitAuthorizationCode({
          instanceId: CODEX_INSTANCE,
          operationId,
          authorizationCode: "first-code",
        })
        .pipe(Effect.forkChild);
      yield* Deferred.await(codeStarted);
      const overlapping = yield* manager
        .submitAuthorizationCode({
          instanceId: CODEX_INSTANCE,
          operationId,
          authorizationCode: "overlapping-code",
        })
        .pipe(Effect.flip);
      assert.strictEqual(overlapping.reason, "authorization_code_not_supported");

      yield* Deferred.succeed(releaseCode, undefined);
      yield* Fiber.join(first);
      yield* Deferred.succeed(completed, undefined);
    }),
  );

  it.effect("rejects a duplicate operation and cancels only the matching active operation", () =>
    Effect.gen(function* () {
      const completed = yield* Deferred.make<void, ProviderConnectionActionError>();
      const cancelled = yield* Deferred.make<void>();
      const actions: ProviderConnectionActions = {
        methods: ["codex_browser"],
        start: () =>
          Effect.succeed({
            authorizationUrl: "https://auth.openai.com/",
            authorizationUrlKind: "primary",
            initialStatus: "waiting_for_browser",
            waitForCompletion: Deferred.await(completed),
            cancel: Deferred.succeed(cancelled, undefined).pipe(Effect.asVoid),
          }),
        disconnect: Effect.void,
      };
      const { manager, transitionsRef } = yield* makeHarness({ actions });
      const started = yield* manager.start({
        instanceId: CODEX_INSTANCE,
        method: "codex_browser",
      });
      const operationId = started.providers[0]?.connection?.operation?.operationId;
      assert.ok(operationId);

      const duplicate = yield* manager
        .start({ instanceId: CODEX_INSTANCE, method: "codex_browser" })
        .pipe(Effect.flip);
      assert.strictEqual(duplicate.reason, "already_running");

      const wrongCancel = yield* manager
        .cancel({ instanceId: CODEX_INSTANCE, operationId: "not-current" })
        .pipe(Effect.flip);
      assert.strictEqual(wrongCancel.reason, "operation_not_found");

      const cancelledResult = yield* manager.cancel({
        instanceId: CODEX_INSTANCE,
        operationId,
      });
      assert.strictEqual(cancelledResult.providers[0]?.connection?.operation?.status, "cancelled");
      assert.strictEqual(yield* Deferred.isDone(cancelled), true);

      yield* Deferred.succeed(completed, undefined);
      yield* Effect.yieldNow;
      const transitions = yield* Ref.get(transitionsRef);
      assert.strictEqual(transitions.at(-1)?.status, "cancelled");
    }),
  );

  it.effect("bounds an unresponsive provider cancellation before publishing cancelled", () =>
    Effect.gen(function* () {
      const attemptCancellations = yield* Ref.make(0);
      const actions: ProviderConnectionActions = {
        methods: ["codex_browser"],
        start: () =>
          Effect.succeed({
            authorizationUrl: "https://auth.openai.com/",
            authorizationUrlKind: "primary",
            initialStatus: "waiting_for_browser",
            waitForCompletion: Effect.never,
            cancel: Ref.update(attemptCancellations, (count) => count + 1).pipe(
              Effect.andThen(Effect.never),
            ),
          }),
        disconnect: Effect.void,
      };
      const { manager, lifecycleCoordinator, lifecycleReleaseCountRef } = yield* makeHarness({
        actions,
      });
      const started = yield* manager.start({
        instanceId: CODEX_INSTANCE,
        method: "codex_browser",
      });
      const operationId = started.providers[0]?.connection?.operation?.operationId;
      assert.ok(operationId);

      const cancelFiber = yield* manager
        .cancel({ instanceId: CODEX_INSTANCE, operationId })
        .pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      assert.strictEqual(yield* Ref.get(attemptCancellations), 1);
      yield* TestClock.adjust("5 seconds");
      const cancelled = yield* Fiber.join(cancelFiber);

      assert.strictEqual(cancelled.providers[0]?.connection?.operation?.status, "cancelled");
      assert.strictEqual(yield* lifecycleCoordinator.current(CODEX_INSTANCE), undefined);
      assert.strictEqual(yield* Ref.get(lifecycleReleaseCountRef), 1);
    }),
  );

  it.effect(
    "keeps cancellation authoritative when completion resolves before supervision runs",
    () =>
      Effect.gen(function* () {
        const completed = yield* Deferred.make<void, ProviderConnectionActionError>();
        const scopeClosures = yield* Ref.make(0);
        const actions: ProviderConnectionActions = {
          methods: ["codex_browser"],
          start: () =>
            Effect.addFinalizer(() => Ref.update(scopeClosures, (count) => count + 1)).pipe(
              Effect.as({
                authorizationUrl: "https://auth.openai.com/",
                authorizationUrlKind: "primary" as const,
                initialStatus: "waiting_for_browser" as const,
                waitForCompletion: Deferred.await(completed),
                cancel: Effect.void,
              }),
            ),
          disconnect: Effect.void,
        };
        const { manager, transitionsRef, lifecycleCoordinator, lifecycleReleaseCountRef } =
          yield* makeHarness({ actions });
        const started = yield* manager.start({
          instanceId: CODEX_INSTANCE,
          method: "codex_browser",
        });
        const operationId = started.providers[0]?.connection?.operation?.operationId;
        assert.ok(operationId);

        yield* Deferred.succeed(completed, undefined);
        const cancelled = yield* manager.cancel({ instanceId: CODEX_INSTANCE, operationId });
        yield* Effect.yieldNow;

        assert.strictEqual(cancelled.providers[0]?.connection?.operation?.status, "cancelled");
        assert.deepStrictEqual(
          (yield* Ref.get(transitionsRef)).map((item) => item?.status ?? null),
          ["starting", "waiting_for_browser", "cancelled"],
        );
        assert.strictEqual(yield* Ref.get(scopeClosures), 1);
        assert.strictEqual(yield* lifecycleCoordinator.current(CODEX_INSTANCE), undefined);
        assert.strictEqual(yield* Ref.get(lifecycleReleaseCountRef), 1);
      }),
  );

  it.effect(
    "preserves verified connection truth when cancellation arrives during verification",
    () =>
      Effect.gen(function* () {
        const completed = yield* Deferred.make<void, ProviderConnectionActionError>();
        const verificationStarted = yield* Deferred.make<void>();
        const releaseVerification = yield* Deferred.make<void>();
        const actions: ProviderConnectionActions = {
          methods: ["codex_browser"],
          start: () =>
            Effect.succeed({
              authorizationUrl: "https://auth.openai.com/",
              authorizationUrlKind: "primary",
              initialStatus: "waiting_for_browser",
              waitForCompletion: Deferred.await(completed),
              cancel: Effect.void,
            }),
          disconnect: Effect.void,
        };
        const {
          manager,
          providersRef,
          transitionsRef,
          lifecycleCoordinator,
          lifecycleReleaseCountRef,
        } = yield* makeHarness({
          actions,
          beforeRefreshInstance: (_instanceId, refreshCount) =>
            refreshCount === 2
              ? Deferred.succeed(verificationStarted, undefined).pipe(
                  Effect.andThen(Deferred.await(releaseVerification)),
                )
              : Effect.void,
          refreshProvider: (provider, refreshCount) =>
            refreshCount === 2 ? authenticatedProvider(provider) : provider,
        });
        const started = yield* manager.start({
          instanceId: CODEX_INSTANCE,
          method: "codex_browser",
        });
        const operationId = started.providers[0]?.connection?.operation?.operationId;
        assert.ok(operationId);

        yield* Deferred.succeed(completed, undefined);
        yield* Deferred.await(verificationStarted);
        const cancelFiber = yield* manager
          .cancel({ instanceId: CODEX_INSTANCE, operationId })
          .pipe(Effect.result, Effect.forkChild);
        yield* Effect.yieldNow;
        yield* Deferred.succeed(releaseVerification, undefined);
        const cancelResult = yield* Fiber.join(cancelFiber);

        assert.strictEqual(cancelResult._tag, "Failure");
        if (cancelResult._tag === "Failure") {
          assert.strictEqual(cancelResult.failure.reason, "operation_not_found");
        }
        assert.strictEqual(
          (yield* Ref.get(providersRef))[0]?.connection?.operation?.status,
          "connected",
        );
        assert.deepStrictEqual(
          (yield* Ref.get(transitionsRef)).map((item) => item?.status ?? null),
          ["starting", "waiting_for_browser", "verifying", "connected"],
        );
        assert.strictEqual(yield* lifecycleCoordinator.current(CODEX_INSTANCE), undefined);
        assert.strictEqual(yield* Ref.get(lifecycleReleaseCountRef), 1);
      }),
  );

  it.effect(
    "shuts down an active connection without leaving resources or publishing a false failure",
    () =>
      Effect.gen(function* () {
        const attemptCancellations = yield* Ref.make(0);
        const supervisorInterruptions = yield* Ref.make(0);
        const operationScopeClosures = yield* Ref.make(0);
        const supervisorStarted = yield* Deferred.make<void>();
        const actions: ProviderConnectionActions = {
          methods: ["codex_browser"],
          start: () =>
            Effect.gen(function* () {
              yield* Effect.addFinalizer(() =>
                Ref.update(operationScopeClosures, (count) => count + 1),
              );
              return {
                authorizationUrl: "https://auth.openai.com/",
                authorizationUrlKind: "primary" as const,
                initialStatus: "waiting_for_browser" as const,
                waitForCompletion: Deferred.succeed(supervisorStarted, undefined).pipe(
                  Effect.andThen(Effect.never),
                  Effect.onInterrupt(() =>
                    Ref.update(supervisorInterruptions, (count) => count + 1),
                  ),
                ),
                cancel: Ref.update(attemptCancellations, (count) => count + 1).pipe(
                  Effect.andThen(Effect.never),
                ),
              };
            }),
          disconnect: Effect.void,
        };
        const { manager, transitionsRef, lifecycleCoordinator, closeManager } = yield* makeHarness({
          actions,
        });
        const started = yield* manager.start({
          instanceId: CODEX_INSTANCE,
          method: "codex_browser",
        });
        const operationId = started.providers[0]?.connection?.operation?.operationId;
        assert.ok(operationId);
        yield* Deferred.await(supervisorStarted);

        const closeFiber = yield* closeManager.pipe(Effect.forkChild);
        yield* Effect.yieldNow;
        yield* TestClock.adjust("5 seconds");
        yield* Fiber.join(closeFiber);

        assert.strictEqual(yield* Ref.get(attemptCancellations), 1);
        assert.strictEqual(yield* Ref.get(supervisorInterruptions), 1);
        assert.strictEqual(yield* Ref.get(operationScopeClosures), 1);
        assert.strictEqual(yield* lifecycleCoordinator.current(CODEX_INSTANCE), undefined);
        assert.deepStrictEqual(
          (yield* Ref.get(transitionsRef)).map((item) => item?.status ?? null),
          ["starting", "waiting_for_browser"],
        );
        const inactive = yield* manager
          .cancel({ instanceId: CODEX_INSTANCE, operationId })
          .pipe(Effect.flip);
        assert.strictEqual(inactive.reason, "operation_not_found");

        yield* closeManager;
        assert.strictEqual(yield* Ref.get(attemptCancellations), 1);
        assert.strictEqual(yield* Ref.get(supervisorInterruptions), 1);
        assert.strictEqual(yield* Ref.get(operationScopeClosures), 1);
      }),
  );

  it.effect("does not resurrect a browser flow cancelled while the provider is starting", () =>
    Effect.gen(function* () {
      const startReleased = yield* Deferred.make<void>();
      const providerCancelled = yield* Deferred.make<void>();
      const actions: ProviderConnectionActions = {
        methods: ["codex_browser"],
        start: () =>
          Deferred.await(startReleased).pipe(
            Effect.as({
              authorizationUrl: "https://auth.openai.com/",
              authorizationUrlKind: "primary" as const,
              initialStatus: "waiting_for_browser" as const,
              waitForCompletion: Effect.never,
              cancel: Deferred.succeed(providerCancelled, undefined).pipe(Effect.asVoid),
            }),
          ),
        disconnect: Effect.void,
      };
      const { manager, providersRef, transitionsRef } = yield* makeHarness({ actions });

      const startFiber = yield* manager
        .start({ instanceId: CODEX_INSTANCE, method: "codex_browser" })
        .pipe(Effect.forkChild);
      const starting = yield* yieldUntil(
        Ref.get(providersRef),
        (providers) => providers[0]?.connection?.operation?.status === "starting",
      );
      const operationId = starting[0]?.connection?.operation?.operationId;
      assert.ok(operationId);

      yield* manager.cancel({ instanceId: CODEX_INSTANCE, operationId });
      yield* Deferred.succeed(startReleased, undefined);
      const result = yield* Fiber.join(startFiber);

      assert.strictEqual(result.providers[0]?.connection?.operation?.status, "cancelled");
      assert.strictEqual(yield* Deferred.isDone(providerCancelled), true);
      assert.deepStrictEqual(
        (yield* Ref.get(transitionsRef)).map((item) => item?.status ?? null),
        ["starting", "cancelled"],
      );
    }),
  );

  it.effect("serializes cancellation with publishing the browser-ready state", () =>
    Effect.gen(function* () {
      const waitingPublishStarted = yield* Deferred.make<void>();
      const releaseWaitingPublish = yield* Deferred.make<void>();
      const providerCancelled = yield* Deferred.make<void>();
      const actions: ProviderConnectionActions = {
        methods: ["claude_subscription"],
        start: () =>
          Effect.succeed({
            authorizationUrl: "https://claude.ai/oauth/authorize",
            authorizationUrlKind: "manual_fallback",
            initialStatus: "waiting_for_browser",
            waitForCompletion: Effect.never,
            cancel: Deferred.succeed(providerCancelled, undefined).pipe(Effect.asVoid),
          }),
        disconnect: Effect.void,
      };
      const { manager, providersRef, transitionsRef } = yield* makeHarness({
        actions,
        provider: {
          ...disconnectedProvider,
          driver: ProviderDriverKind.make("claudeAgent"),
          connection: {
            methods: ["claude_subscription"],
            canDisconnect: false,
            operation: null,
          },
        },
        beforeSetProviderConnectionOperation: (operation) =>
          operation?.status === "waiting_for_browser"
            ? Deferred.succeed(waitingPublishStarted, undefined).pipe(
                Effect.andThen(Deferred.await(releaseWaitingPublish)),
              )
            : Effect.void,
      });

      const startFiber = yield* manager
        .start({ instanceId: CODEX_INSTANCE, method: "claude_subscription" })
        .pipe(Effect.forkChild);
      yield* Deferred.await(waitingPublishStarted);
      const operationId = (yield* Ref.get(providersRef))[0]?.connection?.operation?.operationId;
      assert.ok(operationId);

      const cancelFiber = yield* manager
        .cancel({ instanceId: CODEX_INSTANCE, operationId })
        .pipe(Effect.forkChild);
      yield* Deferred.succeed(releaseWaitingPublish, undefined);
      const [started, cancelled] = yield* Effect.all(
        [Fiber.join(startFiber), Fiber.join(cancelFiber)],
        { concurrency: "unbounded" },
      );

      assert.strictEqual(
        started.providers[0]?.connection?.operation?.status,
        "waiting_for_browser",
      );
      assert.strictEqual(cancelled.providers[0]?.connection?.operation?.status, "cancelled");
      assert.strictEqual(
        (yield* Ref.get(providersRef))[0]?.connection?.operation?.status,
        "cancelled",
      );
      assert.strictEqual(yield* Deferred.isDone(providerCancelled), true);
      assert.deepStrictEqual(
        (yield* Ref.get(transitionsRef)).map((item) => item?.status ?? null),
        ["starting", "waiting_for_browser", "cancelled"],
      );
    }),
  );

  it.effect("cleans up a failed start so the user can retry", () =>
    Effect.gen(function* () {
      let starts = 0;
      const actions: ProviderConnectionActions = {
        methods: ["codex_browser"],
        start: () => {
          starts += 1;
          return Effect.fail(
            new ProviderConnectionActionError({ message: "The provider rejected sign in." }),
          );
        },
        disconnect: Effect.void,
      };
      const { manager, transitionsRef } = yield* makeHarness({ actions });

      const first = yield* manager
        .start({ instanceId: CODEX_INSTANCE, method: "codex_browser" })
        .pipe(Effect.flip);
      const second = yield* manager
        .start({ instanceId: CODEX_INSTANCE, method: "codex_browser" })
        .pipe(Effect.flip);
      assert.strictEqual(first.reason, "connection_failed");
      assert.strictEqual(second.reason, "connection_failed");
      assert.strictEqual(starts, 2);
      assert.deepStrictEqual(
        (yield* Ref.get(transitionsRef)).map((item) => item?.status ?? null),
        ["starting", "failed", "starting", "failed"],
      );
    }),
  );

  it.effect("supports provider-owned browser launch without publishing an invented URL", () =>
    Effect.gen(function* () {
      const actions: ProviderConnectionActions = {
        methods: ["droid_device_pairing"],
        start: () =>
          Effect.succeed({
            initialStatus: "waiting_for_browser",
            waitForCompletion: Effect.never,
            cancel: Effect.void,
          }),
        disconnect: Effect.void,
      };
      const { manager } = yield* makeHarness({
        actions,
        provider: {
          ...disconnectedProvider,
          driver: ProviderDriverKind.make("droid"),
          connection: {
            methods: ["droid_device_pairing"],
            canDisconnect: false,
            operation: null,
          },
        },
      });

      const started = yield* manager.start({
        instanceId: CODEX_INSTANCE,
        method: "droid_device_pairing",
      });
      const operation = started.providers[0]?.connection?.operation;
      assert.strictEqual(operation?.status, "waiting_for_browser");
      assert.strictEqual(operation?.authorizationUrl, undefined);
      assert.strictEqual(operation?.authorizationUrlKind, undefined);
      assert.strictEqual(operation?.acceptsAuthorizationCode, false);

      assert.ok(operation?.operationId);
      yield* manager.cancel({
        instanceId: CODEX_INSTANCE,
        operationId: operation.operationId,
      });
    }),
  );

  it.effect("releases the connection reservation when starting is interrupted", () =>
    Effect.gen(function* () {
      const interrupted = yield* Deferred.make<void>();
      const starts = yield* Ref.make(0);
      const actions: ProviderConnectionActions = {
        methods: ["codex_browser"],
        start: () =>
          Ref.updateAndGet(starts, (count) => count + 1).pipe(
            Effect.flatMap((count) =>
              count === 1
                ? Effect.never.pipe(
                    Effect.onInterrupt(() =>
                      Deferred.succeed(interrupted, undefined).pipe(Effect.asVoid),
                    ),
                  )
                : Effect.fail(
                    new ProviderConnectionActionError({ message: "Second start reached." }),
                  ),
            ),
          ),
        disconnect: Effect.void,
      };
      const { manager, providersRef } = yield* makeHarness({ actions });

      const first = yield* manager
        .start({ instanceId: CODEX_INSTANCE, method: "codex_browser" })
        .pipe(Effect.forkChild);
      yield* yieldUntil(
        Ref.get(providersRef),
        (providers) => providers[0]?.connection?.operation?.status === "starting",
      );
      yield* Fiber.interrupt(first);
      yield* Deferred.await(interrupted);

      const retry = yield* manager
        .start({ instanceId: CODEX_INSTANCE, method: "codex_browser" })
        .pipe(Effect.flip);
      assert.strictEqual(retry.reason, "connection_failed");
      assert.strictEqual(retry.message, "Second start reached.");
      assert.strictEqual(yield* Ref.get(starts), 2);
    }),
  );

  it.effect("releases the connection reservation when initial publication is interrupted", () =>
    Effect.gen(function* () {
      const publicationStarted = yield* Deferred.make<void>();
      const actions: ProviderConnectionActions = {
        methods: ["codex_browser"],
        start: () => Effect.die("must not start"),
        disconnect: Effect.void,
      };
      const { manager, lifecycleCoordinator } = yield* makeHarness({
        actions,
        beforeSetProviderConnectionOperation: (operation) =>
          operation?.status === "starting"
            ? Deferred.succeed(publicationStarted, undefined).pipe(Effect.andThen(Effect.never))
            : Effect.void,
      });

      const startFiber = yield* manager
        .start({ instanceId: CODEX_INSTANCE, method: "codex_browser" })
        .pipe(Effect.forkChild);
      yield* Deferred.await(publicationStarted);
      yield* Fiber.interrupt(startFiber);

      assert.strictEqual(yield* lifecycleCoordinator.current(CODEX_INSTANCE), undefined);
    }),
  );

  it.effect("fails completion when the single post-auth refresh cannot verify the account", () =>
    Effect.gen(function* () {
      const completed = yield* Deferred.make<void, ProviderConnectionActionError>();
      const actions: ProviderConnectionActions = {
        methods: ["droid_device_pairing"],
        start: () =>
          Effect.succeed({
            initialStatus: "waiting_for_browser",
            waitForCompletion: Deferred.await(completed),
            cancel: Effect.void,
          }),
        disconnect: Effect.void,
      };
      const { manager, transitionsRef, refreshCountRef } = yield* makeHarness({
        actions,
        provider: {
          ...disconnectedProvider,
          driver: ProviderDriverKind.make("droid"),
          connection: {
            methods: ["droid_device_pairing"],
            canDisconnect: false,
            operation: null,
          },
        },
      });

      yield* manager.start({
        instanceId: CODEX_INSTANCE,
        method: "droid_device_pairing",
      });
      yield* Deferred.succeed(completed, undefined);
      const transitions = yield* yieldUntil(Ref.get(transitionsRef), (items) =>
        items.some((item) => item?.status === "failed"),
      );

      assert.deepStrictEqual(
        transitions.map((item) => item?.status ?? null),
        ["starting", "waiting_for_browser", "verifying", "failed"],
      );
      assert.strictEqual(yield* Ref.get(refreshCountRef), 2);
    }),
  );

  it.effect("validates provider availability before starting a flow", () =>
    Effect.gen(function* () {
      const unsupported = yield* makeHarness();
      const unsupportedError = yield* unsupported.manager
        .start({ instanceId: CODEX_INSTANCE, method: "codex_browser" })
        .pipe(Effect.flip);
      assert.strictEqual(unsupportedError.reason, "unsupported_provider");

      const actions: ProviderConnectionActions = {
        methods: ["codex_browser"],
        start: () => Effect.die(new Error("must not start")),
        disconnect: Effect.void,
      };
      const notInstalled = yield* makeHarness({
        actions,
        provider: { ...disconnectedProvider, installed: false },
      });
      const notInstalledError = yield* notInstalled.manager
        .start({ instanceId: CODEX_INSTANCE, method: "codex_browser" })
        .pipe(Effect.flip);
      assert.strictEqual(notInstalledError.reason, "provider_not_installed");
    }),
  );

  it.effect("re-probes account state and skips duplicate sign-in for an existing session", () =>
    Effect.gen(function* () {
      const starts = yield* Ref.make(0);
      const actions: ProviderConnectionActions = {
        methods: ["codex_browser"],
        start: () => Ref.update(starts, (count) => count + 1).pipe(Effect.andThen(Effect.never)),
        disconnect: Effect.void,
      };
      const { manager, refreshCountRef } = yield* makeHarness({
        actions,
        refreshProvider: authenticatedProvider,
      });

      const result = yield* manager.start({
        instanceId: CODEX_INSTANCE,
        method: "codex_browser",
      });

      assert.strictEqual(result.providers[0]?.auth.status, "authenticated");
      assert.strictEqual(yield* Ref.get(starts), 0);
      assert.strictEqual(yield* Ref.get(refreshCountRef), 1);
    }),
  );

  it.effect("disconnects through the provider owner and refreshes the authoritative snapshot", () =>
    Effect.gen(function* () {
      const disconnects = yield* Ref.make(0);
      const actions: ProviderConnectionActions = {
        methods: ["codex_browser"],
        start: () => Effect.die(new Error("must not start")),
        disconnect: Ref.update(disconnects, (count) => count + 1),
      };
      const { manager, refreshCountRef } = yield* makeHarness({
        actions,
        provider: {
          ...disconnectedProvider,
          status: "ready",
          auth: { status: "authenticated", required: true },
          connection: {
            methods: ["codex_browser"],
            canDisconnect: true,
            operation: null,
          },
        },
      });

      yield* manager.disconnect({ instanceId: CODEX_INSTANCE });
      assert.strictEqual(yield* Ref.get(disconnects), 1);
      assert.strictEqual(yield* Ref.get(refreshCountRef), 1);
    }),
  );
});
