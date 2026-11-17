// @effect-diagnostics nodeBuiltinImport:off -- This adapter owns Scient's local analytics boundary.
/**
 * Scient first-party analytics implementation behind AnalyticsService.
 *
 * @module ScientAnalytics
 */
import { createAnalyticsRuntime, type AnalyticsRuntime } from "@scientfactory/analytics";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";
import * as NodeSea from "node:sea";
import * as Config from "effect/Config";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";

import packageJson from "../../package.json" with { type: "json" };
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import * as ServerConfig from "../config.ts";
import type { AnalyticsService } from "./AnalyticsService.ts";

const AnalyticsEnvConfig = Config.all({
  enabled: Config.Boolean("SCIENT_ANALYTICS_ENABLED").pipe(Config.withDefault(false)),
  buildChannel: Config.String("SCIENT_ANALYTICS_BUILD_CHANNEL").pipe(
    Config.withDefault("development"),
  ),
  appVersion: Config.String("SCIENT_ANALYTICS_APP_VERSION").pipe(
    Config.withDefault(packageJson.version),
  ),
  testEndpoint: Config.String("SCIENT_ANALYTICS_TEST_ENDPOINT").pipe(Config.withDefault("")),
});

/** Explicit local qualification only; never an alternate third-party telemetry host. */
export function localAnalyticsTestEndpoint(value: string): string | undefined {
  if (!value) return undefined;
  const url = new URL(value);
  if (
    url.protocol !== "http:" ||
    !["127.0.0.1", "[::1]"].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.pathname !== "/v1/events" ||
    url.search ||
    url.hash
  ) {
    throw new Error("Analytics test endpoint must be a loopback ingestion endpoint");
  }
  return url.href;
}

export interface ScientAnalyticsControls {
  /** Whether this build collects analytics at all. */
  readonly status: Effect.Effect<AnalyticsStatus>;
}

export interface AnalyticsStatus {
  readonly available: boolean;
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
    outboxPath,
    appVersion: packageJson.version,
    buildChannel: "unknown",
  });
}

function packagedAnalyticsWorkerUrl(): URL {
  const moduleUrl = new URL(import.meta.url);
  // Lazy CLI chunks and the entry bundle share the emitted worker's directory.
  return NodeSea.isSea() || moduleUrl.pathname.endsWith(".mjs")
    ? new URL("./analytics-worker.mjs", moduleUrl)
    : new URL("../../dist/analytics-worker.mjs", moduleUrl);
}

/** No-op analytics for tests and callers that intentionally disable analytics. */
export const disabledAnalyticsService: AnalyticsService["Service"] = {
  record: () => Effect.void,
  recordOwners: () => Effect.void,
  flush: Effect.void,
  status: Effect.succeed({ available: false }),
};

/** @public */
export const make = Effect.gen(function* () {
  const analyticsConfig = yield* AnalyticsEnvConfig;
  // A managed policy can switch analytics off over the environment, never on.
  const policyAllows =
    ManagedPolicy.deniedBy(yield* ManagedPolicy.ManagedPolicy, "telemetry") === undefined;
  if (!analyticsConfig.enabled || !policyAllows) {
    return disabledAnalyticsService;
  }
  const serverConfig = yield* ServerConfig.ServerConfig;
  const outboxPath = NodePath.join(serverConfig.stateDir, "analytics", "outbox.sqlite");
  // Like T3, analytics is on for everyone; SCIENT_ANALYTICS_ENABLED=false is the off switch.
  const sessionStartedAt = yield* Clock.currentTimeMillis;

  const createRuntime = () => {
    const endpoint = localAnalyticsTestEndpoint(analyticsConfig.testEndpoint);
    return createAnalyticsRuntime({
      enabled: analyticsConfig.enabled,
      outboxPath,
      appVersion: analyticsConfig.appVersion,
      buildChannel: parseBuildChannel(analyticsConfig.buildChannel),
      workerUrl: packagedAnalyticsWorkerUrl(),
      ...(endpoint === undefined ? {} : { endpoint }),
    });
  };

  const runtime = yield* Effect.acquireRelease(
    Effect.try({
      try: createRuntime,
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

  const recordedOwners = new Set<string>();
  const recordOwners: AnalyticsService["Service"]["recordOwners"] = (owners, observedBy) =>
    Effect.forEach(
      owners,
      ({ source, ownerId }) => {
        const key = `${observedBy}:${source}:${ownerId}`;
        if (recordedOwners.has(key)) return Effect.void;
        recordedOwners.add(key);
        return record("install.owner_observed", { ownerSource: source, ownerId, observedBy });
      },
      { discard: true },
    );

  const flush: AnalyticsService["Service"]["flush"] = Effect.tryPromise({
    try: () => runtime.flush(),
    catch: () => "analytics-flush-failed" as const,
  }).pipe(
    Effect.catch(() => Effect.logWarning("Scient analytics delivery attempt failed")),
    Effect.asVoid,
  );

  return {
    record,
    recordOwners,
    flush,
    status: Effect.succeed({ available: true }),
  } satisfies AnalyticsService["Service"];
});
