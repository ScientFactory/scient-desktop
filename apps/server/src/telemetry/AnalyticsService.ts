// @effect-diagnostics nodeBuiltinImport:off -- This adapter owns Scient's local analytics boundary.
/**
 * Scient first-party analytics adapter.
 *
 * The inherited T3 call sites remain unchanged, but this boundary accepts only
 * Scient-registered events and properties. Delivery is disabled by default and
 * goes only through Scient's first-party gateway when deliberately enabled.
 *
 * @module AnalyticsService
 */
import {
  AnalyticsConsent,
  createAnalyticsRuntime,
  type AnalyticsRuntime,
} from "@scientfactory/analytics";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import packageJson from "../../package.json" with { type: "json" };
import * as ServerConfig from "../config.ts";

const AnalyticsEnvConfig = Config.all({
  enabled: Config.boolean("SCIENT_ANALYTICS_ENABLED").pipe(Config.withDefault(false)),
  consent: Config.string("SCIENT_ANALYTICS_CONSENT").pipe(Config.withDefault("off")),
  buildChannel: Config.string("SCIENT_ANALYTICS_BUILD_CHANNEL").pipe(
    Config.withDefault("development"),
  ),
});

function parseConsent(value: string): AnalyticsConsent {
  return AnalyticsConsent.find((candidate) => candidate === value) ?? "off";
}

function parseBuildChannel(
  value: string,
): "stable" | "beta" | "nightly" | "development" | "unknown" {
  switch (value) {
    case "stable":
    case "beta":
    case "nightly":
    case "development":
      return value;
    default:
      return "unknown";
  }
}

function disabledRuntime(outboxPath: string): AnalyticsRuntime {
  return createAnalyticsRuntime({
    enabled: false,
    consent: "off",
    outboxPath,
    appVersion: packageJson.version,
    buildChannel: "unknown",
  });
}

function packagedAnalyticsWorkerUrl(): URL {
  const moduleUrl = new URL(import.meta.url);
  return moduleUrl.pathname.endsWith("/dist/bin.mjs")
    ? new URL("./analytics-worker.mjs", moduleUrl)
    : new URL("../../dist/analytics-worker.mjs", moduleUrl);
}

export class AnalyticsService extends Context.Service<
  AnalyticsService,
  {
    /** Record a registered, bounded event without interrupting user work. */
    readonly record: (
      event: string,
      properties?: Readonly<Record<string, unknown>>,
    ) => Effect.Effect<void>;

    /** Attempt delivery of the currently due local outbox batch. */
    readonly flush: Effect.Effect<void>;
  }
>()("t3/telemetry/AnalyticsService") {
  /** No-op layer for tests and callers that intentionally disable analytics. */
  static readonly layerDisabled = Layer.succeed(
    AnalyticsService,
    AnalyticsService.of({
      record: () => Effect.void,
      flush: Effect.void,
    }),
  );
  static readonly layerTest = AnalyticsService.layerDisabled;
}

export const make = Effect.gen(function* () {
  const analyticsConfig = yield* AnalyticsEnvConfig;
  const serverConfig = yield* ServerConfig.ServerConfig;
  const outboxPath = NodePath.join(serverConfig.stateDir, "analytics", "outbox.sqlite");
  const consent = parseConsent(analyticsConfig.consent);
  const sessionStartedAt = yield* Clock.currentTimeMillis;

  if (analyticsConfig.enabled && consent === "off" && analyticsConfig.consent !== "off") {
    yield* Effect.logWarning("Invalid Scient analytics consent; analytics remains off");
  }

  const runtime = yield* Effect.acquireRelease(
    Effect.try({
      try: () =>
        createAnalyticsRuntime({
          enabled: analyticsConfig.enabled,
          consent,
          outboxPath,
          appVersion: packageJson.version,
          buildChannel: parseBuildChannel(analyticsConfig.buildChannel),
          workerUrl: packagedAnalyticsWorkerUrl(),
        }),
      catch: () => "analytics-initialization-failed" as const,
    }).pipe(
      Effect.catch(() =>
        Effect.logError("Scient analytics initialization failed; analytics remains off").pipe(
          Effect.as(disabledRuntime(outboxPath)),
        ),
      ),
    ),
    (activeRuntime) =>
      Effect.gen(function* () {
        const sessionEndedAt = yield* Clock.currentTimeMillis;
        activeRuntime.record("app.session.ended", {
          durationMs: sessionEndedAt - sessionStartedAt,
          shutdownClass: "graceful",
        });
        yield* Effect.tryPromise({
          try: () => activeRuntime.close(),
          catch: () => "analytics-shutdown-failed" as const,
        });
      }).pipe(Effect.catch(() => Effect.logWarning("Scient analytics shutdown cleanup failed"))),
  );

  runtime.record("app.session.started", {
    platform:
      NodeProcess.platform === "darwin"
        ? "macos"
        : NodeProcess.platform === "win32"
          ? "windows"
          : NodeProcess.platform === "linux"
            ? "linux"
            : "other",
    architecture:
      NodeProcess.arch === "arm64" || NodeProcess.arch === "x64" ? NodeProcess.arch : "other",
  });

  const record: AnalyticsService["Service"]["record"] = (event, properties) =>
    Effect.try({
      try: () => {
        runtime.record(event, properties);
      },
      catch: () => "analytics-record-failed" as const,
    }).pipe(Effect.catch(() => Effect.logWarning("Scient analytics event could not be queued")));

  const flush: AnalyticsService["Service"]["flush"] = Effect.tryPromise({
    try: () => runtime.flush(),
    catch: () => "analytics-flush-failed" as const,
  }).pipe(
    Effect.catch(() => Effect.logWarning("Scient analytics delivery attempt failed")),
    Effect.asVoid,
  );

  if (runtime.enabled) {
    yield* Effect.forever(Effect.sleep("30 seconds").pipe(Effect.andThen(flush))).pipe(
      Effect.forkScoped,
    );
  }

  return AnalyticsService.of({ record, flush });
});

export const layer = Layer.effect(AnalyticsService, make);
export const layerTest = AnalyticsService.layerTest;
export const layerDisabled = AnalyticsService.layerDisabled;
