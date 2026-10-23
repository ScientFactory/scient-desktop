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

const factory = vi.hoisted(() => vi.fn());
vi.mock("@scientfactory/analytics", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@scientfactory/analytics")>()),
  createAnalyticsRuntime: factory,
}));

function fakeRuntime(enabled = true) {
  let alive = enabled;
  const recorded: string[] = [];
  const runtime: AnalyticsRuntime = {
    get enabled() {
      return alive;
    },
    record: (name) => {
      if (alive) recorded.push(name);
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
  return {
    runtime,
    recorded,
    fail: () => {
      alive = false;
    },
  };
}

it.layer(NodeServices.layer)("AnalyticsService control recovery", (it) => {
  it.effect(
    "establishes collection boundaries before acknowledging consent and deletion, and releases listeners",
    () =>
      Effect.gen(function* () {
        factory.mockReset().mockImplementation(() => fakeRuntime().runtime);
        const service = yield* AnalyticsService.make;
        const seen: number[] = [];
        const phases: string[] = [];
        assert.ok(service.observeCollectionBoundary);
        const remove = yield* service.observeCollectionBoundary(async (epoch, phase) => {
          await Promise.resolve();
          seen.push(epoch);
          phases.push(phase);
        });
        assert.deepEqual(seen, [0]);
        yield* service.setConsent("off");
        assert.deepEqual(seen, [0, 1, 2]);
        yield* service.setConsent("product");
        assert.deepEqual(seen, [0, 1, 2, 3, 4]);
        yield* service.deleteData;
        assert.deepEqual(seen, [0, 1, 2, 3, 4, 5, 6]);
        assert.deepEqual(phases, [
          "ready",
          "invalidated",
          "ready",
          "invalidated",
          "ready",
          "invalidated",
          "ready",
        ]);
        remove();
        yield* service.setConsent("off");
        assert.equal(seen.length, 7);
      }).pipe(Effect.provide(testLayer())),
  );
  it.effect("a failed boundary observer cannot prevent Off or erasure", () =>
    Effect.gen(function* () {
      factory.mockReset().mockImplementation(() => fakeRuntime().runtime);
      const service = yield* AnalyticsService.make;
      assert.ok(service.observeCollectionBoundary);
      const remove = yield* service.observeCollectionBoundary(async () => {
        throw new Error("synthetic unavailable sink");
      });
      assert.equal((yield* service.setConsent("off")).consent, "off");
      assert.isTrue(yield* service.deleteData);
      remove();
    }).pipe(Effect.provide(testLayer())),
  );
  it.effect("rejects stale observer records after consent and identity boundaries", () =>
    Effect.gen(function* () {
      let active = fakeRuntime();
      factory
        .mockReset()
        .mockImplementationOnce(() => active.runtime)
        .mockImplementation(() => {
          active = fakeRuntime();
          return active.runtime;
        });
      const service = yield* AnalyticsService.make;
      const oldEpoch = yield* service.collectionEpoch;
      yield* service.setConsent("essential");
      yield* service.setConsent("product");
      yield* service.record("provider.turn.sent", { provider: "scient" }, oldEpoch);
      assert.deepEqual(active.recorded, ["app.session.started"]);
      const currentEpoch = yield* service.collectionEpoch;
      yield* service.record("provider.turn.sent", { provider: "scient" }, currentEpoch);
      assert.deepEqual(active.recorded, ["app.session.started", "provider.turn.sent"]);
      yield* service.deleteData;
      const afterDeletion = active.recorded.length;
      yield* service.record("provider.turn.sent", { provider: "scient" }, currentEpoch);
      assert.equal(active.recorded.length, afterDeletion);
      yield* service.record(
        "provider.turn.sent",
        { provider: "scient" },
        yield* service.collectionEpoch,
      );
      assert.equal(active.recorded.length, afterDeletion + 1);
    }).pipe(Effect.provide(testLayer())),
  );
  it.effect("does not inspect or record owner identities while product analytics is enabled", () =>
    Effect.gen(function* () {
      const active = fakeRuntime();
      factory
        .mockReset()
        .mockImplementation((options: AnalyticsRuntimeOptions) =>
          options.enabled ? active.runtime : fakeRuntime(false).runtime,
        );
      const service = yield* AnalyticsService.make;
      assert.deepEqual(yield* service.status, { available: true, consent: "product" });
      for (const observedBy of ["server", "client"] as const) {
        yield* service.recordOwners(
          [
            {
              get source(): "openai" {
                throw new Error("Unexpected telemetry identity inspection");
              },
              get ownerId(): string {
                throw new Error("Unexpected telemetry identity inspection");
              },
            },
          ],
          observedBy,
        );
      }
      yield* service.record("project.opened");
      assert.deepEqual(active.recorded, ["app.session.started", "project.opened"]);
    }).pipe(Effect.provide(testLayer())),
  );

  it.effect("defaults to usage and reliability when available without a saved preference", () =>
    Effect.gen(function* () {
      factory.mockReset().mockImplementation(() => fakeRuntime().runtime);
      const service = yield* AnalyticsService.make;
      assert.deepEqual(yield* service.status, { available: true, consent: "diagnostic" });
      assert.equal(factory.mock.calls.at(-1)?.[0].consent, "diagnostic");
    }).pipe(Effect.provide(testLayer({ SCIENT_ANALYTICS_ENABLED: "true" }))),
  );

  it.effect("preserves a saved Off choice across service restarts with the new default", () =>
    Effect.gen(function* () {
      factory
        .mockReset()
        .mockImplementation(
          (options: AnalyticsRuntimeOptions) => fakeRuntime(options.enabled).runtime,
        );
      yield* Effect.scoped(
        Effect.gen(function* () {
          const service = yield* AnalyticsService.make;
          yield* service.setConsent("off");
        }),
      );
      const service = yield* AnalyticsService.make;
      assert.deepEqual(yield* service.status, { available: true, consent: "off" });
    }).pipe(Effect.provide(testLayer({ SCIENT_ANALYTICS_ENABLED: "true" }))),
  );

  it.effect("fails closed on damaged saved preferences despite the new default", () =>
    Effect.gen(function* () {
      factory.mockReset().mockImplementation(() => fakeRuntime(false).runtime);
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const config = yield* ServerConfig.ServerConfig;
      const directory = path.join(config.stateDir, "analytics");
      yield* fs.makeDirectory(directory, { recursive: true });
      yield* fs.writeFileString(path.join(directory, "preferences.json"), "invalid");
      const service = yield* AnalyticsService.make;
      assert.deepEqual(yield* service.status, { available: true, consent: "off" });
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
  it.effect("restores collection after retrying deletion through a temporary worker", () =>
    Effect.gen(function* () {
      const failed = fakeRuntime();
      const temporary = fakeRuntime();
      const replacement = fakeRuntime();
      factory.mockReset().mockImplementation((options: AnalyticsRuntimeOptions) => {
        if (!options.enabled) return fakeRuntime(false).runtime;
        if (options.purpose === "deletion") return temporary.runtime;
        return failed.runtime.enabled ? failed.runtime : replacement.runtime;
      });
      const service = yield* AnalyticsService.make;
      failed.fail(); // The runtime terminated after an ambiguous control result.
      assert.isTrue(yield* service.deleteData);
      yield* service.record("project.opened");
      assert.include(replacement.recorded, "project.opened");
      assert.isFalse(temporary.runtime.enabled);
      assert.deepEqual(yield* service.status, { available: true, consent: "product" });
    }).pipe(Effect.provide(testLayer())),
  );

  it.effect("recovers a dead worker when the existing non-Off consent is saved again", () =>
    Effect.gen(function* () {
      const failed = fakeRuntime();
      const replacement = fakeRuntime();
      factory
        .mockReset()
        .mockImplementation((options: AnalyticsRuntimeOptions) =>
          !options.enabled
            ? fakeRuntime(false).runtime
            : failed.runtime.enabled
              ? failed.runtime
              : replacement.runtime,
        );
      const service = yield* AnalyticsService.make;
      failed.fail();
      yield* service.setConsent("product");
      yield* service.record("project.opened");
      assert.include(replacement.recorded, "project.opened");
    }).pipe(Effect.provide(testLayer())),
  );
});

function testLayer(
  env = { SCIENT_ANALYTICS_ENABLED: "true", SCIENT_ANALYTICS_CONSENT: "product" } as Record<
    string,
    string
  >,
) {
  return Layer.mergeAll(
    ServerConfig.ServerConfig.layerTest(process.cwd(), { prefix: "scient-analytics-controls-" }),
    ConfigProvider.layer(
      ConfigProvider.fromEnv({
        env,
      }),
    ),
  );
}
