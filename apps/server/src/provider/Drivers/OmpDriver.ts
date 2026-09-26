import { ompSessionEnvironment } from "../omp/OmpEnvironment.ts";
import { hasLiveOmpProcess, isOmpBinaryUpdating } from "../omp/OmpProcessRegistry.ts";
import {
  OmpSettings,
  ProviderDriverKind,
  type ProviderInstanceEnvironment,
  type ServerProvider,
  type ServerSettings,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpClient } from "effect/unstable/http";
import { ChildProcessSpawner } from "effect/unstable/process";

import { BackgroundPolicy } from "../../background/BackgroundPolicy.ts";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { makeOmpManagedRuntimeResolution } from "../../scient/providerLifecycle/OmpManagedRuntimeActions.ts";
import { makeOmpCustomModelsClientFactory } from "../omp/OmpCustomModels.ts";
import { customModelDiscoverySnapshot } from "../../customModelCapabilities.ts";
import { makeOmpTextGeneration } from "../../textGeneration/OmpTextGeneration.ts";
import { ProviderDriverError } from "../Errors.ts";
import { makeOmpAdapter } from "../Layers/OmpAdapter.ts";
import { ProviderEventLoggers } from "../Layers/ProviderEventLoggers.ts";
import { checkOmpProviderStatus, makePendingOmpProvider } from "../Layers/OmpProvider.ts";
import { makeManagedServerProvider } from "../makeManagedServerProvider.ts";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "../ProviderDriver.ts";
import type { ServerProviderDraft } from "../providerSnapshot.ts";
import { expandHomePath } from "../../pathExpansion.ts";
import { OMP_AGENT_DIR_ENV, OMP_PROFILE_ENV } from "../omp/OmpRpcProcess.ts";
import { mergeProviderInstanceEnvironment } from "../ProviderInstanceEnvironment.ts";
import {
  ompMaintenance,
  shapeOmpExternalAdvisory,
  withOmpReleaseVersion,
} from "../omp/OmpMaintenance.ts";
import {
  enrichProviderSnapshotWithVersionAdvisory,
  makeCachedProviderMaintenanceResolution,
  makeManualOnlyProviderMaintenanceCapabilities,
  resolveProviderMaintenanceCapabilitiesEffect,
} from "../providerMaintenance.ts";
import {
  haveProviderSnapshotSettingsChanged,
  type ProviderSnapshotSettings,
} from "../providerUpdateSettings.ts";
import { withInstanceIdentity } from "./instanceIdentity.ts";

const DRIVER_KIND = ProviderDriverKind.make("omp");
const decodeSettings = Schema.decodeSync(OmpSettings);

export const makeOmpProcessEnvironment = (
  environment: ProviderInstanceEnvironment | undefined,
  baseEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv => ({
  ...ompSessionEnvironment(baseEnv),
  ...mergeProviderInstanceEnvironment(environment, {}),
});

export type OmpDriverEnv =
  | BackgroundPolicy
  | ChildProcessSpawner.ChildProcessSpawner
  | Crypto.Crypto
  | FileSystem.FileSystem
  | HttpClient.HttpClient
  | Path.Path
  | ProviderEventLoggers
  | ServerConfig
  | ServerSettingsService;

export const OmpDriver: ProviderDriver<OmpSettings, OmpDriverEnv> = {
  driverKind: DRIVER_KIND,
  metadata: { displayName: "Oh My Pi", supportsMultipleInstances: true },
  configSchema: OmpSettings,
  defaultConfig: () => decodeSettings({}),
  create: ({ instanceId, displayName, accentColor, environment, enabled, config }) =>
    Effect.gen(function* () {
      const serverConfig = yield* ServerConfig;
      const eventLoggers = yield* ProviderEventLoggers;
      const serverSettings = yield* ServerSettingsService;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const httpClient = yield* HttpClient.HttpClient;
      const effectiveConfig = { ...config, enabled } satisfies OmpSettings;
      const processEnv: NodeJS.ProcessEnv = makeOmpProcessEnvironment(environment);
      const home = effectiveConfig.homePath.trim();
      const profile = effectiveConfig.profile.trim();
      if (home.length > 0 && profile.length > 0) {
        return yield* new ProviderDriverError({
          driver: DRIVER_KIND,
          instanceId,
          detail: "Choose either an Oh My Pi home or a named profile, not both.",
        });
      }
      if (home.length > 0) processEnv[OMP_AGENT_DIR_ENV] = expandHomePath(home);
      if (profile.length > 0) processEnv[OMP_PROFILE_ENV] = profile;
      const makeRpcClient = yield* makeOmpCustomModelsClientFactory(
        serverSettings,
        instanceId,
        serverConfig.stateDir,
      ).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              detail: "Could not prepare Oh My Pi custom models.",
              cause,
            }),
        ),
      );
      const managedRuntime = yield* makeOmpManagedRuntimeResolution({
        settings: effectiveConfig,
        baseDir: serverConfig.baseDir,
        environment: processEnv,
        spawner,
        managedInstallationAllowed: serverConfig.mode === "desktop",
      });
      const launchConfig = {
        ...effectiveConfig,
        binaryPath: managedRuntime.effectiveBinaryPath,
      } satisfies OmpSettings;
      const continuationIdentity = defaultProviderContinuationIdentity({
        driverKind: DRIVER_KIND,
        instanceId,
      });
      const stampIdentity = withInstanceIdentity({
        instanceId,
        driverKind: DRIVER_KIND,
        displayName,
        accentColor,
        continuationGroupKey: continuationIdentity.continuationKey,
      });
      const stamp = (snapshot: ServerProviderDraft): ServerProvider => ({
        ...stampIdentity(snapshot),
        connection: {
          methods: [],
          canDisconnect: false,
          operation: null,
          runtime: managedRuntime.summary,
        },
      });
      const adapter = yield* makeOmpAdapter({
        binaryPath: launchConfig.binaryPath,
        providerInstanceId: instanceId,
        stateDir: serverConfig.stateDir,
        attachmentsDir: serverConfig.attachmentsDir,
        environment: processEnv,
        makeProcess: makeRpcClient,
        homePath: home || undefined,
        profile: profile || undefined,
        // The shared native provider event log, written from the adapter so a
        // native agent's raw protocol frames stay diagnosable like every other
        // provider's.
        ...(eventLoggers.native ? { nativeEventLogger: eventLoggers.native } : {}),
      }).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, path),
      );
      const textGeneration = yield* makeOmpTextGeneration(
        launchConfig,
        processEnv,
        makeRpcClient,
      ).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, path),
      );
      const mapSnapshotSettings = (settings: ServerSettings) => ({
        provider: effectiveConfig,
        enableProviderUpdateChecks: settings.enableProviderUpdateChecks,
        customModels: customModelDiscoverySnapshot(settings.customModels.connections, instanceId),
      });
      const snapshotSettings = {
        getSettings: serverSettings.getSettings.pipe(Effect.map(mapSnapshotSettings)),
        streamSettings: serverSettings.streamChanges.pipe(Stream.map(mapSnapshotSettings)),
      };
      const resolveInstallationMaintenance = yield* makeCachedProviderMaintenanceResolution(
        (managedRuntime.usesManagedPath
          ? Effect.succeed(
              makeManualOnlyProviderMaintenanceCapabilities({
                provider: DRIVER_KIND,
                packageName: null,
              }),
            )
          : resolveProviderMaintenanceCapabilitiesEffect(ompMaintenance, {
              binaryPath: launchConfig.binaryPath,
              env: processEnv,
            })
        )
          .pipe(
            Effect.map((capabilities) =>
              capabilities.update
                ? {
                    ...capabilities,
                    update: {
                      ...capabilities.update,
                      canUpdate: () =>
                        Effect.sync(
                          () =>
                            !isOmpBinaryUpdating(launchConfig.binaryPath) &&
                            !hasLiveOmpProcess(launchConfig.binaryPath),
                        ),
                    },
                  }
                : capabilities,
            ),
          )
          .pipe(
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
            Effect.provideService(FileSystem.FileSystem, fs),
            Effect.provideService(Path.Path, path),
          ),
      );
      // Routine snapshot reads use the cached ownership resolution. An
      // explicit update must re-resolve the GitHub release channel so the
      // runner receives a concrete candidate version before spawning omp.
      const resolveMaintenance = (options?: { readonly fresh?: boolean }) =>
        resolveInstallationMaintenance(options).pipe(
          Effect.flatMap((capabilities) =>
            options?.fresh === true
              ? withOmpReleaseVersion(capabilities, true)
              : Effect.succeed(capabilities),
          ),
          Effect.provideService(HttpClient.HttpClient, httpClient),
        );
      const snapshot = yield* makeManagedServerProvider<
        ProviderSnapshotSettings<OmpSettings> & {
          readonly customModels: ReturnType<typeof customModelDiscoverySnapshot>;
        }
      >({
        resolveMaintenance,
        getSettings: snapshotSettings.getSettings,
        streamSettings: snapshotSettings.streamSettings,
        haveSettingsChanged: haveProviderSnapshotSettingsChanged,
        initialSnapshot: (settings) =>
          makePendingOmpProvider(settings.provider).pipe(Effect.map(stamp)),
        checkProvider: checkOmpProviderStatus(launchConfig, processEnv, makeRpcClient).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.provideService(Path.Path, path),
          Effect.map(stamp),
        ),
        enrichSnapshot: ({ settings, snapshot: currentSnapshot, publishSnapshot }) =>
          resolveMaintenance().pipe(
            Effect.flatMap((capabilities) =>
              managedRuntime.usesManagedPath
                ? Effect.succeed(capabilities)
                : withOmpReleaseVersion(
                    capabilities,
                    settings.enableProviderUpdateChecks !== false && currentSnapshot.enabled,
                  ),
            ),
            Effect.flatMap((capabilities) =>
              enrichProviderSnapshotWithVersionAdvisory(currentSnapshot, capabilities, {
                enableProviderUpdateChecks: settings.enableProviderUpdateChecks,
              }).pipe(
                Effect.map((enriched) => {
                  const advisory = enriched.versionAdvisory;
                  if (!advisory) return enriched;
                  return {
                    ...enriched,
                    versionAdvisory: shapeOmpExternalAdvisory({
                      currentVersion: advisory.currentVersion,
                      latestVersion: advisory.latestVersion,
                      checkedAt: advisory.checkedAt,
                      maintenanceCapabilities: capabilities,
                    }),
                  };
                }),
              ),
            ),
            Effect.provideService(HttpClient.HttpClient, httpClient),
            Effect.flatMap(publishSnapshot),
          ),
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              detail: `Failed to build the Oh My Pi snapshot: ${cause.message ?? String(cause)}`,
              cause,
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
        snapshotForCwd: (cwd) =>
          checkOmpProviderStatus(launchConfig, processEnv, makeRpcClient, cwd).pipe(
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
            Effect.provideService(FileSystem.FileSystem, fs),
            Effect.provideService(Path.Path, path),
            Effect.map(stamp),
          ),
        adapter,
        textGeneration,
        managedRuntimeActions: managedRuntime.actions,
      } satisfies ProviderInstance;
    }),
};
