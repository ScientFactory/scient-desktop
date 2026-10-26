import { ClaudeSettings, ProviderDriverKind } from "@t3tools/contracts";
import * as Cache from "effect/Cache";
import * as Duration from "effect/Duration";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
// SCIENT-FORK:START — Scient Extensions: live-session provider-native inventory.
import * as PubSub from "effect/PubSub";
// SCIENT-FORK:END
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
// SCIENT-FORK:START — Scient Extensions: live-session provider-native inventory.
import * as Stream from "effect/Stream";
// SCIENT-FORK:END
import { HttpClient } from "effect/http";
import { ChildProcessSpawner } from "effect/process";

import { makeClaudeTextGeneration } from "../../textGeneration/ClaudeTextGeneration.ts";
import * as ProviderLatestVersions from "@t3tools/provider-core/server/ProviderLatestVersions";
import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import * as ServerConfig from "../../config.ts";
// SCIENT-FORK:START — assisted account flows and their capability-cache invalidation.
import {
  assistedClaudeConnectionMethods,
  makeClaudeInstanceConnectionActions,
} from "../../scient/providerLifecycle/ClaudeConnectionActions.ts";
export {
  assistedClaudeConnectionMethods,
  invalidateClaudeCapabilitiesAfterAccountChange,
} from "../../scient/providerLifecycle/ClaudeConnectionActions.ts";
// SCIENT-FORK:END
import { makeClaudeManagedRuntimeResolution } from "../../scient/providerLifecycle/ClaudeManagedRuntimeActions.ts";
import { makeClaudeVoiceTranscriptCorrection } from "../../scient/voice/ClaudeVoiceTranscriptCorrection.ts";
import type { ScientProviderDriver, ScientProviderInstance } from "../ScientProviderInstance.ts";
// SCIENT-FORK:START — Scient Extensions: live-session provider-native inventory.
import {
  makeClaudeAccountInventoryRefresh,
  probeClaudeAccountServers,
} from "../../scient/extensions/ClaudeAccountInventory.ts";
import * as Deferred from "effect/Deferred";
import type { ProviderPluginActions } from "../ScientProviderInstanceSeams.ts";
import type { ProviderNativeInventory } from "../ScientProviderInstanceSeams.ts";
// SCIENT-FORK:END
import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import {
  createClaudeAdapterV2,
  type ClaudeAdapterV2DriverEnv,
} from "../../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import { ProviderDriverError } from "@t3tools/provider-core/server/errors";
import { claudeUsageReader } from "./claudeUsage.ts";
import { makeClaudeScopedLimitNames } from "../claudeUsageLimits.ts";
import * as ClaudeResetCredits from "../claudeResetCredits.ts";
import * as ResetCreditCoordinator from "../resetCreditCoordinator.ts";
import {
  checkClaudeProviderStatus,
  makePendingClaudeProvider,
  probeClaudeCapabilities,
  probeClaudeWorkspaceSnapshot,
  type ClaudeCapabilitiesProbe,
} from "../ClaudeProvider.ts";
import { makeManagedServerProvider } from "@t3tools/provider-core/server/managedProvider";
import * as ModelCatalog from "@t3tools/provider-core/server/ModelCatalog";
import { resolveClaudeModelCatalog } from "../ClaudeModelCatalog.ts";
import {
  defaultProviderContinuationIdentity,
  type ProviderInstance,
} from "@t3tools/provider-core/server/driver";
// SCIENT-FORK:START — identity stamp carries assisted connection and runtime state.
import { withConnectionInstanceIdentity } from "./scientInstanceIdentity.ts";
// SCIENT-FORK:END
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import {
  enrichProviderSnapshotWithVersionAdvisory,
  makeManualOnlyProviderMaintenanceCapabilities,
  makeCachedProviderMaintenanceResolution,
  makePackageManagedProviderMaintenanceResolver,
  normalizeCommandPath,
  resolveProviderMaintenanceCapabilitiesEffect,
} from "@t3tools/provider-core/server/maintenanceResolver";
import {
  haveProviderSnapshotSettingsChanged,
  makeProviderSnapshotSettingsSource,
  type ProviderSnapshotSettings,
} from "@t3tools/provider-core/server/snapshotSettings";
import {
  makeClaudeCapabilitiesCacheKey,
  makeClaudeContinuationGroupKey,
  resolveClaudeHomePath,
} from "./ClaudeHome.ts";
import { setClaudeSkillEnabled } from "./ClaudeSkills.ts";
import * as HostProcess from "@t3tools/shared/HostProcess";
const decodeClaudeSettings = Schema.decodeSync(ClaudeSettings);

const DRIVER_KIND = ProviderDriverKind.make("claudeAgent");
const CAPABILITIES_PROBE_TTL = Duration.minutes(5);

const withoutUsage = (capabilities: ClaudeCapabilitiesProbe): ClaudeCapabilitiesProbe => {
  const result = { ...capabilities };
  delete result.usage;
  return result;
};

function isClaudeNativeCommandPath(commandPath: string): boolean {
  const normalized = normalizeCommandPath(commandPath);
  return (
    normalized.endsWith("/.local/bin/claude") ||
    normalized.endsWith("/.local/bin/claude.exe") ||
    normalized.includes("/.local/share/claude/")
  );
}

const UPDATE = makePackageManagedProviderMaintenanceResolver({
  provider: DRIVER_KIND,
  npmPackageName: "@anthropic-ai/claude-code",
  nativeUpdate: {
    args: ["update"],
    isCommandPath: isClaudeNativeCommandPath,
  },
});

export type ClaudeDriverEnv =
  | ClaudeAdapterV2DriverEnv
  | ProviderHost.ProviderHost
  | ChildProcessSpawner.ChildProcessSpawner
  | ResetCreditCoordinator.ResetCreditCoordinator
  | Crypto.Crypto
  | FileSystem.FileSystem
  | HttpClient.HttpClient
  | ProviderLatestVersions.ProviderLatestVersions
  | ModelCatalog.ModelCatalog
  | Path.Path
  | ServerConfig.ServerConfig;

export const ClaudeDriver: ScientProviderDriver<ClaudeSettings, ClaudeDriverEnv, Path.Path> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: "Claude",
    supportsMultipleInstances: true,
  },
  configSchema: ClaudeSettings,
  defaultConfig: (): ClaudeSettings => decodeClaudeSettings({}),
  usage: claudeUsageReader,
  create: Effect.fn("ClaudeDriver.create")(function* ({
    instanceId,
    displayName,
    accentColor,
    environment,
    enabled,
    config,
  }) {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    // Instance-level probes are not tied to a project, so they run in the
    // server's own state dir. The server cwd is $HOME in packaged desktop
    // builds, and `claude` wrappers that scope themselves to their cwd refuse
    // to run there. Workspace probes use the thread cwd via `snapshotForCwd`.
    const serverConfig = yield* ServerConfig.ServerConfig;
    const httpClient = yield* HttpClient.HttpClient;
    const latestVersions = yield* ProviderLatestVersions.ProviderLatestVersions;
    const resetCreditCoordinator = yield* ResetCreditCoordinator.ResetCreditCoordinator;
    const catalogService = yield* ModelCatalog.ModelCatalog;
    const modelCatalog = catalogService
      .current(DRIVER_KIND)
      .pipe(Effect.map(resolveClaudeModelCatalog));
    const processEnv = yield* mergeProviderInstanceEnvironment(environment);
    const fallbackContinuationIdentity = defaultProviderContinuationIdentity({
      driverKind: DRIVER_KIND,
      instanceId,
    });
    const managedRuntime = yield* makeClaudeManagedRuntimeResolution({
      settings: config,
      baseDir: serverConfig.baseDir,
      environment: processEnv,
      spawner,
      managedInstallationAllowed: serverConfig.mode === "desktop",
    });
    const effectiveConfig = {
      ...config,
      enabled,
      binaryPath: expandHomePath(
        managedRuntime.effectiveBinaryPath,
        yield* HostProcess.HomeDirectory,
      ),
    } satisfies ClaudeSettings;
    const effectiveProcessEnv = managedRuntime.usesManagedPath
      ? { ...processEnv, DISABLE_UPDATES: "1" }
      : processEnv;
    const connectionMethods = assistedClaudeConnectionMethods(effectiveProcessEnv);
    const resolveMaintenance = yield* makeCachedProviderMaintenanceResolution(
      (managedRuntime.usesManagedPath
        ? Effect.succeed(
            makeManualOnlyProviderMaintenanceCapabilities({
              provider: DRIVER_KIND,
              packageName: null,
            }),
          )
        : resolveProviderMaintenanceCapabilitiesEffect(UPDATE, {
            binaryPath: effectiveConfig.binaryPath,
            env: effectiveProcessEnv,
          })
      ).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
      ),
    );
    const continuationGroupKey = yield* makeClaudeContinuationGroupKey(effectiveConfig, processEnv);
    const configDir = yield* resolveClaudeHomePath(effectiveConfig, processEnv);
    const accountConfigPath = yield* ClaudeResetCredits.claudeAccountConfigPath(
      effectiveConfig.homePath.trim() || processEnv.CLAUDE_CONFIG_DIR?.trim()
        ? configDir
        : undefined,
    );
    const stampIdentity = withConnectionInstanceIdentity({
      instanceId,
      driverKind: DRIVER_KIND,
      displayName,
      accentColor,
      continuationGroupKey,
      runtime: managedRuntime.summary,
      connectionMethods,
    });

    const scopedLimitNames = yield* makeClaudeScopedLimitNames;
    // SCIENT-FORK:START — Scient Extensions: plugins and MCP servers Claude reports in each live
    // session's `system/init` and turn end, published by the provider registry.
    const nativeInventory = yield* Effect.acquireRelease(
      PubSub.unbounded<ProviderNativeInventory>({ replay: 1 }),
      PubSub.shutdown,
    );
    const inventoryState = yield* Ref.make<ProviderNativeInventory>({});
    const publishInventory = (incoming: ProviderNativeInventory, accountOnly = false) =>
      Ref.updateAndGet(inventoryState, (current) => ({
        ...current,
        ...incoming,
        ...(incoming.mcpServers
          ? {
              mcpServers: [
                ...(current.mcpServers ?? []).filter((server) =>
                  accountOnly
                    ? server.scope !== "claudeai"
                    : server.scope === "claudeai" &&
                      !incoming.mcpServers?.some((entry) => entry.scope === "claudeai"),
                ),
                ...incoming.mcpServers,
              ],
            }
          : {}),
      })).pipe(
        Effect.flatMap((report) => PubSub.publish(nativeInventory, report)),
        Effect.asVoid,
      );
    // SCIENT-FORK:END
    const orchestrationAdapter = yield* createClaudeAdapterV2(
      {
        instanceId,
        displayName,
        accentColor,
        environment: managedRuntime.usesManagedPath
          ? [...environment, { name: "DISABLE_UPDATES", value: "1", sensitive: false }]
          : environment,
        enabled,
        config: effectiveConfig,
      },
      // SCIENT-FORK:START — Scient Extensions: live-session provider-native inventory.
      {
        scopedLimitNames,
        onUsageLimits: (update) => snapshot.applyUsageLimits(update),
        onNativeInventory: (inventory) => publishInventory(inventory),
      },
      // SCIENT-FORK:END
    ).pipe(
      Effect.mapError(
        (cause) =>
          new ProviderDriverError({
            driver: DRIVER_KIND,
            instanceId,
            detail: "Failed to build Claude orchestration adapter.",
            cause,
          }),
      ),
    );
    const textGeneration = yield* makeClaudeTextGeneration(
      effectiveConfig,
      effectiveProcessEnv,
      modelCatalog,
    );
    const voiceTranscriptCorrection = yield* makeClaudeVoiceTranscriptCorrection(
      effectiveConfig,
      effectiveProcessEnv,
      modelCatalog,
    );
    // Per-instance capabilities cache: keyed on binary + resolved HOME so
    // account-specific probes never share auth metadata across instances.
    // A transient miss may reuse the last account once, but its usage windows keep their age.
    const lastGoodCapabilities = yield* Ref.make<ClaudeCapabilitiesProbe | undefined>(undefined);
    // SCIENT-FORK:START — account connectors are probed only by Extensions, never health refreshes.
    const retired = yield* Deferred.make<void>();
    yield* Effect.addFinalizer(() => Deferred.succeed(retired, undefined));
    const refreshInventory = yield* makeClaudeAccountInventoryRefresh(
      Ref.get(lastGoodCapabilities),
      probeClaudeAccountServers(effectiveConfig, effectiveProcessEnv, serverConfig.stateDir).pipe(
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
      ),
      (mcpServers) => publishInventory({ mcpServers }, true),
    );
    const unsupported = Effect.fail({ message: "Claude manages this operation itself." });
    const pluginActions: ProviderPluginActions = {
      refreshInventory,
      listPlugins: () => unsupported,
      readMcpServer: () => unsupported,
      uninstall: () => unsupported,
      startMcpSignIn: () => unsupported,
      isRetired: Deferred.isDone(retired),
      whenRetired: Deferred.await(retired),
    };
    // SCIENT-FORK:END
    const capabilitiesProbeCache = yield* Cache.makeWith(
      () =>
        probeClaudeCapabilities(effectiveConfig, effectiveProcessEnv, serverConfig.stateDir).pipe(
          Effect.flatMap((capabilities) =>
            ClaudeResetCredits.readClaudeOrganizationId(accountConfigPath).pipe(
              Effect.map((workspaceId) => ({
                _tag: "fresh" as const,
                capabilities:
                  workspaceId === undefined ? capabilities : { ...capabilities, workspaceId },
              })),
            ),
          ),
          Effect.tap(({ capabilities }) => Ref.set(lastGoodCapabilities, capabilities)),
          Effect.catch((error) =>
            Ref.getAndSet(lastGoodCapabilities, undefined).pipe(
              Effect.flatMap((capabilities) =>
                capabilities === undefined
                  ? Effect.fail(error)
                  : ClaudeResetCredits.readClaudeOrganizationId(accountConfigPath).pipe(
                      Effect.flatMap((workspaceId) =>
                        workspaceId === capabilities.workspaceId
                          ? Effect.succeed({
                              _tag: "fallback" as const,
                              capabilities: withoutUsage(capabilities),
                            })
                          : Effect.fail(error),
                      ),
                    ),
              ),
            ),
          ),
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.provideService(Path.Path, path),
        ),
      {
        capacity: 1,
        timeToLive: (exit) =>
          // Only fresh usage earns the TTL; failures, fallbacks and usage-less probes retry.
          Exit.isSuccess(exit) &&
          exit.value._tag === "fresh" &&
          exit.value.capabilities.usage !== undefined
            ? CAPABILITIES_PROBE_TTL
            : Duration.zero,
      },
    );
    const capabilitiesCacheKey = yield* makeClaudeCapabilitiesCacheKey(
      effectiveConfig,
      serverConfig.stateDir,
      effectiveProcessEnv,
    );
    const connectionActions = yield* makeClaudeInstanceConnectionActions({
      connectionMethods,
      settings: effectiveConfig,
      environment: effectiveProcessEnv,
      spawner,
      invalidateCapabilities: Cache.invalidate(capabilitiesProbeCache, capabilitiesCacheKey),
    });
    const resolveCapabilities = Cache.get(capabilitiesProbeCache, capabilitiesCacheKey).pipe(
      Effect.map((result) => result.capabilities),
    );

    const checkProvider = catalogService.refreshInBackground.pipe(
      Effect.andThen(
        modelCatalog.pipe(
          Effect.flatMap((catalog) =>
            checkClaudeProviderStatus(
              effectiveConfig,
              () => resolveCapabilities,
              effectiveProcessEnv,
              serverConfig.stateDir,
              catalog,
              scopedLimitNames,
              (version) =>
                ClaudeResetCredits.readClaudeResetCredits(configDir, version).pipe(
                  Effect.provideService(HttpClient.HttpClient, httpClient),
                  Effect.provideService(FileSystem.FileSystem, fileSystem),
                  Effect.provideService(Path.Path, path),
                ),
            ),
          ),
          Effect.tap((provider) =>
            provider.auth.status === "unauthenticated"
              ? Cache.invalidateAll(capabilitiesProbeCache)
              : Effect.void,
          ),
          // SCIENT-FORK:START — account app access requires verified first-party subscription auth.
          Effect.flatMap((provider) =>
            Ref.get(lastGoodCapabilities).pipe(
              Effect.map((account) => ({
                ...provider,
                accountAppsAvailable:
                  provider.auth.status === "authenticated" &&
                  account?.apiProvider === "firstParty" &&
                  Boolean(account.subscriptionType),
              })),
            ),
          ),
          // SCIENT-FORK:END
          Effect.map(stampIdentity),
        ),
      ),
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
    );

    const snapshotSettings = yield* makeProviderSnapshotSettingsSource(effectiveConfig);
    const snapshot = yield* makeManagedServerProvider<ProviderSnapshotSettings<ClaudeSettings>>({
      resolveMaintenance,
      getSettings: snapshotSettings.getSettings,
      streamSettings: snapshotSettings.streamSettings,
      haveSettingsChanged: haveProviderSnapshotSettingsChanged,
      initialSnapshot: (settings) =>
        modelCatalog.pipe(
          Effect.flatMap((catalog) => makePendingClaudeProvider(settings.provider, catalog)),
          Effect.map(stampIdentity),
        ),
      checkProvider,
      enrichSnapshot: ({ settings, snapshot, publishSnapshot }) =>
        resolveMaintenance().pipe(
          Effect.flatMap((maintenanceCapabilities) =>
            enrichProviderSnapshotWithVersionAdvisory(snapshot, maintenanceCapabilities, {
              enableProviderUpdateChecks: settings.enableProviderUpdateChecks,
            }),
          ),
          Effect.provideService(HttpClient.HttpClient, httpClient),
          Effect.provideService(ProviderLatestVersions.ProviderLatestVersions, latestVersions),
          Effect.flatMap((enrichedSnapshot) => publishSnapshot(enrichedSnapshot)),
        ),
    }).pipe(
      Effect.mapError(
        (cause) =>
          new ProviderDriverError({
            driver: DRIVER_KIND,
            instanceId,
            detail: `Failed to build Claude snapshot: ${cause.message ?? String(cause)}`,
            cause,
          }),
      ),
    );
    const skillActions = {
      setEnabled: (skill: {
        readonly name: string;
        readonly path: string;
        readonly scope?: string | undefined;
        readonly enabled: boolean;
      }) =>
        setClaudeSkillEnabled({
          config: effectiveConfig,
          environment: processEnv,
          cwd: serverConfig.cwd,
          name: skill.name,
          scope: skill.scope,
          enabled: skill.enabled,
        }).pipe(
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.provideService(Path.Path, path),
          Effect.mapError((cause) => ({ message: cause.detail, cause })),
        ),
    };

    // Same rules as Codex: serialised on the config directory that holds the
    // login, one request id kept until Claude answers (a cooldown or rate
    // limit is an answer), then a re-probe.
    const consumeResetCredit: NonNullable<ProviderInstance["consumeResetCredit"]> = Effect.fn(
      "ClaudeDriver.consumeResetCredit",
    )(
      function* () {
        const current = yield* snapshot.getSnapshot;
        const grantId = current.usageLimits?.resetCredits?.nextCreditId;
        if (!grantId || !current.version) return "noCredit" as const;
        const version = current.version;
        return yield* resetCreditCoordinator.redeem(
          configDir,
          (requestId) =>
            ClaudeResetCredits.consumeClaudeResetCredit({
              configDir,
              accountConfigPath,
              version,
              grantId,
              requestId,
            }),
          ClaudeResetCredits.isSettledClaudeResetCreditFailure,
        );
      },
      Effect.provideService(HttpClient.HttpClient, httpClient),
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
      Effect.mapError(
        (cause) =>
          new ProviderDriverError({
            driver: DRIVER_KIND,
            instanceId,
            detail:
              cause._tag === "ClaudeResetCreditError"
                ? cause.message
                : "Claude could not redeem the reset.",
            cause,
          }),
      ),
      Effect.tap((outcome) =>
        Effect.gen(function* () {
          const before = (yield* snapshot.getSnapshot).usageLimits?.checkedAt;
          yield* Cache.invalidateAll(capabilitiesProbeCache);
          const refreshed = yield* snapshot.refresh;
          const after = refreshed.usageLimits?.checkedAt;
          if (
            outcome === "reset" &&
            (after === undefined ||
              after === before ||
              refreshed.usageLimits?.unavailable?.reason === "probeFailed")
          ) {
            return yield* new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              detail:
                "The reset was applied, but Claude could not confirm the new limits. Refresh to check.",
            });
          }
        }),
      ),
    );

    return {
      instanceId,
      driverKind: DRIVER_KIND,
      continuationIdentity: {
        ...fallbackContinuationIdentity,
        continuationKey: continuationGroupKey,
      },
      displayName,
      accentColor,
      enabled,
      snapshot,
      invalidateCaches: Cache.invalidateAll(capabilitiesProbeCache),
      snapshotForCwd: (cwd: string) =>
        !effectiveConfig.enabled
          ? snapshot.getSnapshot
          : snapshot.getSnapshot.pipe(
              Effect.flatMap((machineSnapshot) =>
                probeClaudeWorkspaceSnapshot(effectiveConfig, machineSnapshot, cwd, processEnv),
              ),
              Effect.provideService(FileSystem.FileSystem, fileSystem),
              Effect.provideService(Path.Path, path),
            ),
      skillActions,
      // SCIENT-FORK:START — Scient Extensions: live-session provider-native inventory.
      pluginActions,
      nativeInventoryChanges: Stream.fromPubSub(nativeInventory),
      // SCIENT-FORK:END
      orchestrationAdapter,
      textGeneration,
      voiceTranscriptCorrection,
      ...(connectionActions ? { connectionActions } : {}),
      managedRuntimeActions: managedRuntime.actions,
      consumeResetCredit,
    } satisfies ScientProviderInstance;
  }),
};
