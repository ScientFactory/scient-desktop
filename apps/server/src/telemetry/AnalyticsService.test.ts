// @effect-diagnostics nodeBuiltinImport:off -- This test proves disabled mode creates no local state.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ConfigProvider from "effect/ConfigProvider";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { HostProcessPlatform, HostProcessArchitecture } from "@t3tools/shared/hostProcess";
import { HttpServer, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import * as ServerConfig from "../config.ts";
import * as AnalyticsService from "./AnalyticsService.ts";

it.layer(NodeServices.layer)("AnalyticsService test", (it) => {
  it.effect("is completely inert by default", () =>
    Effect.gen(function* () {
      const serverConfigLayer = ServerConfig.ServerConfig.layerTest(process.cwd(), {
        prefix: "scient-analytics-base-",
      });
      const analyticsLayer = AnalyticsService.layer.pipe(Layer.provideMerge(serverConfigLayer));

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
      const serverConfigLayer = ServerConfig.ServerConfig.layerTest(process.cwd(), {
        prefix: "t3-telemetry-disabled-",
      });
      const telemetryLayer = AnalyticsService.layer.pipe(Layer.provideMerge(serverConfigLayer));
      const configLayer = ConfigProvider.layer(
        ConfigProvider.fromUnknown({
          T3CODE_TELEMETRY_ENABLED: false,
          T3CODE_POSTHOG_KEY: "phc_test_key",
          T3CODE_POSTHOG_HOST: "http://localhost",
        }),
      );
      const batchServerLayer = HttpServer.serve(
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          capturedPaths.push(request.url);
          return HttpServerResponse.jsonUnsafe({});
        }),
      );
      const runtimeLayer = telemetryLayer.pipe(
        Layer.provide(configLayer),
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(HostProcessPlatform, "linux"),
            Layer.succeed(HostProcessArchitecture, "arm64"),
          ),
        ),
        Layer.provideMerge(NodeHttpServer.layerTest),
      );

      yield* Effect.gen(function* () {
        yield* Layer.launch(batchServerLayer).pipe(Effect.forkScoped);
        const analytics = yield* AnalyticsService.AnalyticsService;
        yield* analytics.record("test.disabled", { index: 1 });
        yield* analytics.flush;
      }).pipe(Effect.provide(runtimeLayer));

      assert.deepEqual(capturedPaths, []);
    }),
  );
});
