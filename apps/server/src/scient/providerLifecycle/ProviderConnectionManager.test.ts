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
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

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
          yield* Ref.update(refreshCountRef, (count) => count + 1);
          return yield* Ref.updateAndGet(providersRef, (providers) =>
            providers.map((provider) =>
              provider.instanceId === instanceId
                ? {
                    ...provider,
                    status: "ready" as const,
                    auth: { status: "authenticated" as const, required: true },
                    ...(provider.connection
                      ? {
                          connection: {
                            ...provider.connection,
                            canDisconnect: true,
                          },
                        }
                      : {}),
                  }
                : provider,
            ),
          );
        }),
      getProviderMaintenanceCapabilitiesForInstance: (_instanceId, provider) =>
        Effect.succeed(
          makeManualOnlyProviderMaintenanceCapabilities({ provider, packageName: null }),
        ),
      getProviderConnectionActionsForInstance: () => Effect.succeed(options?.actions),
      getProviderManagedRuntimeActionsForInstance: () => Effect.succeed(undefined),
      setProviderManagedRuntimeSummary: () => Effect.succeed([]),
      setProviderMaintenanceActionState: () => Ref.get(providersRef),
      setProviderConnectionOperation,
      streamChanges: Stream.empty,
    };

    const lifecycleCoordinator = yield* makeLifecycleCoordinator;
    const manager = yield* make().pipe(
      Effect.provideService(ProviderRegistry, registry),
      Effect.provideService(ProviderLifecycleCoordinator, lifecycleCoordinator),
      Effect.provide(NodeServices.layer),
    );
    return { manager, providersRef, transitionsRef, refreshCountRef };
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
              waitForCompletion: Deferred.await(completed),
              cancel: Effect.void,
            }),
          disconnect: Effect.void,
        };
        const { manager, transitionsRef, refreshCountRef } = yield* makeHarness({ actions });

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

        yield* Deferred.succeed(completed, undefined);
        const transitions = yield* yieldUntil(Ref.get(transitionsRef), (items) =>
          items.some((item) => item?.status === "connected"),
        );
        assert.deepStrictEqual(
          transitions.map((item) => item?.status ?? null),
          ["starting", "waiting_for_browser", "verifying", "connected"],
        );
        assert.strictEqual(yield* Ref.get(refreshCountRef), 1);
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
