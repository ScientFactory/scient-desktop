// @effect-diagnostics nodeBuiltinImport:off -- This test proves disabled mode creates no local state.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientError from "effect/http/HttpClientError";
import * as HttpServer from "effect/http/HttpServer";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { HostProcessArchitecture, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";

import * as ServerConfig from "../config.ts";
import * as AnalyticsService from "./AnalyticsService.ts";

it("restricts the optional analytics QA destination to literal loopback ingestion", () => {
  assert.equal(AnalyticsService.localAnalyticsTestEndpoint(""), undefined);
  assert.equal(
    AnalyticsService.localAnalyticsTestEndpoint("http://127.0.0.1:43199/v1/events"),
    "http://127.0.0.1:43199/v1/events",
  );
  for (const url of [
    "https://eu.posthog.com/v1/events",
    "http://127.0.0.1.attacker.test/v1/events",
    "http://user:password@127.0.0.1/v1/events",
    "http://127.0.0.1/v1/events?secret=value",
    "http://127.0.0.1/admin",
  ]) {
    assert.throws(() => AnalyticsService.localAnalyticsTestEndpoint(url));
  }
});

const SentBatch = Schema.fromJsonString(
  Schema.Struct({
    batch: Schema.Array(Schema.Struct({ uuid: Schema.String })),
  }),
);

/**
 * HTTP client that reads each batch, then fails as if the connection dropped
 * before the response arrived. PostHog stores these batches, so the server
 * must not send them forever.
 */
const layerAcceptThenFailClient = (batches: Array<ReadonlyArray<{ readonly uuid: string }>>) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.gen(function* () {
        if (request.body._tag === "Uint8Array") {
          const body = yield* Schema.decodeEffect(SentBatch)(
            new TextDecoder().decode(request.body.body),
          ).pipe(Effect.orDie);
          batches.push(body.batch);
        }
        return yield* new HttpClientError.HttpClientError({
          reason: new HttpClientError.TransportError({ request, cause: "connection reset" }),
        });
      }),
    ),
  );

it.effect("the disabled adapter retains Scient consent controls without collecting events", () =>
  Effect.gen(function* () {
    const analytics = yield* AnalyticsService.AnalyticsService;
    yield* analytics.record("server.boot.heartbeat");
    yield* analytics.flush;
    assert.deepEqual(yield* analytics.status, { available: false, consent: "off" });
  }).pipe(Effect.provide(AnalyticsService.layerDisabled)),
);

it.layer(NodeServices.layer)("AnalyticsService test", (it) => {
  it.effect("does not read server paths when the master gate is off", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const service = yield* AnalyticsService.make.pipe(
        Effect.provideService(ServerConfig.ServerConfig, {
          ...config,
          get stateDir(): string {
            throw new Error("Disabled analytics must not read the state directory");
          },
        }),
      );
      assert.deepEqual(yield* service.status, { available: false, consent: "off" });
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          ServerConfig.ServerConfig.layerTest(process.cwd(), {
            prefix: "scient-analytics-disabled-",
          }),
          ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} })),
        ),
      ),
    ),
  );
  it.effect(
    "fails closed on invalid saved consent instead of taking a more permissive environment default",
    () =>
      Effect.gen(function* () {
        for (const contents of [
          "invalid json",
          '{"version":1,"consent":"unexpected"}',
          '{"version":99,"consent":"product"}',
        ]) {
          yield* Effect.gen(function* () {
            const config = yield* ServerConfig.ServerConfig;
            const directory = NodePath.join(config.stateDir, "analytics");
            NodeFS.mkdirSync(directory, { recursive: true });
            NodeFS.writeFileSync(NodePath.join(directory, "preferences.json"), contents);
            const service = yield* AnalyticsService.make;
            assert.deepEqual(yield* service.status, { available: true, consent: "off" });
            yield* service.record("project.opened");
            assert.isFalse(NodeFS.existsSync(NodePath.join(directory, "outbox.sqlite")));
          }).pipe(
            Effect.scoped,
            Effect.provide(
              Layer.mergeAll(
                ServerConfig.ServerConfig.layerTest(process.cwd(), {
                  prefix: "scient-analytics-invalid-",
                }),
                ConfigProvider.layer(
                  ConfigProvider.fromEnv({
                    env: {
                      SCIENT_ANALYTICS_ENABLED: "true",
                      SCIENT_ANALYTICS_CONSENT: "product",
                    },
                  }),
                ),
              ),
            ),
          );
        }
      }),
  );
  it.effect("is completely inert by default", () =>
    Effect.gen(function* () {
      const serverConfigLayer = ServerConfig.ServerConfig.layerTest(process.cwd(), {
        prefix: "scient-analytics-base-",
      });
      const analyticsLayer = AnalyticsService.layer.pipe(
        Layer.provideMerge(serverConfigLayer),
        Layer.provideMerge(ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} }))),
      );

      yield* Effect.gen(function* () {
        const serverConfig = yield* ServerConfig.ServerConfig;
        const analytics = yield* AnalyticsService.AnalyticsService;
        yield* analytics.record("server.boot.heartbeat", { threadCount: 99 });
        yield* analytics.flush;

        assert.isFalse(NodeFS.existsSync(NodePath.join(serverConfig.stateDir, "analytics")));
      }).pipe(Effect.provide(analyticsLayer));
    }),
  );

  it.effect("does not send batch requests when telemetry is disabled", () =>
    Effect.gen(function* () {
      const capturedPaths: Array<string> = [];
      const layerServerConfig = ServerConfig.ServerConfig.layerTest(process.cwd(), {
        prefix: "t3-telemetry-disabled-",
      });
      const layerTelemetry = AnalyticsService.layer.pipe(Layer.provideMerge(layerServerConfig));
      const layerConfig = ConfigProvider.layer(
        ConfigProvider.fromUnknown({
          T3CODE_TELEMETRY_ENABLED: false,
          T3CODE_POSTHOG_KEY: "phc_test_key",
          T3CODE_POSTHOG_HOST: "http://localhost",
        }),
      );
      const layerBatchServer = HttpServer.serve(
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          capturedPaths.push(request.url);
          return HttpServerResponse.jsonUnsafe({});
        }),
      );
      const layerRuntime = layerTelemetry.pipe(
        Layer.provide(layerConfig),
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(HostProcessPlatform, "linux"),
            Layer.succeed(HostProcessArchitecture, "arm64"),
          ),
        ),
        Layer.provideMerge(NodeHttpServer.layerTest),
      );

      yield* Effect.gen(function* () {
        yield* Layer.launch(layerBatchServer).pipe(Effect.forkScoped);
        const analytics = yield* AnalyticsService.AnalyticsService;
        yield* analytics.record("test.disabled", { index: 1 });
        yield* analytics.flush;
      }).pipe(Effect.provide(layerRuntime));

      assert.deepEqual(capturedPaths, []);
    }),
  );
});
