// @effect-diagnostics nodeBuiltinImport:off -- This test proves disabled mode creates no local state.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

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
});
