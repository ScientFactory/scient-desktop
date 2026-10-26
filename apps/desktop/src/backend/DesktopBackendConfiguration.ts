import * as NodeOS from "node:os";

import { parsePersistedServerObservabilitySettings } from "@t3tools/shared/serverSettings";
import { currentDesktopBootstrapToken } from "@t3tools/shared/desktopBootstrapToken";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import * as SynchronizedRef from "effect/SynchronizedRef";

import serverPackageJson from "../../../server/package.json" with { type: "json" };

import * as DesktopBackendManager from "./DesktopBackendManager.ts";
import * as DesktopCliShim from "../app/DesktopCliShim.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopServerExposure from "./DesktopServerExposure.ts";
import * as DesktopShellEnvironment from "../shell/DesktopShellEnvironment.ts";
import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";
import * as DesktopWslEnvironment from "../wsl/DesktopWslEnvironment.ts";
import { SCIENT_DESKTOP_IDENTITY } from "@t3tools/shared/scientDesktopIdentity";
import * as DesktopWslServerTree from "../wsl/DesktopWslServerTree.ts";
import {
  scientAnalyticsMetadata,
  SCIENT_ANALYTICS_METADATA_ENV_NAMES,
} from "./scientAnalyticsMetadata.ts";
// SCIENT-FORK:START — Scient launch environment and bundled SyncTeX navigator.
import {
  resolveSyncTexNavigatorPath,
  scientPrimaryBackendEnv,
  scientWslBackendEnv,
  WSL_CANDIDATE_ENV_NAMES,
} from "./scientBackendLaunch.ts";
// SCIENT-FORK:END

export class DesktopBackendObservabilitySettingsReadError extends Schema.TaggedError<DesktopBackendObservabilitySettingsReadError>()(
  "DesktopBackendObservabilitySettingsReadError",
  {
    settingsPath: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to read persisted backend observability settings at ${this.settingsPath}.`;
  }
}

export class DesktopBackendConfiguration extends Context.Service<
  DesktopBackendConfiguration,
  {
    readonly resolvePrimary: Effect.Effect<
      DesktopBackendManager.DesktopBackendStartConfig,
      PlatformError.PlatformError
    >;
    readonly resolveWsl: (input: {
      readonly port: number;
      readonly distro: string | null;
    }) => Effect.Effect<
      DesktopBackendManager.DesktopBackendStartConfig,
      PlatformError.PlatformError
    >;
    readonly resolvePrimaryLabel: Effect.Effect<string>;
    readonly currentBootstrapToken: Effect.Effect<string, PlatformError.PlatformError>;
  }
>()("@t3tools/desktop/backend/DesktopBackendConfiguration") {}

interface BackendObservabilitySettings {
  readonly otlpTracesUrl: Option.Option<string>;
  readonly otlpMetricsUrl: Option.Option<string>;
  readonly otlpLogsUrl: Option.Option<string>;
}

const emptyBackendObservabilitySettings: BackendObservabilitySettings = {
  otlpTracesUrl: Option.none(),
  otlpMetricsUrl: Option.none(),
  otlpLogsUrl: Option.none(),
};

const DESKTOP_BACKEND_ENV_NAMES = [
  "SCIENT_DEV_SCRATCH_ROOT",
  ...SCIENT_ANALYTICS_METADATA_ENV_NAMES,
  "T3CODE_HOME",
  "SCIENT_NEXT_HOME",
  "T3CODE_PORT",
  "T3CODE_MODE",
  "T3CODE_NO_BROWSER",
  "T3CODE_HOST",
  "T3CODE_DESKTOP_WS_URL",
  "T3CODE_DESKTOP_LAN_ACCESS",
  "T3CODE_DESKTOP_LAN_HOST",
  "T3CODE_DESKTOP_HTTPS_ENDPOINTS",
  "T3CODE_TAILSCALE_SERVE",
  "T3CODE_TAILSCALE_SERVE_PORT",
  "SCIENT_NEXT_DEVELOPMENT_STATE",
] as const;

// Windows forwards these variables into WSL only through WSLENV.
const WSL_FORWARDED_ENV_NAMES = [
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "T3CODE_TELEMETRY_ENABLED",
  // Otherwise the WSL server keeps exporting to endpoints from the bootstrap.
  "T3CODE_OTEL_SDK_DISABLED",
  "OTEL_SDK_DISABLED",
  "T3CODE_OTLP_HEADERS",
  "T3CODE_OTLP_PROTOCOL",
  // Untranslated T3 URLs must override bootstrap endpoints inside WSL, as they do on Windows.
  "T3CODE_OTLP_TRACES_URL",
  "T3CODE_OTLP_METRICS_URL",
  "T3CODE_OTLP_LOGS_URL",
  "OTEL_EXPORTER_OTLP_ENDPOINT",
  "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT",
  "OTEL_EXPORTER_OTLP_METRICS_ENDPOINT",
  "OTEL_EXPORTER_OTLP_LOGS_ENDPOINT",
  "OTEL_EXPORTER_OTLP_HEADERS",
  "OTEL_EXPORTER_OTLP_TRACES_HEADERS",
  "OTEL_EXPORTER_OTLP_METRICS_HEADERS",
  "OTEL_EXPORTER_OTLP_LOGS_HEADERS",
  "OTEL_EXPORTER_OTLP_PROTOCOL",
  "OTEL_EXPORTER_OTLP_TRACES_PROTOCOL",
  "OTEL_EXPORTER_OTLP_METRICS_PROTOCOL",
  "OTEL_EXPORTER_OTLP_LOGS_PROTOCOL",
  "OTEL_TRACES_EXPORTER",
  "OTEL_METRICS_EXPORTER",
  "OTEL_LOGS_EXPORTER",
  "OTEL_RESOURCE_ATTRIBUTES",
] as const;

const WSL_SERVER_SYSTEM_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

const backendChildEnvPatch = (): Record<string, string | undefined> =>
  Object.fromEntries(DESKTOP_BACKEND_ENV_NAMES.map((name) => [name, undefined]));

const getWslEnvEntryName = (entry: string): string => {
  const slashIndex = entry.indexOf("/");
  return slashIndex === -1 ? entry : entry.slice(0, slashIndex);
};

const mergeWslEnv = (
  existingWslEnv: string | undefined,
  forwardedEnvNames: ReadonlyArray<string>,
): string | undefined => {
  const existing = existingWslEnv?.trim() ?? "";

  const seenNames = new Set(
    existing
      .split(":")
      .map((entry) => getWslEnvEntryName(entry.trim()))
      .filter((name) => name.length > 0),
  );

  const additions = forwardedEnvNames.filter((name) => !seenNames.has(name));

  // Preserve empty segments and duplicates in the user's WSLENV; only append required variables.
  const parts = [existing, ...additions].filter((part) => part.length > 0);
  return parts.length > 0 ? parts.join(":") : undefined;
};

const logBackendObservabilitySettingsReadFailure = (
  settingsPath: string,
  cause: PlatformError.PlatformError,
) => {
  const error = new DesktopBackendObservabilitySettingsReadError({ settingsPath, cause });
  return Effect.logWarning(error).pipe(
    Effect.annotateLogs({
      component: "desktop-backend-configuration",
      error,
    }),
  );
};

function resourceMonitorBinaryName(platform: NodeJS.Platform): string {
  return platform === "win32" ? "scient-resource-monitor.exe" : "scient-resource-monitor";
}

const resolveResourceMonitorPath = Effect.fn(
  "desktop.backendConfiguration.resolveResourceMonitorPath",
)(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const fileSystem = yield* FileSystem.FileSystem;
  const binaryName = resourceMonitorBinaryName(environment.platform);
  const candidates = environment.isDevelopment
    ? [
        environment.path.join(
          environment.rootDir,
          "native/resource-monitor/target/release",
          binaryName,
        ),
        environment.path.join(
          environment.rootDir,
          "native/resource-monitor/target/debug",
          binaryName,
        ),
      ]
    : environment.isPackaged
      ? [environment.path.join(environment.resourcesPath, "resource-monitor", binaryName)]
      : environment.resolveResourcePathCandidates(
          environment.path.join("resource-monitor", binaryName),
        );

  for (const candidate of candidates) {
    if (yield* fileSystem.exists(candidate).pipe(Effect.orElseSucceed(() => false))) {
      return Option.some(candidate);
    }
  }

  return Option.none<string>();
});

const resolveFilePublicationHelperPath = Effect.fn(
  "desktop.backendConfiguration.resolveFilePublicationHelperPath",
)(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const fileSystem = yield* FileSystem.FileSystem;
  const binaryName =
    environment.platform === "win32" ? "scient-file-publication.exe" : "scient-file-publication";
  const candidates = environment.isDevelopment
    ? [
        // Pair the backend bundle with the helper staged by the same build.
        // A cached native-tree build may speak an older publication protocol.
        environment.path.join(environment.rootDir, "apps/server/dist/file-exchange", binaryName),
        environment.path.join(
          environment.rootDir,
          "native/file-exchange",
          `${environment.platform}-${environment.processArch}`,
          binaryName,
        ),
        ...(environment.platform === "darwin"
          ? [
              environment.path.join(
                environment.rootDir,
                "native/file-exchange/darwin-universal",
                binaryName,
              ),
            ]
          : []),
      ]
    : environment.isPackaged
      ? [environment.path.join(environment.resourcesPath, "file-exchange", binaryName)]
      : environment.resolveResourcePathCandidates(
          environment.path.join("file-exchange", binaryName),
        );
  for (const candidate of candidates) {
    if (yield* fileSystem.exists(candidate).pipe(Effect.orElseSucceed(() => false)))
      return Option.some(candidate);
  }
  // Keep absence explicit: the server must not discover a different packaged helper.
  return environment.isPackaged && candidates[0] !== undefined
    ? Option.some(candidates[0])
    : Option.none<string>();
});

const readPersistedBackendObservabilitySettings = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const raw = yield* fileSystem.readFileString(environment.serverSettingsPath).pipe(
    Effect.asSome,
    Effect.catchTags({
      PlatformError: (cause) =>
        cause.reason._tag === "NotFound"
          ? Effect.succeedNone
          : logBackendObservabilitySettingsReadFailure(environment.serverSettingsPath, cause).pipe(
              Effect.as(Option.none()),
            ),
    }),
  );
  if (Option.isNone(raw)) {
    return emptyBackendObservabilitySettings;
  }

  const parsed = parsePersistedServerObservabilitySettings(raw.value);
  return {
    otlpTracesUrl: Option.fromNullishOr(parsed.otlpTracesUrl),
    otlpMetricsUrl: Option.fromNullishOr(parsed.otlpMetricsUrl),
    otlpLogsUrl: Option.fromNullishOr(parsed.otlpLogsUrl),
  };
});

const readBackendObservabilitySettings = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const persisted = yield* readPersistedBackendObservabilitySettings;
  return {
    otlpTracesUrl: Option.orElse(environment.otlpTracesUrl, () => persisted.otlpTracesUrl),
    otlpMetricsUrl: Option.orElse(environment.otlpMetricsUrl, () => persisted.otlpMetricsUrl),
    otlpLogsUrl: Option.orElse(environment.otlpLogsUrl, () => persisted.otlpLogsUrl),
  } satisfies BackendObservabilitySettings;
});

interface SharedBootstrapInput {
  readonly bootstrapToken: string;
  readonly bootstrapSecret: string;
  readonly observabilitySettings: BackendObservabilitySettings;
}

interface WslPreflightSuccess {
  readonly _tag: "Ready";
  readonly runningDistro: string;
  readonly windowsEntryPath: string;
  readonly linuxEntryPath: string;
  // Launch the exact Node path probed with node-pty, even if later PATH lookup would resolve another version.
  readonly nodePath: string;
  // PATH captured from the same login shell after the shared resolver loaded
  // version managers. The launch forwards this value directly without a shell.
  readonly resolvedPath: string;
  readonly runtimeId?: string;
}

interface WslPreflightFailure {
  readonly _tag: "Failed";
  readonly reason: string;
  readonly fatal: boolean;
  readonly retryLimit?: number;
}

const WSL_TRANSIENT_PREFLIGHT_RETRY_LIMIT = 12;
const WSL_RUNTIME_ARCHIVE_NAME = "wsl-runtime.tar.gz";
const WSL_RUNTIME_ARCHIVE_HASH_NAME = `${WSL_RUNTIME_ARCHIVE_NAME}.sha256`;
const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/i;

const parseWslRuntimeArchiveHash = (value: string): string | null => {
  const trimmed = value.trim();
  return SHA256_HEX_PATTERN.test(trimmed) ? trimmed.toLowerCase() : null;
};

type FailedNodePtyResult = Extract<
  DesktopWslEnvironment.EnsureWslNodePtyResult,
  { readonly ok: false }
>;

const runWslPreflight = Effect.fn("desktop.backendConfiguration.wslPreflight")(function* (input: {
  readonly distro: string | null;
  readonly runtimeArchive: DesktopWslEnvironment.WslRuntimeArchive | null;
  readonly allowBuild: boolean;
}): Effect.fn.Return<
  WslPreflightSuccess | WslPreflightFailure,
  never,
  | DesktopEnvironment.DesktopEnvironment
  | DesktopWslEnvironment.DesktopWslEnvironment
  | DesktopWslServerTree.DesktopWslServerTree
  | FileSystem.FileSystem
> {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const wslEnv = yield* DesktopWslEnvironment.DesktopWslEnvironment;
  const wslServerTree = yield* DesktopWslServerTree.DesktopWslServerTree;
  const fileSystem = yield* FileSystem.FileSystem;

  const wslAvailable = yield* wslEnv.isAvailable;
  if (!wslAvailable) {
    return {
      _tag: "Failed",
      reason: "WSL is not available on this system",
      fatal: false,
    } as const;
  }

  const distroProbe = yield* wslEnv.probeDistros.pipe(
    Effect.map((distros) => ({ _tag: "Success", distros }) as const),
    Effect.catch((error) => Effect.succeed({ _tag: "Failure", error } as const)),
  );
  if (distroProbe._tag === "Failure") {
    return {
      _tag: "Failed",
      reason: `Unable to list WSL distributions: ${distroProbe.error.message}`,
      fatal: false,
    } as const;
  }

  const installedDistros = distroProbe.distros;
  const runningDistro = input.distro
    ? (installedDistros.find(
        (installed) => installed.name.toLowerCase() === input.distro?.toLowerCase(),
      )?.name ?? null)
    : (installedDistros.find((installed) => installed.isDefault)?.name ?? null);
  if (runningDistro === null) {
    return {
      _tag: "Failed",
      reason: input.distro
        ? `WSL distro is not installed: ${input.distro}`
        : installedDistros.length === 0
          ? "WSL has no installed distributions"
          : "WSL has no default distribution",
      fatal: true,
    } as const;
  }

  const nodePtyOptions = {
    allowBuild: input.allowBuild,
    nodeEngineRange: serverPackageJson.engines.node,
  };
  const failedNodePty = (result: FailedNodePtyResult) =>
    ({
      _tag: "Failed",
      reason: `WSL node-pty unavailable: ${result.reason}`,
      fatal: result.fatal,
      ...(result.retryLimit === undefined ? {} : { retryLimit: result.retryLimit }),
    }) as const;

  const resolveMountedAppRoot = Effect.gen(function* () {
    const serverTree = yield* wslServerTree.ensure;
    if (!serverTree.ok) {
      return { ok: false, reason: serverTree.reason, fatal: serverTree.fatal } as const;
    }
    const windowsEntryPath = environment.path.join(serverTree.root, "apps/server/dist/bin.mjs");
    const entryExists = yield* fileSystem
      .exists(windowsEntryPath)
      .pipe(Effect.orElseSucceed(() => false));
    if (!entryExists) {
      return {
        ok: false,
        reason: `missing server entry at ${windowsEntryPath}`,
        fatal: true,
      } as const;
    }
    const mountedAppRoot = yield* wslEnv.windowsToWslPath(runningDistro, serverTree.root);
    return Option.isNone(mountedAppRoot)
      ? ({
          ok: false,
          reason: `wslpath conversion failed for ${serverTree.root}`,
          fatal: false,
        } as const)
      : ({ ok: true, windowsEntryPath, linuxAppRoot: mountedAppRoot.value } as const);
  });

  // SCIENT-FORK:START — retain the original staged failure without inventing a cache identity.
  let stagedFailure:
    | { readonly runtimeId?: string; readonly failure: WslPreflightFailure }
    | undefined;
  // SCIENT-FORK:END

  if (input.runtimeArchive !== null) {
    const runtime = yield* wslEnv.prepareRuntime(runningDistro, input.runtimeArchive);
    if (runtime.ok) {
      const stagedNodePty = yield* wslEnv.ensureNodePty(
        runningDistro,
        runtime.linuxAppRoot,
        nodePtyOptions,
      );
      if (stagedNodePty.ok) {
        yield* wslServerTree.cleanupLegacy;
        return {
          _tag: "Ready",
          runningDistro,
          windowsEntryPath: environment.backendEntryPath,
          linuxEntryPath: `${runtime.linuxAppRoot}/apps/server/dist/bin.mjs`,
          nodePath: stagedNodePty.nodePath,
          resolvedPath: stagedNodePty.resolvedPath,
          runtimeId: input.runtimeArchive.runtimeId,
        } as const;
      }
      // A transport failure says nothing about the staged tree, so it is
      // retried against the same cache rather than spending a second probe on
      // the mounted tree and risking a needless reinstall.
      if (!stagedNodePty.fatal) return failedNodePty(stagedNodePty);
      yield* Effect.logWarning(
        "The staged WSL runtime could not load node-pty; retrying from the mounted server tree.",
        { reason: stagedNodePty.reason },
      );
      // SCIENT-FORK:START — preserve the complete staged diagnostic through mounted fallback.
      stagedFailure = {
        runtimeId: input.runtimeArchive.runtimeId,
        failure: failedNodePty(stagedNodePty),
      };
      // SCIENT-FORK:END
    } else {
      // SCIENT-FORK:START — preparation failure has no staged cache to invalidate.
      stagedFailure = {
        failure: {
          _tag: "Failed",
          reason: `WSL runtime unavailable: ${runtime.reason}`,
          fatal: true,
        },
      };
      // SCIENT-FORK:END
      yield* Effect.logWarning(
        "Could not stage the WSL runtime; launching from the mounted server tree instead.",
        { reason: runtime.reason },
      );
    }
  }

  const mounted = yield* resolveMountedAppRoot;
  if (!mounted.ok) {
    // SCIENT-FORK:START — prefer the staged diagnostic only when the fallback is also fatal.
    return stagedFailure && mounted.fatal
      ? stagedFailure.failure
      : ({ _tag: "Failed", reason: mounted.reason, fatal: mounted.fatal } as const);
    // SCIENT-FORK:END
  }

  const nodePtyResult = yield* wslEnv.ensureNodePty(
    runningDistro,
    mounted.linuxAppRoot,
    nodePtyOptions,
  );
  if (!nodePtyResult.ok) {
    // Only substitute a staged failure for a fatal mounted failure; transient /mnt failures must remain retryable.
    // SCIENT-FORK:START — a transient mounted failure must remain retryable.
    return stagedFailure && nodePtyResult.fatal
      ? stagedFailure.failure
      : failedNodePty(nodePtyResult);
    // SCIENT-FORK:END
  }

  if (stagedFailure?.runtimeId) {
    yield* wslEnv.invalidateRuntime(runningDistro, stagedFailure.runtimeId);
  }

  return {
    _tag: "Ready",
    runningDistro,
    windowsEntryPath: mounted.windowsEntryPath,
    linuxEntryPath: `${mounted.linuxAppRoot}/apps/server/dist/bin.mjs`,
    nodePath: nodePtyResult.nodePath,
    resolvedPath: nodePtyResult.resolvedPath,
  } as const;
});

// In WSL2 mirrored mode, eth0 matches a host IP; use loopback for the renderer.
const isLocalHostIpv4 = (ip: string): boolean => {
  const interfaces = NodeOS.networkInterfaces();
  for (const list of Object.values(interfaces)) {
    if (!list) continue;
    for (const entry of list) {
      const family = String(entry.family);
      if ((family === "IPv4" || family === "4") && entry.address === ip) return true;
    }
  }
  return false;
};

const buildObservabilityFragment = (
  observabilitySettings: BackendObservabilitySettings,
  safetyEnvelopeEnabled: boolean,
) => {
  // Candidate D4 deliberately does not forward persisted OTLP destinations.
  // Local trace files remain available for diagnostics.
  if (safetyEnvelopeEnabled && !SCIENT_DESKTOP_IDENTITY.outboundTelemetryEnabled) return {};
  return {
    ...Option.match(observabilitySettings.otlpTracesUrl, {
      onNone: () => ({}),
      onSome: (otlpTracesUrl) => ({ otlpTracesUrl }),
    }),
    ...Option.match(observabilitySettings.otlpMetricsUrl, {
      onNone: () => ({}),
      onSome: (otlpMetricsUrl) => ({ otlpMetricsUrl }),
    }),
    ...Option.match(observabilitySettings.otlpLogsUrl, {
      onNone: () => ({}),
      onSome: (otlpLogsUrl) => ({ otlpLogsUrl }),
    }),
  };
};

const resolvePrimaryStartConfig = Effect.fn("desktop.backendConfiguration.resolvePrimary")(
  function* (
    input: SharedBootstrapInput & {
      readonly resourceMonitorPath: Option.Option<string>;
      readonly filePublicationHelperPath: Option.Option<string>;
      readonly syncTexNavigatorPath: Option.Option<string>;
      readonly cliPath: Option.Option<string>;
      readonly shellEnvironmentPrepared: boolean;
    },
  ): Effect.fn.Return<
    DesktopBackendManager.DesktopBackendStartConfig,
    never,
    DesktopEnvironment.DesktopEnvironment | DesktopServerExposure.DesktopServerExposure
  > {
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    const serverExposure = yield* DesktopServerExposure.DesktopServerExposure;
    const backendExposure = yield* serverExposure.backendConfig;

    const bootstrap = {
      mode: "desktop" as const,
      noBrowser: true,
      port: backendExposure.port,
      t3Home: environment.baseDir,
      host: backendExposure.bindHost,
      desktopBootstrapToken: input.bootstrapToken,
      desktopBootstrapSecret: input.bootstrapSecret,

      shellEnvironmentPrepared: input.shellEnvironmentPrepared,
      tailscaleServeEnabled: backendExposure.tailscaleServeEnabled,
      tailscaleServePort: backendExposure.tailscaleServePort,
      desktopTelemetryFd: 4,
      desktopTelemetryControlFd: 5,
      desktopBrowserFd: 6,
      desktopBrowserControlFd: 7,
      ...Option.match(input.resourceMonitorPath, {
        onNone: () => ({}),
        onSome: (resourceMonitorPath) => ({ resourceMonitorPath }),
      }),
      ...Option.match(input.filePublicationHelperPath, {
        onNone: () => ({}),
        onSome: (filePublicationHelperPath) => ({ filePublicationHelperPath }),
      }),
      ...Option.match(input.syncTexNavigatorPath, {
        onNone: () => ({}),
        onSome: (syncTexNavigatorPath) => ({ syncTexNavigatorPath }),
      }),
      ...buildObservabilityFragment(input.observabilitySettings, environment.safetyEnvelopeEnabled),
    };

    return {
      executablePath: process.execPath,
      // SCIENT-FORK: Development launches must not share the production compile cache, even when packaged.
      // --require prevents cache settings leaking to provider subprocesses.
      args: [
        ...(environment.isDevelopment ? [] : ["--require", environment.compileCachePath]),
        environment.backendEntryPath,
        "--bootstrap-fd",
        "3",
        ...Option.match(environment.devServerUrl, {
          onNone: () => [] as ReadonlyArray<string>,
          onSome: (url) => ["--dev-url", url.href],
        }),
      ],
      entryPath: environment.backendEntryPath,
      cwd: environment.backendCwd,
      env: {
        ...backendChildEnvPatch(),
        ...scientAnalyticsMetadata(environment, process.env.SCIENT_ANALYTICS_ENABLED),
        ELECTRON_RUN_AS_NODE: "1",
        // SCIENT-FORK:START — Scient state directory and safety envelope.
        ...scientPrimaryBackendEnv(environment),
        // SCIENT-FORK:END
        T3CODE_CLI_PATH: Option.getOrUndefined(input.cliPath),
      },
      extendEnv: true,
      bootstrap,
      bootstrapDelivery: "fd3",
      httpBaseUrl: backendExposure.httpBaseUrl,
      captureOutput: true,
      preflightFailure: Option.none(),
    } satisfies DesktopBackendManager.DesktopBackendStartConfig;
  },
);

const resolveWslStartConfig = Effect.fn("desktop.backendConfiguration.resolveWsl")(function* (
  input: SharedBootstrapInput & {
    readonly port: number;
    readonly distro: string | null;
  },
): Effect.fn.Return<
  DesktopBackendManager.DesktopBackendStartConfig,
  never,
  | DesktopEnvironment.DesktopEnvironment
  | DesktopWslEnvironment.DesktopWslEnvironment
  | DesktopWslServerTree.DesktopWslServerTree
  | FileSystem.FileSystem
> {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const wslEnvironment = yield* DesktopWslEnvironment.DesktopWslEnvironment;
  const fileSystem = yield* FileSystem.FileSystem;

  // wslhost loopback forwarding is unreliable on some Windows hosts; advertise the WSL IP instead.
  const wslBindHost = "0.0.0.0";

  const bootstrap = {
    mode: "desktop" as const,
    noBrowser: true,
    port: input.port,
    // Omit t3Home to keep the Linux backend from sharing the primary's Windows SQLite file.
    host: wslBindHost,
    desktopBootstrapToken: input.bootstrapToken,
    desktopBootstrapSecret: input.bootstrapSecret,
    // PortSchema rejects 0 even when Tailscale Serve is disabled.
    tailscaleServeEnabled: false,
    tailscaleServePort: 443,
    ...buildObservabilityFragment(input.observabilitySettings, environment.safetyEnvelopeEnabled),
  };

  const archivePath = environment.path.join(environment.resourcesPath, WSL_RUNTIME_ARCHIVE_NAME);
  const archiveHashPath = environment.path.join(
    environment.resourcesPath,
    WSL_RUNTIME_ARCHIVE_HASH_NAME,
  );

  const hasArchive = environment.isPackaged
    ? yield* fileSystem.exists(archivePath).pipe(Effect.orElseSucceed(() => false))
    : false;
  const archiveHash = hasArchive
    ? yield* fileSystem.readFileString(archiveHashPath).pipe(
        Effect.map(parseWslRuntimeArchiveHash),
        Effect.orElseSucceed(() => null),
      )
    : null;
  if (hasArchive && archiveHash === null) {
    yield* Effect.logWarning(
      "Ignoring the WSL runtime archive because its SHA-256 identity is missing or invalid; launching from the mounted server tree instead.",
      { hashPath: archiveHashPath },
    );
  }

  const preflight = yield* runWslPreflight({
    distro: input.distro,
    runtimeArchive:
      archiveHash === null
        ? null
        : {
            windowsPath: archivePath,
            runtimeId: `sha256-${archiveHash}`,
            sha256: archiveHash,
          },
    // Packaged WSL runtimes must work without a compiler or network using the shipped Linux node-pty.
    // Only development builds may compile it; packaged probe failures must surface a diagnostic.
    allowBuild: !environment.isPackaged,
  });

  // Pin the preflight distro so a default change cannot race backend startup.
  const runningDistro = preflight._tag === "Ready" ? preflight.runningDistro : null;
  const distroForConfig = runningDistro ?? input.distro;

  const distroIp = yield* wslEnvironment.getDistroIp(distroForConfig);
  const usesSharedNetworkStack = Option.match(distroIp, {
    onNone: () => false,
    onSome: (ip) => isLocalHostIpv4(ip),
  });
  const rendererHost = usesSharedNetworkStack
    ? "127.0.0.1"
    : Option.getOrElse(distroIp, () => "127.0.0.1");
  const httpBaseUrl = new URL(`http://${rendererHost}:${input.port}`);

  const distroArgs = distroForConfig ? ["-d", distroForConfig] : [];
  const forwardedEnv: Record<string, string> = {};
  const forwardedEnvNames: string[] = [];
  for (const name of WSL_FORWARDED_ENV_NAMES) {
    const value = process.env[name];
    if (value !== undefined && value.length > 0) {
      forwardedEnv[name] = value;
      forwardedEnvNames.push(name);
    }
  }

  // Build an explicit copy of process.env minus both desktop home aliases
  // (dev-runner exports the Windows-side base dir for the primary; if either
  // leaks into the WSL backend the Linux side can resolve a Windows path via
  // /mnt/c, share the primary database, and collide on environment ids).
  const parentEnvWithoutDesktopHome: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key === "T3CODE_HOME" || key === "SCIENT_NEXT_HOME") continue;
    parentEnvWithoutDesktopHome[key] = value;
  }
  const wslEnv = mergeWslEnv(parentEnvWithoutDesktopHome.WSLENV, [
    ...WSL_CANDIDATE_ENV_NAMES,
    ...forwardedEnvNames,
  ]);

  const baseConfig = {
    executablePath: "wsl.exe",
    entryPath:
      preflight._tag === "Ready" ? preflight.windowsEntryPath : environment.backendEntryPath,
    cwd: environment.backendCwd,
    env: {
      ...parentEnvWithoutDesktopHome,
      ...backendChildEnvPatch(),
      ...forwardedEnv,
      ...scientAnalyticsMetadata(environment, process.env.SCIENT_ANALYTICS_ENABLED),
      // SCIENT-FORK:START — Scient WSL state directory and safety envelope.
      ...scientWslBackendEnv(environment),
      // SCIENT-FORK:END
      ...(wslEnv !== undefined ? { WSLENV: wslEnv } : {}),
    },
    // env excludes both desktop home aliases; merging process.env would restore them.
    extendEnv: false,
    bootstrap,
    bootstrapDelivery: "stdin" as const,
    httpBaseUrl,
    captureOutput: true,
    ...(runningDistro !== null ? { runningDistro } : {}),
  };

  // Explicit --dev-url keeps WSL state in dev/ rather than userdata/.
  const devUrlArgs = Option.match(environment.devServerUrl, {
    onNone: () => [] as ReadonlyArray<string>,
    onSome: (url) => ["--dev-url", url.href],
  });

  if (preflight._tag === "Failed") {
    const retryLimit =
      preflight.retryLimit ?? (preflight.fatal ? undefined : WSL_TRANSIENT_PREFLIGHT_RETRY_LIMIT);
    return {
      ...baseConfig,
      args: [...distroArgs, "--", "node", "--version"],
      preflightFailure: Option.some({
        reason: preflight.reason,
        fatal: preflight.fatal,
        ...(retryLimit === undefined ? {} : { retryLimit }),
      }),
    } satisfies DesktopBackendManager.DesktopBackendStartConfig;
  }

  // wsl.exe --exec omits the login-shell PATH needed to find provider CLIs and npm.
  // Pass dynamic values as separate argv entries to preserve quotes and reserve stdin for bootstrap.
  const lastSlash = preflight.nodePath.lastIndexOf("/");
  const nodeBinDir = lastSlash > 0 ? preflight.nodePath.slice(0, lastSlash) : "/usr/bin";
  const launchPath = `${nodeBinDir}:${WSL_SERVER_SYSTEM_PATH}:${preflight.resolvedPath}`;

  return {
    ...baseConfig,
    args: [
      ...distroArgs,
      "--exec",
      "env",
      `PATH=${launchPath}`,
      preflight.nodePath,
      preflight.linuxEntryPath,
      "--bootstrap-fd",
      "0",
      ...devUrlArgs,
    ],
    preflightFailure: Option.none(),
    ...(preflight.runtimeId === undefined ? {} : { wslRuntimeId: preflight.runtimeId }),
  } satisfies DesktopBackendManager.DesktopBackendStartConfig;
});

/** @public */
export const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const shellEnvironment = yield* DesktopShellEnvironment.DesktopShellEnvironment;
  const fileSystem = yield* FileSystem.FileSystem;
  const serverExposure = yield* DesktopServerExposure.DesktopServerExposure;
  const wslEnvironment = yield* DesktopWslEnvironment.DesktopWslEnvironment;
  const wslServerTree = yield* DesktopWslServerTree.DesktopWslServerTree;
  const settings = yield* DesktopAppSettings.DesktopAppSettings;
  const crypto = yield* Crypto.Crypto;
  // Random generation yields; serialize it so concurrent backends cannot capture distinct bootstrap secrets.
  const secretRef = yield* SynchronizedRef.make(Option.none<string>());
  const getOrCreateBootstrapSecret = SynchronizedRef.modifyEffect(secretRef, (current) =>
    Option.match(current, {
      onSome: (secret) => Effect.succeed([secret, current] as const),
      onNone: () =>
        crypto.randomBytes(32).pipe(
          Effect.map((bytes) => {
            const secret = Hex.encode(bytes);
            return [secret, Option.some(secret)] as const;
          }),
        ),
    }),
  );

  const sharedInputs = Effect.gen(function* () {
    const bootstrapSecret = yield* getOrCreateBootstrapSecret;
    const bootstrapToken = currentDesktopBootstrapToken(
      bootstrapSecret,
      yield* Clock.currentTimeMillis,
    );
    const observabilitySettings = yield* readBackendObservabilitySettings.pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(DesktopEnvironment.DesktopEnvironment, environment),
    );
    return {
      bootstrapToken,
      bootstrapSecret,
      observabilitySettings,
    } satisfies SharedBootstrapInput;
  });

  const buildWslPrimaryConfig = Effect.gen(function* () {
    const backendExposure = yield* serverExposure.backendConfig;
    const persistedSettings = yield* settings.get;
    const shared = yield* sharedInputs;
    yield* wslEnvironment.preWarm(persistedSettings.wslDistro);
    return yield* resolveWslStartConfig({
      ...shared,
      port: backendExposure.port,
      distro: persistedSettings.wslDistro,
    }).pipe(
      Effect.provideService(DesktopEnvironment.DesktopEnvironment, environment),
      Effect.provideService(DesktopWslEnvironment.DesktopWslEnvironment, wslEnvironment),
      Effect.provideService(DesktopWslServerTree.DesktopWslServerTree, wslServerTree),
      Effect.provideService(FileSystem.FileSystem, fileSystem),
    );
  });

  const buildWindowsPrimaryConfig = Effect.gen(function* () {
    const shared = yield* sharedInputs;
    const resourceMonitorPath = yield* resolveResourceMonitorPath().pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(DesktopEnvironment.DesktopEnvironment, environment),
    );
    const filePublicationHelperPath = yield* resolveFilePublicationHelperPath().pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(DesktopEnvironment.DesktopEnvironment, environment),
    );
    // SCIENT-FORK:START — the bundled SyncTeX navigator for LaTeX source navigation.
    const syncTexNavigatorPath = yield* resolveSyncTexNavigatorPath().pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(DesktopEnvironment.DesktopEnvironment, environment),
    );
    // SCIENT-FORK:END
    const cliPath = yield* DesktopCliShim.install.pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(DesktopEnvironment.DesktopEnvironment, environment),
    );
    const shellEnvironmentPrepared = yield* shellEnvironment.installIntoProcess;
    return yield* resolvePrimaryStartConfig({
      ...shared,
      resourceMonitorPath,
      filePublicationHelperPath,
      cliPath,
      shellEnvironmentPrepared,
      // SCIENT-FORK:START — the bundled SyncTeX navigator.
      syncTexNavigatorPath,
      // SCIENT-FORK:END
    }).pipe(
      Effect.provideService(DesktopEnvironment.DesktopEnvironment, environment),
      Effect.provideService(DesktopServerExposure.DesktopServerExposure, serverExposure),
    );
  });

  // Resolve on each restart so toggling wsl-only takes effect without recreating the pool.
  const describePrimary = Effect.gen(function* () {
    const persistedSettings = yield* settings.get;
    const wslRequested = persistedSettings.wslOnly && persistedSettings.wslBackendEnabled;
    // When WSL is unavailable its controls are hidden; fall back to Windows to keep recovery possible.
    const useWsl = wslRequested && (yield* wslEnvironment.isAvailable);
    return { useWsl, wslRequested, distro: persistedSettings.wslDistro };
  });

  const currentBootstrapToken = Effect.gen(function* () {
    const secret = yield* getOrCreateBootstrapSecret;
    return currentDesktopBootstrapToken(secret, yield* Clock.currentTimeMillis);
  });

  return DesktopBackendConfiguration.of({
    currentBootstrapToken,
    resolvePrimary: Effect.gen(function* () {
      const { useWsl, wslRequested } = yield* describePrimary;
      if (useWsl) {
        return yield* buildWslPrimaryConfig;
      }
      if (wslRequested) {
        yield* Effect.logWarning(
          "WSL-only backend requested but WSL is unavailable; starting the Windows primary instead.",
        );
      }
      return yield* buildWindowsPrimaryConfig;
    }).pipe(Effect.withSpan("desktop.backendConfiguration.resolvePrimary")),
    resolvePrimaryLabel: Effect.gen(function* () {
      const { useWsl, distro } = yield* describePrimary;
      if (!useWsl) {
        return environment.platform === "win32" ? "Windows" : "Local environment";
      }
      return distro ? `WSL (${distro})` : "WSL";
    }).pipe(Effect.withSpan("desktop.backendConfiguration.resolvePrimaryLabel")),
    // The span options depend on each request's port and distro.
    resolveWsl: Effect.fnUntraced(
      function* (input) {
        const shared = yield* sharedInputs;
        return yield* resolveWslStartConfig({ ...shared, ...input }).pipe(
          Effect.provideService(DesktopEnvironment.DesktopEnvironment, environment),
          Effect.provideService(DesktopWslEnvironment.DesktopWslEnvironment, wslEnvironment),
          Effect.provideService(DesktopWslServerTree.DesktopWslServerTree, wslServerTree),
          Effect.provideService(FileSystem.FileSystem, fileSystem),
        );
      },
      (effect, input) =>
        effect.pipe(
          Effect.withSpan("desktop.backendConfiguration.resolveWsl", {
            attributes: { port: input.port, distro: input.distro ?? null },
          }),
        ),
    ),
  });
});

export const layer = Layer.effect(DesktopBackendConfiguration, make);
