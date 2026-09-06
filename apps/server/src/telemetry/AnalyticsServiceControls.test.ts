// @effect-diagnostics nodeBuiltinImport:off -- Scoped synthetic preference files only.
import * as NodeServices from "@effect/platform-node/NodeServices";
import type { AnalyticsRuntime, AnalyticsRuntimeOptions } from "@scientfactory/analytics";
import { assert, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
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

function testLayer() {
  return Layer.mergeAll(
    ServerConfig.ServerConfig.layerTest(process.cwd(), { prefix: "scient-analytics-controls-" }),
    ConfigProvider.layer(
      ConfigProvider.fromEnv({
        env: {
          SCIENT_ANALYTICS_ENABLED: "true",
          SCIENT_ANALYTICS_CONSENT: "product",
        },
      }),
    ),
  );
}
