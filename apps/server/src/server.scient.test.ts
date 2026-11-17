import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import type { AnalyticsRuntime } from "@scientfactory/analytics";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { assert, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import { vi } from "vite-plus/test";

import * as ServerConfig from "./config.ts";
import * as ManagedPolicy from "./policy/ManagedPolicy.ts";
import { layerAnalytics } from "./server.ts";
import { AnalyticsService } from "./telemetry/AnalyticsService.ts";
import { ScientAnalyticsAvailability } from "./telemetry/ScientAnalytics.ts";

const scient = vi.hoisted(() => ({ recorded: [] as string[] }));
vi.mock("@scientfactory/analytics", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@scientfactory/analytics")>()),
  createAnalyticsRuntime: (): AnalyticsRuntime => ({
    enabled: true,
    record: (name) => {
      scient.recorded.push(name);
      return true;
    },
    flush: async () => 0,
    pendingCount: async () => 0,
    close: async () => undefined,
  }),
}));

it.effect(
  "the composed server records through Scient's analytics and sends nothing to PostHog",
  () =>
    Effect.gen(function* () {
      scient.recorded.length = 0;
      const posthogRequests: string[] = [];
      const posthog = HttpClient.make((request) =>
        Effect.sync(() => {
          posthogRequests.push(request.url);
          return HttpClientResponse.fromWeb(request, new Response(null, { status: 204 }));
        }),
      );
      const available = yield* Effect.gen(function* () {
        const analytics = yield* AnalyticsService;
        yield* analytics.record("provider.turn.sent", { provider: "codex" });
        yield* analytics.recordOwners([{ source: "openai", ownerId: "a".repeat(64) }], "server");
        yield* analytics.flush;
        return (yield* ScientAnalyticsAvailability).available;
      }).pipe(
        Effect.provide(
          layerAnalytics.pipe(
            Layer.provide(
              Layer.mergeAll(
                ManagedPolicy.layerTest(),
                ServerConfig.ServerConfig.layerTest(process.cwd(), {
                  prefix: "scient-composed-analytics-",
                }),
                // T3's PostHog path is switched on here, so only the composition keeps it out.
                ConfigProvider.layer(
                  ConfigProvider.fromUnknown({
                    SCIENT_ANALYTICS_ENABLED: "true",
                    T3CODE_TELEMETRY_ENABLED: true,
                    T3CODE_POSTHOG_KEY: "phc_test_key",
                    T3CODE_POSTHOG_HOST: "http://posthog.test",
                  }),
                ),
                Layer.succeed(HttpClient.HttpClient, posthog),
                Layer.succeed(HostProcess.Platform, "linux"),
                Layer.succeed(HostProcess.Architecture, "arm64"),
              ),
            ),
          ),
        ),
        Effect.scoped,
      );
      assert.deepEqual(posthogRequests, []);
      assert.deepEqual(scient.recorded, [
        "app.session.started",
        "provider.turn.sent",
        "install.owner_observed",
        "app.session.ended",
      ]);
      assert.isTrue(available);
    }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
);
