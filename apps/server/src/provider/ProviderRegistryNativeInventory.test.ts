import * as NodeServices from "@effect/platform-node/NodeServices";
import * as ProviderLatestVersions from "@t3tools/provider-core/server/ProviderLatestVersions";
import { assert, describe, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type ServerProviderMcpServer,
  type ServerProviderPlugin,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import { makeManualOnlyProviderMaintenanceCapabilities } from "@t3tools/provider-core/server/maintenanceResolver";

import * as BackgroundPolicy from "../background/BackgroundPolicy.ts";
import { makeProviderPluginManagement } from "../scient/extensions/ProviderPluginManagement.ts";
import { mergeProviderInventory } from "../../../web/src/scient/extensions/providerInventory.ts";
import * as ServerConfig from "../config.ts";
import * as ModelManifest from "./ModelManifest.ts";
import { readProviderStatusCache, resolveProviderStatusCachePath } from "./providerStatusCache.ts";
import * as ProviderInstanceRegistry from "./ProviderInstanceRegistry.ts";
import { nextInventoryReadSequence } from "./ProviderNativeInventory.ts";
import * as ProviderRegistry from "./ProviderRegistry.ts";
import type { ScientProviderInstance } from "./ScientProviderInstance.ts";
import type {
  ProviderNativeInventory,
  ProviderPluginActions,
  ProviderWorkspaceInventory,
} from "./ScientProviderInstanceSeams.ts";

const DRIVER = ProviderDriverKind.make("codex");
const INSTANCE_ID = ProviderInstanceId.make("codex");
const TEST_EPOCH = DateTime.makeUnsafe("1970-01-01T00:00:00.000Z");

const linear: ServerProviderPlugin = {
  id: "linear@curated",
  name: "linear",
  source: "remote",
  enabled: true,
  canUninstall: true,
};
const notion: ServerProviderMcpServer = {
  name: "notion",
  status: "needs-auth",
  canStartSignIn: true,
};

function provider(checkedAt: string, inventory: ProviderNativeInventory = {}): ServerProvider {
  return {
    instanceId: INSTANCE_ID,
    driver: DRIVER,
    status: "ready",
    enabled: true,
    installed: true,
    auth: { status: "authenticated" },
    checkedAt,
    version: "0.150.0",
    models: [],
    slashCommands: [],
    skills: [],
    ...inventory,
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

const makeHarness = Effect.fn("ProviderRegistryNativeInventory.makeHarness")(function* (
  actionOverrides: Partial<ProviderPluginActions> = {},
) {
  const snapshotRef = yield* Ref.make(provider("2026-10-21T00:00:00.000Z"));
  const registryChanges = yield* PubSub.unbounded<void>();

  const harnessScope = yield* Effect.scope;
  // Workspace scans finish when this gate does; tests hold it to run scans concurrently.
  const scanGateRef = yield* Ref.make<Effect.Effect<void>>(Effect.void);
  // Listing cleanup (`cancel`) finishes when this gate does, like a slow teardown.
  const cancelGateRef = yield* Ref.make<Effect.Effect<void>>(Effect.void);
  const scanCalls = yield* Ref.make(0);
  const makeInstance = Effect.fn("makeInstance")(function* () {
    const liveInventory = yield* PubSub.unbounded<ProviderNativeInventory>();
    // Workspace listings answer when the test opens this gate, after the scan.
    const workspaceListingGate = yield* Deferred.make<void>();
    const workspaceCalls: Array<string> = [];
    const listingFibers = new Map<string, Fiber.Fiber<void>>();
    const listingReadRef = yield* Ref.make<
      (cwd: string) => Effect.Effect<ReadonlyArray<ServerProviderPlugin> | undefined>
    >(() => Deferred.await(workspaceListingGate).pipe(Effect.as([linear])));
    /** Workspaces whose listing is queued or running. */
    const runningWorkspaceListings = new Set<string>();
    const workspaceInventory: ProviderWorkspaceInventory = {
      awaitCurrent: (cwd) =>
        Effect.suspend(() => {
          const fiber = listingFibers.get(cwd);
          return fiber ? Fiber.await(fiber).pipe(Effect.asVoid) : Effect.void;
        }),
      cancel: (cwd) =>
        Ref.get(cancelGateRef).pipe(
          Effect.flatten,
          Effect.andThen(
            Effect.sync(() => {
              workspaceCalls.push(`cancel ${cwd}`);
              runningWorkspaceListings.delete(cwd);
            }),
          ),
          Effect.andThen(
            Effect.suspend(() => {
              const fiber = listingFibers.get(cwd);
              listingFibers.delete(cwd);
              return fiber ? Fiber.interrupt(fiber).pipe(Effect.asVoid) : Effect.void;
            }),
          ),
        ),
      refresh: (cwd, publish) =>
        Effect.sync(() => {
          workspaceCalls.push(`refresh ${cwd}`);
          runningWorkspaceListings.add(cwd);
        }).pipe(
          Effect.andThen(
            Effect.gen(function* () {
              const sequence = yield* nextInventoryReadSequence;
              const read = yield* Ref.get(listingReadRef);
              const plugins = yield* read(cwd);
              if (plugins !== undefined) yield* publish({ cwd, plugins, sequence });
            }).pipe(
              Effect.forkIn(harnessScope),
              Effect.tap((fiber) =>
                Effect.sync(() => {
                  listingFibers.set(cwd, fiber);
                }),
              ),
            ),
          ),
          Effect.asVoid,
        ),
      retain: (current) =>
        current.pipe(
          Effect.flatMap((keep) =>
            Effect.gen(function* () {
              const runningListings = [...runningWorkspaceListings];
              for (const cwd of runningListings) {
                if (keep.has(cwd)) continue;
                runningWorkspaceListings.delete(cwd);
                workspaceCalls.push(`stop ${cwd}`);
                const fiber = listingFibers.get(cwd);
                listingFibers.delete(cwd);
                if (fiber) yield* Fiber.interrupt(fiber);
              }
            }),
          ),
        ),
    };
    const pluginActions: ProviderPluginActions = {
      listPlugins: () => Effect.die("unused"),
      readMcpServer: () => Effect.die("unused"),
      uninstall: () => Effect.die("unused"),
      startMcpSignIn: () => Effect.die("unused"),
      isRetired: Effect.succeed(false),
      whenRetired: Effect.never,
      ...actionOverrides,
    };
    const instance: ScientProviderInstance = {
      instanceId: INSTANCE_ID,
      driverKind: DRIVER,
      continuationIdentity: { driverKind: DRIVER, continuationKey: "codex:instance:codex" },
      displayName: undefined,
      enabled: true,
      snapshot: {
        resolveMaintenance: () =>
          Effect.succeed(
            makeManualOnlyProviderMaintenanceCapabilities({ provider: DRIVER, packageName: null }),
          ),
        getSnapshot: Ref.get(snapshotRef),
        applyUsageLimits: () => Effect.void,
        refresh: Ref.get(snapshotRef),
        streamChanges: Stream.empty,
      },
      snapshotForCwd: () =>
        Ref.update(scanCalls, (count) => count + 1).pipe(
          Effect.andThen(Ref.get(scanGateRef)),
          Effect.flatten,
          Effect.andThen(Ref.get(snapshotRef)),
        ),
      get orchestrationAdapter(): never {
        throw new Error("Snapshot projection must not start an orchestration adapter.");
      },
      textGeneration: {} as ScientProviderInstance["textGeneration"],
      pluginActions,
      nativeInventoryChanges: Stream.fromPubSub(liveInventory),
      workspaceInventory,
    };
    return {
      instance,
      liveInventory,
      pluginActions,
      workspaceListingGate,
      listingReadRef,
      workspaceCalls,
      runningWorkspaceListings,
    };
  });

  const initial = yield* makeInstance();
  const instancesRef = yield* Ref.make<ReadonlyArray<ScientProviderInstance>>([initial.instance]);
  const unavailableRef = yield* Ref.make<ReadonlyArray<ServerProvider>>([]);
  const instanceRegistryLayer = Layer.succeed(ProviderInstanceRegistry.ProviderInstanceRegistry, {
    getInstance: (instanceId) =>
      Ref.get(instancesRef).pipe(
        Effect.map((instances) => instances.find((instance) => instance.instanceId === instanceId)),
      ),
    rebuildInstance: () => Effect.void,
    listInstances: Ref.get(instancesRef),
    listUnavailable: Ref.get(unavailableRef),
    streamChanges: Stream.fromPubSub(registryChanges),
    subscribeChanges: PubSub.subscribe(registryChanges),
  });
  const services = yield* Layer.build(
    ProviderRegistry.layer.pipe(
      Layer.provideMerge(instanceRegistryLayer),
      Layer.provideMerge(
        ServerConfig.layerTest(process.cwd(), { prefix: "scient-provider-native-inventory-" }),
      ),
      Layer.provideMerge(ModelManifest.layerTest),
      Layer.provideMerge(ProviderLatestVersions.layer),
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
  const readCache = readProviderStatusCache(cachePath).pipe(Effect.provide(NodeServices.layer));
  return {
    registry,
    snapshotRef,
    registryChanges,
    instancesRef,
    unavailableRef,
    makeInstance,
    liveInventory: initial.liveInventory,
    pluginActions: initial.pluginActions,
    workspaceListingGate: initial.workspaceListingGate,
    listingReadRef: initial.listingReadRef,
    workspaceCalls: initial.workspaceCalls,
    runningWorkspaceListings: initial.runningWorkspaceListings,
    scanGateRef,
    cancelGateRef,
    scanCalls,
    readCache,
  };
});

/**
 * Returns the provider once `ready` holds. The registry commits its state before
 * publishing it, so subscribing before reading cannot miss a later publication.
 */
const awaitProviders = Effect.fn("awaitProviders")(function* (
  registry: ProviderRegistry.ProviderRegistry["Service"],
  ready: (provider: ServerProvider | undefined) => boolean,
) {
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const published = yield* Stream.toPull(
        registry.streamChanges.pipe(Stream.filter((providers) => ready(providers[0]))),
      );
      const current = (yield* registry.getProviders)[0];
      if (ready(current)) return current;
      return (yield* published)[0][0];
    }),
  );
});

describe("ProviderRegistry provider-native inventory", () => {
  it.effect(
    "keeps the last complete report across probes and partial reports, never caching it",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { registry, snapshotRef, liveInventory, readCache } = yield* makeHarness();
          yield* registry.refreshInstance(INSTANCE_ID);
          yield* PubSub.publish(liveInventory, { plugins: [linear], mcpServers: [notion] });
          yield* awaitProviders(registry, (current) => current?.plugins?.length === 1);

          // The plugin listing was incomplete this time, so the report omits it.
          yield* PubSub.publish(liveInventory, { mcpServers: [] });
          const partial = yield* awaitProviders(
            registry,
            (current) => current?.mcpServers?.length === 0,
          );
          assert.deepStrictEqual(partial?.plugins, [linear]);

          // A probe never carries this inventory and never erases it.
          yield* Ref.set(snapshotRef, provider("2026-10-21T00:00:02.000Z"));
          const probed = (yield* registry.refreshInstance(INSTANCE_ID))[0];
          const generation = partial?.nativeInventoryGeneration;
          assert.isString(generation);
          assert.strictEqual(probed?.nativeInventoryGeneration, generation);
          assert.deepStrictEqual(probed?.plugins, [linear]);
          assert.strictEqual(probed?.checkedAt, "2026-10-21T00:00:02.000Z");
          const cached = yield* readCache;
          assert.exists(cached);
          assert.strictEqual(cached.checkedAt, "2026-10-21T00:00:02.000Z");
          assert.strictEqual("plugins" in cached, false);
          assert.strictEqual("mcpServers" in cached, false);
          assert.strictEqual("nativeInventoryGeneration" in cached, false);

          // A complete empty listing is authoritative.
          yield* PubSub.publish(liveInventory, { plugins: [] });
          yield* awaitProviders(registry, (current) => current?.plugins?.length === 0);
        }),
      ),
  );

  it.effect("resolves plugin actions from the current generation before the registry syncs", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { registry, instancesRef, makeInstance } = yield* makeHarness();
        const rebuilt = yield* makeInstance();
        // The instance registry already holds the new generation; no sync has run.
        yield* Ref.set(instancesRef, [rebuilt.instance]);
        assert.strictEqual(
          yield* registry.getProviderPluginActionsForInstance(INSTANCE_ID),
          rebuilt.pluginActions,
        );
      }),
    ),
  );

  it.effect("ignores reports and recorded listings from a retired generation", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        const { registry, instancesRef, registryChanges, makeInstance } = harness;
        yield* registry.refreshInstance(INSTANCE_ID);
        yield* registry.refreshWorkspaceSnapshot({ instanceId: INSTANCE_ID, cwd: "/repo" });
        const generation = (yield* registry.getProviders)[0]?.nativeInventoryGeneration;
        assert.isString(generation);
        const retired = {
          liveInventory: harness.liveInventory,
          pluginActions: harness.pluginActions,
        };

        const rebuilt = yield* makeInstance();
        yield* Ref.set(instancesRef, [rebuilt.instance]);
        yield* PubSub.publish(registryChanges, undefined);
        yield* PubSub.publish(retired.liveInventory, { plugins: [linear] });
        const ignored = yield* registry.recordProviderNativeInventory({
          instanceId: INSTANCE_ID,
          reportedBy: retired.pluginActions,
          inventory: { plugins: [linear] },
        });
        yield* awaitProviders(
          registry,
          (current) => current?.nativeInventoryGeneration !== generation,
        );
        assert.strictEqual(ignored[0]?.plugins, undefined);
        assert.strictEqual((yield* registry.getProviders)[0]?.plugins, undefined);

        yield* registry.refreshWorkspaceSnapshot({ instanceId: INSTANCE_ID, cwd: "/repo" });
        const recorded = yield* registry.recordProviderNativeInventory({
          instanceId: INSTANCE_ID,
          reportedBy: rebuilt.pluginActions,
          inventory: { cwd: "/repo", plugins: [linear] },
        });
        assert.deepStrictEqual(recorded[0]?.workspaceSnapshots?.[0]?.plugins, [linear]);
        // A workspace listing leaves the machine inventory alone.
        assert.strictEqual(recorded[0]?.plugins, undefined);
      }),
    ),
  );

  it.effect("publishes workspace plugins listed after the scan was published", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        const { registry, snapshotRef } = harness;
        yield* registry.refreshInstance(INSTANCE_ID);
        const scanned = yield* registry.refreshWorkspaceSnapshot({
          instanceId: INSTANCE_ID,
          cwd: "/repo",
        });
        // The scan returned with its skills; the listing has not answered yet.
        assert.strictEqual(scanned[0]?.workspaceSnapshots?.[0]?.plugins, undefined);
        assert.deepStrictEqual(harness.workspaceCalls, ["cancel /repo", "refresh /repo"]);

        yield* Deferred.succeed(harness.workspaceListingGate, undefined);
        const listed = yield* awaitProviders(
          registry,
          (current) => current?.workspaceSnapshots?.[0]?.plugins !== undefined,
        );
        assert.deepStrictEqual(listed?.workspaceSnapshots?.[0]?.plugins, [linear]);
        assert.strictEqual(listed?.plugins, undefined);

        // A newer scan without a listing keeps the workspace's last list.
        yield* Ref.set(snapshotRef, provider("2026-10-21T00:00:09.000Z"));
        const rescanned = yield* registry.refreshWorkspaceSnapshot({
          instanceId: INSTANCE_ID,
          cwd: "/repo",
          fresh: true,
        });
        assert.deepStrictEqual(rescanned[0]?.workspaceSnapshots?.[0]?.plugins, [linear]);
        assert.deepStrictEqual(harness.workspaceCalls.slice(2), ["cancel /repo", "refresh /repo"]);
      }),
    ),
  );

  it.effect("returns published listings for 40 serial full-inventory roots despite retention", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        const { registry } = harness;
        yield* registry.refreshInstance(INSTANCE_ID);
        const started = yield* Queue.unbounded<{ cwd: string; gate: Deferred.Deferred<void> }>();
        yield* Ref.set(harness.listingReadRef, (cwd) =>
          Effect.gen(function* () {
            const gate = yield* Deferred.make<void>();
            yield* Queue.offer(started, { cwd, gate });
            yield* Deferred.await(gate);
            return [{ ...linear, id: cwd }];
          }),
        );
        const collected: string[] = [];
        const scanning = Effect.gen(function* () {
          for (let index = 0; index < 40; index++) {
            const cwd = `/root-${index}`;
            const reply = yield* registry.refreshWorkspaceSnapshot({
              instanceId: INSTANCE_ID,
              cwd,
              awaitNativeInventory: true,
            });
            const plugins = reply[0]?.workspaceSnapshots?.find(
              (snapshot) => snapshot.cwd === cwd,
            )?.plugins;
            // Removing the completion wait returns undefined here, before the controlled listing answers.
            assert.deepStrictEqual(
              plugins?.map((plugin) => plugin.id),
              [cwd],
            );
            collected.push(...plugins!.map((plugin) => plugin.id));
          }
        });
        const releaseListings = Effect.gen(function* () {
          for (let index = 0; index < 40; index++) {
            const listing = yield* Queue.take(started);
            assert.strictEqual(listing.cwd, `/root-${index}`);
            yield* Deferred.succeed(listing.gate, undefined);
          }
        });
        yield* Effect.all([scanning, releaseListings], { concurrency: 2 });
        assert.lengthOf(collected, 40);
        assert.lengthOf((yield* registry.getProviders)[0]?.workspaceSnapshots ?? [], 16);
      }),
    ),
  );

  it.effect(
    "reacquires an evicted page root before current-generation plugin action admission",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const installed = yield* Ref.make<ReadonlyArray<ServerProviderPlugin>>([linear]);
          const validatedCwds: Array<string | undefined> = [];
          const mutations: Array<string | undefined> = [];
          const harness = yield* makeHarness({
            listPlugins: ({ cwd }) =>
              Effect.gen(function* () {
                validatedCwds.push(cwd);
                return {
                  plugins: yield* Ref.get(installed),
                  sequence: yield* nextInventoryReadSequence,
                };
              }),
            uninstall: ({ cwd }) =>
              Effect.sync(() => mutations.push(cwd)).pipe(
                Effect.andThen(Ref.set(installed, [])),
                Effect.asVoid,
              ),
          });
          const { registry } = harness;
          yield* registry.refreshInstance(INSTANCE_ID);
          yield* Ref.set(harness.listingReadRef, () => Ref.get(installed));
          const roots = new Set(Array.from({ length: 40 }, (_, index) => `/root-${index}`));
          let page: ReadonlyArray<ServerProvider> = [];
          for (const cwd of roots) {
            const reply = yield* registry.refreshWorkspaceSnapshot({
              instanceId: INSTANCE_ID,
              cwd,
              awaitNativeInventory: true,
            });
            page = mergeProviderInventory(page, reply, roots);
          }
          assert.lengthOf(page[0]?.workspaceSnapshots ?? [], 40);
          assert.lengthOf((yield* registry.getProviders)[0]?.workspaceSnapshots ?? [], 16);
          assert.isFalse(
            (yield* registry.getProviders)[0]?.workspaceSnapshots?.some(
              (snapshot) => snapshot.cwd === "/root-0",
            ),
          );
          const entered = yield* Deferred.make<void>();
          const release = yield* Deferred.make<void>();
          yield* Ref.set(harness.listingReadRef, (cwd) =>
            Effect.gen(function* () {
              assert.strictEqual(cwd, "/root-0");
              yield* Deferred.succeed(entered, undefined);
              yield* Deferred.await(release);
              return yield* Ref.get(installed);
            }),
          );
          const management = makeProviderPluginManagement(registry, yield* Effect.scope);
          const action = yield* management
            .act({
              instanceId: INSTANCE_ID,
              cwd: "/root-0",
              action: { type: "uninstall", pluginId: linear.id },
            })
            .pipe(Effect.forkChild);
          yield* Deferred.await(entered);
          assert.deepStrictEqual(validatedCwds, []);
          assert.deepStrictEqual(mutations, []);
          yield* Deferred.succeed(release, undefined);
          const result = yield* Fiber.join(action);
          assert.deepStrictEqual(validatedCwds, ["/root-0", "/root-0"]);
          assert.deepStrictEqual(mutations, ["/root-0"]);
          assert.deepStrictEqual(
            result.providers[0]?.workspaceSnapshots?.find((snapshot) => snapshot.cwd === "/root-0")
              ?.plugins,
            [],
          );
          assert.lengthOf(result.providers[0]?.workspaceSnapshots ?? [], 16);
        }),
      ),
  );

  it.effect.each(["unreported", "removed", "evicted", "replaced"] as const)(
    "refuses workspace uninstall when reacquisition is %s",
    (outcome) =>
      Effect.scoped(
        Effect.gen(function* () {
          const harness = yield* makeHarness();
          const { registry } = harness;
          yield* registry.refreshInstance(INSTANCE_ID);
          yield* Ref.set(harness.listingReadRef, () =>
            Effect.succeed(
              outcome === "unreported" ? undefined : outcome === "removed" ? [] : [linear],
            ),
          );
          const management = makeProviderPluginManagement(
            {
              ...registry,
              refreshWorkspaceSnapshot: Effect.fn("test.reacquireThenInterleave")(function* (
                input: Parameters<
                  ProviderRegistry.ProviderRegistryShape["refreshWorkspaceSnapshot"]
                >[0],
              ) {
                const reply = yield* registry.refreshWorkspaceSnapshot(input);
                if (outcome === "evicted") {
                  for (let index = 0; index < 16; index++) {
                    yield* registry.refreshWorkspaceSnapshot({
                      instanceId: INSTANCE_ID,
                      cwd: `/other-${index}`,
                      awaitNativeInventory: true,
                    });
                  }
                } else if (outcome === "replaced") {
                  const replacement = yield* harness.makeInstance();
                  yield* Ref.set(harness.instancesRef, [replacement.instance]);
                }
                return reply;
              }),
            },
            yield* Effect.scope,
          );
          const error = yield* management
            .act({
              instanceId: INSTANCE_ID,
              cwd: "/evicted",
              action: { type: "uninstall", pluginId: linear.id },
            })
            .pipe(Effect.flip);
          assert.strictEqual(
            error.reason,
            outcome === "removed" ? "not-found" : "state-unavailable",
          );
        }),
      ),
  );

  it.effect("interrupts action reacquisition when its captured generation retires", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const retired = yield* Deferred.make<void>();
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const harness = yield* makeHarness({
          isRetired: Deferred.isDone(retired),
          whenRetired: Deferred.await(retired),
        });
        yield* harness.registry.refreshInstance(INSTANCE_ID);
        yield* Ref.set(harness.listingReadRef, () =>
          Deferred.succeed(entered, undefined).pipe(
            Effect.andThen(Deferred.await(release)),
            Effect.as([linear]),
          ),
        );
        const management = makeProviderPluginManagement(harness.registry, yield* Effect.scope);
        const action = yield* management
          .act({
            instanceId: INSTANCE_ID,
            cwd: "/evicted",
            action: { type: "uninstall", pluginId: linear.id },
          })
          .pipe(Effect.flip, Effect.forkChild);
        yield* Deferred.await(entered);
        yield* Deferred.succeed(retired, undefined);
        assert.strictEqual((yield* Fiber.join(action)).reason, "state-unavailable");
        yield* Deferred.succeed(release, undefined);
      }),
    ),
  );

  it.effect("waits for a cached scan's native publication without owning its cancellation", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        const { registry } = harness;
        yield* registry.refreshInstance(INSTANCE_ID);
        const input = { instanceId: INSTANCE_ID, cwd: "/repo" };
        const scanned = yield* registry.refreshWorkspaceSnapshot(input);
        assert.isUndefined(scanned[0]?.workspaceSnapshots?.[0]?.plugins);
        const first = yield* registry
          .refreshWorkspaceSnapshot({ ...input, awaitNativeInventory: true })
          .pipe(Effect.forkChild({ startImmediately: true }));
        assert.isUndefined(first.pollUnsafe());
        yield* Fiber.interrupt(first);
        const next = yield* registry
          .refreshWorkspaceSnapshot({ ...input, awaitNativeInventory: true })
          .pipe(Effect.forkChild({ startImmediately: true }));
        assert.isUndefined(next.pollUnsafe());
        yield* Deferred.succeed(harness.workspaceListingGate, undefined);
        assert.deepStrictEqual((yield* Fiber.join(next))[0]?.workspaceSnapshots?.[0]?.plugins, [
          linear,
        ]);
        assert.strictEqual(yield* Ref.get(harness.scanCalls), 1);
      }),
    ),
  );

  it.effect("a forced scan replaces a pending listing without reviving its old result", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        const { registry } = harness;
        yield* registry.refreshInstance(INSTANCE_ID);
        const started = yield* Deferred.make<void>();
        const oldResult = yield* Deferred.make<void>();
        yield* Ref.set(harness.listingReadRef, () =>
          Deferred.succeed(started, undefined).pipe(
            Effect.andThen(Deferred.await(oldResult)),
            Effect.as([linear]),
          ),
        );
        yield* registry.refreshWorkspaceSnapshot({ instanceId: INSTANCE_ID, cwd: "/repo" });
        yield* Deferred.await(started);
        yield* Ref.set(harness.listingReadRef, () => Effect.succeed([]));
        const reply = yield* registry.refreshWorkspaceSnapshot({
          instanceId: INSTANCE_ID,
          cwd: "/repo",
          fresh: true,
          awaitNativeInventory: true,
        });
        assert.deepStrictEqual(reply[0]?.workspaceSnapshots?.[0]?.plugins, []);
        yield* Deferred.succeed(oldResult, undefined);
        assert.deepStrictEqual(
          (yield* registry.getProviders)[0]?.workspaceSnapshots?.[0]?.plugins,
          [],
        );
        assert.strictEqual(yield* Ref.get(harness.scanCalls), 2);
      }),
    ),
  );

  it.effect("leaves an unsuccessful full-inventory listing unknown instead of empty", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        yield* harness.registry.refreshInstance(INSTANCE_ID);
        // @effect-diagnostics-next-line effectSucceedWithVoid:off -- An unreported listing is undefined, not void.
        yield* Ref.set(harness.listingReadRef, () => Effect.succeed(undefined));
        const reply = yield* harness.registry.refreshWorkspaceSnapshot({
          instanceId: INSTANCE_ID,
          cwd: "/repo",
          awaitNativeInventory: true,
        });
        assert.isUndefined(reply[0]?.workspaceSnapshots?.[0]?.plugins);
      }),
    ),
  );

  it.effect("does not apply a full-inventory completion from a replaced instance", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        const { registry } = harness;
        yield* registry.refreshInstance(INSTANCE_ID);
        yield* registry.refreshWorkspaceSnapshot({ instanceId: INSTANCE_ID, cwd: "/repo" });
        const waiting = yield* registry
          .refreshWorkspaceSnapshot({
            instanceId: INSTANCE_ID,
            cwd: "/repo",
            awaitNativeInventory: true,
          })
          .pipe(Effect.forkChild({ startImmediately: true }));
        const replacement = yield* harness.makeInstance();
        yield* Ref.set(harness.instancesRef, [replacement.instance]);
        yield* Deferred.succeed(harness.workspaceListingGate, undefined);
        const reply = yield* Fiber.join(waiting);
        assert.isUndefined(reply[0]?.workspaceSnapshots?.[0]?.plugins);
      }),
    ),
  );

  it.effect("releases an explicit inventory waiter when another scan evicts its listing", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        const { registry } = harness;
        yield* registry.refreshInstance(INSTANCE_ID);
        yield* registry.refreshWorkspaceSnapshot({ instanceId: INSTANCE_ID, cwd: "/repo" });
        const waiting = yield* registry
          .refreshWorkspaceSnapshot({
            instanceId: INSTANCE_ID,
            cwd: "/repo",
            awaitNativeInventory: true,
          })
          .pipe(Effect.forkChild({ startImmediately: true }));
        for (let index = 0; index < 16; index++) {
          yield* registry.refreshWorkspaceSnapshot({
            instanceId: INSTANCE_ID,
            cwd: `/other-${index}`,
          });
        }
        assert.isFalse(
          (yield* Fiber.join(waiting))[0]?.workspaceSnapshots?.some(
            (snapshot) => snapshot.cwd === "/repo",
          ),
        );
        assert.include(harness.workspaceCalls, "stop /repo");
      }),
    ),
  );

  it.effect(
    "publishes live-session inventory over probes and drops it when the instance rebuilds",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const {
            registry,
            snapshotRef,
            liveInventory,
            readCache,
            instancesRef,
            registryChanges,
            makeInstance,
          } = yield* makeHarness();
          yield* registry.refreshInstance(INSTANCE_ID);

          yield* PubSub.publish(liveInventory, { plugins: [linear] });
          yield* awaitProviders(registry, (current) => current?.plugins?.length === 1);
          // A later partial report keeps the fields it does not carry.
          yield* PubSub.publish(liveInventory, { mcpServers: [notion] });
          const live = yield* awaitProviders(
            registry,
            (current) => current?.mcpServers !== undefined,
          );
          assert.deepStrictEqual(live?.plugins, [linear]);

          // The live report wins over a probe that reports something else.
          yield* Ref.set(
            snapshotRef,
            provider("2026-10-21T00:00:04.000Z", { plugins: [], mcpServers: [] }),
          );
          const refreshed = (yield* registry.refreshInstance(INSTANCE_ID))[0];
          assert.deepStrictEqual(refreshed?.plugins, [linear]);
          assert.deepStrictEqual(refreshed?.mcpServers, [notion]);
          const cached = yield* readCache;
          assert.exists(cached);
          assert.strictEqual("plugins" in cached, false);

          yield* Ref.set(snapshotRef, provider("2026-10-21T00:00:05.000Z"));
          const rebuilt = yield* makeInstance();
          yield* Ref.set(instancesRef, [rebuilt.instance]);
          yield* PubSub.publish(registryChanges, undefined);
          const afterRebuild = yield* awaitProviders(
            registry,
            (current) => current?.checkedAt === "2026-10-21T00:00:05.000Z",
          );
          assert.strictEqual(afterRebuild?.plugins, undefined);
          assert.strictEqual(afterRebuild?.mcpServers, undefined);
        }),
      ),
  );

  it("keeps a workspace's plugins when its scan could not list them", () => {
    const scanned = ProviderRegistry.upsertProviderWorkspaceSnapshot(
      provider("2026-10-21T00:00:00.000Z", { plugins: [] }),
      "/repo",
      provider("2026-10-21T00:00:01.000Z", { plugins: [linear] }),
    );
    assert.deepStrictEqual(scanned.workspaceSnapshots?.[0]?.plugins, [linear]);
    // Machine-level plugins are untouched by a workspace scan.
    assert.deepStrictEqual(scanned.plugins, []);

    const failedScan = ProviderRegistry.upsertProviderWorkspaceSnapshot(
      scanned,
      "/repo",
      provider("2026-10-21T00:00:02.000Z"),
    );
    assert.deepStrictEqual(failedScan.workspaceSnapshots?.[0]?.plugins, [linear]);
    assert.strictEqual(failedScan.workspaceSnapshots?.[0]?.checkedAt, "2026-10-21T00:00:02.000Z");
  });

  it.effect(
    "drops a generation's inventory when it becomes unavailable, and never revives it",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const harness = yield* makeHarness();
          const { registry, instancesRef, unavailableRef, registryChanges, makeInstance } = harness;
          yield* registry.refreshInstance(INSTANCE_ID);
          yield* PubSub.publish(harness.liveInventory, { plugins: [linear], mcpServers: [notion] });
          yield* awaitProviders(registry, (current) => current?.mcpServers?.length === 1);

          // The rebuild fails: the configured instance is unavailable for now.
          yield* Ref.set(instancesRef, []);
          yield* Ref.set(unavailableRef, [
            { ...provider("2026-10-21T00:00:05.000Z"), status: "error", installed: false },
          ]);
          yield* PubSub.publish(registryChanges, undefined);
          const unavailable = yield* awaitProviders(
            registry,
            (current) => current?.status === "error",
          );
          assert.strictEqual(unavailable?.plugins, undefined);
          assert.strictEqual(unavailable?.mcpServers, undefined);

          // The repaired configuration comes back as a new generation.
          const recovered = yield* makeInstance();
          yield* Ref.set(harness.snapshotRef, provider("2026-10-21T00:00:06.000Z"));
          yield* Ref.set(unavailableRef, []);
          yield* Ref.set(instancesRef, [recovered.instance]);
          yield* PubSub.publish(registryChanges, undefined);
          const back = yield* awaitProviders(registry, (current) => current?.status === "ready");
          assert.strictEqual(back?.plugins, undefined);
          assert.strictEqual(back?.mcpServers, undefined);
          // Its first, partial report cannot pick up the other field from the old generation.
          yield* PubSub.publish(recovered.liveInventory, { mcpServers: [] });
          const reported = yield* awaitProviders(
            registry,
            (current) => current?.mcpServers?.length === 0,
          );
          assert.strictEqual(reported?.plugins, undefined);
        }),
      ),
  );

  it.effect("stops the plugin listing of a workspace snapshot the registry evicts", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        const { registry } = harness;
        yield* registry.refreshInstance(INSTANCE_ID);
        // One more workspace than the registry keeps.
        for (let index = 0; index <= 16; index++) {
          yield* registry.refreshWorkspaceSnapshot({ instanceId: INSTANCE_ID, cwd: `/w-${index}` });
        }
        const kept = (yield* registry.getProviders)[0]?.workspaceSnapshots?.map((s) => s.cwd);
        assert.notInclude(kept ?? [], "/w-0");
        assert.strictEqual(harness.workspaceCalls.at(-1), "stop /w-0");
        assert.sameMembers([...harness.runningWorkspaceListings], kept ?? []);
      }),
    ),
  );

  it.effect("stops every evicted listing when workspace scans finish concurrently", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        const { registry } = harness;
        yield* registry.refreshInstance(INSTANCE_ID);
        // All scans start against the same empty inventory, then finish together.
        const scanGate = yield* Deferred.make<void>();
        yield* Ref.set(harness.scanGateRef, Deferred.await(scanGate));
        const workspaces = Array.from({ length: 24 }, (_, index) => `/w-${index}`);
        const scans = yield* Effect.forEach(workspaces, (cwd) =>
          registry
            .refreshWorkspaceSnapshot({ instanceId: INSTANCE_ID, cwd })
            .pipe(Effect.forkChild),
        );
        for (let attempt = 0; attempt < 50; attempt++) yield* Effect.yieldNow;
        yield* Deferred.succeed(scanGate, undefined);
        yield* Fiber.joinAll(scans);

        const kept = (yield* registry.getProviders)[0]?.workspaceSnapshots?.map((s) => s.cwd);
        assert.lengthOf(kept ?? [], 16);
        // Only the published workspaces still have a listing.
        assert.sameMembers([...harness.runningWorkspaceListings], kept ?? []);
      }),
    ),
  );

  it.effect("never lets a read that began earlier replace a verified uninstall", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        const { registry, liveInventory, pluginActions } = harness;
        yield* registry.refreshInstance(INSTANCE_ID);
        yield* registry.refreshWorkspaceSnapshot({ instanceId: INSTANCE_ID, cwd: "/repo" });

        // Background listings begin, then an uninstall is verified with a later read.
        const backgroundRead = yield* nextInventoryReadSequence;
        const verifiedRead = yield* nextInventoryReadSequence;
        yield* registry.recordProviderNativeInventory({
          instanceId: INSTANCE_ID,
          reportedBy: pluginActions,
          inventory: { plugins: [], sequence: verifiedRead },
        });
        yield* registry.recordProviderNativeInventory({
          instanceId: INSTANCE_ID,
          reportedBy: pluginActions,
          inventory: { cwd: "/repo", plugins: [], sequence: verifiedRead },
        });

        // The slow background results arrive afterwards.
        yield* PubSub.publish(liveInventory, { plugins: [linear], sequence: backgroundRead });
        yield* PubSub.publish(liveInventory, {
          cwd: "/repo",
          plugins: [linear],
          sequence: backgroundRead,
        });
        // A newer MCP listing still applies.
        yield* PubSub.publish(liveInventory, {
          mcpServers: [notion],
          sequence: yield* nextInventoryReadSequence,
        });
        const current = yield* awaitProviders(
          registry,
          (candidate) => candidate?.mcpServers !== undefined,
        );
        assert.deepStrictEqual(current?.plugins, []);
        assert.deepStrictEqual(current?.workspaceSnapshots?.[0]?.plugins, []);
      }),
    ),
  );

  it.effect(
    "ignores a listing of an evicted workspace that began before it was scanned again",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { registry, liveInventory } = yield* makeHarness();
          yield* registry.refreshInstance(INSTANCE_ID);
          const beforeRescan = yield* nextInventoryReadSequence;
          yield* registry.refreshWorkspaceSnapshot({ instanceId: INSTANCE_ID, cwd: "/repo" });
          yield* PubSub.publish(liveInventory, {
            cwd: "/repo",
            plugins: [linear],
            sequence: beforeRescan,
          });
          yield* PubSub.publish(liveInventory, { mcpServers: [notion] });
          const current = yield* awaitProviders(
            registry,
            (candidate) => candidate?.mcpServers !== undefined,
          );
          assert.strictEqual(current?.workspaceSnapshots?.[0]?.plugins, undefined);
        }),
      ),
  );

  it.effect(
    "shares a workspace scan through caller cancellation during listing cleanup and releases its claim",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const harness = yield* makeHarness();
          const { registry } = harness;
          yield* registry.refreshInstance(INSTANCE_ID);
          // Cleanup of the workspace's old listing is slow.
          const cleanupStarted = yield* Deferred.make<void>();
          const cleanupGate = yield* Deferred.make<void>();
          yield* Ref.set(
            harness.cancelGateRef,
            Deferred.succeed(cleanupStarted, undefined).pipe(
              Effect.andThen(Deferred.await(cleanupGate)),
            ),
          );
          const scan = yield* registry
            .refreshWorkspaceSnapshot({ instanceId: INSTANCE_ID, cwd: "/repo" })
            .pipe(Effect.forkChild);
          yield* Deferred.await(cleanupStarted);
          // The caller goes away while the old listing is still shutting down.
          yield* Fiber.interrupt(scan);
          const waiter = yield* registry
            .refreshWorkspaceSnapshot({
              instanceId: INSTANCE_ID,
              cwd: "/repo",
              awaitNativeInventory: true,
            })
            .pipe(Effect.forkChild);
          yield* Deferred.succeed(cleanupGate, undefined);
          yield* awaitProviders(
            registry,
            (provider) =>
              provider?.workspaceSnapshots?.some((snapshot) => snapshot.cwd === "/repo") === true,
          );
          assert.isUndefined(waiter.pollUnsafe());
          yield* Deferred.succeed(harness.workspaceListingGate, undefined);
          const scanned = yield* Fiber.join(waiter);
          assert.deepStrictEqual(scanned[0]?.workspaceSnapshots?.[0]?.plugins, [linear]);
          assert.strictEqual(yield* Ref.get(harness.scanCalls), 1);
          assert.include(
            scanned[0]?.workspaceSnapshots?.map((snapshot) => snapshot.cwd) ?? [],
            "/repo",
          );
          yield* Ref.set(harness.cancelGateRef, Effect.void);
          yield* registry.refreshWorkspaceSnapshot({
            instanceId: INSTANCE_ID,
            cwd: "/repo",
            fresh: true,
          });
          assert.strictEqual(yield* Ref.get(harness.scanCalls), 2);
        }),
      ),
  );
});
