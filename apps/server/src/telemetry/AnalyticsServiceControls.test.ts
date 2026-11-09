// @effect-diagnostics nodeBuiltinImport:off -- Scoped synthetic preference files only.
import * as NodeServices from "@effect/platform-node/NodeServices";
import type { AnalyticsRuntime, AnalyticsRuntimeOptions } from "@scientfactory/analytics";
import { assert, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as ServerConfig from "../config.ts";
import * as AnalyticsService from "./AnalyticsService.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";

const factory = vi.hoisted(() => vi.fn());
const executable = vi.hoisted(() => ({ active: false }));
vi.mock("node:sea", () => ({ isSea: () => executable.active }));
vi.mock("@scientfactory/analytics", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@scientfactory/analytics")>()),
  createAnalyticsRuntime: factory,
}));

function fakeRuntime(enabled = true) {
  let alive = enabled;
  const recorded: string[] = [];
  const properties: unknown[] = [];
  const runtime: AnalyticsRuntime = {
    get enabled() {
      return alive;
    },
    record: (name, eventProperties) => {
      if (alive) {
        recorded.push(name);
        properties.push(eventProperties);
      }
      return alive;
    },
    flush: async () => 0,
    setConsent: async () => 0,
    pendingCount: async () => 0,
    deleteData: async () => true,
    close: async () => {
      alive = false;
    },
  };
  return { runtime, recorded, properties };
}

it.layer(NodeServices.layer)("AnalyticsService collection fences", (it) => {
  it.effect("reports the ready boundary to observers, even one that fails", () =>
    Effect.gen(function* () {
      factory.mockReset().mockImplementation(() => fakeRuntime().runtime);
      const service = yield* AnalyticsService.make;
      const seen: [number, string][] = [];
      assert.ok(service.observeCollectionBoundary);
      const remove = yield* service.observeCollectionBoundary(async (epoch, phase) => {
        await Promise.resolve();
        seen.push([epoch, phase]);
      });
      assert.deepEqual(seen, [[0, "ready"]]);
      remove();
      const removeFailing = yield* service.observeCollectionBoundary(async () => {
        throw new Error("synthetic unavailable sink");
      });
      removeFailing();
    }).pipe(Effect.provide(testLayer())),
  );
  it.effect("rejects observer records fenced to another collection epoch", () =>
    Effect.gen(function* () {
      const active = fakeRuntime();
      factory.mockReset().mockImplementation(() => active.runtime);
      const service = yield* AnalyticsService.make;
      const currentEpoch = yield* service.collectionEpoch;
      yield* service.record("provider.turn.sent", { provider: "scient" }, currentEpoch + 1);
      assert.deepEqual(active.recorded, ["app.session.started"]);
      yield* service.record("provider.turn.sent", { provider: "scient" }, currentEpoch);
      assert.deepEqual(active.recorded, ["app.session.started", "provider.turn.sent"]);
    }).pipe(Effect.provide(testLayer())),
  );
  it.effect("uses an executable sibling for the analytics worker without starting collection", () =>
    Effect.gen(function* () {
      executable.active = true;
      factory.mockReset().mockImplementation(() => fakeRuntime().runtime);
      yield* AnalyticsService.make;
      const options = factory.mock.calls.findLast(([options]) => options.enabled)?.[0] as
        | AnalyticsRuntimeOptions
        | undefined;
      assert.equal(
        options?.workerUrl?.href,
        new URL("./analytics-worker.mjs", import.meta.url).href,
      );
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          executable.active = false;
        }),
      ),
      Effect.provide(testLayer()),
    ),
  );
  it.effect("defaults to usage and reliability when available without a saved preference", () =>
    Effect.gen(function* () {
      factory.mockReset().mockImplementation(() => fakeRuntime().runtime);
      const service = yield* AnalyticsService.make;
      assert.deepEqual(yield* service.status, { available: true, consent: "diagnostic" });
      assert.equal(factory.mock.calls.at(-1)?.[0].consent, "diagnostic");
    }).pipe(Effect.provide(testLayer({ SCIENT_ANALYTICS_ENABLED: "true" }))),
  );

  it.effect("reports each owner once per process", () =>
    Effect.gen(function* () {
      const active = fakeRuntime();
      factory.mockReset().mockImplementation(() => active.runtime);
      const service = yield* AnalyticsService.make;
      const owners = [
        { source: "openai", ownerId: "a".repeat(64) },
        { source: "claude", ownerId: "b".repeat(64) },
      ] as const;
      yield* service.recordOwners(owners, "server");
      yield* service.recordOwners(owners, "server");
      assert.deepEqual(
        active.properties.filter((_, index) => active.recorded[index] === "install.owner_observed"),
        [
          { ownerSource: "openai", ownerId: "a".repeat(64), observedBy: "server" },
          { ownerSource: "claude", ownerId: "b".repeat(64), observedBy: "server" },
        ],
      );
    }).pipe(Effect.provide(testLayer({ SCIENT_ANALYTICS_ENABLED: "true" }))),
  );

  it.effect("ignores damaged saved preferences", () =>
    Effect.gen(function* () {
      factory.mockReset().mockImplementation(() => fakeRuntime(false).runtime);
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const config = yield* ServerConfig.ServerConfig;
      const directory = path.join(config.stateDir, "analytics");
      yield* fs.makeDirectory(directory, { recursive: true });
      yield* fs.writeFileString(path.join(directory, "preferences.json"), "invalid");
      const service = yield* AnalyticsService.make;
      assert.deepEqual(yield* service.status, { available: true, consent: "diagnostic" });
    }).pipe(Effect.provide(testLayer({ SCIENT_ANALYTICS_ENABLED: "true" }))),
  );

  it.effect("honors an explicit environment Off override", () =>
    Effect.gen(function* () {
      factory.mockReset().mockImplementation(() => fakeRuntime(false).runtime);
      const service = yield* AnalyticsService.make;
      assert.deepEqual(yield* service.status, { available: true, consent: "off" });
    }).pipe(
      Effect.provide(
        testLayer({ SCIENT_ANALYTICS_ENABLED: "true", SCIENT_ANALYTICS_CONSENT: "off" }),
      ),
    ),
  );
});

function testLayer(
  env = { SCIENT_ANALYTICS_ENABLED: "true", SCIENT_ANALYTICS_CONSENT: "product" } as Record<
    string,
    string
  >,
) {
  return Layer.mergeAll(
    ManagedPolicy.layerTest(),
    ServerConfig.ServerConfig.layerTest(process.cwd(), { prefix: "scient-analytics-controls-" }),
    ConfigProvider.layer(
      ConfigProvider.fromEnv({
        env,
      }),
    ),
  );
}
