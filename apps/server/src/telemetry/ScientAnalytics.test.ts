// @effect-diagnostics nodeBuiltinImport:off -- This test proves disabled mode creates no local state.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../config.ts";
import { makeApplyDesktopShellEnvironmentSnapshot } from "../resourceTelemetry/DesktopTelemetryReceiver.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import { AnalyticsService } from "./AnalyticsService.ts";
import * as ScientAnalytics from "./ScientAnalytics.ts";

const enabledLayer = (prefix: string) =>
  Layer.mergeAll(
    ManagedPolicy.layerTest(),
    ServerConfig.ServerConfig.layerTest(process.cwd(), { prefix }),
    ConfigProvider.layer(
      ConfigProvider.fromEnv({
        env: {
          SCIENT_ANALYTICS_ENABLED: "true",
          SCIENT_ANALYTICS_TEST_ENDPOINT: "http://127.0.0.1:9/v1/events",
        },
      }),
    ),
  );

const shellSnapshot = (discovered: boolean, environment: Record<string, string>) => ({
  version: 1 as const,
  type: "shellEnvironment" as const,
  discovered,
  platform: "darwin",
  environment,
});

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

  it.effect("DO_NOT_TRACK turns analytics off over an explicit enable", () =>
    Effect.gen(function* () {
      assert.isFalse((yield* ScientAnalytics.make).available);
    }).pipe(
      Effect.provideService(HostProcess.Environment, { DO_NOT_TRACK: "1" }),
      Effect.provide(enabledLayer("scient-analytics-dnt-")),
    ),
  );

  it.effect("waits for the desktop's shell and honors a DO_NOT_TRACK set only there", () =>
    Effect.gen(function* () {
      // A cold launch: the backend starts before the login shell has answered.
      const env: NodeJS.ProcessEnv = { T3CODE_DESKTOP_SHELL_DISCOVERY_PENDING: "1" };
      const { analytics, recorded } = yield* ScientAnalytics.make.pipe(
        Effect.provideService(HostProcess.Environment, env),
      );
      assert.isFalse(yield* analytics.record("server.boot.heartbeat", { threadCount: 1 }));
      assert.isFalse(yield* recorded.ingest([]));
      yield* makeApplyDesktopShellEnvironmentSnapshot(
        env,
        "darwin",
      )(shellSnapshot(true, { DO_NOT_TRACK: "1" }));
      assert.isFalse(yield* analytics.record("server.boot.heartbeat", { threadCount: 1 }));
      // Never sent, so the desktop drops the facts it offered.
      assert.isTrue(yield* recorded.ingest([]));
    }).pipe(Effect.scoped, Effect.provide(enabledLayer("scient-analytics-shell-dnt-"))),
  );

  it.effect(
    "a cached shell does not start analytics; a later DO_NOT_TRACK snapshot keeps it off",
    () =>
      Effect.gen(function* () {
        const env: NodeJS.ProcessEnv = { T3CODE_DESKTOP_SHELL_DISCOVERY_PENDING: "1" };
        const apply = makeApplyDesktopShellEnvironmentSnapshot(env, "darwin");
        const { analytics } = yield* ScientAnalytics.make.pipe(
          Effect.provideService(HostProcess.Environment, env),
        );
        yield* apply(shellSnapshot(false, { PATH: "/cached/bin" }));
        assert.isFalse(yield* analytics.record("server.boot.heartbeat", { threadCount: 1 }));
        yield* apply(shellSnapshot(true, { PATH: "/cached/bin", DO_NOT_TRACK: "1" }));
        assert.isFalse(yield* analytics.record("server.boot.heartbeat", { threadCount: 1 }));
      }).pipe(Effect.scoped, Effect.provide(enabledLayer("scient-analytics-cached-dnt-"))),
  );

  it.effect("starts once the desktop's shell answers without DO_NOT_TRACK", () =>
    Effect.gen(function* () {
      const env: NodeJS.ProcessEnv = { T3CODE_DESKTOP_SHELL_DISCOVERY_PENDING: "1" };
      const { analytics } = yield* ScientAnalytics.make.pipe(
        Effect.provideService(HostProcess.Environment, env),
      );
      assert.isFalse(yield* analytics.record("server.boot.heartbeat", { threadCount: 1 }));
      yield* makeApplyDesktopShellEnvironmentSnapshot(
        env,
        "darwin",
      )(shellSnapshot(true, { PATH: "/discovered/bin" }));
      assert.isTrue(yield* analytics.record("server.boot.heartbeat", { threadCount: 1 }));
    }).pipe(Effect.scoped, Effect.provide(enabledLayer("scient-analytics-shell-"))),
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
          Effect.provideService(HostProcess.Environment, {}),
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
      Effect.provideService(HostProcess.Environment, {}),
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
