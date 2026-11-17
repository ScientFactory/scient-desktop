// @effect-diagnostics nodeBuiltinImport:off -- This adapter owns Scient's local analytics boundary.
/**
 * Scient first-party analytics, provided as T3's AnalyticsService where the server is built.
 * T3's PostHog layer is never composed, so no event reaches T3's PostHog.
 *
 * @module ScientAnalytics
 */
import {
  createAnalyticsRuntime,
  type AnalyticsRuntime,
  type RecordedAnalyticsEvent,
} from "@scientfactory/analytics";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";
import * as NodeSea from "node:sea";
import * as Config from "effect/Config";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import packageJson from "../../package.json" with { type: "json" };
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import * as ServerConfig from "../config.ts";
import { AnalyticsService } from "./AnalyticsService.ts";

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

export interface AnalyticsAvailability {
  readonly available: boolean;
}

/** Whether this build collects analytics at all; unprovided means it does not. */
export class ScientAnalyticsAvailability extends Context.Reference<AnalyticsAvailability>(
  "scient/telemetry/ScientAnalyticsAvailability",
  {
    defaultValue: () => ({ available: false }),
  },
) {}

export interface RecordedAnalyticsIngest {
  /**
   * Queues events another Scient process recorded, keeping their ids and times. True once the
   * outbox holds them or analytics never sends them; false asks the sender to offer again.
   */
  readonly ingest: (events: ReadonlyArray<RecordedAnalyticsEvent>) => Effect.Effect<boolean>;
}

const neverSent: RecordedAnalyticsIngest = { ingest: () => Effect.succeed(true) };

/** Ingest for events recorded in another process; unprovided means they are never sent. */
export class ScientRecordedAnalyticsIngest extends Context.Reference<RecordedAnalyticsIngest>(
  "scient/telemetry/ScientRecordedAnalyticsIngest",
  { defaultValue: () => neverSent },
) {}

export interface ScientAnalytics {
  readonly analytics: AnalyticsService["Service"];
  readonly available: boolean;
  readonly recorded: RecordedAnalyticsIngest;
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
};

const disabled: ScientAnalytics = {
  analytics: disabledAnalyticsService,
  available: false,
  recorded: neverSent,
};

export const make = Effect.gen(function* () {
  const analyticsConfig = yield* AnalyticsEnvConfig;
  // A managed policy can switch analytics off over the environment, never on.
  const policyAllows =
    ManagedPolicy.deniedBy(yield* ManagedPolicy.ManagedPolicy, "telemetry") === undefined;
  if (!analyticsConfig.enabled || !policyAllows) return disabled;
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

  const recorded: RecordedAnalyticsIngest = {
    ingest: (events) =>
      Effect.tryPromise({
        try: () => runtime.ingest(events),
        catch: () => "analytics-ingest-failed" as const,
      }).pipe(Effect.orElseSucceed(() => false)),
  };

  return {
    analytics: AnalyticsService.of({ record, recordOwners, flush }),
    available: true,
    recorded,
  } satisfies ScientAnalytics;
});

/** Provides AnalyticsService and its availability in place of T3's PostHog layer. */
export const layer = Layer.effectContext(
  Effect.map(make, ({ analytics, available, recorded }) =>
    Context.make(AnalyticsService, analytics).pipe(
      Context.add(ScientAnalyticsAvailability, { available }),
      Context.add(ScientRecordedAnalyticsIngest, recorded),
    ),
  ),
);

/** No-op layer for tests and callers that intentionally disable analytics. */
export const layerDisabled = Layer.succeed(AnalyticsService, disabledAnalyticsService);
