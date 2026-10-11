import { describe, it, assert } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  type ProviderConnectionOperation,
  type ServerProvider,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import {
  ProviderRegistry,
  ProviderRegistryRefreshError,
  type ProviderRegistryShape,
} from "../../provider/ProviderRegistry.ts";
import { makeManualOnlyProviderMaintenanceCapabilities } from "@t3tools/provider-core/server/maintenanceResolver";
import type {
  ProviderConnectionActions,
  ProviderVoiceTranscriptCorrection,
} from "../../provider/ScientProviderInstanceSeams.ts";
import { ProviderConnectionActionError } from "./ProviderConnectionActions.ts";
import {
  ProviderSessionCloseError,
  ProviderSessionManagerV2,
  type ProviderSessionManagerV2Shape,
} from "../../orchestration-v2/ProviderSessionManager.ts";
import {
  layer as ProviderConnectionManagerLayer,
  make,
  ProviderConnectionManager,
} from "./ProviderConnectionManager.ts";
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
  readonly providers?: ReadonlyArray<ServerProvider>;
  readonly closeInstance?: ProviderSessionManagerV2Shape["closeInstance"];
  readonly actions?: ProviderConnectionActions | undefined;
  readonly beforeSetProviderConnectionOperation?: (
    operation: ProviderConnectionOperation | null,
  ) => Effect.Effect<void>;
  readonly beforeRefreshInstance?: (
    instanceId: ProviderInstanceId,
    refreshCount: number,
  ) => Effect.Effect<void>;
  readonly refreshProvider?: (provider: ServerProvider, refreshCount: number) => ServerProvider;
  readonly failStrictRefreshAt?: number;
  readonly useProductionLayer?: boolean;
}) {
  return Effect.gen(function* () {
    const providersRef = yield* Ref.make<ReadonlyArray<ServerProvider>>(
      options?.providers ?? [options?.provider ?? disconnectedProvider],
    );
    const transitionsRef = yield* Ref.make<ReadonlyArray<ProviderConnectionOperation | null>>([]);
    const refreshCountRef = yield* Ref.make(0);
    const accountChangeRefreshCountRef = yield* Ref.make(0);

    const setProviderConnectionOperation: ProviderRegistryShape["setProviderConnectionOperation"] =
      (input) =>
        Effect.gen(function* () {
          yield* options?.beforeSetProviderConnectionOperation?.(input.operation) ?? Effect.void;
          yield* Ref.update(transitionsRef, (transitions) => [...transitions, input.operation]);
          // As the registry does: a sign-in to one of a provider's accounts is
          // published in its own field.
          return yield* Ref.updateAndGet(providersRef, (providers) =>
            providers.map((provider) => {
              if (provider.instanceId !== input.instanceId || !provider.connection) return provider;
              const { accountOperation: _previous, ...connection } = provider.connection;
              return {
                ...provider,
                connection:
                  input.operation?.account === undefined
                    ? { ...connection, operation: input.operation }
                    : { ...connection, operation: null, accountOperation: input.operation },
              };
            }),
          );
        });

    const refreshInstance = (instanceId: ProviderInstanceId, strict: boolean) =>
      Effect.gen(function* () {
        const refreshCount = yield* Ref.updateAndGet(refreshCountRef, (count) => count + 1);
        yield* options?.beforeRefreshInstance?.(instanceId, refreshCount) ?? Effect.void;
        if (strict && options?.failStrictRefreshAt === refreshCount) {
          return yield* new ProviderRegistryRefreshError({
            operation: "refresh",
            instanceId,
            message: "Simulated strict refresh failure.",
          });
        }
        return yield* Ref.updateAndGet(providersRef, (providers) =>
          providers.map((provider) =>
            provider.instanceId === instanceId
              ? (options?.refreshProvider?.(provider, refreshCount) ?? provider)
              : provider,
          ),
        );
      });

    const registry: ProviderRegistryShape = {
      getProviders: Ref.get(providersRef),
      refresh: () => Ref.get(providersRef),
      refreshInstance: (instanceId) =>
        refreshInstance(instanceId, false).pipe(Effect.catch(() => Ref.get(providersRef))),
      refreshWorkspaceSnapshot: () => Ref.get(providersRef),
      refreshInstanceStrict: (instanceId) => refreshInstance(instanceId, true),
      refreshInstanceAfterAccountChange: (instanceId) =>
        Ref.update(accountChangeRefreshCountRef, (count) => count + 1).pipe(
          Effect.andThen(refreshInstance(instanceId, true)),
        ),
      reloadInstance: () => Ref.get(providersRef),
      reloadInstanceStrict: () => Ref.get(providersRef),
      getProviderMaintenanceCapabilitiesForInstance: (_instanceId, provider) =>
        Effect.succeed(
          makeManualOnlyProviderMaintenanceCapabilities({ provider, packageName: null }),
        ),
      getProviderConnectionActionsForInstance: () => Effect.succeed(options?.actions),
      getProviderManagedRuntimeActionsForInstance: () => Effect.succeed(undefined),
      getProviderSkillActionsForInstance: () => Effect.succeed(undefined),
      getVoiceTranscriptCorrectionForInstance: () =>
        // @effect-diagnostics-next-line effectSucceedWithVoid:off -- Exact optional return requires undefined, not void.
        Effect.succeed<ProviderVoiceTranscriptCorrection | undefined>(undefined),
      setProviderManagedRuntimeSummary: () => Effect.succeed([]),
      setProviderMaintenanceActionState: () => Ref.get(providersRef),
      setProviderConnectionOperation,
      setProviderAuthenticationFailure: () => Ref.get(providersRef),
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
    const providerSessionsLayer = Layer.mock(ProviderSessionManagerV2)({
      closeInstance: options?.closeInstance ?? (() => Effect.void),
    });
    const manager = options?.useProductionLayer
      ? yield* Layer.build(
          ProviderConnectionManagerLayer.pipe(
            Layer.provide(
              Layer.mergeAll(
                Layer.succeed(ProviderRegistry, registry),
                Layer.succeed(ProviderLifecycleCoordinator, trackedLifecycleCoordinator),
                providerSessionsLayer,
                NodeServices.layer,
              ),
            ),
          ),
        ).pipe(
          Scope.provide(managerScope),
          Effect.map((services) => Context.get(services, ProviderConnectionManager)),
        )
      : yield* make().pipe(
          Effect.provideService(ProviderRegistry, registry),
          Effect.provideService(ProviderLifecycleCoordinator, trackedLifecycleCoordinator),
          Effect.provide(Layer.mergeAll(providerSessionsLayer, NodeServices.layer)),
          Scope.provide(managerScope),
        );
    return {
      manager,
      providersRef,
      transitionsRef,
      refreshCountRef,
      accountChangeRefreshCountRef,
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
        const { manager, transitionsRef, refreshCountRef, accountChangeRefreshCountRef } =
          yield* makeHarness({
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
        assert.strictEqual(yield* Ref.get(accountChangeRefreshCountRef), 1);
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

  it.effect.each(["code", "callback_url"] as const)(
    "forwards an optional %s only to the matching live attempt",
    (authorizationResponseKind) =>
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
              authorizationResponseKind,
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
        assert.strictEqual(
          started.providers[0]?.connection?.operation?.authorizationResponseKind,
          authorizationResponseKind,
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

  it.effect("holds the lifecycle reservation until cancelled state is published", () =>
    Effect.gen(function* () {
      const cancellationPublicationStarted = yield* Deferred.make<void>();
      const releaseCancellationPublication = yield* Deferred.make<void>();
      const actions: ProviderConnectionActions = {
        methods: ["codex_browser"],
        start: () =>
          Effect.succeed({
            authorizationUrl: "https://auth.openai.com/",
            authorizationUrlKind: "primary",
            initialStatus: "waiting_for_browser",
            waitForCompletion: Effect.never,
            cancel: Effect.void,
          }),
        disconnect: Effect.void,
      };
      const { manager, lifecycleCoordinator, lifecycleReleaseCountRef } = yield* makeHarness({
        actions,
        beforeSetProviderConnectionOperation: (operation) =>
          operation?.status === "cancelled"
            ? Deferred.succeed(cancellationPublicationStarted, undefined).pipe(
                Effect.andThen(Deferred.await(releaseCancellationPublication)),
              )
            : Effect.void,
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
      yield* Deferred.await(cancellationPublicationStarted);

      assert.strictEqual(
        (yield* lifecycleCoordinator.current(CODEX_INSTANCE))?.operationId,
        operationId,
      );
      const overlappingStart = yield* manager
        .start({ instanceId: CODEX_INSTANCE, method: "codex_browser" })
        .pipe(Effect.flip);
      assert.strictEqual(overlappingStart.reason, "already_running");

      yield* Deferred.succeed(releaseCancellationPublication, undefined);
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
        const {
          manager,
          transitionsRef,
          lifecycleCoordinator,
          lifecycleReleaseCountRef,
          closeManager,
        } = yield* makeHarness({ actions, useProductionLayer: true });
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
        assert.strictEqual(yield* Ref.get(lifecycleReleaseCountRef), 1);
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
        assert.strictEqual(yield* Ref.get(lifecycleReleaseCountRef), 1);
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

  it.effect("holds the lifecycle reservation until failed start state is published", () =>
    Effect.gen(function* () {
      const failurePublicationStarted = yield* Deferred.make<void>();
      const releaseFailurePublication = yield* Deferred.make<void>();
      const actions: ProviderConnectionActions = {
        methods: ["codex_browser"],
        start: () =>
          Effect.fail(
            new ProviderConnectionActionError({ message: "The provider rejected sign in." }),
          ),
        disconnect: Effect.void,
      };
      const { manager, lifecycleCoordinator, lifecycleReleaseCountRef } = yield* makeHarness({
        actions,
        beforeSetProviderConnectionOperation: (operation) =>
          operation?.status === "failed"
            ? Deferred.succeed(failurePublicationStarted, undefined).pipe(
                Effect.andThen(Deferred.await(releaseFailurePublication)),
              )
            : Effect.void,
      });

      const startFiber = yield* manager
        .start({ instanceId: CODEX_INSTANCE, method: "codex_browser" })
        .pipe(Effect.result, Effect.forkChild);
      yield* Deferred.await(failurePublicationStarted);
      const reservation = yield* lifecycleCoordinator.current(CODEX_INSTANCE);
      assert.ok(reservation);

      const overlappingStart = yield* manager
        .start({ instanceId: CODEX_INSTANCE, method: "codex_browser" })
        .pipe(Effect.flip);
      assert.strictEqual(overlappingStart.reason, "already_running");

      yield* Deferred.succeed(releaseFailurePublication, undefined);
      const failed = yield* Fiber.join(startFiber);
      assert.strictEqual(failed._tag, "Failure");
      if (failed._tag === "Failure") assert.strictEqual(failed.failure.reason, "connection_failed");
      assert.strictEqual(yield* lifecycleCoordinator.current(CODEX_INSTANCE), undefined);
      assert.strictEqual(yield* Ref.get(lifecycleReleaseCountRef), 1);
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

  it.effect("fails completion when the strict post-auth refresh itself fails", () =>
    Effect.gen(function* () {
      const completed = yield* Deferred.make<void, ProviderConnectionActionError>();
      const actions: ProviderConnectionActions = {
        methods: ["codex_browser"],
        start: () =>
          Effect.succeed({
            initialStatus: "waiting_for_browser",
            waitForCompletion: Deferred.await(completed),
            cancel: Effect.void,
          }),
        disconnect: Effect.void,
      };
      const { manager, transitionsRef, lifecycleReleaseCountRef } = yield* makeHarness({
        actions,
        failStrictRefreshAt: 2,
      });

      yield* manager.start({ instanceId: CODEX_INSTANCE, method: "codex_browser" });
      yield* Deferred.succeed(completed, undefined);
      const transitions = yield* yieldUntil(Ref.get(transitionsRef), (items) =>
        items.some((item) => item?.status === "failed"),
      );

      assert.deepStrictEqual(
        transitions.map((item) => item?.status ?? null),
        ["starting", "waiting_for_browser", "verifying", "failed"],
      );
      assert.strictEqual(
        transitions.at(-1)?.message,
        "The provider finished sign in, but Scient could not verify the connected account.",
      );
      assert.strictEqual(yield* Ref.get(lifecycleReleaseCountRef), 1);
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

  it.effect("does not start sign in when the strict preflight refresh fails", () =>
    Effect.gen(function* () {
      const starts = yield* Ref.make(0);
      const actions: ProviderConnectionActions = {
        methods: ["codex_browser"],
        start: () => Ref.update(starts, (count) => count + 1).pipe(Effect.andThen(Effect.never)),
        disconnect: Effect.void,
      };
      const { manager, lifecycleReleaseCountRef } = yield* makeHarness({
        actions,
        failStrictRefreshAt: 1,
      });

      const failure = yield* manager
        .start({ instanceId: CODEX_INSTANCE, method: "codex_browser" })
        .pipe(Effect.flip);

      assert.strictEqual(failure.reason, "connection_failed");
      assert.strictEqual(
        failure.message,
        "Scient could not verify the provider before starting sign in. Try again.",
      );
      assert.strictEqual(yield* Ref.get(starts), 0);
      assert.strictEqual(yield* Ref.get(lifecycleReleaseCountRef), 0);
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
      const { manager, refreshCountRef, accountChangeRefreshCountRef } = yield* makeHarness({
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
      assert.strictEqual(yield* Ref.get(accountChangeRefreshCountRef), 1);
    }),
  );

  it.effect("closes only the requested V2 instance before credential logout and refresh", () =>
    Effect.gen(function* () {
      const otherInstance = ProviderInstanceId.make("codex-other-account");
      const liveInstances = yield* Ref.make<ReadonlyArray<ProviderInstanceId>>([
        CODEX_INSTANCE,
        otherInstance,
      ]);
      const order = yield* Ref.make<ReadonlyArray<string>>([]);
      const { manager, lifecycleCoordinator } = yield* makeHarness({
        useProductionLayer: true,
        providers: [
          authenticatedProvider(disconnectedProvider),
          authenticatedProvider({ ...disconnectedProvider, instanceId: otherInstance }),
        ],
        closeInstance: (instanceId) =>
          Effect.gen(function* () {
            assert.equal(instanceId, CODEX_INSTANCE);
            yield* Ref.update(order, (events) => [...events, `close:${instanceId}`]);
            yield* Ref.update(liveInstances, (instances) =>
              instances.filter((candidate) => candidate !== instanceId),
            );
          }),
        actions: {
          methods: ["codex_browser"],
          start: () => Effect.die("Sign-out must not start a sign-in flow"),
          disconnect: Effect.gen(function* () {
            assert.deepEqual(yield* Ref.get(liveInstances), [otherInstance]);
            yield* Ref.update(order, (events) => [...events, "logout"]);
          }),
        },
        beforeRefreshInstance: (instanceId) =>
          Ref.update(order, (events) => [...events, `refresh:${instanceId}`]),
      });

      yield* manager.disconnect({ instanceId: CODEX_INSTANCE });
      assert.deepEqual(yield* Ref.get(order), [
        `close:${CODEX_INSTANCE}`,
        "logout",
        `refresh:${CODEX_INSTANCE}`,
      ]);
      assert.deepEqual(yield* Ref.get(liveInstances), [otherInstance]);
      assert.equal(yield* lifecycleCoordinator.current(CODEX_INSTANCE), undefined);
    }),
  );

  it.effect("aborts credential logout when V2 shutdown fails and releases its reservation", () =>
    Effect.gen(function* () {
      const logoutCount = yield* Ref.make(0);
      const { manager, lifecycleCoordinator, refreshCountRef, lifecycleReleaseCountRef } =
        yield* makeHarness({
          provider: authenticatedProvider(disconnectedProvider),
          closeInstance: () =>
            Effect.fail(
              new ProviderSessionCloseError({
                providerSessionId: ProviderSessionId.make("failed-session"),
              }),
            ),
          actions: {
            methods: ["codex_browser"],
            start: () => Effect.die("Sign-out must not start a sign-in flow"),
            disconnect: Ref.update(logoutCount, (count) => count + 1),
          },
        });
      const failure = yield* manager.disconnect({ instanceId: CODEX_INSTANCE }).pipe(Effect.flip);
      assert.equal(failure.reason, "disconnect_failed");
      assert.equal(failure.instanceId, CODEX_INSTANCE);
      assert.equal(yield* Ref.get(logoutCount), 0);
      assert.equal(yield* Ref.get(refreshCountRef), 0);
      assert.equal(yield* lifecycleCoordinator.current(CODEX_INSTANCE), undefined);
      assert.equal(yield* Ref.get(lifecycleReleaseCountRef), 1);
    }),
  );

  it.effect("reports an unverifiable account state after provider-owned sign out completes", () =>
    Effect.gen(function* () {
      const disconnects = yield* Ref.make(0);
      const actions: ProviderConnectionActions = {
        methods: ["codex_browser"],
        start: () => Effect.die(new Error("must not start")),
        disconnect: Ref.update(disconnects, (count) => count + 1),
      };
      const { manager, lifecycleReleaseCountRef } = yield* makeHarness({
        actions,
        provider: authenticatedProvider(disconnectedProvider),
        failStrictRefreshAt: 1,
      });

      const failure = yield* manager.disconnect({ instanceId: CODEX_INSTANCE }).pipe(Effect.flip);

      assert.strictEqual(failure.reason, "disconnect_failed");
      assert.strictEqual(
        failure.message,
        "The provider completed sign out, but Scient could not verify the current account state.",
      );
      assert.strictEqual(yield* Ref.get(disconnects), 1);
      assert.strictEqual(yield* Ref.get(lifecycleReleaseCountRef), 1);
    }),
  );

  it.effect("holds the lifecycle reservation through post-disconnect refresh", () =>
    Effect.gen(function* () {
      const refreshStarted = yield* Deferred.make<void>();
      const releaseRefresh = yield* Deferred.make<void>();
      const actions: ProviderConnectionActions = {
        methods: ["codex_browser"],
        start: () => Effect.die(new Error("must not start")),
        disconnect: Effect.void,
      };
      const { manager, lifecycleCoordinator, lifecycleReleaseCountRef } = yield* makeHarness({
        actions,
        provider: authenticatedProvider(disconnectedProvider),
        beforeRefreshInstance: (_instanceId, refreshCount) =>
          refreshCount === 1
            ? Deferred.succeed(refreshStarted, undefined).pipe(
                Effect.andThen(Deferred.await(releaseRefresh)),
              )
            : Effect.void,
      });

      const disconnectFiber = yield* manager
        .disconnect({ instanceId: CODEX_INSTANCE })
        .pipe(Effect.forkChild);
      yield* Deferred.await(refreshStarted);

      assert.strictEqual((yield* lifecycleCoordinator.current(CODEX_INSTANCE))?.kind, "connection");
      const overlappingDisconnect = yield* manager
        .disconnect({ instanceId: CODEX_INSTANCE })
        .pipe(Effect.flip);
      assert.strictEqual(overlappingDisconnect.reason, "already_running");

      yield* Deferred.succeed(releaseRefresh, undefined);
      yield* Fiber.join(disconnectFiber);
      assert.strictEqual(yield* lifecycleCoordinator.current(CODEX_INSTANCE), undefined);
      assert.strictEqual(yield* Ref.get(lifecycleReleaseCountRef), 1);
    }),
  );
});

describe("ProviderConnectionManager with a provider that lists accounts", () => {
  const SCIENT = ProviderDriverKind.make("scient");
  const SCIENT_INSTANCE = ProviderInstanceId.make("scient");
  type Account = NonNullable<NonNullable<ServerProvider["connection"]>["accounts"]>[number];
  const account = (overrides: Partial<Account> & Pick<Account, "id">): Account => ({
    name: overrides.id,
    kind: "account",
    connected: false,
    canDisconnect: false,
    ...overrides,
  });
  const agentProvider = (accounts: ReadonlyArray<Account>): ServerProvider => ({
    ...disconnectedProvider,
    instanceId: SCIENT_INSTANCE,
    driver: SCIENT,
    // The provider as a whole has no single signed-in state.
    auth: { status: "unknown", required: false },
    connection: {
      methods: [],
      canDisconnect: false,
      operation: null,
      accounts,
    },
  });
  const withAccounts = (provider: ServerProvider, accounts: ReadonlyArray<Account>) => ({
    ...provider,
    connection: { ...provider.connection!, accounts },
  });

  it.effect("signs in to the named account and verifies it against the provider's list", () =>
    Effect.gen(function* () {
      const completed = yield* Deferred.make<void, ProviderConnectionActionError>();
      const startedWith = yield* Ref.make<ReadonlyArray<string | undefined>>([]);
      const actions: ProviderConnectionActions = {
        methods: ["scient_agent_account"],
        requiresAccount: true,
        start: (_method, requested) =>
          Ref.update(startedWith, (previous) => [...previous, requested]).pipe(
            Effect.as({
              authorizationUrl: "https://auth.openai.com/codex/device",
              authorizationUrlKind: "primary" as const,
              initialStatus: "waiting_for_device_code" as const,
              userCode: "ABCD-1234",
              instructions: "Enter code: ABCD-1234",
              waitForCompletion: Deferred.await(completed),
              cancel: Effect.void,
            }),
          ),
        disconnect: Effect.void,
      };
      const { manager, transitionsRef } = yield* makeHarness({
        actions,
        provider: agentProvider([account({ id: "openai-codex" }), account({ id: "anthropic" })]),
        refreshProvider: (provider, refreshCount) =>
          refreshCount >= 2
            ? withAccounts(provider, [
                account({ id: "openai-codex", connected: true, canDisconnect: true }),
                account({ id: "anthropic" }),
              ])
            : provider,
      });

      const started = yield* manager.start({
        instanceId: SCIENT_INSTANCE,
        method: "scient_agent_account",
        account: "openai-codex",
      });
      assert.deepStrictEqual(yield* Ref.get(startedWith), ["openai-codex"]);
      const operation = started.providers[0]?.connection?.accountOperation;
      // Never in the field a client that predates accounts decodes.
      assert.strictEqual(started.providers[0]?.connection?.operation, null);
      assert.strictEqual(operation?.account, "openai-codex");
      assert.strictEqual(operation?.instructions, "Enter code: ABCD-1234");
      assert.strictEqual(operation?.userCode, "ABCD-1234");

      yield* Deferred.succeed(completed, undefined);
      const transitions = yield* yieldUntil(Ref.get(transitionsRef), (items) =>
        items.some((item) => item?.status === "connected"),
      );
      assert.deepStrictEqual(
        transitions.map((item) => [item?.status ?? null, item?.account ?? null]),
        [
          ["starting", "openai-codex"],
          ["waiting_for_device_code", "openai-codex"],
          ["verifying", "openai-codex"],
          ["connected", "openai-codex"],
        ],
      );
    }),
  );

  it.effect("fails a sign-in the provider's list does not confirm", () =>
    Effect.gen(function* () {
      const actions: ProviderConnectionActions = {
        methods: ["scient_agent_account"],
        requiresAccount: true,
        start: () =>
          Effect.succeed({
            initialStatus: "waiting_for_browser",
            waitForCompletion: Effect.void,
            cancel: Effect.void,
          }),
        disconnect: Effect.void,
      };
      const { manager, transitionsRef } = yield* makeHarness({
        actions,
        // Another account connecting must not count for this one.
        provider: agentProvider([
          account({ id: "openai-codex" }),
          account({ id: "anthropic", connected: true }),
        ]),
      });

      yield* manager.start({
        instanceId: SCIENT_INSTANCE,
        method: "scient_agent_account",
        account: "openai-codex",
      });
      const transitions = yield* yieldUntil(Ref.get(transitionsRef), (items) =>
        items.some((item) => item?.status === "failed"),
      );
      assert.strictEqual(
        transitions.at(-1)?.message,
        "The provider finished sign in, but Scient could not verify the connected account.",
      );
    }),
  );

  it.effect("publishes a question the provider asks after the link was shown", () =>
    Effect.gen(function* () {
      const asked = yield* Deferred.make<void>();
      const completed = yield* Deferred.make<void, ProviderConnectionActionError>();
      const answers = yield* Ref.make<ReadonlyArray<string>>([]);
      const actions: ProviderConnectionActions = {
        methods: ["scient_agent_account"],
        requiresAccount: true,
        start: () =>
          Effect.succeed({
            authorizationUrl: "https://auth.example.com/",
            authorizationUrlKind: "primary" as const,
            initialStatus: "waiting_for_browser" as const,
            laterQuestion: Deferred.await(asked).pipe(
              Effect.as({
                instructions: "Paste the redirect URL",
                submitAuthorizationCode: (code: string) =>
                  Ref.update(answers, (previous) => [...previous, code]),
              }),
            ),
            waitForCompletion: Deferred.await(completed),
            cancel: Effect.void,
          }),
        disconnect: Effect.void,
      };
      const { manager, providersRef } = yield* makeHarness({
        actions,
        provider: agentProvider([account({ id: "openai-codex" })]),
      });
      const published = Ref.get(providersRef).pipe(
        Effect.map((providers) => providers[0]?.connection?.accountOperation),
      );

      const started = yield* manager.start({
        instanceId: SCIENT_INSTANCE,
        method: "scient_agent_account",
        account: "openai-codex",
      });
      const operationId = started.providers[0]!.connection!.accountOperation!.operationId;
      assert.strictEqual(
        started.providers[0]?.connection?.accountOperation?.acceptsAuthorizationCode,
        false,
      );
      // Before the question, there is nothing to answer.
      const early = yield* manager
        .submitAuthorizationCode({
          instanceId: SCIENT_INSTANCE,
          operationId,
          authorizationCode: "too-early",
        })
        .pipe(Effect.flip);
      assert.strictEqual(early.reason, "authorization_code_not_supported");

      yield* Deferred.succeed(asked, undefined);
      const waiting = yield* yieldUntil(
        published,
        (operation) => operation?.acceptsAuthorizationCode === true,
      );
      assert.strictEqual(waiting?.instructions, "Paste the redirect URL");
      assert.strictEqual(waiting?.account, "openai-codex");
      assert.strictEqual(waiting?.authorizationUrl, "https://auth.example.com/");

      yield* manager.submitAuthorizationCode({
        instanceId: SCIENT_INSTANCE,
        operationId,
        authorizationCode: "the-answer",
      });
      assert.deepStrictEqual(yield* Ref.get(answers), ["the-answer"]);
    }),
  );

  it.effect("does not reopen a cancelled sign-in for a question that comes too late", () =>
    Effect.gen(function* () {
      const asked = yield* Deferred.make<void>();
      const actions: ProviderConnectionActions = {
        methods: ["scient_agent_account"],
        requiresAccount: true,
        start: () =>
          Effect.succeed({
            initialStatus: "waiting_for_browser" as const,
            laterQuestion: Deferred.await(asked).pipe(
              Effect.as({ submitAuthorizationCode: () => Effect.void }),
            ),
            waitForCompletion: Effect.never,
            cancel: Effect.void,
          }),
        disconnect: Effect.void,
      };
      const { manager, providersRef } = yield* makeHarness({
        actions,
        provider: agentProvider([account({ id: "openai-codex" })]),
      });
      const started = yield* manager.start({
        instanceId: SCIENT_INSTANCE,
        method: "scient_agent_account",
        account: "openai-codex",
      });
      yield* manager.cancel({
        instanceId: SCIENT_INSTANCE,
        operationId: started.providers[0]!.connection!.accountOperation!.operationId,
      });
      yield* Deferred.succeed(asked, undefined);
      for (let turn = 0; turn < 20; turn += 1) yield* Effect.yieldNow;
      const operation = (yield* Ref.get(providersRef))[0]?.connection?.accountOperation;
      assert.strictEqual(operation?.status, "cancelled");
      assert.notStrictEqual(operation?.acceptsAuthorizationCode, true);
    }),
  );

  it.effect("starts nothing for an account the provider does not list", () =>
    Effect.gen(function* () {
      const started = yield* Ref.make(0);
      const actions: ProviderConnectionActions = {
        methods: ["scient_agent_account"],
        requiresAccount: true,
        start: () =>
          Ref.update(started, (count) => count + 1).pipe(
            Effect.as({
              initialStatus: "waiting_for_browser" as const,
              waitForCompletion: Effect.void,
              cancel: Effect.void,
            }),
          ),
        disconnect: Effect.void,
      };
      const { manager } = yield* makeHarness({
        actions,
        provider: agentProvider([account({ id: "openai-codex" })]),
      });

      for (const requested of [undefined, "not-listed"]) {
        const error = yield* manager
          .start({
            instanceId: SCIENT_INSTANCE,
            method: "scient_agent_account",
            ...(requested === undefined ? {} : { account: requested }),
          })
          .pipe(Effect.flip);
        assert.strictEqual(error.reason, "invalid_method");
      }
      assert.strictEqual(yield* Ref.get(started), 0);
    }),
  );

  it.effect("publishes nothing for a sign-in to no account when the list could not be read", () =>
    Effect.gen(function* () {
      const actions: ProviderConnectionActions = {
        methods: ["scient_agent_account"],
        requiresAccount: true,
        start: () => Effect.die("must not start"),
        disconnect: Effect.void,
      };
      // The latest check could not read the agent's list.
      const { accounts: _accounts, ...connection } = agentProvider([]).connection!;
      const { manager, transitionsRef } = yield* makeHarness({
        actions,
        provider: { ...agentProvider([]), connection },
      });

      for (const requested of [undefined, "openai-codex"]) {
        const error = yield* manager
          .start({
            instanceId: SCIENT_INSTANCE,
            method: "scient_agent_account",
            ...(requested === undefined ? {} : { account: requested }),
          })
          .pipe(Effect.flip);
        assert.strictEqual(error.reason, "invalid_method");
      }
      // No operation, so the method never reaches a field an older client decodes.
      assert.deepStrictEqual(yield* Ref.get(transitionsRef), []);
    }),
  );

  it.effect("takes no account for a provider that lists none", () =>
    Effect.gen(function* () {
      const actions: ProviderConnectionActions = {
        methods: ["codex_browser"],
        start: () => Effect.die("must not start"),
        disconnect: Effect.void,
      };
      const { manager } = yield* makeHarness({ actions });
      const error = yield* manager
        .start({ instanceId: CODEX_INSTANCE, method: "codex_browser", account: "openai-codex" })
        .pipe(Effect.flip);
      assert.strictEqual(error.reason, "invalid_method");
    }),
  );

  it.effect("signs out of one account and leaves the provider-wide sign-out alone", () =>
    Effect.gen(function* () {
      const signedOut = yield* Ref.make<ReadonlyArray<string>>([]);
      const actions: ProviderConnectionActions = {
        methods: ["scient_agent_account"],
        requiresAccount: true,
        start: () => Effect.die("must not start"),
        disconnect: Effect.die("must not sign out of the whole provider"),
        disconnectAccount: (requested) =>
          Ref.update(signedOut, (previous) => [...previous, requested]),
      };
      const { manager, accountChangeRefreshCountRef } = yield* makeHarness({
        actions,
        provider: agentProvider([
          account({ id: "openai-codex", connected: true, canDisconnect: true }),
          // Connected through the environment: nothing is stored to remove.
          account({ id: "anthropic", connected: true }),
        ]),
      });

      yield* manager.disconnect({ instanceId: SCIENT_INSTANCE, account: "openai-codex" });
      assert.deepStrictEqual(yield* Ref.get(signedOut), ["openai-codex"]);
      assert.strictEqual(yield* Ref.get(accountChangeRefreshCountRef), 1);

      for (const requested of ["anthropic", "not-listed", undefined]) {
        const error = yield* manager
          .disconnect({
            instanceId: SCIENT_INSTANCE,
            ...(requested === undefined ? {} : { account: requested }),
          })
          .pipe(Effect.flip);
        assert.strictEqual(error.reason, "unsupported_provider");
      }
      assert.deepStrictEqual(yield* Ref.get(signedOut), ["openai-codex"]);
    }),
  );

  const signedInAgent = () =>
    agentProvider([account({ id: "openai-codex", connected: true, canDisconnect: true })]);

  it.effect("removes an account's sign-in and then stops only its native instance", () =>
    Effect.gen(function* () {
      const steps = yield* Ref.make<ReadonlyArray<string>>([]);
      const otherInstance = ProviderInstanceId.make("scient-independent-account-root");
      const liveInstances = yield* Ref.make<ReadonlyArray<ProviderInstanceId>>([
        SCIENT_INSTANCE,
        otherInstance,
      ]);
      const note = (step: string) => Ref.update(steps, (previous) => [...previous, step]);
      const actions: ProviderConnectionActions = {
        methods: ["scient_agent_account"],
        requiresAccount: true,
        start: () => Effect.die("must not start"),
        disconnect: Effect.die("must not sign out of the whole provider"),
        disconnectAccount: (requested) => note(`remove ${requested}`),
      };
      const { manager } = yield* makeHarness({
        actions,
        provider: signedInAgent(),
        closeInstance: (instanceId) =>
          Ref.update(liveInstances, (instances) =>
            instances.filter((id) => id !== instanceId),
          ).pipe(Effect.andThen(note(`stop ${instanceId}`))),
      });

      yield* manager.disconnect({ instanceId: SCIENT_INSTANCE, account: "openai-codex" });
      assert.deepStrictEqual(yield* Ref.get(steps), [
        "remove openai-codex",
        `stop ${SCIENT_INSTANCE}`,
      ]);
      assert.deepStrictEqual(yield* Ref.get(liveInstances), [otherInstance]);
    }),
  );

  it.live("still stops the conversations when the request is interrupted after the removal", () =>
    Effect.gen(function* () {
      const removing = yield* Deferred.make<void>();
      const finishRemoval = yield* Deferred.make<void>();
      const stopped = yield* Deferred.make<void>();
      const actions: ProviderConnectionActions = {
        methods: ["scient_agent_account"],
        requiresAccount: true,
        start: () => Effect.die("must not start"),
        disconnect: Effect.void,
        disconnectAccount: () =>
          Deferred.succeed(removing, undefined).pipe(Effect.andThen(Deferred.await(finishRemoval))),
      };
      const { manager } = yield* makeHarness({
        actions,
        provider: signedInAgent(),
        closeInstance: (instanceId) => {
          assert.strictEqual(instanceId, SCIENT_INSTANCE);
          return Deferred.succeed(stopped, undefined).pipe(Effect.asVoid);
        },
      });

      const request = yield* manager
        .disconnect({ instanceId: SCIENT_INSTANCE, account: "openai-codex" })
        .pipe(Effect.forkChild);
      yield* Deferred.await(removing);
      // The client goes away while the agent is removing the sign-in.
      const interruption = yield* Fiber.interrupt(request).pipe(Effect.forkChild);
      // Let the interruption reach the request while the removal is still pending.
      yield* Effect.sleep("50 millis");
      yield* Deferred.succeed(finishRemoval, undefined);
      yield* Fiber.join(interruption);
      assert.isTrue(yield* Deferred.isDone(stopped));
    }),
  );

  it.effect("stops the conversations after a sign-out that may have removed the sign-in", () =>
    Effect.gen(function* () {
      const stops = yield* Ref.make(0);
      const outcome = yield* Ref.make<{ readonly maybeRemoved: boolean }>({ maybeRemoved: true });
      const actions: ProviderConnectionActions = {
        methods: ["scient_agent_account"],
        requiresAccount: true,
        start: () => Effect.die("must not start"),
        disconnect: Effect.void,
        disconnectAccount: () =>
          Ref.get(outcome).pipe(
            Effect.flatMap(({ maybeRemoved }) =>
              Effect.fail({
                message: "The agent did not answer.",
                signInMayBeRemoved: maybeRemoved,
              }),
            ),
          ),
      };
      const { manager } = yield* makeHarness({
        actions,
        provider: signedInAgent(),
        closeInstance: (instanceId) => {
          assert.strictEqual(instanceId, SCIENT_INSTANCE);
          return Ref.update(stops, (count) => count + 1);
        },
      });
      const signOut = manager
        .disconnect({ instanceId: SCIENT_INSTANCE, account: "openai-codex" })
        .pipe(Effect.flip);

      const unknown = yield* signOut;
      assert.strictEqual(unknown.reason, "disconnect_failed");
      assert.strictEqual(unknown.message, "The agent did not answer.");
      assert.strictEqual(yield* Ref.get(stops), 1);

      // The agent said it kept the sign-in: running work is left alone.
      yield* Ref.set(outcome, { maybeRemoved: false });
      yield* signOut;
      assert.strictEqual(yield* Ref.get(stops), 1);
    }),
  );

  it.effect("reports a removal whose conversations could not be stopped", () =>
    Effect.gen(function* () {
      const actions: ProviderConnectionActions = {
        methods: ["scient_agent_account"],
        requiresAccount: true,
        start: () => Effect.die("must not start"),
        disconnect: Effect.void,
        disconnectAccount: () => Effect.void,
      };
      const { manager } = yield* makeHarness({
        actions,
        provider: signedInAgent(),
        closeInstance: () =>
          Effect.fail(
            new ProviderSessionCloseError({
              providerSessionId: ProviderSessionId.make("scient-account-session"),
            }),
          ),
      });
      const error = yield* manager
        .disconnect({ instanceId: SCIENT_INSTANCE, account: "openai-codex" })
        .pipe(Effect.flip);
      assert.strictEqual(error.reason, "disconnect_failed");
      assert.match(error.message, /The sign-in was removed, but Scient could not stop/u);
    }),
  );
});
