/**
 * AnalyticsServiceLive - First-party ScientFactory telemetry layer.
 *
 * Persists a random installation-scoped anonymous id to state dir, buffers
 * events in memory, and flushes batches to the ScientFactory event gateway.
 *
 * @module AnalyticsServiceLive
 */

import type { TelemetryPrivacyLevel } from "@synara/contracts";
import { Config, DateTime, Effect, Layer, Ref } from "effect";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";
import { randomUUID } from "node:crypto";

import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { AnalyticsService, type AnalyticsServiceShape } from "../Services/AnalyticsService.ts";
import { getTelemetryIdentifier } from "../Identify.ts";
import { version } from "../../../package.json" with { type: "json" };

interface BufferedAnalyticsEvent {
  readonly id: string;
  readonly event: string;
  readonly properties?: Readonly<Record<string, unknown>>;
  readonly capturedAt: string;
  readonly privacyLevel: Exclude<TelemetryPrivacyLevel, "off">;
  readonly consentLevel: Exclude<TelemetryPrivacyLevel, "off">;
}

const PRIVACY_RANK: Readonly<Record<TelemetryPrivacyLevel, number>> = {
  off: 0,
  essential: 1,
  product: 2,
  diagnostic: 3,
  contribution: 4,
};

const ALLOWED_PROPERTY_NAMES = new Set([
  "attachmentCount",
  "decision",
  "hasCwd",
  "hasInput",
  "hasModel",
  "hasResumeCursor",
  "index",
  "interactionMode",
  "model",
  "projectCount",
  "provider",
  "runtimeMode",
  "sessionCount",
  "strategy",
  "target",
  "threadCount",
  "turns",
]);

function defaultEventPrivacyLevel(event: string): Exclude<TelemetryPrivacyLevel, "off"> {
  return event === "server.boot.heartbeat" ? "essential" : "product";
}

function canCapture(
  configured: TelemetryPrivacyLevel,
  required: Exclude<TelemetryPrivacyLevel, "off">,
): boolean {
  return PRIVACY_RANK[configured] >= PRIVACY_RANK[required];
}

function sanitizedProperties(
  properties: Readonly<Record<string, unknown>> | undefined,
): Readonly<Record<string, unknown>> | undefined {
  if (!properties) return undefined;
  const safe = Object.fromEntries(
    Object.entries(properties).filter(
      ([key, value]) =>
        ALLOWED_PROPERTY_NAMES.has(key) &&
        (typeof value === "string" ||
          typeof value === "number" ||
          typeof value === "boolean" ||
          value === null),
    ),
  );
  return Object.keys(safe).length > 0 ? safe : undefined;
}

const TelemetryEnvConfig = Config.all({
  endpoint: Config.string("SYNARA_TELEMETRY_ENDPOINT").pipe(
    Config.withDefault("https://events.scientfactory.com/v1/events"),
  ),
  enabled: Config.boolean("SYNARA_TELEMETRY_ENABLED").pipe(Config.withDefault(true)),
  flushBatchSize: Config.number("SYNARA_TELEMETRY_FLUSH_BATCH_SIZE").pipe(Config.withDefault(20)),
  maxBufferedEvents: Config.number("SYNARA_TELEMETRY_MAX_BUFFERED_EVENTS").pipe(
    Config.withDefault(1_000),
  ),
});

const makeAnalyticsService = Effect.gen(function* () {
  const telemetryConfig = yield* TelemetryEnvConfig.asEffect();
  const httpClient = yield* HttpClient.HttpClient;
  const serverConfig = yield* ServerConfig;
  const serverSettings = yield* ServerSettingsService;
  const identifier = yield* getTelemetryIdentifier;
  const sessionId = `session:${randomUUID()}`;
  const bufferRef = yield* Ref.make<ReadonlyArray<BufferedAnalyticsEvent>>([]);
  const clientType = serverConfig.mode === "desktop" ? "desktop-app" : "cli-web-client";
  const currentPrivacyLevel = serverSettings.getSettings.pipe(
    Effect.map((settings) => settings.telemetryPrivacyLevel),
    Effect.orElseSucceed(() => "essential" as const),
  );

  const enqueueBufferedEvent = (
    event: string,
    privacyLevel: Exclude<TelemetryPrivacyLevel, "off">,
    consentLevel: Exclude<TelemetryPrivacyLevel, "off">,
    properties?: Readonly<Record<string, unknown>>,
  ) =>
    Effect.flatMap(DateTime.now, (now) =>
      Ref.modify(bufferRef, (current) => {
        const appended = [
          ...current,
          {
            id: randomUUID(),
            event,
            ...(properties ? { properties } : {}),
            capturedAt: DateTime.formatIso(now),
            privacyLevel,
            consentLevel,
          } satisfies BufferedAnalyticsEvent,
        ];

        const next =
          appended.length > telemetryConfig.maxBufferedEvents
            ? appended.slice(appended.length - telemetryConfig.maxBufferedEvents)
            : appended;

        return [
          {
            size: next.length,
            dropped: next.length !== appended.length,
          } as const,
          next,
        ] as const;
      }),
    );

  const sendBatch = (events: ReadonlyArray<BufferedAnalyticsEvent>) =>
    Effect.gen(function* () {
      if (!telemetryConfig.enabled || !identifier) return;

      const payload = {
        schema_version: 2,
        source: "desktop",
        sent_at: new Date().toISOString(),
        events: events.map((event) => ({
          id: event.id,
          name: event.event,
          distinct_id: identifier,
          session_id: sessionId,
          occurred_at: event.capturedAt,
          privacy_level: event.privacyLevel,
          consent_level: event.consentLevel,
          properties: {
            ...event.properties,
            platform: process.platform,
            wsl: process.env.WSL_DISTRO_NAME,
            arch: process.arch,
            synaraCodeVersion: version,
            clientType,
          },
        })),
      };

      yield* HttpClientRequest.post(telemetryConfig.endpoint).pipe(
        HttpClientRequest.bodyJson(payload),
        Effect.flatMap(httpClient.execute),
        Effect.flatMap(HttpClientResponse.filterStatusOk),
      );
    });

  const flush: AnalyticsServiceShape["flush"] = Effect.gen(function* () {
    while (true) {
      const configuredLevel = yield* currentPrivacyLevel;
      const batch = yield* Ref.modify(bufferRef, (current) => {
        const permitted = current.filter((event) =>
          canCapture(configuredLevel, event.privacyLevel),
        );
        if (permitted.length === 0) {
          return [[] as ReadonlyArray<BufferedAnalyticsEvent>, permitted] as const;
        }
        const nextBatch = permitted.slice(0, telemetryConfig.flushBatchSize);
        const remaining = permitted.slice(nextBatch.length);
        return [nextBatch, remaining] as const;
      });

      if (batch.length === 0) {
        return;
      }

      yield* sendBatch(batch).pipe(
        Effect.catch((error) =>
          Ref.update(bufferRef, (current) => [...batch, ...current]).pipe(
            Effect.flatMap(() => Effect.fail(error)),
          ),
        ),
      );
    }
  }).pipe(Effect.catch((cause) => Effect.logError("Failed to flush telemetry", { cause })));

  const record: AnalyticsServiceShape["record"] = Effect.fnUntraced(
    function* (event, properties, options) {
      if (!telemetryConfig.enabled || !identifier) return;

      const configuredLevel = yield* currentPrivacyLevel;
      const privacyLevel = options?.privacyLevel ?? defaultEventPrivacyLevel(event);
      if (!canCapture(configuredLevel, privacyLevel) || configuredLevel === "off") return;

      const enqueueResult = yield* enqueueBufferedEvent(
        event,
        privacyLevel,
        configuredLevel,
        sanitizedProperties(properties),
      );
      if (enqueueResult.dropped) {
        yield* Effect.logDebug("analytics buffer full; dropping oldest event", {
          size: enqueueResult.size,
          event,
        });
      }
    },
  );

  yield* Effect.forever(Effect.sleep(1000).pipe(Effect.flatMap(() => flush)), {
    disableYield: true,
  }).pipe(Effect.forkScoped);

  yield* Effect.addFinalizer(() => flush);

  return {
    record,
    flush,
  } satisfies AnalyticsServiceShape;
});

export const AnalyticsServiceLayerLive = Layer.effect(AnalyticsService, makeAnalyticsService);
