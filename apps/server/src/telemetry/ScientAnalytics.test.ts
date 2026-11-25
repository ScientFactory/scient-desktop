// @effect-diagnostics nodeBuiltinImport:off -- This test proves disabled mode creates no local state.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../config.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import { AnalyticsService } from "./AnalyticsService.ts";
import * as ScientAnalytics from "./ScientAnalytics.ts";

it("restricts the optional analytics QA destination to literal loopback ingestion", () => {
  assert.equal(ScientAnalytics.localAnalyticsTestEndpoint(""), undefined);
  assert.equal(
    ScientAnalytics.localAnalyticsTestEndpoint("http://127.0.0.1:43199/v1/events"),
    "http://127.0.0.1:43199/v1/events",
  );
  for (const url of [
    "https://eu.posthog.com/v1/events",
    "http://127.0.0.1.attacker.test/v1/events",
    "http://user:password@127.0.0.1/v1/events",
    "http://127.0.0.1/v1/events?secret=value",
    "http://127.0.0.1/admin",
  ]) {
    assert.throws(() => ScientAnalytics.localAnalyticsTestEndpoint(url));
  }
});

it.effect("the disabled adapter reports unavailable without collecting events", () =>
  Effect.gen(function* () {
    const analytics = yield* AnalyticsService;
    yield* analytics.record("server.boot.heartbeat");
    yield* analytics.recordOwners([{ source: "connect", ownerId: "a".repeat(64) }], "server");
    yield* analytics.flush;
    assert.isFalse((yield* ScientAnalytics.ScientAnalyticsAvailability).available);
  }).pipe(Effect.provide(ScientAnalytics.layerDisabled)),
);

it.layer(NodeServices.layer)("ScientAnalytics", (it) => {
  it.effect("a managed policy turns analytics off over the environment", () =>
    Effect.gen(function* () {
      assert.isFalse((yield* ScientAnalytics.make).available);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          ManagedPolicy.layerTest({
            schemaVersion: 1,
            organization: "Example Corp",
            limits: { telemetry: false },
          }),
          ServerConfig.ServerConfig.layerTest(process.cwd(), {
            prefix: "scient-analytics-policy-",
          }),
          ConfigProvider.layer(
            ConfigProvider.fromEnv({
              env: { SCIENT_ANALYTICS_ENABLED: "true" },
            }),
          ),
        ),
      ),
    ),
  );

  it.effect("does not read server paths when the master gate is off", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const service = yield* ScientAnalytics.make.pipe(
        Effect.provideService(ServerConfig.ServerConfig, {
          ...config,
          get stateDir(): string {
            throw new Error("Disabled analytics must not read the state directory");
          },
        }),
      );
      assert.isFalse(service.available);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          ManagedPolicy.layerTest(),
          ServerConfig.ServerConfig.layerTest(process.cwd(), {
            prefix: "scient-analytics-disabled-",
          }),
          ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} })),
        ),
      ),
    ),
  );
  it.effect("ignores saved consent so analytics stays on for everyone", () =>
    Effect.gen(function* () {
      for (const contents of [
        "invalid json",
        '{"version":1,"consent":"unexpected"}',
        '{"version":99,"consent":"product"}',
        '{"version":1,"consent":"off"}',
      ]) {
        yield* Effect.gen(function* () {
          const config = yield* ServerConfig.ServerConfig;
          const directory = NodePath.join(config.stateDir, "analytics");
          NodeFS.mkdirSync(directory, { recursive: true });
          NodeFS.writeFileSync(NodePath.join(directory, "preferences.json"), contents);
          assert.isTrue((yield* ScientAnalytics.make).available);
        }).pipe(
          Effect.scoped,
          Effect.provide(
            Layer.mergeAll(
              ManagedPolicy.layerTest(),
              ServerConfig.ServerConfig.layerTest(process.cwd(), {
                prefix: "scient-analytics-invalid-",
              }),
              ConfigProvider.layer(
                ConfigProvider.fromEnv({
                  env: { SCIENT_ANALYTICS_ENABLED: "true" },
                }),
              ),
            ),
          ),
        );
      }
    }),
  );
  it.effect("refuses agent feedback reports while queueing other events", () =>
    Effect.gen(function* () {
      const analytics = (yield* ScientAnalytics.make).analytics;
      assert.isTrue(yield* analytics.record("server.boot.heartbeat", { threadCount: 1 }));
      assert.isFalse(
        yield* analytics.record("agent.feedback", {
          kind: "bug",
          subject: "general",
          expected: "synthetic expected",
          actual: "synthetic actual",
        } as never),
      );
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(
          ManagedPolicy.layerTest(),
          ServerConfig.ServerConfig.layerTest(process.cwd(), { prefix: "scient-analytics-held-" }),
          ConfigProvider.layer(
            ConfigProvider.fromEnv({
              env: {
                SCIENT_ANALYTICS_ENABLED: "true",
                SCIENT_ANALYTICS_TEST_ENDPOINT: "http://127.0.0.1:9/v1/events",
              },
            }),
          ),
        ),
      ),
    ),
  );

  it.effect("is completely inert by default", () =>
    Effect.gen(function* () {
      const serverConfigLayer = ServerConfig.ServerConfig.layerTest(process.cwd(), {
        prefix: "scient-analytics-base-",
      });
      const analyticsLayer = ScientAnalytics.layer.pipe(
        Layer.provideMerge(serverConfigLayer),
        Layer.provideMerge(ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} }))),
        Layer.provideMerge(ManagedPolicy.layerTest()),
      );

      yield* Effect.gen(function* () {
        const serverConfig = yield* ServerConfig.ServerConfig;
        const analytics = yield* AnalyticsService;
        yield* analytics.record("server.boot.heartbeat", { threadCount: 99 });
        yield* analytics.flush;

        assert.isFalse(NodeFS.existsSync(NodePath.join(serverConfig.stateDir, "analytics")));
      }).pipe(Effect.provide(analyticsLayer));
    }),
  );
});
