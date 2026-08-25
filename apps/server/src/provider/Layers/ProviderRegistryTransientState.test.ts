import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderConnectionOperation,
  type ProviderRuntimeSummary,
  type ServerProvider,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import * as ServerConfig from "../../config.ts";
import type { ProviderInstance } from "../ProviderDriver.ts";
import { makeManualOnlyProviderMaintenanceCapabilities } from "../providerMaintenance.ts";
import { readProviderStatusCache, resolveProviderStatusCachePath } from "../providerStatusCache.ts";
import * as ProviderInstanceRegistry from "../Services/ProviderInstanceRegistry.ts";
import * as ProviderRegistry from "../Services/ProviderRegistry.ts";
import { ProviderRegistryLive } from "./ProviderRegistry.ts";

const DRIVER = ProviderDriverKind.make("cursor");
const INSTANCE_ID = ProviderInstanceId.make("cursor");
const TEST_EPOCH = DateTime.makeUnsafe("1970-01-01T00:00:00.000Z");

const systemRuntime: ProviderRuntimeSummary = {
  source: "system",
  supportTier: "fully_assisted",
  target: "darwin-arm64",
  actions: ["install"],
  managedVersion: null,
  previousManagedVersion: null,
  operation: null,
  message: "Using the Cursor installation on this computer.",
};

const managedRuntimeOperation = {
  operationId: "runtime-cursor-install",
  action: "install",
  status: "succeeded",
  startedAt: "2026-08-24T00:00:00.000Z",
  finishedAt: "2026-08-24T00:00:01.000Z",
  message: "The provider runtime was installed and verified.",
} as const;

const managedRuntime: ProviderRuntimeSummary = {
  source: "scient_managed",
  supportTier: "fully_assisted",
  target: "darwin-arm64",
  actions: ["repair", "remove"],
  managedVersion: "2026.08.11-e8db854",
  previousManagedVersion: null,
  operation: managedRuntimeOperation,
  message: "Scient manages this Cursor runtime.",
};

const connectionOperation: ProviderConnectionOperation = {
  operationId: "connection-cursor-browser",
  method: "cursor_browser",
  status: "waiting_for_browser",
  startedAt: "2026-08-24T00:00:00.000Z",
  finishedAt: null,
  message: "Finish signing in in your browser.",
  authorizationUrl: "https://example.invalid/cursor-login",
};

function provider(checkedAt: string): ServerProvider {
  return {
    instanceId: INSTANCE_ID,
    driver: DRIVER,
    status: "warning",
    enabled: true,
    installed: true,
    auth: { status: "unauthenticated", required: true },
    checkedAt,
    version: "2026.08.11-e8db854",
    models: [],
    slashCommands: [],
    skills: [],
    connection: {
      methods: ["cursor_browser"],
      canDisconnect: false,
      operation: null,
      runtime: systemRuntime,
    },
  };
}

function authenticatedProvider(checkedAt: string): ServerProvider {
  return {
    ...provider(checkedAt),
    status: "ready",
    auth: {
      status: "authenticated",
      required: true,
      email: "scientist@example.com",
      label: "Claude Pro Subscription",
    },
    connection: {
      methods: ["claude_subscription"],
      canDisconnect: true,
      operation: null,
      runtime: systemRuntime,
    },
  };
}

const BackgroundPolicyAlwaysRunLayer = Layer.mock(BackgroundPolicy.BackgroundPolicy)({
  reportClientActivity: () => Effect.void,
  removeRpcClient: () => Effect.void,
  reportHostPowerState: () => Effect.void,
  snapshot: Effect.succeed({
    hostPower: {
      source: "unknown",
      idle: "unknown",
      idleSeconds: null,
      locked: "unknown",
      suspended: false,
      onBattery: "unknown",
      lowPowerMode: "unknown",
      thermalState: "unknown",
      stale: true,
      updatedAt: TEST_EPOCH,
    },
    leases: [],
    activeForegroundLeaseCount: 0,
    activeScopeKeys: [],
    shouldRunOpportunisticWork: true,
    updatedAt: TEST_EPOCH,
  }),
  streamChanges: Stream.empty,
  hasDemand: () => Effect.succeed(true),
  shouldRunScopeWork: () => Effect.succeed(true),
  shouldRunOpportunisticWork: Effect.succeed(true),
});

const makeHarness = Effect.fn("ProviderRegistryTransientState.makeHarness")(function* () {
  const snapshotRef = yield* Ref.make(provider("2026-08-24T00:00:00.000Z"));
  const sourceChanges = yield* PubSub.unbounded<ServerProvider>();
  const registryChanges = yield* PubSub.unbounded<void>();
  const refreshFailsRef = yield* Ref.make(false);

  const makeInstance = (): ProviderInstance => ({
    instanceId: INSTANCE_ID,
    driverKind: DRIVER,
    continuationIdentity: {
      driverKind: DRIVER,
      continuationKey: "cursor:instance:cursor",
    },
    displayName: undefined,
    enabled: true,
    snapshot: {
      maintenanceCapabilities: makeManualOnlyProviderMaintenanceCapabilities({
        provider: DRIVER,
        packageName: null,
      }),
      getSnapshot: Ref.get(snapshotRef),
      refresh: Effect.gen(function* () {
        if (yield* Ref.get(refreshFailsRef)) {
          return yield* Effect.die(new Error("simulated provider refresh failure"));
        }
        return yield* Ref.get(snapshotRef);
      }),
      streamChanges: Stream.fromPubSub(sourceChanges),
    },
    adapter: {} as ProviderInstance["adapter"],
    textGeneration: {} as ProviderInstance["textGeneration"],
  });

  const initialInstance = makeInstance();
  const instancesRef = yield* Ref.make<ReadonlyArray<ProviderInstance>>([initialInstance]);
  const instanceRegistryLayer = Layer.succeed(ProviderInstanceRegistry.ProviderInstanceRegistry, {
    getInstance: (instanceId) =>
      Ref.get(instancesRef).pipe(
        Effect.map((instances) => instances.find((instance) => instance.instanceId === instanceId)),
      ),
    rebuildInstance: () => Effect.void,
    listInstances: Ref.get(instancesRef),
    listUnavailable: Effect.succeed([]),
    streamChanges: Stream.fromPubSub(registryChanges),
    subscribeChanges: PubSub.subscribe(registryChanges),
  });
  const services = yield* Layer.build(
    ProviderRegistryLive.pipe(
      Layer.provideMerge(instanceRegistryLayer),
      Layer.provideMerge(
        ServerConfig.layerTest(process.cwd(), {
          prefix: "scient-provider-registry-transient-state-",
        }),
      ),
      Layer.provideMerge(BackgroundPolicyAlwaysRunLayer),
      Layer.provideMerge(NodeServices.layer),
    ),
  );
  const registry = yield* ProviderRegistry.ProviderRegistry.pipe(Effect.provide(services));
  const config = yield* ServerConfig.ServerConfig.pipe(Effect.provide(services));
  const cachePath = yield* resolveProviderStatusCachePath({
    cacheDir: config.providerStatusCacheDir,
    instanceId: INSTANCE_ID,
  }).pipe(Effect.provide(services));
  return {
    registry,
    snapshotRef,
    refreshFailsRef,
    instancesRef,
    registryChanges,
    makeInstance,
    cachePath,
  };
});

const nextRegistryEmission = Effect.fn("ProviderRegistryTransientState.nextEmission")(function* (
  registry: ProviderRegistry.ProviderRegistryShape,
) {
  const fiber = yield* registry.streamChanges.pipe(Stream.runHead, Effect.forkChild);
  yield* Effect.yieldNow;
  return fiber;
});

describe("ProviderRegistry transient lifecycle overlays", () => {
  it.effect(
    "publishes and reapplies transient state without persisting process-local operations",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { registry, snapshotRef, cachePath } = yield* makeHarness();
          yield* Ref.set(snapshotRef, provider("2026-08-24T00:00:01.000Z"));
          yield* registry.refreshInstance(INSTANCE_ID);

          const publishedFiber = yield* nextRegistryEmission(registry);
          const withConnection = yield* registry.setProviderConnectionOperation({
            instanceId: INSTANCE_ID,
            operation: connectionOperation,
          });
          const published = Option.getOrThrow(yield* Fiber.join(publishedFiber));
          assert.deepStrictEqual(published, withConnection);
          assert.deepStrictEqual(withConnection[0]?.connection?.operation, connectionOperation);

          yield* registry.setProviderManagedRuntimeSummary({
            instanceId: INSTANCE_ID,
            runtime: managedRuntime,
          });
          yield* Ref.set(snapshotRef, provider("2026-08-24T00:00:02.000Z"));
          const refreshed = yield* registry.refreshInstance(INSTANCE_ID);

          assert.deepStrictEqual(refreshed[0]?.connection?.operation, connectionOperation);
          assert.deepStrictEqual(refreshed[0]?.connection?.runtime, managedRuntime);
          const cached = yield* readProviderStatusCache(cachePath).pipe(
            Effect.provide(NodeServices.layer),
          );
          assert.exists(cached);
          assert.strictEqual(cached.connection?.operation, null);
          assert.strictEqual(cached.connection?.runtime?.operation, null);

          const clearedConnection = yield* registry.setProviderConnectionOperation({
            instanceId: INSTANCE_ID,
            operation: null,
          });
          yield* registry.setProviderManagedRuntimeSummary({
            instanceId: INSTANCE_ID,
            runtime: null,
          });
          const cleared = yield* registry.refreshInstance(INSTANCE_ID);
          assert.strictEqual(clearedConnection[0]?.connection?.operation, null);
          assert.strictEqual(cleared[0]?.connection?.runtime?.source, "system");
        }),
      ),
  );

  it.effect("prunes overlays when an instance disappears before the same id is rebuilt", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { registry, instancesRef, registryChanges, makeInstance } = yield* makeHarness();
        yield* registry.setProviderConnectionOperation({
          instanceId: INSTANCE_ID,
          operation: connectionOperation,
        });
        yield* registry.setProviderManagedRuntimeSummary({
          instanceId: INSTANCE_ID,
          runtime: managedRuntime,
        });
        yield* registry.setProviderAuthenticationFailure({
          instanceId: INSTANCE_ID,
          message: "Provider authentication expired. Sign in again.",
        });

        const removedFiber = yield* nextRegistryEmission(registry);
        yield* Ref.set(instancesRef, []);
        yield* PubSub.publish(registryChanges, undefined);
        assert.deepStrictEqual(Option.getOrThrow(yield* Fiber.join(removedFiber)), []);

        const rebuiltFiber = yield* nextRegistryEmission(registry);
        yield* Ref.set(instancesRef, [makeInstance()]);
        yield* PubSub.publish(registryChanges, undefined);
        const rebuilt = Option.getOrThrow(yield* Fiber.join(rebuiltFiber));

        assert.strictEqual(rebuilt[0]?.connection?.operation, null);
        assert.strictEqual(rebuilt[0]?.connection?.runtime?.source, "system");
        assert.strictEqual(rebuilt[0]?.connection?.runtime?.operation, null);
        assert.strictEqual(rebuilt[0]?.message, undefined);
      }),
    ),
  );

  it.effect("keeps runtime-proven authentication failure until a verified account transition", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { registry, snapshotRef, refreshFailsRef, cachePath } = yield* makeHarness();
        yield* Ref.set(snapshotRef, authenticatedProvider("2026-08-24T00:00:01.000Z"));
        yield* registry.refreshInstance(INSTANCE_ID);

        const failed = yield* registry.setProviderAuthenticationFailure({
          instanceId: INSTANCE_ID,
          message: "OAuth access token has been revoked. Sign in again.",
        });
        assert.strictEqual(failed[0]?.status, "warning");
        assert.strictEqual(failed[0]?.auth.status, "unauthenticated");
        assert.strictEqual(failed[0]?.connection?.canDisconnect, false);

        yield* Ref.set(snapshotRef, authenticatedProvider("2026-08-24T00:00:02.000Z"));
        const passivelyRefreshed = yield* registry.refreshInstance(INSTANCE_ID);
        assert.strictEqual(passivelyRefreshed[0]?.auth.status, "unauthenticated");
        assert.strictEqual(
          passivelyRefreshed[0]?.message,
          "OAuth access token has been revoked. Sign in again.",
        );

        const cached = yield* readProviderStatusCache(cachePath).pipe(
          Effect.provide(NodeServices.layer),
        );
        assert.strictEqual(cached?.auth.status, "authenticated");

        yield* Ref.set(refreshFailsRef, true);
        const failedRefresh = yield* registry
          .refreshInstanceAfterAccountChange(INSTANCE_ID)
          .pipe(Effect.result);
        assert.strictEqual(failedRefresh._tag, "Failure");
        yield* Ref.set(refreshFailsRef, false);

        const afterFailedVerification = yield* registry.refreshInstance(INSTANCE_ID);
        assert.strictEqual(afterFailedVerification[0]?.auth.status, "unauthenticated");

        const recovered = yield* registry.refreshInstanceAfterAccountChange(INSTANCE_ID);
        assert.strictEqual(recovered[0]?.status, "ready");
        assert.strictEqual(recovered[0]?.auth.status, "authenticated");
        assert.strictEqual(recovered[0]?.connection?.canDisconnect, true);
      }),
    ),
  );

  it.effect("does not invent assisted recovery for an externally managed account", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { registry, snapshotRef } = yield* makeHarness();
        const externalProvider: ServerProvider = {
          ...authenticatedProvider("2026-08-24T00:00:01.000Z"),
          auth: {
            status: "authenticated",
            required: false,
            type: "apiKey",
            label: "External API key",
          },
          connection: {
            methods: [],
            canDisconnect: false,
            operation: null,
            runtime: systemRuntime,
          },
        };
        yield* Ref.set(snapshotRef, externalProvider);
        yield* registry.refreshInstance(INSTANCE_ID);

        const unchanged = yield* registry.setProviderAuthenticationFailure({
          instanceId: INSTANCE_ID,
          message: "Provider authentication expired. Sign in again.",
        });

        assert.strictEqual(unchanged[0]?.status, "ready");
        assert.strictEqual(unchanged[0]?.auth.status, "authenticated");
        assert.strictEqual(unchanged[0]?.message, undefined);
        assert.deepStrictEqual(unchanged[0]?.connection?.methods, []);
      }),
    ),
  );
});
