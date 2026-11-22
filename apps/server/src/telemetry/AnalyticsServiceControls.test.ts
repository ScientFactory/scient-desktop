import * as NodeServices from "@effect/platform-node/NodeServices";
import type { AnalyticsRuntime, AnalyticsRuntimeOptions } from "@scientfactory/analytics";
import { assert, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ServerConfig from "../config.ts";
import * as ScientAnalytics from "./ScientAnalytics.ts";
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
    ingest: async () => true,
    flush: async () => 0,
    pendingCount: async () => 0,
    close: async () => {
      alive = false;
    },
  };
  return { runtime, recorded, properties };
}

it.layer(NodeServices.layer)("ScientAnalytics controls", (it) => {
  it.effect("uses an executable sibling for the analytics worker without starting collection", () =>
    Effect.gen(function* () {
      executable.active = true;
      factory.mockReset().mockImplementation(() => fakeRuntime().runtime);
      yield* ScientAnalytics.make;
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
  it.effect("collects when enabled", () =>
    Effect.gen(function* () {
      factory.mockReset().mockImplementation(() => fakeRuntime().runtime);
      assert.isTrue((yield* ScientAnalytics.make).available);
      assert.equal(factory.mock.calls.at(-1)?.[0].enabled, true);
    }).pipe(Effect.provide(testLayer())),
  );

  it.effect("reports each owner once per process", () =>
    Effect.gen(function* () {
      const active = fakeRuntime();
      factory.mockReset().mockImplementation(() => active.runtime);
      const { analytics: service } = yield* ScientAnalytics.make;
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
    }).pipe(Effect.provide(testLayer())),
  );
});

function testLayer(env: Record<string, string> = { SCIENT_ANALYTICS_ENABLED: "true" }) {
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
