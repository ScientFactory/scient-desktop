import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ConfigProvider, Effect, Layer } from "effect";
import * as HttpServer from "effect/unstable/http/HttpServer";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { getTelemetryIdentifier } from "../Identify.ts";
import { AnalyticsService } from "../Services/AnalyticsService.ts";
import { AnalyticsServiceLayerLive } from "./AnalyticsService.ts";

interface RecordedBatchRequest {
  readonly path: string;
  readonly body: {
    readonly schema_version?: number;
    readonly source?: string;
    readonly events?: ReadonlyArray<{
      readonly id?: string;
      readonly name?: string;
      readonly distinct_id?: string;
      readonly session_id?: string;
      readonly occurred_at?: string;
      readonly privacy_level?: string;
      readonly consent_level?: string;
      readonly properties?: {
        readonly index?: number;
        readonly clientType?: string;
        readonly prompt?: string;
      };
    }>;
  } | null;
}

interface RecordedBatchBody {
  readonly schema_version: number;
  readonly source: string;
  readonly events: ReadonlyArray<{
    readonly id?: string;
    readonly name?: string;
    readonly distinct_id?: string;
    readonly session_id?: string;
    readonly privacy_level?: string;
    readonly consent_level?: string;
    readonly properties?: {
      readonly index?: number;
      readonly clientType?: string;
      readonly prompt?: string;
    };
  }>;
}

it.layer(NodeServices.layer)("AnalyticsService test", (it) => {
  it.effect("flush drains all buffered events across multiple batches", () =>
    Effect.gen(function* () {
      const capturedRequests: Array<RecordedBatchRequest> = [];
      const serverConfigLayer = ServerConfig.layerTest(process.cwd(), {
        prefix: "synara-telemetry-base-",
      });

      const telemetryLayer = AnalyticsServiceLayerLive.pipe(
        Layer.provideMerge(serverConfigLayer),
        Layer.provideMerge(ServerSettingsService.layerTest({ telemetryPrivacyLevel: "product" })),
      );
      const configLayer = ConfigProvider.layer(
        ConfigProvider.fromUnknown({
          SYNARA_TELEMETRY_ENABLED: true,
          SYNARA_TELEMETRY_ENDPOINT: "/v1/events",
          SYNARA_TELEMETRY_FLUSH_BATCH_SIZE: 20,
        }),
      );
      const batchServerLayer = HttpServer.serve(
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          if (request.method !== "POST") {
            return HttpServerResponse.empty({ status: 404 });
          }

          const payload = yield* request.json.pipe(
            Effect.map((body) => body as RecordedBatchRequest["body"]),
            Effect.catch(() => Effect.succeed(null)),
          );

          capturedRequests.push({ path: request.url, body: payload });

          return HttpServerResponse.jsonUnsafe({});
        }),
      );
      const runtimeLayer = telemetryLayer.pipe(
        Layer.provide(configLayer),
        Layer.provideMerge(NodeHttpServer.layerTest),
      );

      yield* Effect.gen(function* () {
        yield* Layer.launch(batchServerLayer).pipe(Effect.forkScoped);
        const telemetryIdentifier = yield* getTelemetryIdentifier;
        assert.equal(telemetryIdentifier !== null, true);
        const analytics = yield* AnalyticsService;

        for (let index = 0; index < 45; index += 1) {
          yield* analytics.record("test.flush.drain", {
            index,
            prompt: "must never leave the device",
          });
        }

        yield* analytics.flush;
      }).pipe(Effect.provide(runtimeLayer));

      const batchRequests = capturedRequests.filter(
        (request): request is RecordedBatchRequest & { readonly body: RecordedBatchBody } =>
          Array.isArray(request.body?.events),
      );
      assert.equal(batchRequests.length, 3);
      assert.equal(
        batchRequests.every((request) => request.path === "/v1/events"),
        true,
      );
      const deliveredIndexes = batchRequests.flatMap((request) =>
        request.body.events
          .filter((event) => event.name === "test.flush.drain")
          .map((event) => event.properties?.index)
          .filter((index): index is number => typeof index === "number"),
      );

      const sorted = deliveredIndexes.toSorted((a, b) => a - b);
      assert.equal(sorted.length, 45);
      assert.deepEqual(
        sorted,
        Array.from({ length: 45 }, (_, index) => index),
      );
      assert.equal(
        batchRequests.every(
          (request) =>
            request.body.schema_version === 2 &&
            request.body.source === "desktop" &&
            request.body.events.every(
              (event) =>
                event.properties?.clientType === "cli-web-client" &&
                event.properties?.prompt === undefined &&
                event.privacy_level === "product" &&
                event.consent_level === "product" &&
                event.session_id?.startsWith("session:") === true &&
                event.distinct_id?.startsWith("installation:") === true &&
                typeof event.id === "string",
            ),
        ),
        true,
      );
    }),
  );

  it.effect("essential mode sends heartbeat but not product workflow events", () =>
    Effect.gen(function* () {
      const capturedRequests: Array<RecordedBatchRequest> = [];
      const serverConfigLayer = ServerConfig.layerTest(process.cwd(), {
        prefix: "synara-telemetry-essential-",
      });
      const telemetryLayer = AnalyticsServiceLayerLive.pipe(
        Layer.provideMerge(serverConfigLayer),
        Layer.provideMerge(ServerSettingsService.layerTest({ telemetryPrivacyLevel: "essential" })),
      );
      const configLayer = ConfigProvider.layer(
        ConfigProvider.fromUnknown({
          SYNARA_TELEMETRY_ENABLED: true,
          SYNARA_TELEMETRY_ENDPOINT: "/v1/events",
        }),
      );
      const batchServerLayer = HttpServer.serve(
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          const payload = yield* request.json.pipe(
            Effect.map((body) => body as RecordedBatchRequest["body"]),
            Effect.catch(() => Effect.succeed(null)),
          );
          capturedRequests.push({ path: request.url, body: payload });
          return HttpServerResponse.jsonUnsafe({});
        }),
      );
      const runtimeLayer = telemetryLayer.pipe(
        Layer.provide(configLayer),
        Layer.provideMerge(NodeHttpServer.layerTest),
      );

      yield* Effect.gen(function* () {
        yield* Layer.launch(batchServerLayer).pipe(Effect.forkScoped);
        const analytics = yield* AnalyticsService;
        yield* analytics.record("provider.turn.sent", { provider: "codex" });
        yield* analytics.record(
          "provider.diagnostic.sample",
          { provider: "codex" },
          { privacyLevel: "diagnostic" },
        );
        yield* analytics.record("server.boot.heartbeat", { threadCount: 2, projectCount: 1 });
        yield* analytics.flush;
      }).pipe(Effect.provide(runtimeLayer));

      const names = capturedRequests.flatMap(
        (request) => request.body?.events?.map((event) => event.name) ?? [],
      );
      assert.deepEqual(names, ["server.boot.heartbeat"]);
      assert.equal(capturedRequests[0]?.body?.events?.[0]?.privacy_level, "essential");
      assert.equal(capturedRequests[0]?.body?.events?.[0]?.consent_level, "essential");
    }),
  );
});
