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
import * as NodeFSP from "node:fs/promises";
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

export interface AnalyticsStatus {
  readonly available: boolean;
  readonly consent: AnalyticsConsent;
}

interface StoredAnalyticsPreference {
  readonly version: 1;
  readonly consent: AnalyticsConsent;
}

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

async function readStoredConsent(path: string): Promise<AnalyticsConsent | null> {
  try {
    const parsed = JSON.parse(await NodeFSP.readFile(path, "utf8")) as unknown;
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !("version" in parsed) ||
      parsed.version !== 1 ||
      !("consent" in parsed) ||
      typeof parsed.consent !== "string"
    ) {
      return null;
    }
    return AnalyticsConsent.find((candidate) => candidate === parsed.consent) ?? null;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    return null;
  }
}

async function writeStoredConsent(path: string, consent: AnalyticsConsent): Promise<void> {
  await NodeFSP.mkdir(NodePath.dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPath = `${path}.tmp`;
  const preference: StoredAnalyticsPreference = { version: 1, consent };
  await NodeFSP.writeFile(temporaryPath, `${JSON.stringify(preference)}\n`, { mode: 0o600 });
  await NodeFSP.rename(temporaryPath, path);
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

    /** Read the current local consent state and master availability gate. */
    readonly status: Effect.Effect<AnalyticsStatus>;

    /** Persist and apply a new local consent level before accepting later events. */
    readonly setConsent: (consent: AnalyticsConsent) => Effect.Effect<AnalyticsStatus>;

    /** Request remote deletion, then rotate local pseudonymous state on acknowledgement. */
    readonly deleteData: Effect.Effect<boolean>;
  }
>()("t3/telemetry/AnalyticsService") {
  /** No-op layer for tests and callers that intentionally disable analytics. */
  static readonly layerDisabled = Layer.succeed(
    AnalyticsService,
    AnalyticsService.of({
      record: () => Effect.void,
      flush: Effect.void,
      status: Effect.succeed({ available: false, consent: "off" }),
      setConsent: () => Effect.succeed({ available: false, consent: "off" }),
      deleteData: Effect.succeed(false),
    }),
  );
  static readonly layerTest = AnalyticsService.layerDisabled;
}

export const make = Effect.gen(function* () {
  const analyticsConfig = yield* AnalyticsEnvConfig;
  const serverConfig = yield* ServerConfig.ServerConfig;
  const outboxPath = NodePath.join(serverConfig.stateDir, "analytics", "outbox.sqlite");
  const preferencePath = NodePath.join(serverConfig.stateDir, "analytics", "preferences.json");
  const storedConsent = analyticsConfig.enabled
    ? yield* Effect.promise(() => readStoredConsent(preferencePath))
    : null;
  let consent = storedConsent ?? parseConsent(analyticsConfig.consent);
  let sessionStartedAt = yield* Clock.currentTimeMillis;

  if (analyticsConfig.enabled && consent === "off" && analyticsConfig.consent !== "off") {
    yield* Effect.logWarning("Invalid Scient analytics consent; analytics remains off");
  }

  const createRuntime = (runtimeConsent: AnalyticsConsent) =>
    createAnalyticsRuntime({
      enabled: analyticsConfig.enabled,
      consent: runtimeConsent,
      outboxPath,
      appVersion: packageJson.version,
      buildChannel: parseBuildChannel(analyticsConfig.buildChannel),
      workerUrl: packagedAnalyticsWorkerUrl(),
    });

  const runtimeHolder: { current: AnalyticsRuntime } = {
    current: disabledRuntime(outboxPath),
  };
  runtimeHolder.current = yield* Effect.acquireRelease(
    Effect.try({
      try: () => createRuntime(consent),
      catch: () => "analytics-initialization-failed" as const,
    }).pipe(
      Effect.catch(() =>
        Effect.logError("Scient analytics initialization failed; analytics remains off").pipe(
          Effect.as(disabledRuntime(outboxPath)),
        ),
      ),
    ),
    () =>
      Effect.gen(function* () {
        const activeRuntime = runtimeHolder.current;
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

  const recordSessionStarted = (activeRuntime: AnalyticsRuntime, startedAt: number) => {
    sessionStartedAt = startedAt;
    activeRuntime.record("app.session.started", {
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
  };
  recordSessionStarted(runtimeHolder.current, sessionStartedAt);

  let controlInProgress = false;

  const record: AnalyticsService["Service"]["record"] = (event, properties) =>
    Effect.try({
      try: () => {
        if (controlInProgress) return;
        runtimeHolder.current.record(event, properties);
      },
      catch: () => "analytics-record-failed" as const,
    }).pipe(Effect.catch(() => Effect.logWarning("Scient analytics event could not be queued")));

  const flush: AnalyticsService["Service"]["flush"] = Effect.tryPromise({
    try: () => runtimeHolder.current.flush(),
    catch: () => "analytics-flush-failed" as const,
  }).pipe(
    Effect.catch(() => Effect.logWarning("Scient analytics delivery attempt failed")),
    Effect.asVoid,
  );

  yield* Effect.forever(Effect.sleep("30 seconds").pipe(Effect.andThen(flush))).pipe(
    Effect.forkScoped,
  );

  let controlQueue: Promise<void> = Promise.resolve();
  const serializeControl = <A>(operation: () => Promise<A>): Promise<A> => {
    const result = controlQueue.then(operation, operation);
    controlQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };

  const status: AnalyticsService["Service"]["status"] = Effect.sync(() => ({
    available: analyticsConfig.enabled,
    consent: analyticsConfig.enabled ? consent : "off",
  }));

  const setConsent: AnalyticsService["Service"]["setConsent"] = (nextConsent) =>
    Effect.gen(function* () {
      const nextSessionStartedAt = yield* Clock.currentTimeMillis;
      return yield* Effect.tryPromise({
        try: () =>
          serializeControl(async () => {
            if (!analyticsConfig.enabled) return { available: false, consent: "off" } as const;
            controlInProgress = true;
            const previousConsent = consent;
            const previousRuntime = runtimeHolder.current;
            let candidateRuntime: AnalyticsRuntime | null = null;
            try {
              if (nextConsent === previousConsent) {
                await writeStoredConsent(preferencePath, nextConsent);
                return { available: true, consent } as const;
              }
              if (nextConsent !== "off" && !previousRuntime.enabled) {
                candidateRuntime = createRuntime(nextConsent);
              } else if (previousRuntime.enabled) {
                await previousRuntime.setConsent(nextConsent);
              }
              try {
                await writeStoredConsent(preferencePath, nextConsent);
              } catch (error) {
                if (candidateRuntime) await candidateRuntime.close();
                if (previousRuntime.enabled) await previousRuntime.setConsent(previousConsent);
                throw error;
              }
              consent = nextConsent;
              if (nextConsent === "off") {
                await previousRuntime.close();
                runtimeHolder.current = disabledRuntime(outboxPath);
              } else if (candidateRuntime) {
                runtimeHolder.current = candidateRuntime;
                recordSessionStarted(candidateRuntime, nextSessionStartedAt);
              }
              return { available: true, consent } as const;
            } finally {
              controlInProgress = false;
            }
          }),
        catch: () => "analytics-consent-update-failed" as const,
      });
    }).pipe(
      Effect.tapError(() => Effect.logWarning("Scient analytics consent could not be updated")),
      Effect.orDie,
    );

  const deleteData: AnalyticsService["Service"]["deleteData"] = Effect.gen(function* () {
    const nextSessionStartedAt = yield* Clock.currentTimeMillis;
    return yield* Effect.tryPromise({
      try: () =>
        serializeControl(async () => {
          if (!analyticsConfig.enabled) return false;
          controlInProgress = true;
          try {
            const temporaryRuntime = runtimeHolder.current.enabled
              ? null
              : createRuntime("essential");
            const deletionRuntime = temporaryRuntime ?? runtimeHolder.current;
            try {
              const deleted = await deletionRuntime.deleteData();
              if (deleted && !temporaryRuntime) {
                await deletionRuntime.close();
                try {
                  const replacementRuntime = createRuntime(consent);
                  runtimeHolder.current = replacementRuntime;
                  recordSessionStarted(replacementRuntime, nextSessionStartedAt);
                } catch {
                  runtimeHolder.current = disabledRuntime(outboxPath);
                }
              }
              return deleted;
            } finally {
              if (temporaryRuntime) await temporaryRuntime.close();
            }
          } finally {
            controlInProgress = false;
          }
        }),
      catch: () => "analytics-deletion-failed" as const,
    });
  }).pipe(
    Effect.catch(() =>
      Effect.logWarning("Scient analytics data deletion could not be completed").pipe(
        Effect.as(false),
      ),
    ),
  );

  return AnalyticsService.of({ record, flush, status, setConsent, deleteData });
});

export const layer = Layer.effect(AnalyticsService, make);
export const layerTest = AnalyticsService.layerTest;
export const layerDisabled = AnalyticsService.layerDisabled;
