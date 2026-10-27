import { CodexSettings, ProviderDriverKind, type ServerProvider } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { HttpClient } from "effect/http";
import { ChildProcessSpawner } from "effect/process";

import type * as CodexUsageHistory from "../../usage/CodexUsageHistory.ts";
import { makeCodexTextGeneration } from "../../textGeneration/CodexTextGeneration.ts";
import * as ProviderLatestVersions from "@t3tools/provider-core/server/ProviderLatestVersions";
import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import * as ServerConfig from "../../config.ts";
import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import {
  createCodexAdapterV2,
  type CodexAdapterV2DriverEnv,
} from "../../orchestration-v2/Adapters/CodexAdapterV2.ts";
import { ProviderDriverError } from "@t3tools/provider-core/server/errors";
import * as ResetCreditCoordinator from "../resetCreditCoordinator.ts";
import { resolveCodexLaunchArgs } from "../codexLaunchArgs.ts";
import {
  checkCodexProviderStatus,
  makePendingCodexProvider,
  probeCodexSkillsForCwd,
  setCodexSkillEnabled,
  withCodexAppServerClient,
} from "../CodexProvider.ts";
// SCIENT-FORK:START — Scient Extensions: provider-native plugin and MCP server management.
import { makeCodexNativeInventory } from "../CodexPluginInventory.ts";
// SCIENT-FORK:END
import { makeManagedServerProvider } from "@t3tools/provider-core/server/managedProvider";
import * as ModelCatalog from "@t3tools/provider-core/server/ModelCatalog";
import { applyCodexModelCatalog } from "../codexModelCatalog.ts";
import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import type { ServerProviderDraft } from "@t3tools/provider-core/server/snapshotProbe";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import { makeCodexConnectionActions } from "../../scient/providerLifecycle/CodexConnectionActions.ts";
import {
  isStandInForManagedCodex,
  makeCodexManagedRuntimeResolution,
} from "../../scient/providerLifecycle/CodexManagedRuntimeActions.ts";
import { makeCodexVoiceTranscriptCorrection } from "../../scient/voice/CodexVoiceTranscriptCorrection.ts";
import type { ScientProviderDriver, ScientProviderInstance } from "../ScientProviderInstance.ts";
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
  codexContinuationIdentity,
  materializeCodexShadowHome,
  resolveCodexHomeLayout,
} from "./CodexHomeLayout.ts";
import { CODEX_SUBSCRIPTION_SHARING_UNAVAILABLE } from "../../scient/providerLifecycle/codexSubscriptionSharingPolicy.ts";

import { codexUsageReader } from "./codexUsage.ts";
import * as CodexInstallation from "../CodexInstallation.ts";
import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import * as HostProcess from "@t3tools/shared/HostProcess";
const decodeCodexSettings = Schema.decodeSync(CodexSettings);

const DRIVER_KIND = ProviderDriverKind.make("codex");
function isCodexStandaloneCommandPath(commandPath: string): boolean {
  return normalizeCommandPath(commandPath).includes("/packages/standalone/");
}

/** `codex update` owns the shared home's standalone tree; auth-overlay homes do not carry it. */
function makeCodexMaintenanceResolver(sharedHomePath: string) {
  return makePackageManagedProviderMaintenanceResolver({
    provider: DRIVER_KIND,
    npmPackageName: "@openai/codex",
    nativeUpdate: {
      args: ["update"],
      isCommandPath: isCodexStandaloneCommandPath,
      requiresCommandPath: true,
      env: { CODEX_HOME: sharedHomePath },
    },
  });
}

export type CodexDriverEnv =
  | CodexAdapterV2DriverEnv
  | ProviderHost.ProviderHost
  | ChildProcessSpawner.ChildProcessSpawner
  | ResetCreditCoordinator.ResetCreditCoordinator
  | Crypto.Crypto
  | FileSystem.FileSystem
  | HttpClient.HttpClient
  | ProviderLatestVersions.ProviderLatestVersions
  | ModelCatalog.ModelCatalog
  | Path.Path
  | ServerConfig.ServerConfig
  | ServerSecretStore.ServerSecretStore
  | ServerEnvironment.ServerEnvironmentIdentity
  | CodexInstallation.CodexInstallation;

/**
 * Stamp instance identity onto a `ServerProvider` snapshot produced by the
 * driver-kind-only codex helpers. Once `buildServerProvider` in
 * `providerSnapshot.ts` is widened to accept `instanceId`/`driver`, this
 * wrapper disappears.
 */
const withInstanceIdentity =
  (input: {
    readonly instanceId: ProviderInstance["instanceId"];
    readonly displayName: string | undefined;
    readonly accentColor: string | undefined;
    readonly continuationGroupKey: string;
    readonly runtime: NonNullable<NonNullable<ServerProvider["connection"]>["runtime"]>;
  }) =>
  (snapshot: ServerProviderDraft): ServerProvider => ({
    ...snapshot,
    instanceId: input.instanceId,
    driver: DRIVER_KIND,
    ...(input.displayName ? { displayName: input.displayName } : {}),
    ...(input.accentColor ? { accentColor: input.accentColor } : {}),
    continuation: { groupKey: input.continuationGroupKey },
    skills: snapshot.skills.map((skill) => ({ ...skill, canSetEnabled: true })),
    connection: {
      methods: snapshot.auth.required === false ? [] : ["codex_browser", "codex_device_code"],
      canDisconnect: snapshot.auth.required !== false && snapshot.auth.status === "authenticated",
      operation: null,
      runtime: input.runtime,
    },
  });
export const CodexDriver: ScientProviderDriver<
  CodexSettings,
  CodexDriverEnv,
  Path.Path | CodexUsageHistory.CodexUsageHistory
> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: "Codex",
    supportsMultipleInstances: true,
  },
  configSchema: CodexSettings,
  defaultConfig: (): CodexSettings => decodeCodexSettings({}),
  usage: codexUsageReader,
  create: Effect.fn("CodexDriver.create")(function* ({
    instanceId,
    displayName,
    accentColor,
    environment,
    enabled,
    config,
  }) {
    // SCIENT-FORK:START — native Codex owns credentials; subscription sharing is dormant.
    if (config.setupMode === "managed")
      return yield* new ProviderDriverError({
        driver: DRIVER_KIND,
        instanceId,
        detail: CODEX_SUBSCRIPTION_SHARING_UNAVAILABLE,
      });
    // SCIENT-FORK:END
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const serverConfig = yield* ServerConfig.ServerConfig;
    const resetCreditCoordinator = yield* ResetCreditCoordinator.ResetCreditCoordinator;
    const fileSystem = yield* FileSystem.FileSystem;
    const pathService = yield* Path.Path;
    const httpClient = yield* HttpClient.HttpClient;
    const latestVersions = yield* ProviderLatestVersions.ProviderLatestVersions;
    const modelCatalog = yield* ModelCatalog.ModelCatalog;
    const currentCatalog = modelCatalog.current(DRIVER_KIND);
    const processEnv = yield* mergeProviderInstanceEnvironment(environment);
    const homeLayout = yield* resolveCodexHomeLayout(config);
    const continuationIdentity = codexContinuationIdentity(homeLayout);
    yield* materializeCodexShadowHome(homeLayout).pipe(
      Effect.mapError(
        (cause) =>
          new ProviderDriverError({
            driver: DRIVER_KIND,
            instanceId,
            detail: cause.message,
            cause,
          }),
      ),
    );
    const managedRuntime = yield* makeCodexManagedRuntimeResolution({
      settings: config,
      baseDir: serverConfig.baseDir,
      cwd: serverConfig.cwd,
      effectiveHomePath: homeLayout.effectiveHomePath,
      environment: processEnv,
      spawner,
      managedInstallationAllowed: serverConfig.mode === "desktop",
    });
    const stampIdentity = withInstanceIdentity({
      instanceId,
      displayName,
      accentColor,
      continuationGroupKey: continuationIdentity.continuationKey,
      runtime: managedRuntime.summary,
    });
    const effectiveConfig = {
      ...config,
      enabled,
      binaryPath: expandHomePath(
        managedRuntime.effectiveBinaryPath,
        yield* HostProcess.HomeDirectory,
      ),
      homePath: homeLayout.effectiveHomePath ?? "",
    } satisfies CodexSettings;
    const resolveMaintenance = yield* makeCachedProviderMaintenanceResolution(
      (managedRuntime.usesManagedPath || isStandInForManagedCodex(managedRuntime.summary)
        ? Effect.succeed(
            makeManualOnlyProviderMaintenanceCapabilities({
              provider: DRIVER_KIND,
              packageName: null,
            }),
          )
        : resolveProviderMaintenanceCapabilitiesEffect(
            makeCodexMaintenanceResolver(homeLayout.sharedHomePath),
            {
              binaryPath: effectiveConfig.binaryPath,
              env: processEnv,
            },
          )
      ).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, pathService),
      ),
    );

    const voiceTranscriptCorrection = yield* makeCodexVoiceTranscriptCorrection(
      effectiveConfig,
      processEnv,
    );
    const connectionActions = makeCodexConnectionActions(
      effectiveConfig,
      serverConfig.cwd,
      processEnv,
      spawner,
    );
    const skillActions = {
      setEnabled: (skill: {
        readonly name: string;
        readonly path: string;
        readonly enabled: boolean;
      }) =>
        setCodexSkillEnabled({
          binaryPath: effectiveConfig.binaryPath,
          ...(effectiveConfig.homePath ? { homePath: effectiveConfig.homePath } : {}),
          launchArgs: resolveCodexLaunchArgs(effectiveConfig.launchArgs, processEnv),
          cwd: serverConfig.cwd,
          environment: processEnv,
          ...skill,
        }).pipe(
          Effect.scoped,
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Effect.mapError((cause) => ({
            message: `Codex could not ${skill.enabled ? "enable" : "disable"} '${skill.name}'.`,
            cause,
          })),
        ),
    };
    // SCIENT-FORK:START — Scient Extensions: provider-native plugins and MCP servers: bounded
    // enrichment and generation-bound actions, owned by this instance.
    const nativeInventory = yield* makeCodexNativeInventory(
      (cwd) =>
        withCodexAppServerClient({
          binaryPath: effectiveConfig.binaryPath,
          homePath: effectiveConfig.homePath,
          launchArgs: resolveCodexLaunchArgs(effectiveConfig.launchArgs, processEnv),
          cwd: cwd ?? serverConfig.cwd,
          environment: processEnv,
        }).pipe(
          Effect.map(({ client }) => client),
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        ),
      pathService.join(homeLayout.sharedHomePath, "plugins", "cache"),
    );
    // SCIENT-FORK:END

    const orchestrationAdapter = yield* createCodexAdapterV2(
      {
        instanceId,
        displayName,
        accentColor,
        environment,
        enabled,
        // The native factory resolves the shared/auth-overlay home itself.
        config: { ...config, binaryPath: effectiveConfig.binaryPath },
      },
      { onUsageLimits: (update) => snapshot.applyUsageLimits(update) },
    ).pipe(
      Effect.mapError(
        (cause) =>
          new ProviderDriverError({
            driver: DRIVER_KIND,
            instanceId,
            detail: "Failed to build Codex orchestration adapter.",
            cause,
          }),
      ),
    );

    // Kick the TTL-gated manifest refresh in the background and classify with the in-memory
    // manifest, so a slow or hung fetch never delays the provider check.
    const checkProvider = modelCatalog.refreshInBackground.pipe(
      Effect.andThen(
        Effect.zipWith(
          checkCodexProviderStatus(effectiveConfig, undefined, processEnv),
          currentCatalog,
          (draft, catalog) => stampIdentity(applyCodexModelCatalog(draft, catalog)),
          { concurrent: true },
        ),
      ),
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, pathService),
    );
    const snapshotSettings = yield* makeProviderSnapshotSettingsSource(effectiveConfig);
    const snapshot = yield* makeManagedServerProvider<ProviderSnapshotSettings<CodexSettings>>({
      resolveMaintenance,
      getSettings: snapshotSettings.getSettings,
      streamSettings: snapshotSettings.streamSettings,
      haveSettingsChanged: haveProviderSnapshotSettingsChanged,
      initialSnapshot: (settings) =>
        Effect.zipWith(
          makePendingCodexProvider(settings.provider),
          currentCatalog,
          (draft, catalog) => stampIdentity(applyCodexModelCatalog(draft, catalog)),
        ),
      checkProvider,
      // SCIENT-FORK:START — Scient Extensions: beside the version advisory, the machine inventory is
      // listed after each healthy probe, off its path; a failed probe keeps the
      // last inventory without another spawn.
      enrichSnapshot: ({ settings, snapshot, publishSnapshot }) =>
        Effect.all(
          [
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
            snapshot.installed && snapshot.status !== "error"
              ? nativeInventory.refresh
              : Effect.void,
          ],
          { concurrency: "unbounded", discard: true },
        ),
      // SCIENT-FORK:END
    }).pipe(
      Effect.mapError(
        (cause) =>
          new ProviderDriverError({
            driver: DRIVER_KIND,
            instanceId,
            detail: `Failed to build Codex snapshot: ${cause.message ?? String(cause)}`,
            cause,
          }),
      ),
    );
    const textGeneration = yield* makeCodexTextGeneration(
      effectiveConfig,
      processEnv,
      snapshot.getSnapshot.pipe(Effect.map((value) => value.models)),
    );
    const snapshotForCwd = (cwd: string) =>
      !effectiveConfig.enabled
        ? snapshot.getSnapshot
        : Effect.all([
            snapshot.getSnapshot,
            probeCodexSkillsForCwd({
              binaryPath: effectiveConfig.binaryPath,
              homePath: effectiveConfig.homePath,
              launchArgs: resolveCodexLaunchArgs(effectiveConfig.launchArgs, processEnv),
              cwd,
              environment: processEnv,
            }).pipe(
              Effect.scoped,
              Effect.timeout("20 seconds"),
              Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
            ),
          ]).pipe(
            Effect.map(([machineSnapshot, skills]) => ({ ...machineSnapshot, skills })),
            Effect.mapError(
              (cause) =>
                new ProviderDriverError({
                  driver: DRIVER_KIND,
                  instanceId,
                  detail: `Failed to probe Codex skills for '${cwd}'`,
                  cause,
                }),
            ),
          );

    // Redemption spends account credit; serialize by the auth.json directory, keep one idempotency key
    // until the outcome, and bound the wait so a hung app-server cannot hold the account lock.
    // Auth overlays use effectiveHomePath; the continuation key would conflate them with shared homes.
    const accountKey = homeLayout.effectiveHomePath ?? homeLayout.sharedHomePath;
    const consumeResetCredit: NonNullable<ProviderInstance["consumeResetCredit"]> = () =>
      resetCreditCoordinator
        .redeem(accountKey, (idempotencyKey) =>
          Effect.gen(function* () {
            const { client } = yield* withCodexAppServerClient({
              binaryPath: effectiveConfig.binaryPath,
              homePath: effectiveConfig.homePath,
              launchArgs: resolveCodexLaunchArgs(effectiveConfig.launchArgs, processEnv),
              cwd: process.cwd(),
              environment: processEnv,
            });
            const response = yield* client.request("account/rateLimitResetCredit/consume", {
              idempotencyKey,
            });
            return response.outcome;
          }).pipe(Effect.scoped, Effect.timeout("20 seconds")),
        )
        .pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Effect.mapError(
            (cause) =>
              new ProviderDriverError({
                driver: DRIVER_KIND,
                instanceId,
                detail: "Codex could not redeem the reset credit.",
                cause,
              }),
          ),
          // The windows just changed; re-probe so the snapshot says so. A
          // failed probe republishes the pre-redemption limits rather than
          // marking them failed, so "confirmed" means `checkedAt` moved past
          // what was published before the redemption started.
          Effect.tap((outcome) =>
            Effect.gen(function* () {
              const before = (yield* snapshot.getSnapshot).usageLimits?.checkedAt;
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
                    "The reset was applied, but Codex could not confirm the new limits. Refresh to check.",
                });
              }
            }),
          ),
        );

    return {
      instanceId,
      driverKind: DRIVER_KIND,
      continuationIdentity,
      displayName,
      accentColor,
      enabled,
      snapshot,
      snapshotForCwd,
      consumeResetCredit,
      orchestrationAdapter,
      textGeneration,
      voiceTranscriptCorrection,
      connectionActions,
      managedRuntimeActions: managedRuntime.actions,
      skillActions,
      // SCIENT-FORK:START — Scient Extensions: provider-native plugins and MCP servers.
      pluginActions: nativeInventory.actions,
      nativeInventoryChanges: nativeInventory.reports,
      workspaceInventory: nativeInventory.workspace,
      // SCIENT-FORK:END
    } satisfies ScientProviderInstance;
  }),
};
