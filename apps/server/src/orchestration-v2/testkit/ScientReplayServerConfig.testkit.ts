import * as OtelEnvironment from "@t3tools/shared/otelEnvironment";
import { DEFAULT_SIGNAL_EXPORT } from "@t3tools/shared/observability";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";
import type * as Scope from "effect/Scope";

import type { ServerConfig } from "../../config.ts";

/** The allocating scope owns the entire profile, including failed initialization. */
export const makeReplayServerConfig = Effect.fn("testkit.makeReplayServerConfig")(function* (
  scenario: string,
): Effect.fn.Return<
  ServerConfig["Service"],
  PlatformError.PlatformError,
  FileSystem.FileSystem | Path.Path | Scope.Scope
> {
  const safeScenario = scenario.replace(/[^a-z0-9_-]+/gi, "-");
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const baseDir = yield* Effect.acquireRelease(
    fs.makeTempDirectory({ prefix: `t3-orchestration-v2-replay-${safeScenario}-` }),
    (directory) => fs.remove(directory, { recursive: true, force: true }).pipe(Effect.orDie),
  );
  const stateDir = path.join(baseDir, "userdata");
  const logsDir = path.join(stateDir, "logs");
  const providerLogsDir = path.join(logsDir, "provider");
  const terminalLogsDir = path.join(logsDir, "terminals");
  const attachmentsDir = path.join(stateDir, "attachments");
  const environmentThemesDir = path.join(stateDir, "themes");
  const worktreesDir = path.join(baseDir, "worktrees");
  const providerStatusCacheDir = path.join(baseDir, "caches");

  for (const directory of [
    stateDir,
    logsDir,
    providerLogsDir,
    terminalLogsDir,
    attachmentsDir,
    environmentThemesDir,
    worktreesDir,
    providerStatusCacheDir,
  ]) {
    yield* fs.makeDirectory(directory, { recursive: true });
  }

  const config = {
    logLevel: "Error",
    traceMinLevel: "Info",
    traceTimingEnabled: true,
    traceBatchWindowMs: 200,
    traceMaxBytes: 10 * 1024 * 1024,
    traceMaxFiles: 10,
    otelEnvironment: OtelEnvironment.none,
    otlpTracesUrl: undefined,
    otlpMetricsUrl: undefined,
    otlpLogsUrl: undefined,
    otlpTracesExport: DEFAULT_SIGNAL_EXPORT,
    otlpMetricsExport: DEFAULT_SIGNAL_EXPORT,
    otlpLogsExport: DEFAULT_SIGNAL_EXPORT,
    mode: "web",
    port: 0,
    host: undefined,
    cwd: baseDir,
    baseDir,
    staticDir: undefined,
    devUrl: undefined,
    devAllowedOrigins: [],
    noBrowser: false,
    startupPresentation: "browser",
    tailscaleServeEnabled: false,
    tailscaleServePort: 443,
    desktopBootstrapToken: undefined,
    autoBootstrapProjectFromCwd: false,
    logWebSocketEvents: false,
    stateDir,
    dbPath: path.join(stateDir, "state.sqlite"),
    keybindingsConfigPath: path.join(stateDir, "keybindings.json"),
    settingsPath: path.join(stateDir, "settings.json"),
    providerStatusCacheDir,
    worktreesDir,
    attachmentsDir,
    browserArtifactsDir: path.join(stateDir, "browser-artifacts"),
    environmentThemesDir,
    logsDir,
    serverLogPath: path.join(logsDir, "server.log"),
    serverTracePath: path.join(logsDir, "server.trace.ndjson"),
    providerLogsDir,
    providerEventLogPath: path.join(providerLogsDir, "events.log"),
    terminalLogsDir,
    anonymousIdPath: path.join(stateDir, "anonymous-id"),
    environmentIdPath: path.join(stateDir, "environment-id"),
    serverRuntimeStatePath: path.join(stateDir, "server-runtime.json"),
    secretsDir: path.join(stateDir, "secrets"),
    analysisDir: path.join(stateDir, "analysis"),
    computeDir: path.join(stateDir, "compute"),
    latexDir: path.join(stateDir, "latex"),
    documentArtifactsDir: path.join(stateDir, "document-artifacts"),
  } as const;
  return config;
});
